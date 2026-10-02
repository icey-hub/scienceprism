import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cacheRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.cache');
await mkdir(cacheRoot, { recursive: true });
const dataDir = await mkdtemp(path.join(cacheRoot, 'agent-service-test-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { runToolAgent, buildToolAgentModel } = await import('../src/services/agentService.js');
const { runHarnessRequest, getHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { fetchArxivEntry } = await import('../src/services/arxivService.js');
await mkdir(path.join(dataDir, 'test'));
await writeFile(path.join(dataDir, 'test', 'project.json'), '{}');
await writeFile(path.join(dataDir, 'test', 'main.tex'), 'saved manuscript');
test.after(() => rm(dataDir, { recursive: true, force: true }));

const baseRequest = {
  projectId: 'test',
  llmConfig: { endpoint: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' },
  // Keep the real LangChain + OpenAI SDK path, replacing only the HTTP transport.
  modelFactory(options) {
    const built = buildToolAgentModel(options);
    built.model.clientConfig.fetch = (...args) => globalThis.fetch(...args);
    return built;
  }
};

function providerResponse(request, { content = '', tool, args = {} } = {}) {
  const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
  const message = { role: 'assistant', content, ...(tool ? { tool_calls: [
    { id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }
  ] } : {}) };
  const common = { id: 'fixture-completion', model: 'fixture-model', created: 1 };
  if (!request.stream) return Response.json({ ...common, choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage });
  const delta = { ...message, ...(tool ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
  const chunks = [
    { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    { ...common, choices: [], usage }
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

test('Legacy reads a Skill on demand, records tool events, and sums streaming usage', async (t) => {
  const requests = [];
  const events = [];
  const responses = [
    { tool: 'read_research_skill', args: { name: 'paper-figure-style' } },
    { tool: 'get_compile_log' },
    { content: 'review complete' }
  ];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return providerResponse(request, responses.shift());
  });
  const result = await runToolAgent({ ...baseRequest, researchSkills: ['paper-figure-style'], compileLog: 'Undefined control sequence', emit: (event) => events.push(event) });
  assert.equal(result.reply, 'review complete');
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('# Paper Figure Style')), JSON.stringify(requests[1].messages.filter((message) => message.role === 'tool')));
  assert.ok(requests[2].messages.some((message) => message.role === 'tool' && message.content.includes('Undefined control sequence')));
  assert.deepEqual(result.usage, { promptTokens: 60, completionTokens: 15, totalTokens: 75 });
  assert.deepEqual(events.filter((event) => event.type === 'tool/start').map((event) => event.data.name), ['read_research_skill', 'get_compile_log']);
  assert.equal(events.filter((event) => event.type === 'tool/end').length, 2);
});

test('Legacy cancellation reaches the in-flight provider request', async (t) => {
  const controller = new AbortController();
  let release;
  let requestSignal;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requestSignal = init.signal;
    reportStarted();
    return new Promise((resolve, reject) => {
      release = () => resolve(providerResponse(request, { content: 'late response' }));
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  const pending = runToolAgent({ ...baseRequest, signal: controller.signal });
  const outcome = pending.then(() => 'completed', () => 'aborted');
  try {
    await started;
    controller.abort(new Error('cancelled by researcher'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requestSignal.aborted, true, 'the SDK request must receive cancellation');
    assert.equal(await outcome, 'aborted');
  } finally {
    release?.();
    await outcome;
  }
});

test('Legacy fails on tool errors instead of silently continuing', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls += 1;
    return providerResponse(JSON.parse(init.body), calls === 1
      ? { tool: 'read_file', args: { path: 'missing.tex' } }
      : { content: 'claimed success despite missing file' });
  });
  await assert.rejects(runToolAgent(baseRequest), /ENOENT/);
  assert.equal(calls, 1);
});

test('Legacy advertises only tools granted to the Run', async (t) => {
  let advertised;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    advertised = request.tools.map((tool) => tool.function.name);
    return providerResponse(request, { content: 'read-only review' });
  });
  await runToolAgent({ ...baseRequest, capabilities: ['project.read'] });
  assert.deepEqual(advertised.sort(), ['get_compile_log', 'list_files', 'read_file']);
});

test('Harness persists Legacy Skill tool events without granting network authority', async (t) => {
  await mkdir(path.join(dataDir, 'test', '.scienceprism'), { recursive: true });
  await writeFile(path.join(dataDir, 'test', '.scienceprism', 'project-constraints.json'), JSON.stringify({ featureFlags: { advancedHarness: true } }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => providerResponse(JSON.parse(init.body), ++calls === 1
    ? { tool: 'read_research_skill', args: { name: 'paper-figure-style' } }
    : { content: 'review complete' }));
  const result = await runHarnessRequest({ ...baseRequest, adapter: 'legacy', fallback: false, role: 'research-stage-assistant', capabilities: ['project.read'], researchSkills: ['paper-figure-style'] });
  assert.equal(result.ok, true);
  const run = await getHarnessRun('test', result.runId);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.capabilities.granted, ['project.read']);
  assert.ok(run.events.some((event) => event.type === 'tool/start' && event.name === 'read_research_skill' && event.capability === 'project.read'));
  assert.ok(run.events.some((event) => event.type === 'tool/end'));
  assert.equal(run.tokenUsage.totalTokens, 50);
});

test('arXiv metadata requests honor the caller cancellation signal', async (t) => {
  const controller = new AbortController();
  const reason = new Error('stop metadata lookup');
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const pending = fetchArxivEntry('2401.00001', { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});
