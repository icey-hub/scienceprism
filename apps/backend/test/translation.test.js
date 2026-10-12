import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createTranslationService } from '../src/services/translation/index.js';
import { registerTranslationRoutes } from '../src/routes/translation.js';

const request = { selectionId: 'selection-1', text: 'The experiment compares the baseline with the proposed method.', sourceLanguage: 'en', targetLanguage: 'zh-CN' };
const authHtml = '<div data-iid="translator.5028"><script>const x={IG:"AB123"};var params_AbusePreventionHelper = [1791763200000,"temporary-secret",3600000];</script></div>';
const success = () => Response.json([{ detectedLanguage: { language: 'en' }, translations: [{ text: '该实验比较了基线方法与所提出的方法。', to: 'zh-Hans' }] }]);
const resolveProject = async id => { if (!['project-a', 'project-b'].includes(id)) throw Object.assign(new Error('private path'), { code: 'ENOENT' }); };
const build = options => createTranslationService({ resolveProject, intervalMs: 0, ...options });

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
    const service = build({ timeoutMs: 15, fetchImpl: async (_, { signal }) => {
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
