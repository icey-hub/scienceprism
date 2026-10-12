import { createHash, randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { createWebTranslationProviders, PROVIDERS, TranslationError } from './providers.js';
import { createTranslationState, describeTranslationOperation } from './state.js';

export { TranslationError } from './providers.js';

function shortId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TranslationError('TRANSLATION_INVALID_INPUT', `${name} is required and must be a valid identifier.`, 400);
  return value;
}

function normalizeRequest(body, settings = { defaultProviderId: 'bing-web', targetLanguage: 'zh-CN' }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TranslationError('TRANSLATION_INVALID_INPUT', 'A translation request is required.', 400);
  if (Object.keys(body).some(key => !['providerId', 'text', 'sourceLanguage', 'targetLanguage', 'selectionId', 'source', 'operationId'].includes(key))) throw new TranslationError('TRANSLATION_INVALID_INPUT', 'Unknown translation request fields.', 400);
  const providerId = body.providerId ?? settings.defaultProviderId;
  const provider = PROVIDERS.find(entry => entry.id === providerId);
  if (!provider) throw new TranslationError('TRANSLATION_PROVIDER_UNAVAILABLE', 'Choose an available free translation provider. Credentialed Azure and Google Cloud APIs are not integrated yet.', 400);
  if (typeof body.text !== 'string' || !body.text.trim() || !body.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) throw new TranslationError('TRANSLATION_INVALID_INPUT', 'Select valid text to translate.', 400);
  if (Array.from(body.text).length > provider.maxCharacters) throw new TranslationError('TRANSLATION_TEXT_TOO_LONG', `Select at most ${provider.maxCharacters} characters for this provider.`, 400);
  const sourceLanguage = body.sourceLanguage ?? 'auto';
  const targetLanguage = body.targetLanguage ?? settings.targetLanguage;
  if (!provider.sourceLanguages.includes(sourceLanguage) || !provider.targetLanguages.includes(targetLanguage)) throw new TranslationError('TRANSLATION_UNSUPPORTED_LANGUAGE', 'Choose a supported source and target language.', 400);
  let source;
  if (body.source !== undefined) {
    const value = body.source;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.fileSha256) || !Number.isInteger(value.page) || value.page < 1 || value.page > 100000) {
      throw new TranslationError('TRANSLATION_INVALID_INPUT', 'A source reference needs a PDF hash and page number.', 400);
    }
    source = { paperId: shortId(value.paperId, 'paperId'), attachmentId: shortId(value.attachmentId, 'attachmentId'), fileSha256: value.fileSha256.toLowerCase(), page: value.page };
  }
  return { provider, request: { operationId: body.operationId === undefined ? randomUUID() : shortId(body.operationId, 'operationId'), selectionId: shortId(body.selectionId, 'selectionId'), providerId, text: body.text, sourceLanguage, targetLanguage, ...(source ? { source } : {}) } };
}

/**
 * Project-scoped selected-text translation. Source references are reader context,
 * not verified evidence. No notes, files or scientific claims are written here.
 * @param {{fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number,
 * intervalMs?: number, cacheTtlMs?: number, maxCacheEntries?: number,
 * resolveProject?: (id: string) => Promise<unknown>}} options
 */
export function createTranslationService({ fetchImpl, now = Date.now, timeoutMs = 15000, intervalMs = 600, cacheTtlMs = 86_400_000, maxCacheEntries = 2000, resolveProject = getProjectRoot, stateStore = createTranslationState({ resolveProject, now }) } = {}) {
  const providers = createWebTranslationProviders({ fetchImpl, now });
  const cache = new Map();
  const state = new Map(PROVIDERS.map(provider => [provider.id, { active: false, nextAllowedAt: 0, cooldownUntil: 0, health: { status: 'unknown', checkedAt: null, errorCode: null } }]));
  const cacheLimit = Math.max(1, Math.min(2000, Math.trunc(maxCacheEntries) || 200));
  const ttlCeiling = Number.isFinite(cacheTtlMs) ? Math.max(1, Math.min(86_400_000, Math.trunc(cacheTtlMs))) : 86_400_000;
  const operations = new Map();
  let cacheGeneration = 0;

  function invalidateCache(projectId) {
    cacheGeneration++;
    let clearedEntries = 0, clearedResults = 0;
    for (const [key, entry] of cache) if (entry.projectId === projectId) { cache.delete(key); clearedEntries++; }
    for (const [key, entry] of operations) if (entry.projectId === projectId && entry.settled) { operations.delete(key); clearedResults++; }
    return { clearedEntries, clearedResults };
  }

  async function ensureProject(projectId) {
    try { await resolveProject(projectId); }
    catch (error) { throw new TranslationError('TRANSLATION_PROJECT_UNAVAILABLE', 'Project not found or unavailable.', error?.code === 'ENOENT' ? 404 : 400); }
  }

  return {
    async getSettings(projectId) { return stateStore.read(projectId); },
    async getUsage(projectId) { return { usage: (await stateStore.read(projectId)).usage }; },
    async updateSettings(projectId, body) {
      const result = await stateStore.updateSettings(projectId, body);
      invalidateCache(projectId);
      return result;
    },
    async clearCache(projectId) { await ensureProject(projectId); return invalidateCache(projectId); },
    async listProviders(projectId) {
      await ensureProject(projectId);
      const preferences = await stateStore.read(projectId);
      return { defaultProviderId: preferences.settings.defaultProviderId, settings: preferences.settings, revision: preferences.revision, usage: preferences.usage, providers: PROVIDERS.map(provider => {
        const current = state.get(provider.id);
        return { ...provider, sourceLanguages: [...provider.sourceLanguages], targetLanguages: [...provider.targetLanguages], configured: true,
          configuration: { status: 'configured', enabled: true }, capabilities: { translation: true, explanation: false, nativeGlossary: false },
          health: { ...current.health, retryAfter: current.cooldownUntil > now() ? Math.ceil((current.cooldownUntil - now()) / 1000) : null } };
      }) };
    },
    async translate(projectId, body, { signal } = {}) {
      const preferences = await stateStore.read(projectId);
      const { request, provider } = normalizeRequest(body, preferences.settings);
      await ensureProject(projectId);
      if (signal?.aborted) throw new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
      const descriptor = describeTranslationOperation(request);
      const operationKey = JSON.stringify([projectId, request.operationId]);
      for (const [id, entry] of operations) if (entry.settled && entry.expiresAt <= now()) operations.delete(id);
      const previous = operations.get(operationKey);
      if (previous) {
        if (previous.requestHash !== descriptor.requestHash) throw new TranslationError('TRANSLATION_OPERATION_CONFLICT', 'The request identity was reused with different input.', 409);
        const result = await previous.promise;
        if (signal?.aborted) throw new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
        return { ...structuredClone(result), replayed: true };
      }
      while (operations.size >= cacheLimit) {
        const oldest = [...operations].find(([, entry]) => entry.settled);
        if (!oldest) throw new TranslationError('TRANSLATION_BUSY', 'Too many translation requests are awaiting completion.', 429, 1);
        operations.delete(oldest[0]);
      }
      const generation = cacheGeneration;
      const ttl = Math.min(ttlCeiling, preferences.settings.cache.ttlMs);
      const entry = { projectId, requestHash: descriptor.requestHash, recorded: false, settled: false, expiresAt: Infinity, promise: null };
      entry.promise = Promise.resolve().then(async () => {
        const existing = await stateStore.lookup(projectId, request);
        if (existing.operation) {
          entry.recorded = true;
          throw new TranslationError('TRANSLATION_RESULT_UNAVAILABLE', 'This request is already recorded, but its result is no longer available. It will not be sent again automatically.', 409);
        }
        const timestamp = now();
        for (const [key, entry] of cache) if (entry.expiresAt <= timestamp) cache.delete(key);
        const key = createHash('sha256').update(JSON.stringify([projectId, preferences.revision, provider.id, provider.version, request.sourceLanguage, request.targetLanguage, request.text])).digest('hex');
        const stored = preferences.settings.cache.enabled ? cache.get(key) : null;
        const decorate = (result, cached) => ({ ...result, operationId: request.operationId, selectionId: request.selectionId, sourceText: request.text, ...(request.source ? { source: { ...request.source } } : {}), cached });
        if (stored) {
          if (signal?.aborted) throw new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
          const receipt = await stateStore.recordCached(projectId, request);
          entry.recorded = true;
          if (receipt.disposition !== 'reserved') throw new TranslationError('TRANSLATION_RESULT_UNAVAILABLE', 'This request was already recorded by another operation. It will not be sent again.', 409);
          if (signal?.aborted) throw new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
          if (generation === cacheGeneration && cache.get(key) === stored) { cache.delete(key); cache.set(key, stored); }
          return decorate(stored.result, true);
        }
        const current = state.get(provider.id);
        if (current.active) throw new TranslationError('TRANSLATION_BUSY', 'A translation request is already active for this provider. Retry shortly.', 429, 1);
        const waitUntil = Math.max(current.nextAllowedAt, current.cooldownUntil);
        if (timestamp < waitUntil) throw new TranslationError('TRANSLATION_RATE_LIMITED', 'Wait before calling this translation provider again.', 429, Math.max(1, Math.ceil((waitUntil - timestamp) / 1000)));
        current.active = true;
        current.nextAllowedAt = timestamp + intervalMs;
        const deadline = AbortSignal.timeout(timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let reserved = false, dispatched = false, completed = false, providerStarted = false, providerCompleted = false;
        try {
          requestSignal.throwIfAborted();
          const admission = await stateStore.reserve(projectId, request);
          entry.recorded = true;
          if (admission.disposition !== 'reserved') throw new TranslationError('TRANSLATION_RESULT_UNAVAILABLE', 'This request was already recorded by another operation. It will not be sent again.', 409);
          reserved = true;
          requestSignal.throwIfAborted();
          await stateStore.markDispatched(projectId, request.operationId);
          dispatched = true;
          requestSignal.throwIfAborted();
          providerStarted = true;
          const translated = await providers[provider.id](request, { signal: requestSignal });
          providerCompleted = true;
          requestSignal.throwIfAborted();
          const result = { ...translated, providerId: provider.id, providerVersion: provider.version,
            sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, translatedAt: new Date(now()).toISOString() };
          await stateStore.settle(projectId, request.operationId, { outcome: 'completed' });
          completed = true;
          requestSignal.throwIfAborted();
          if (preferences.settings.cache.enabled && generation === cacheGeneration) {
            cache.set(key, { projectId, expiresAt: now() + ttl, result });
            const projectLimit = Math.min(cacheLimit, preferences.settings.cache.maxEntries);
            while ([...cache.values()].filter(value => value.projectId === projectId).length > projectLimit) {
              const oldest = [...cache].find(([, value]) => value.projectId === projectId);
              cache.delete(oldest[0]);
            }
            while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
          }
          current.health = { status: 'available', checkedAt: new Date(now()).toISOString(), errorCode: null };
          return decorate(result, false);
        } catch (cause) {
          if (reserved && !completed) await stateStore.settle(projectId, request.operationId, { outcome: dispatched ? 'uncertain' : 'released' });
          let error = cause;
          if (signal?.aborted) error = new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
          else if (requestSignal.aborted) error = new TranslationError('TRANSLATION_TIMEOUT', providerCompleted ? 'Translation result commit timed out.' : 'Translation provider timed out.', 504);
          else if (!(error instanceof TranslationError)) error = new TranslationError('TRANSLATION_REQUEST_FAILED', 'Translation provider is unavailable. Your selected text has been preserved.');
          if (providerStarted && !providerCompleted && error.statusCode === 429) current.cooldownUntil = now() + (error.retryAfter || 60) * 1000;
          if (providerStarted && !providerCompleted && error.code !== 'TRANSLATION_CANCELLED') current.health = { status: error.statusCode === 429 ? 'rate-limited' : 'unavailable', checkedAt: new Date(now()).toISOString(), errorCode: error.code };
          throw error;
        } finally { current.active = false; }
      }).finally(() => {
        entry.settled = true;
        entry.expiresAt = now() + ttl;
        if (!entry.recorded || generation !== cacheGeneration) operations.delete(operationKey);
      });
      operations.set(operationKey, entry);
      return structuredClone(await entry.promise);
    }
  };
}

export const translationService = createTranslationService();
