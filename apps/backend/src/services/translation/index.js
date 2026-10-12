import { createHash } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { createWebTranslationProviders, PROVIDERS, TranslationError } from './providers.js';

export { TranslationError } from './providers.js';

function shortId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TranslationError('TRANSLATION_INVALID_INPUT', `${name} is required and must be a valid identifier.`, 400);
  return value;
}

function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TranslationError('TRANSLATION_INVALID_INPUT', 'A translation request is required.', 400);
  const providerId = body.providerId ?? 'bing-web';
  const provider = PROVIDERS.find(entry => entry.id === providerId);
  if (!provider) throw new TranslationError('TRANSLATION_PROVIDER_UNAVAILABLE', 'Choose an available free translation provider. Credentialed Azure and Google Cloud APIs are not integrated yet.', 400);
  if (typeof body.text !== 'string' || !body.text.trim() || !body.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) throw new TranslationError('TRANSLATION_INVALID_INPUT', 'Select valid text to translate.', 400);
  if (Array.from(body.text).length > provider.maxCharacters) throw new TranslationError('TRANSLATION_TEXT_TOO_LONG', `Select at most ${provider.maxCharacters} characters for this provider.`, 400);
  const sourceLanguage = body.sourceLanguage ?? 'auto';
  const targetLanguage = body.targetLanguage ?? 'zh-CN';
  if (!provider.sourceLanguages.includes(sourceLanguage) || !provider.targetLanguages.includes(targetLanguage)) throw new TranslationError('TRANSLATION_UNSUPPORTED_LANGUAGE', 'Choose a supported source and target language.', 400);
  let source;
  if (body.source !== undefined) {
    const value = body.source;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.fileSha256) || !Number.isInteger(value.page) || value.page < 1 || value.page > 100000) {
      throw new TranslationError('TRANSLATION_INVALID_INPUT', 'A source reference needs a PDF hash and page number.', 400);
    }
    source = { paperId: shortId(value.paperId, 'paperId'), attachmentId: shortId(value.attachmentId, 'attachmentId'), fileSha256: value.fileSha256.toLowerCase(), page: value.page };
  }
  return { provider, request: { selectionId: shortId(body.selectionId, 'selectionId'), providerId, text: body.text, sourceLanguage, targetLanguage, ...(source ? { source } : {}) } };
}

/**
 * Project-scoped selected-text translation. Source references are reader context,
 * not verified evidence. No notes, files or scientific claims are written here.
 * @param {{fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number,
 * intervalMs?: number, cacheTtlMs?: number, maxCacheEntries?: number,
 * resolveProject?: (id: string) => Promise<unknown>}} options
 */
export function createTranslationService({ fetchImpl, now = Date.now, timeoutMs = 15000, intervalMs = 600, cacheTtlMs = 30 * 60 * 1000, maxCacheEntries = 200, resolveProject = getProjectRoot } = {}) {
  const providers = createWebTranslationProviders({ fetchImpl, now });
  const cache = new Map();
  const state = new Map(PROVIDERS.map(provider => [provider.id, { active: false, nextAllowedAt: 0, cooldownUntil: 0, health: { status: 'unknown', checkedAt: null, errorCode: null } }]));
  const cacheLimit = Math.max(1, Math.min(2000, Math.trunc(maxCacheEntries) || 200));

  async function ensureProject(projectId) {
    try { await resolveProject(projectId); }
    catch (error) { throw new TranslationError('TRANSLATION_PROJECT_UNAVAILABLE', 'Project not found or unavailable.', error?.code === 'ENOENT' ? 404 : 400); }
  }

  return {
    async listProviders(projectId) {
      await ensureProject(projectId);
      return { defaultProviderId: 'bing-web', providers: PROVIDERS.map(provider => {
        const current = state.get(provider.id);
        return { ...provider, sourceLanguages: [...provider.sourceLanguages], targetLanguages: [...provider.targetLanguages], configured: true,
          health: { ...current.health, retryAfter: current.cooldownUntil > now() ? Math.ceil((current.cooldownUntil - now()) / 1000) : null } };
      }) };
    },
    async translate(projectId, body, { signal } = {}) {
      const { request, provider } = normalizeRequest(body);
      await ensureProject(projectId);
      if (signal?.aborted) throw new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
      const timestamp = now();
      for (const [key, entry] of cache) if (entry.expiresAt <= timestamp) cache.delete(key);
      const key = createHash('sha256').update(JSON.stringify([projectId, provider.id, provider.version, request.sourceLanguage, request.targetLanguage, request.text])).digest('hex');
      const stored = cache.get(key);
      const decorate = (result, cached) => ({ ...result, selectionId: request.selectionId, sourceText: request.text, ...(request.source ? { source: { ...request.source } } : {}), cached });
      if (stored) {
        cache.delete(key);
        cache.set(key, stored);
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
      try {
        const translated = await providers[provider.id](request, { signal: requestSignal });
        requestSignal.throwIfAborted();
        const result = { ...translated, providerId: provider.id, providerVersion: provider.version,
          sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, translatedAt: new Date(now()).toISOString() };
        cache.set(key, { expiresAt: now() + cacheTtlMs, result });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
        current.health = { status: 'available', checkedAt: new Date(now()).toISOString(), errorCode: null };
        return decorate(result, false);
      } catch (cause) {
        let error = cause;
        if (signal?.aborted) error = new TranslationError('TRANSLATION_CANCELLED', 'Translation cancelled.', 499);
        else if (requestSignal.aborted) error = new TranslationError('TRANSLATION_TIMEOUT', 'Translation provider timed out.', 504);
        else if (!(error instanceof TranslationError)) error = new TranslationError('TRANSLATION_REQUEST_FAILED', 'Translation provider is unavailable. Your selected text has been preserved.');
        if (error.statusCode === 429) current.cooldownUntil = now() + (error.retryAfter || 60) * 1000;
        if (error.code !== 'TRANSLATION_CANCELLED') current.health = { status: error.statusCode === 429 ? 'rate-limited' : 'unavailable', checkedAt: new Date(now()).toISOString(), errorCode: error.code };
        throw error;
      } finally { current.active = false; }
    }
  };
}

export const translationService = createTranslationService();
