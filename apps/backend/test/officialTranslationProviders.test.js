import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialTranslationProviders, describeOfficialTranslationConfiguration, OFFICIAL_TRANSLATION_PROVIDERS, ALL_TRANSLATION_PROVIDERS } from '../src/services/translation/officialProviders.js';
import { TranslationError } from '../src/services/translation/providers.js';

const azureKey = 'fixture-private-azure-key', googleKey = 'fixture-private-google-key';
const configuration = () => ({ 'azure-api': { enabled: true, apiKey: azureKey, region: 'eastasia' }, 'google-cloud': { enabled: true, apiKey: googleKey } });
const request = (extra = {}) => ({ text: 'Scientific text', sourceLanguage: 'auto', targetLanguage: 'zh-CN', ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const responseFor = id => id === 'azure-api' ? json([{ detectedLanguage: { language: 'en' }, translations: [{ text: '科学文本', to: 'zh-Hans' }] }]) : json({ data: { translations: [{ translatedText: '科学文本', detectedSourceLanguage: 'en', model: 'nmt' }] } });
const safeError = (code, key = azureKey) => error => error.code === code && !`${error.message}${error.stack}${JSON.stringify(error)}`.includes(key);

test('official metadata distinguishes account billing and exposes no credentials or unverified health', async () => {
  assert.deepEqual(OFFICIAL_TRANSLATION_PROVIDERS.map(provider => provider.id), ['azure-api', 'google-cloud']);
  assert.deepEqual(ALL_TRANSLATION_PROVIDERS.map(provider => provider.id), ['bing-web', 'google-web', 'azure-api', 'google-cloud']);
  const states = describeOfficialTranslationConfiguration(configuration());
  for (const provider of OFFICIAL_TRANSLATION_PROVIDERS) {
    assert.equal(provider.mode, 'official-api'); assert.equal(provider.requiresCredentials, true);
    assert.equal(provider.freeAllowanceGuaranteed, false); assert.equal(provider.capabilities.nativeGlossary, false);
    assert.equal(states[provider.id].configuration.status, 'configured'); assert.equal(states[provider.id].configuration.enabled, true);
    assert.equal(Object.hasOwn(states[provider.id], 'health'), false);
  }
  assert.ok(!JSON.stringify(states).includes(azureKey)); assert.ok(!JSON.stringify(states).includes(googleKey));
  const missing = describeOfficialTranslationConfiguration();
  assert.ok(Object.values(missing).every(provider => !provider.configured && provider.configuration.status === 'not-configured'));
});

test('Azure uses a fixed POST endpoint, key/region headers, plain text, one target and Chinese language conversion', async () => {
  const calls = [];
  const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json([{ detectedLanguage: { language: 'zh-Hant' }, translations: [{ text: '科学文本', to: 'zh-Hans' }] }], 200, { 'x-metered-usage': '15' });
  } });
  const result = await providers['azure-api'](request({ sourceLanguage: 'zh-TW' }), { signal: new AbortController().signal });
  const url = new URL(calls[0].url), options = calls[0].options;
  assert.equal(url.origin, 'https://api.cognitive.microsofttranslator.com'); assert.equal(url.pathname, '/translate');
  assert.equal(url.searchParams.get('api-version'), '3.0'); assert.equal(url.searchParams.get('from'), 'zh-Hant');
  assert.deepEqual(url.searchParams.getAll('to'), ['zh-Hans']); assert.equal(url.searchParams.get('textType'), 'plain');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
  assert.equal(options.headers['Ocp-Apim-Subscription-Key'], azureKey); assert.equal(options.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.deepEqual(JSON.parse(options.body), [{ Text: 'Scientific text' }]); assert.ok(!calls[0].url.includes(azureKey));
  assert.deepEqual(result, { translatedText: '科学文本', detectedLanguage: 'zh-TW', providerMeteredCharacters: 15 });
});

test('Azure global resource may omit region and auto source is omitted, without extra authentication calls', async () => {
  const calls = [];
  const providers = createOfficialTranslationProviders({ configuration: { 'azure-api': { enabled: true, apiKey: azureKey } }, fetchImpl: async (url, options) => { calls.push({ url, options }); return responseFor('azure-api'); } });
  await providers['azure-api'](request(), {});
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).searchParams.has('from'), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Ocp-Apim-Subscription-Region'), false);
});

test('Google Basic fixes NMT/text POST JSON, puts the key in a header, and decodes text entities once', async () => {
  const calls = [];
  const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ data: { translations: [{ translatedText: 'A &amp; B &#39;quote&#39; &quot;yes&quot; &#x1F680; &amp;lt;', detectedSourceLanguage: 'en', model: 'nmt' }] } });
  } });
  const result = await providers['google-cloud'](request(), {});
  assert.equal(calls[0].url, 'https://translation.googleapis.com/language/translate/v2');
  assert.equal(calls[0].options.headers['X-Goog-Api-Key'], googleKey); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].options.body), { q: ['Scientific text'], target: 'zh-CN', format: 'text', model: 'nmt' });
  assert.equal(result.translatedText, 'A & B \'quote\' "yes" 🚀 &lt;'); assert.equal(result.detectedLanguage, 'en');
});

test('exact Unicode input limit is accepted and explicit Google source is sent from an immutable configuration snapshot', async () => {
  const config = configuration(), calls = [];
  const providers = createOfficialTranslationProviders({ configuration: config, fetchImpl: async (url, options) => { calls.push({ url, options }); return responseFor('google-cloud'); } });
  config['google-cloud'].apiKey = 'changed-key';
  await providers['google-cloud'](request({ text: '😀'.repeat(1000), sourceLanguage: 'en', targetLanguage: 'ja' }), {});
  assert.equal(calls[0].options.headers['X-Goog-Api-Key'], googleKey);
  const body = JSON.parse(calls[0].options.body); assert.equal(body.source, 'en'); assert.equal(body.target, 'ja'); assert.equal(Array.from(body.q[0]).length, 1000);
});

test('missing, disabled, malformed or endpoint-injecting configuration refuses to send', async () => {
  for (const id of ['azure-api', 'google-cloud']) {
    for (const [entry, code] of [[undefined, 'TRANSLATION_NOT_CONFIGURED'], [{ apiKey: azureKey }, 'TRANSLATION_NOT_CONFIGURED'],
      [{ enabled: false, apiKey: azureKey }, 'TRANSLATION_NOT_CONFIGURED'], [{ enabled: true }, 'TRANSLATION_NOT_CONFIGURED'],
      [{ enabled: true, apiKey: 'line\r\nheader' }, 'TRANSLATION_CONFIGURATION_INVALID'], [{ enabled: true, apiKey: azureKey, endpoint: 'https://attacker.invalid' }, 'TRANSLATION_CONFIGURATION_INVALID']]) {
      let calls = 0; const providers = createOfficialTranslationProviders({ configuration: entry ? { [id]: entry } : {}, fetchImpl: async () => { calls++; return responseFor(id); } });
      await assert.rejects(providers[id](request(), {}), safeError(code)); assert.equal(calls, 0);
    }
  }
});

test('unsupported languages, malformed text and overlong Unicode selections cannot spend quota', async () => {
  for (const patch of [{ text: '' }, { text: '😀'.repeat(1001) }, { text: '\u0000' }, { text: '\ud800' }, { sourceLanguage: 'xx' }, { targetLanguage: 'auto' }]) {
    let calls = 0; const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => { calls++; return responseFor('azure-api'); } });
    await assert.rejects(providers['azure-api'](request(patch), {}), { code: 'TRANSLATION_INVALID_INPUT' }); assert.equal(calls, 0);
  }
});

test('Azure auth, quota and rate errors remain distinct with sanitized messages and bounded Retry-After', async () => {
  for (const [status, body, code, retry] of [[401, { error: { code: 401000, message: azureKey } }, 'TRANSLATION_AUTH_INVALID', null],
    [403, { error: { code: 403001, message: azureKey } }, 'TRANSLATION_QUOTA_EXHAUSTED', null],
    [403, { error: { code: 403000, message: azureKey } }, 'TRANSLATION_ACCESS_DENIED', null],
    [429, { error: { code: 429000, message: azureKey } }, 'TRANSLATION_RATE_LIMITED', 86400]]) {
    let calls = 0; const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => { calls++; return json(body, status, { 'retry-after': '999999' }); } });
    await assert.rejects(providers['azure-api'](request(), {}), error => safeError(code)(error) && error.retryAfter === retry); assert.equal(calls, 1);
  }
});

test('Google 403 daily quota and user rate quota do not become false authentication errors', async () => {
  for (const [body, code] of [[{ error: { message: `Daily Limit Exceeded ${googleKey}` } }, 'TRANSLATION_QUOTA_EXHAUSTED'],
    [{ error: { message: `User Rate Limit Exceeded ${googleKey}` } }, 'TRANSLATION_RATE_LIMITED'],
    [{ error: { message: googleKey, status: 'PERMISSION_DENIED' } }, 'TRANSLATION_ACCESS_DENIED']]) {
    const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => json(body, 403) });
    await assert.rejects(providers['google-cloud'](request(), {}), safeError(code, googleKey));
  }
});

test('redirects and fetch exceptions never follow another origin, retry or disclose credentials', async () => {
  for (const id of ['azure-api', 'google-cloud']) {
    for (const mode of ['redirect', 'throw', 'foreign-translation-error']) {
      let calls = 0; const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => {
        calls++;
        if (mode === 'throw') throw new Error(`${azureKey} ${googleKey}`);
        if (mode === 'foreign-translation-error') throw new TranslationError('TRANSLATION_AUTH_INVALID', `${azureKey} ${googleKey}`, 401);
        return new Response('', { status: 307, headers: { location: 'https://attacker.invalid' } });
      } });
      await assert.rejects(providers[id](request(), {}), safeError(mode === 'redirect' ? 'TRANSLATION_UNSAFE_REDIRECT' : 'TRANSLATION_UPSTREAM_UNAVAILABLE', id === 'azure-api' ? azureKey : googleKey));
      assert.equal(calls, 1);
    }
  }
});

test('official rate errors parse Retry-After dates and timeout reasons never become raw transport errors', async () => {
  const fixedNow = Date.parse('2026-10-13T00:00:00Z');
  const providers = createOfficialTranslationProviders({ now: () => fixedNow, configuration: configuration(), fetchImpl: async () => json({}, 429, { 'retry-after': 'Tue, 13 Oct 2026 00:00:17 GMT' }) });
  await assert.rejects(providers['google-cloud'](request(), {}), error => error.code === 'TRANSLATION_RATE_LIMITED' && error.retryAfter === 17);
  await assert.rejects(providers['azure-api'](request(), { signal: AbortSignal.abort(new DOMException(azureKey, 'TimeoutError')) }), safeError('TRANSLATION_TIMEOUT'));
});

test('response byte limits, invalid JSON and mismatched target/model/credential echoes cannot return success', async () => {
  const cases = [
    ['azure-api', () => new Response('x'.repeat(131073)), 'TRANSLATION_RESPONSE_TOO_LARGE'],
    ['azure-api', () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }), 'TRANSLATION_INVALID_RESPONSE'],
    ['azure-api', () => json([{ translations: [{ text: 'wrong', to: 'ja' }] }]), 'TRANSLATION_INVALID_RESPONSE'],
    ['google-cloud', () => json({ data: { translations: [{ translatedText: googleKey }] } }), 'TRANSLATION_INVALID_RESPONSE'],
    ['google-cloud', () => json({ data: { translations: [{ translatedText: 'text', model: 'translation-llm' }] } }), 'TRANSLATION_INVALID_RESPONSE'],
    ['google-cloud', () => json({ data: { translations: [{ translatedText: '&#0;' }] } }), 'TRANSLATION_INVALID_RESPONSE']
  ];
  for (const [id, response, code] of cases) {
    const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => response() });
    await assert.rejects(providers[id](request(), {}), safeError(code, id === 'azure-api' ? azureKey : googleKey));
  }
});

test('abort before fetch and while awaiting response/body prevents late success even with an uncooperative transport', async () => {
  for (const phase of ['before', 'fetch', 'body']) {
    const controller = new AbortController(); let calls = 0, release, cancelled = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const providers = createOfficialTranslationProviders({ configuration: configuration(), fetchImpl: async () => {
      calls++; if (phase === 'fetch') await waiting;
      if (phase !== 'body') return responseFor('azure-api');
      return new Response(new ReadableStream({ pull: () => waiting, cancel: () => { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
    } });
    if (phase === 'before') controller.abort();
    const pending = providers['azure-api'](request(), { signal: controller.signal });
    if (phase !== 'before') { await new Promise(resolve => setImmediate(resolve)); controller.abort(); }
    await assert.rejects(pending, { code: 'TRANSLATION_CANCELLED' }); release();
    assert.equal(calls, phase === 'before' ? 0 : 1); if (phase === 'body') assert.equal(cancelled, 1);
  }
});
