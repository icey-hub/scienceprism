import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLLMConfig, callOpenAICompatible } from '../src/services/llmService.js';
function configure(t) {
  for (const [name, value] of Object.entries({ SCIENCEPRISM_LLM_ENDPOINT: 'http://127.0.0.1:7864/v1', SCIENCEPRISM_LLM_API_KEY: 'fixture-server-key', SCIENCEPRISM_LLM_MODEL: 'deepseek-flash-fixture' })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}
test('unset endpoint and equivalent base/chat URLs inherit server credentials; explicit key takes precedence', t => {
  configure(t);
  for (const endpoint of [undefined, '', '  ', 'http://127.0.0.1:7864', 'http://127.0.0.1:7864/v1/', ' http://127.0.0.1:7864/v1/chat/completions/ ']) assert.equal(resolveLLMConfig({ endpoint }).apiKey, 'fixture-server-key');
  assert.equal(resolveLLMConfig().model, 'deepseek-flash-fixture');
  assert.equal(resolveLLMConfig({ endpoint: 'https://other-provider.test/v1', apiKey: 'own-provider-key', model: 'own-model' }).apiKey, 'own-provider-key');
  process.env.SCIENCEPRISM_LLM_ENDPOINT = 'https://MODEL.test:443/v1';
  assert.equal(resolveLLMConfig({ endpoint: 'https://model.test/v1/chat/completions' }).apiKey, 'fixture-server-key');
});
test('different hosts, schemes, ports and base paths never inherit the server key; direct calls cannot re-add it', async t => {
  configure(t);
  const different = ['https://api.openai.com/v1/chat/completions', 'http://localhost:7864/v1', 'https://127.0.0.1:7864/v1', 'http://127.0.0.1:7865/v1', 'http://127.0.0.1:7864/proxy/v1', 'not-an-endpoint'];
  for (const endpoint of different) assert.equal(resolveLLMConfig({ endpoint }).apiKey, '');
  let calls = 0; const previous = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('No network should be used'); }; t.after(() => { globalThis.fetch = previous; });
  const resolved = resolveLLMConfig({ endpoint: different[0] });
  assert.equal((await callOpenAICompatible({ ...resolved, messages: [] })).ok, false); assert.equal(calls, 0);
});
test('direct model callers keep same-endpoint compatibility and send only an explicit key to another provider', async t => {
  configure(t); const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, authorization: options.headers.Authorization }); return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ choices: [{ message: { content: 'Fixture reply' } }] }) }; };
  t.after(() => { globalThis.fetch = previous; });
  assert.equal((await callOpenAICompatible({ endpoint: 'http://127.0.0.1:7864/v1/chat/completions', messages: [] })).ok, true);
  assert.equal((await callOpenAICompatible({ endpoint: 'https://other-provider.test/v1', apiKey: 'explicit-provider-key', messages: [] })).ok, true);
  assert.deepEqual(requests.map(request => request.authorization), ['Bearer fixture-server-key', 'Bearer explicit-provider-key']);
});
