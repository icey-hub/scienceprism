import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createTranslationService } from '../src/services/translation/index.js';
import { createTranslationState, DEFAULT_TRANSLATION_SETTINGS } from '../src/services/translation/state.js';
import { registerTranslationRoutes } from '../src/routes/translation.js';

const request = { selectionId: 'selection-1', text: 'The experiment compares the baseline with the proposed method.', sourceLanguage: 'en', targetLanguage: 'zh-CN' };
const authHtml = '<div data-iid="translator.5028"><script>const x={IG:"AB123"};var params_AbusePreventionHelper = [1791763200000,"temporary-secret",3600000];</script></div>';
const success = () => Response.json([{ detectedLanguage: { language: 'en' }, translations: [{ text: '该实验比较了基线方法与所提出的方法。', to: 'zh-Hans' }] }]);
const resolveProject = async id => { if (!['project-a', 'project-b'].includes(id)) throw Object.assign(new Error('private path'), { code: 'ENOENT' }); };
const cacheRoot = fileURLToPath(new URL('../../../.cache/research-workbench-v2/translation/', import.meta.url));
await fs.mkdir(cacheRoot, { recursive: true });
const fixtureRoot = await fs.mkdtemp(path.join(cacheRoot, 'service-test-'));
after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
const fixtureResolvers = new WeakMap();
const build = (options = {}) => {
  const root = path.join(fixtureRoot, randomUUID());
  const resolver = options.resolveProject || (async id => {
    await resolveProject(id);
    const project = path.join(root, id);
    await fs.mkdir(project, { recursive: true });
    return project;
  });
  const service = createTranslationService({ intervalMs: 0, ...options, resolveProject: resolver });
  fixtureResolvers.set(service, resolver);
  return service;
};

test('official sources stay disabled without server configuration and reject before reserving character usage', async () => {
  let calls = 0;
  const service = build({ fetchImpl: async () => { calls++; throw new Error('must not send'); } });
  const listed = await service.listProviders('project-a');
  assert.equal(listed.providers.length, 4);
  for (const providerId of ['azure-api', 'google-cloud']) {
    const provider = listed.providers.find(item => item.id === providerId);
    assert.equal(provider.configured, false); assert.equal(provider.health.status, 'unknown');
    await assert.rejects(service.translate('project-a', { ...request, providerId, operationId: providerId }), { code: 'TRANSLATION_NOT_CONFIGURED' });
    await assert.rejects(service.updateSettings('project-a', { expectedRevision: listed.revision, patch: { defaultProviderId: providerId } }), { code: 'TRANSLATION_NOT_CONFIGURED' });
  }
  assert.equal(calls, 0);
  const usage = (await service.getUsage('project-a')).usage;
  assert.equal(usage.usedCharacters, 0); assert.equal(usage.reservedCharacters, 0);
});

test('enabled official translation shares persisted settings, idempotency and application quota without a fallback', async () => {
  const calls = [];
  const service = build({ officialConfiguration: { 'google-cloud': { enabled: true, apiKey: 'fixture-private-official-key' } },
    fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.headers['X-Goog-Api-Key'], 'fixture-private-official-key'); return Response.json({ data: { translations: [{ translatedText: '证据' }] } }); } });
  const listed = await service.listProviders('project-a');
  assert.equal(listed.providers.find(item => item.id === 'google-cloud').configured, true);
  assert.equal(JSON.stringify(listed).includes('fixture-private-official-key'), false);
  await service.updateSettings('project-a', { expectedRevision: listed.revision, patch: { defaultProviderId: 'google-cloud', monthlyCharacterLimit: 8 } });
  const input = { ...request, text: 'Evidence', operationId: 'official-stable' };
  const first = await service.translate('project-a', input);
  assert.equal(first.providerId, 'google-cloud'); assert.equal(first.translatedText, '证据');
  assert.equal((await service.translate('project-a', input)).replayed, true); assert.equal(calls.length, 1);
  await assert.rejects(service.translate('project-a', { ...input, text: 'Other', operationId: 'over-limit' }), { code: 'TRANSLATION_QUOTA_EXHAUSTED' });
  assert.equal(calls.length, 1); assert.equal((await service.getUsage('project-a')).usage.usedCharacters, 8);
});

test('Bing translates selected text with a temporary session and exposes no session credentials', async () => {
  const calls = [];
  const service = build({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(authHtml) : success();
  } });
  const before = await service.listProviders('project-a');
  assert.equal(before.defaultProviderId, 'bing-web');
  assert.equal(before.providers[0].health.status, 'unknown');
  assert.equal(calls.length, 0, 'listing providers must not send any text');
  const result = await service.translate('project-a', request);
  assert.equal(result.translatedText, '该实验比较了基线方法与所提出的方法。');
  assert.equal(result.sourceText, request.text);
  assert.equal(result.selectionId, request.selectionId);
  assert.equal(result.cached, false);
  assert.equal(result.detectedLanguage, 'en');
  assert.equal(calls[0].url, 'https://www.bing.com/translator');
  const endpoint = new URL(calls[1].url);
  assert.equal(endpoint.pathname, '/ttranslatev3');
  assert.equal(endpoint.searchParams.get('IG'), 'AB123');
  assert.equal(endpoint.searchParams.has('edgepdftranslator'), false);
  assert.equal(calls[1].options.redirect, 'error');
  const body = new URLSearchParams(calls[1].options.body);
  assert.equal(body.get('to'), 'zh-Hans');
  assert.equal(body.get('text'), request.text);
  assert.equal(body.get('token'), 'temporary-secret');
  const after = await service.listProviders('project-a');
  assert.equal(after.providers[0].health.status, 'available');
  assert.equal(JSON.stringify({ result, after }).includes('temporary-secret'), false);
});

test('cache reuses translation but keeps the new selection and source context, isolated by project', async () => {
  let count = 0;
  const service = build({ fetchImpl: async url => { count++; return url.endsWith('/translator') ? new Response(authHtml) : success(); } });
  const source = { paperId: 'paper-1', attachmentId: 'attachment-1', fileSha256: 'a'.repeat(64), page: 3 };
  await service.translate('project-a', { ...request, source });
  const replay = await service.translate('project-a', { ...request, selectionId: 'selection-2', source: { ...source, page: 4 } });
  assert.equal(count, 2);
  assert.equal(replay.cached, true);
  assert.equal(replay.selectionId, 'selection-2');
  assert.equal(replay.source.page, 4);
  await service.translate('project-b', request);
  assert.equal(count, 3, 'another project must not reuse project-a cache');
  const noSource = await service.translate('project-a', request);
  assert.equal(noSource.source, undefined, 'cached context must not leak to a request with no source');
});

test('cache has a bounded LRU lifetime and provider/language keys', async () => {
  let time = 1000, count = 0;
  const service = build({ now: () => time, maxCacheEntries: 1, cacheTtlMs: 100, fetchImpl: async url => {
    count++;
    return url.includes('translate.googleapis.com') ? Response.json([[['你好', 'hello']], null, 'en']) : url.endsWith('/translator') ? new Response(authHtml) : success();
  } });
  await service.translate('project-a', request);
  await service.translate('project-a', { ...request, providerId: 'google-web' });
  assert.equal(count, 3);
  await service.translate('project-a', request);
  assert.equal(count, 4, 'evicted Bing entry must run again');
  time += 101;
  await service.translate('project-a', request);
  assert.equal(count, 5, 'expired entry must run again');
  await service.translate('project-a', { ...request, targetLanguage: 'ja' });
  assert.equal(count, 6, 'different language must not reuse the Chinese translation');
});

test('Google 429 is explicit, preserves Retry-After and cools down without retries or fallback', async () => {
  let time = 1000, calls = 0;
  const service = build({ now: () => time, fetchImpl: async () => { calls++; return new Response('provider challenge and private diagnostics', { status: 429, headers: { 'Retry-After': '90' } }); } });
  const input = { ...request, providerId: 'google-web' };
  await assert.rejects(service.translate('project-a', input), error => error.code === 'TRANSLATION_RATE_LIMITED' && error.statusCode === 429 && error.retryAfter === 90 && !error.message.includes('diagnostics'));
  const catalog = await service.listProviders('project-a');
  assert.equal(catalog.providers.find(p => p.id === 'google-web').health.status, 'rate-limited');
  assert.equal(catalog.providers.find(p => p.id === 'google-web').health.retryAfter, 90);
  await assert.rejects(service.translate('project-a', input), { code: 'TRANSLATION_RATE_LIMITED' });
  assert.equal(calls, 1);
  time += 91000;
  await assert.rejects(service.translate('project-a', input), { code: 'TRANSLATION_RATE_LIMITED' });
  assert.equal(calls, 2);
});

test('Google combines provider segments in order and encodes the text as data', async () => {
  const service = build({ fetchImpl: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('q'), 'A & B? q=wrong');
    assert.equal(parsed.searchParams.get('client'), 'gtx');
    return Response.json([[['甲', 'A'], ['和乙', '& B']], null, 'en']);
  } });
  const result = await service.translate('project-a', { ...request, text: 'A & B? q=wrong', providerId: 'google-web' });
  assert.equal(result.translatedText, '甲和乙');
});

test('validation and missing project reject before any external request', async () => {
  let calls = 0;
  const service = build({ fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  for (const body of [null, [], {}, { ...request, text: '' }, { ...request, text: '\u0000' }, { ...request, text: '\ud800' }, { ...request, text: 'a'.repeat(1001) }, { ...request, selectionId: '../bad' }, { ...request, providerId: 'azure' }, { ...request, targetLanguage: 'auto' }, { ...request, source: { fileSha256: 123, page: 1 } }]) {
    await assert.rejects(service.translate('project-a', body), error => error.statusCode === 400);
  }
  await assert.rejects(service.translate('missing', request), { code: 'TRANSLATION_PROJECT_UNAVAILABLE', statusCode: 404 });
  assert.equal(calls, 0);
});

test('Bing follows only bounded Microsoft public redirects and sends no token to other origins', async () => {
  const destinations = ['http://www.bing.com/translator', 'https://example.test/translator', 'https://www.bing.com:444/translator', 'https://user:pass@www.bing.com/translator', 'http://127.0.0.1/'];
  for (const location of destinations) {
    let calls = 0;
    const service = build({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(service.translate('project-a', request), { code: 'TRANSLATION_UNSAFE_REDIRECT' });
    assert.equal(calls, 1);
  }
  const calls = [];
  const service = build({ fetchImpl: async url => {
    calls.push(url);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/translator' } }) : calls.length === 2 ? new Response(authHtml) : success();
  } });
  await service.translate('project-a', request);
  assert.equal(new URL(calls[2]).origin, 'https://cn.bing.com');
});

test('invalid sessions, CAPTCHA and malformed responses are errors and never become successful cache', async () => {
  for (const [fixture, code] of [[new Response('<html>No session</html>'), 'TRANSLATION_SESSION_UNAVAILABLE'], [new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'TRANSLATION_RESPONSE_TOO_LARGE']]) {
    const service = build({ fetchImpl: async () => fixture });
    await assert.rejects(service.translate('project-a', request), { code });
  }
  for (const payload of [{ ShowCaptcha: true }, { statusCode: 401 }, [{ translations: [] }]]) {
    let calls = 0;
    const service = build({ fetchImpl: async url => { calls++; return url.endsWith('/translator') ? new Response(authHtml) : Response.json(payload); } });
    await assert.rejects(service.translate('project-a', request), error => error.statusCode === 502);
    assert.equal(calls, 2);
    assert.equal((await service.listProviders('project-a')).providers[0].health.status, 'unavailable');
  }
  for (const body of ['<html>private challenge</html>', 'null', '[[]]', '[[null]]']) {
    const service = build({ fetchImpl: async () => new Response(body) });
    await assert.rejects(service.translate('project-a', { ...request, providerId: 'google-web' }), { code: 'TRANSLATION_INVALID_RESPONSE' });
  }
});

test('active provider rejects overlapping calls and cancellation reaches its actual request', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let observedSignal;
  const service = build({ fetchImpl: async (_, { signal }) => {
    observedSignal = signal;
    entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const running = service.translate('project-a', request, { signal: controller.signal });
  await started;
  await assert.rejects(service.translate('project-b', request), { code: 'TRANSLATION_BUSY', statusCode: 429 });
  controller.abort();
  await assert.rejects(running, { code: 'TRANSLATION_CANCELLED', statusCode: 499 });
  assert.equal(observedSignal.aborted, true);
  assert.equal((await service.listProviders('project-a')).providers[0].health.status, 'unknown', 'user cancellation is not provider downtime');
});

test('timeout aborts fetch, reports 504 and late result cannot be cached', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let observedSignal;
    // This provider-abort check excludes filesystem latency; persistent budgets
    // and before-dispatch refusal are exercised by the real state tests below.
    const stateStore = { read: async () => ({ revision: 0, settings: DEFAULT_TRANSLATION_SETTINGS }), lookup: async () => ({ operation: null }),
      reserve: async () => ({ disposition: 'reserved' }), markDispatched: async () => {}, settle: async () => {} };
    const service = build({ timeoutMs: 15, stateStore, fetchImpl: async (_, { signal }) => {
      observedSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    await assert.rejects(service.translate('project-a', request), { code: 'TRANSLATION_TIMEOUT', statusCode: 504 });
    assert.equal(observedSignal.aborted, true);
  } finally { clearTimeout(keepAlive); }
  let finish;
  const provider = new Promise(resolve => { finish = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const service = build({ fetchImpl: async () => { started(); return provider; } });
  const pending = service.translate('project-a', { ...request, providerId: 'google-web' }, { signal: controller.signal });
  await entered;
  controller.abort();
  finish(Response.json([[['迟到内容', 'late']], null, 'en']));
  await assert.rejects(pending, { code: 'TRANSLATION_CANCELLED' });
});

test('route catalog is read-only and errors retain stable shape without response body secrets', async t => {
  const app = Fastify();
  t.after(() => app.close());
  let calls = 0;
  registerTranslationRoutes(app, { service: build({ fetchImpl: async () => { calls++; return new Response('never return this private text', { status: 429, headers: { 'Retry-After': '30' } }); } }) });
  const catalog = await app.inject('/api/projects/project-a/translation/providers');
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().ok, true);
  assert.equal(calls, 0);
  const result = await app.inject({ method: 'POST', url: '/api/projects/project-a/translations', payload: { ...request, providerId: 'google-web' } });
  assert.equal(result.statusCode, 429);
  assert.equal(result.headers['retry-after'], '30');
  assert.equal(result.json().error.code, 'TRANSLATION_RATE_LIMITED');
  assert.equal(result.body.includes('private text'), false);
  const missing = await app.inject('/api/projects/missing/translation/providers');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.includes('private path'), false);
  const invalid = await app.inject({ method: 'POST', url: '/api/projects/project-a/translations', payload: { ...request, text: '' } });
  assert.equal(invalid.statusCode, 400);
});

test('project translation settings, usage and cache commands share persistent revision and provider defaults', async t => {
  let calls = 0;
  const service = build({ fetchImpl: async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('tl'), 'ja');
    return Response.json([[['比較実験', 'comparison']], null, 'en']);
  } });
  const app = Fastify(); t.after(() => app.close());
  registerTranslationRoutes(app, { service });
  const base = '/api/projects/project-a/translation';
  const before = await app.inject(`${base}/settings`);
  assert.equal(before.statusCode, 200);
  const revision = before.json().revision;
  assert.equal(before.json().settings.defaultProviderId, 'bing-web');
  const changed = await app.inject({ method: 'PATCH', url: `${base}/settings`, payload: {
    expectedRevision: revision, patch: { defaultProviderId: 'google-web', targetLanguage: 'ja', monthlyCharacterLimit: 100 }
  } });
  assert.equal(changed.statusCode, 200);
  assert.ok(changed.json().revision > revision);
  const conflict = await app.inject({ method: 'PATCH', url: `${base}/settings`, payload: { expectedRevision: revision, patch: { automatic: true } } });
  assert.equal(conflict.statusCode, 409);
  const providers = await app.inject(`${base}/providers`);
  assert.equal(providers.json().defaultProviderId, 'google-web');
  assert.equal(calls, 0, 'reading settings and health must not contact providers');
  const translated = await app.inject({ method: 'POST', url: '/api/projects/project-a/translations', payload: { selectionId: 'defaults', text: 'comparison', operationId: 'settings-op' } });
  assert.equal(translated.statusCode, 200);
  assert.equal(translated.json().translation.providerId, 'google-web');
  assert.equal(translated.json().translation.targetLanguage, 'ja');
  const usage = await app.inject(`${base}/usage`);
  assert.equal(usage.statusCode, 200);
  assert.equal(usage.json().usage.usedCharacters, 10);
  assert.equal(usage.json().usage.limitCharacters, 100);
  assert.equal((await app.inject(`${base}/settings`)).json().revision, changed.json().revision, 'usage must not cause settings conflicts');
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/cache` })).statusCode, 200);
  assert.equal(calls, 1);
  assert.equal((await app.inject('/api/projects/missing/translation/settings')).statusCode, 404);
});

test('one operation shares in-flight output, cached identities survive restart, and local quota never becomes provider downtime', async () => {
  let enter, finish, calls = 0;
  const started = new Promise(resolve => { enter = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const service = build({ fetchImpl: async () => { calls++; enter(); return response; } });
  const input = { selectionId: 'one', operationId: 'one', providerId: 'google-web', text: 'hello' };
  const prefs = await service.getSettings('project-a');
  await service.updateSettings('project-a', { expectedRevision: prefs.revision, patch: { monthlyCharacterLimit: 5 } });
  const first = service.translate('project-a', input);
  await started;
  const repeated = service.translate('project-a', input);
  await assert.rejects(service.translate('project-a', { ...input, text: 'changed' }), { code: 'TRANSLATION_OPERATION_CONFLICT' });
  finish(Response.json([[['你好', 'hello']], null, 'en']));
  assert.equal((await first).translatedText, '你好');
  assert.equal((await repeated).replayed, true);
  assert.equal(calls, 1);
  assert.equal((await service.getUsage('project-a')).usage.usedCharacters, 5);
  assert.equal((await service.translate('project-a', { ...input, operationId: 'cached', selectionId: 'two' })).cached, true);
  assert.equal(calls, 1);
  const resolver = fixtureResolvers.get(service);
  const restarted = build({ resolveProject: resolver, fetchImpl: async () => { calls++; throw new Error('must not resend'); } });
  await assert.rejects(restarted.translate('project-a', { ...input, operationId: 'cached', selectionId: 'two' }), { code: 'TRANSLATION_RESULT_UNAVAILABLE' });
  await assert.rejects(restarted.translate('project-a', { ...input, operationId: 'blocked', providerId: 'bing-web', text: 'world' }), { code: 'TRANSLATION_QUOTA_EXHAUSTED' });
  assert.equal((await restarted.listProviders('project-a')).providers[0].health.status, 'unknown');
  const state = await fs.readFile(path.join(await resolver('project-a'), '.scienceprism/translation.json'), 'utf8');
  assert.ok(!state.includes('hello') && !state.includes('你好'));
  assert.equal(calls, 1);
});

test('a busy request can retry its unchanged identity once capacity is free', async () => {
  let enter, finish, calls = 0;
  const started = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const service = build({ fetchImpl: async () => { calls++; if (calls === 1) { enter(); await blocked; } return Response.json([[['译文', 'text']], null, 'en']); } });
  const input = { selectionId: 'busy', operationId: 'busy', providerId: 'google-web', text: 'second' };
  const first = service.translate('project-a', { ...input, operationId: 'first', text: 'first' });
  await started;
  await assert.rejects(service.translate('project-a', input), { code: 'TRANSLATION_BUSY' });
  finish(); await first;
  assert.equal((await service.translate('project-a', input)).translatedText, '译文');
  assert.equal(calls, 2);
});

test('clearing content cache during a cached receipt prevents late cache refill', async () => {
  let enter, finish, calls = 0;
  const started = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const resolverService = build();
  const resolver = fixtureResolvers.get(resolverService);
  const store = createTranslationState({ resolveProject: resolver });
  const service = build({ resolveProject: resolver, stateStore: { ...store, recordCached: async (...args) => { enter(); await blocked; return store.recordCached(...args); } },
    fetchImpl: async () => { calls++; return Response.json([[['译文', 'text']], null, 'en']); } });
  const input = { selectionId: 'clear', operationId: 'original', providerId: 'google-web', text: 'same' };
  await service.translate('project-a', input);
  const cached = service.translate('project-a', { ...input, operationId: 'cache-hit' });
  await started; await service.clearCache('project-a'); finish(); await cached;
  assert.equal((await service.translate('project-a', { ...input, operationId: 'new' })).cached, false);
  assert.equal(calls, 2);
});

test('a reservation appearing between lookup and reserve cannot be taken over or dispatched', async () => {
  let calls = 0;
  const resolverService = build();
  const resolver = fixtureResolvers.get(resolverService);
  const store = createTranslationState({ resolveProject: resolver });
  const service = build({ resolveProject: resolver, stateStore: { ...store, lookup: async (...args) => {
    const result = await store.lookup(...args); await store.reserve(...args); return result;
  } }, fetchImpl: async () => { calls++; return Response.json([[['不应调用', 'text']], null, 'en']); } });
  await assert.rejects(service.translate('project-a', { selectionId: 'race', operationId: 'race', providerId: 'google-web', text: 'text' }), { code: 'TRANSLATION_RESULT_UNAVAILABLE' });
  assert.equal(calls, 0);
  assert.equal((await service.getUsage('project-a')).usage.reservedCharacters, 4);
});

test('cancellation while committing a network or cached result preserves accounting and returns no success', async () => {
  for (const cached of [false, true]) {
    let enter, finish, calls = 0;
    const started = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { finish = resolve; });
    const resolver = fixtureResolvers.get(build());
    const store = createTranslationState({ resolveProject: resolver });
    const stateStore = { ...store,
      settle: async (...args) => { if (!cached && args[2].outcome === 'completed') { enter(); await blocked; } return store.settle(...args); },
      recordCached: async (...args) => { enter(); await blocked; return store.recordCached(...args); }
    };
    const service = build({ resolveProject: resolver, stateStore, fetchImpl: async () => { calls++; return Response.json([[['译文', 'text']], null, 'en']); } });
    const input = { selectionId: 'commit', operationId: 'commit', providerId: 'google-web', text: 'same' };
    if (cached) await service.translate('project-a', { ...input, operationId: 'seed' });
    const controller = new AbortController();
    const running = service.translate('project-a', input, { signal: controller.signal });
    await started; controller.abort(); finish();
    await assert.rejects(running, { code: 'TRANSLATION_CANCELLED' });
    assert.equal((await store.lookup('project-a', { ...input, sourceLanguage: 'auto', targetLanguage: 'zh-CN' })).operation.status, 'completed');
    if (!cached) {
      assert.equal((await service.translate('project-a', { ...input, operationId: 'next' })).cached, false);
      assert.equal(calls, 2, 'cancelled result must not refill content cache');
    }
  }
});

test('local settlement failure preserves uncertain budget without declaring the translation provider unavailable', async () => {
  const resolver = fixtureResolvers.get(build());
  const store = createTranslationState({ resolveProject: resolver });
  const { TranslationError } = await import('../src/services/translation/index.js');
  const service = build({ resolveProject: resolver, stateStore: { ...store, settle: async (...args) => {
    if (args[2].outcome === 'completed') throw new TranslationError('TRANSLATION_STATE_UNAVAILABLE', 'Storage unavailable.', 500);
    return store.settle(...args);
  } }, fetchImpl: async () => Response.json([[['译文', 'text']], null, 'en']) });
  await assert.rejects(service.translate('project-a', { selectionId: 'disk', operationId: 'disk', providerId: 'google-web', text: 'same' }), { code: 'TRANSLATION_STATE_UNAVAILABLE' });
  assert.equal((await service.getUsage('project-a')).usage.uncertainCharacters, 4);
  assert.equal((await service.listProviders('project-a')).providers.find(provider => provider.id === 'google-web').health.status, 'unknown');
});
