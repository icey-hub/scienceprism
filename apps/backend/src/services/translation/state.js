import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { PROVIDERS, TranslationError } from './providers.js';

const OWNER = randomUUID();
const fail = (code, message, status = 400) => { throw new TranslationError(`TRANSLATION_${code}`, message, status); };
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const providerId = z.enum(['bing-web', 'google-web']);
const cacheSchema = z.object({ enabled: z.boolean(), ttlMs: z.number().int().min(1000).max(86_400_000), maxEntries: z.number().int().min(1).max(2000) }).strict();
const settingsSchema = z.object({ defaultProviderId: providerId, targetLanguage: z.string(), automatic: z.boolean(), cache: cacheSchema,
  monthlyCharacterLimit: z.number().int().min(0).max(1_000_000_000).nullable() }).strict().refine(value => PROVIDERS.find(p => p.id === value.defaultProviderId).targetLanguages.includes(value.targetLanguage));
export const DEFAULT_TRANSLATION_SETTINGS = Object.freeze({ defaultProviderId: 'bing-web', targetLanguage: 'zh-CN', automatic: false,
  cache: Object.freeze({ enabled: true, ttlMs: 1_800_000, maxEntries: 200 }), monthlyCharacterLimit: null });
const referenceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const sourceSchema = z.object({ paperId: referenceId, attachmentId: referenceId, fileSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase()), page: z.number().int().min(1).max(100000) }).strict();
const requestSchema = z.object({ operationId: referenceId, providerId, text: z.string().min(1).max(2000).refine(value => value.trim() && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)),
  sourceLanguage: z.string(), targetLanguage: z.string(), selectionId: referenceId, source: sourceSchema.optional() }).strict();
const operationSchema = z.object({ operationId: referenceId, requestHash: z.string().regex(/^[a-f0-9]{64}$/), providerId, characters: z.number().int().min(1).max(1000), cached: z.boolean(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), ownerId: id, status: z.enum(['reserved', 'dispatched', 'completed', 'released', 'uncertain']), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict()
  .refine(value => (!value.cached || value.status === 'completed') && value.period === value.createdAt.slice(0, 7) && value.updatedAt >= value.createdAt);
const stateSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), settings: settingsSchema, operations: z.array(operationSchema).max(10000) }).strict()
  .refine(state => new Set(state.operations.map(operation => operation.operationId)).size === state.operations.length);
const parse = (schema, value, stored = false) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(stored ? 'STATE_INVALID' : 'INVALID_INPUT', stored ? 'Translation state is invalid; preserve it for inspection.' : 'Invalid translation settings or operation.', stored ? 500 : 400);
  return result.data;
};

export function describeTranslationOperation(input) {
  const request = parse(requestSchema, input);
  const provider = PROVIDERS.find(value => value.id === request.providerId);
  const characters = Array.from(request.text).length;
  if (characters > provider.maxCharacters || !provider.sourceLanguages.includes(request.sourceLanguage) || !provider.targetLanguages.includes(request.targetLanguage)) fail('INVALID_INPUT', 'Unsupported translation language or text length.');
  const { operationId, ...semantic } = request;
  const requestHash = createHash('sha256').update(JSON.stringify({ ...semantic, providerVersion: provider.version })).digest('hex');
  return { operationId, requestHash, providerId: provider.id, characters };
}

/** One backend process owns this project state. Network I/O belongs to the caller. */
export function createTranslationState({ resolveProject = getProjectRoot, now = Date.now, ownerId = OWNER, maxOperations = 4096, maxStateBytes = 4_194_304 } = {}) {
  parse(id, ownerId);
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 10000 || !Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1024 || maxStateBytes > 4_194_304) fail('INVALID_INPUT', 'Invalid translation storage bounds.');
  const timestamp = () => new Date(now()).toISOString();
  const period = () => timestamp().slice(0, 7);
  async function location(projectId) {
    parse(id, projectId);
    try { return path.join(await fs.realpath(await resolveProject(projectId)), '.scienceprism', 'translation.json'); }
    catch { fail('PROJECT_UNAVAILABLE', 'Project not found or unavailable.', 404); }
  }
  async function checkDirectory(file, create = false) {
    const directory = path.dirname(file);
    if (create) await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) fail('STATE_INVALID', 'Translation state must use a real project directory.', 500);
  }
  async function checkFile(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('STATE_INVALID', 'Translation state must be a regular unlinked file.', 500);
  }
  async function load(file) {
    let handle;
    try {
      await checkDirectory(file);
      await checkFile(file);
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail('STATE_INVALID', 'Translation state must be a regular unlinked file.', 500);
      if (stat.size > maxStateBytes) fail('STATE_CAPACITY', 'Translation state exceeds its storage limit.', 503);
      const buffer = Buffer.alloc(maxStateBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxStateBytes) fail('STATE_CAPACITY', 'Translation state exceeds its storage limit.', 503);
      const state = parse(stateSchema, JSON.parse(buffer.subarray(0, size).toString('utf8')), true);
      for (const operation of state.operations) if (operation.ownerId !== ownerId && ['reserved', 'dispatched'].includes(operation.status)) operation.status = 'uncertain';
      return state;
    }
    catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, settings: structuredClone(DEFAULT_TRANSLATION_SETTINGS), operations: [] };
      if (error instanceof TranslationError) throw error;
      fail('STATE_INVALID', 'Translation state could not be read; preserve it for inspection.', 500);
    } finally { await handle?.close(); }
  }
  async function save(file, state) {
    parse(stateSchema, state, true);
    const content = `${JSON.stringify(state)}\n`;
    // Reserve enough room for every pending operation to change status later.
    const growth = state.operations.reduce((total, operation) => total + (operation.status === 'reserved' ? 2 : 0), 0);
    if (Buffer.byteLength(content) + growth > maxStateBytes) fail('STATE_CAPACITY', 'Translation state has reached its storage limit.', 503);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await checkDirectory(file, true);
      await checkFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await checkDirectory(file);
      await fs.rename(temporary, file);
    } catch (error) { if (error instanceof TranslationError) throw error; fail('STATE_UNAVAILABLE', 'Translation state could not be saved.', 500); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function usage(state) {
    const currentPeriod = period();
    const sum = matches => state.operations.filter(operation => !operation.cached && matches(operation)).reduce((total, operation) => total + operation.characters, 0);
    const usedCharacters = sum(operation => operation.status === 'completed' && operation.period === currentPeriod);
    const reservedCharacters = sum(operation => ['reserved', 'dispatched', 'uncertain'].includes(operation.status));
    const limitCharacters = state.settings.monthlyCharacterLimit;
    return { scope: 'application', period: currentPeriod, timezone: 'UTC', accounting: 'estimated', usedCharacters, reservedCharacters,
      uncertainCharacters: sum(operation => operation.status === 'uncertain'), limitCharacters,
      remainingCharacters: limitCharacters === null ? null : Math.max(0, limitCharacters - usedCharacters - reservedCharacters), operationCount: state.operations.length, maxOperations };
  }
  const view = state => ({ revision: state.revision, settings: structuredClone(state.settings), usage: usage(state) });
  async function transaction(projectId, mutate) {
    const file = await location(projectId);
    return withHubLock(file, async () => { const state = await load(file); const value = mutate(state); await save(file, state); return value; });
  }
  function matching(state, description) {
    const operation = state.operations.find(value => value.operationId === description.operationId);
    if (operation && operation.requestHash !== description.requestHash) fail('OPERATION_CONFLICT', 'This translation operation ID belongs to different text or context.', 409);
    return operation;
  }
  async function reserve(projectId, input, cached) {
    const description = describeTranslationOperation(input);
    return transaction(projectId, state => {
      let operation = matching(state, description);
      if (operation) return { disposition: 'existing', operation: structuredClone(operation), usage: usage(state) };
      if (state.operations.length >= maxOperations) fail('STATE_CAPACITY', 'Translation operation history is full. Existing identities have been preserved.', 503);
      if (!cached && usage(state).remainingCharacters !== null && description.characters > usage(state).remainingCharacters) fail('QUOTA_EXHAUSTED', 'The project translation character limit has been reached.', 429);
      const at = timestamp();
      operation = { ...description, cached, period: at.slice(0, 7), ownerId, status: cached ? 'completed' : 'reserved', createdAt: at, updatedAt: at };
      state.operations.push(operation);
      return { disposition: 'reserved', operation: structuredClone(operation), usage: usage(state) };
    });
  }
  async function transition(projectId, operationId, outcome) {
    parse(referenceId, operationId);
    return transaction(projectId, state => {
      const operation = state.operations.find(value => value.operationId === operationId);
      if (!operation) fail('OPERATION_STATE', 'Translation operation does not exist.', 409);
      const allowed = outcome === 'dispatched' || outcome === 'released' ? ['reserved'] : outcome === 'completed' ? ['dispatched'] : ['reserved', 'dispatched'];
      if (operation.ownerId !== ownerId || !allowed.includes(operation.status)) fail('OPERATION_STATE', 'Translation operation cannot enter this state.', 409);
      const currentUsage = usage(state);
      if (outcome === 'dispatched' && currentUsage.limitCharacters !== null && currentUsage.usedCharacters + currentUsage.reservedCharacters > currentUsage.limitCharacters) fail('QUOTA_EXHAUSTED', 'The project translation limit was reduced before dispatch.', 429);
      operation.status = outcome;
      operation.updatedAt = timestamp();
      return { operation: structuredClone(operation), usage: usage(state) };
    });
  }
  return Object.freeze({
    async read(projectId) {
      const file = await location(projectId);
      return withHubLock(file, async () => view(await load(file)));
    },
    async lookup(projectId, input) {
      const description = describeTranslationOperation(input);
      const file = await location(projectId);
      return withHubLock(file, async () => { const state = await load(file); return { operation: structuredClone(matching(state, description) || null), usage: usage(state) }; });
    },
    reserve: (projectId, input) => reserve(projectId, input, false),
    recordCached: (projectId, input) => reserve(projectId, input, true),
    markDispatched: (projectId, operationId) => transition(projectId, operationId, 'dispatched'),
    settle(projectId, operationId, input) {
      const { outcome } = parse(z.object({ outcome: z.enum(['completed', 'released', 'uncertain']) }).strict(), input);
      return transition(projectId, operationId, outcome);
    },
    async updateSettings(projectId, input) {
      const { expectedRevision, patch } = parse(z.object({ expectedRevision: z.number().int().nonnegative(), patch: z.object({ defaultProviderId: providerId.optional(), targetLanguage: z.string().optional(),
        automatic: z.boolean().optional(), cache: cacheSchema.partial().optional(), monthlyCharacterLimit: z.number().int().min(0).max(1_000_000_000).nullable().optional() }).strict() }).strict(), input);
      return transaction(projectId, state => {
        if (state.revision !== expectedRevision) fail('SETTINGS_CONFLICT', 'Translation settings changed. Reload before saving.', 409);
        state.settings = parse(settingsSchema, { ...state.settings, ...patch, cache: { ...state.settings.cache, ...patch.cache } });
        state.revision += 1;
        return view(state);
      });
    }
  });
}

export const translationState = createTranslationState();
