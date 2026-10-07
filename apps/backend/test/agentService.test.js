import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const cacheRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.cache');
await mkdir(cacheRoot, { recursive: true });
const dataDir = await mkdtemp(path.join(cacheRoot, 'agent-service-test-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { runToolAgent, buildToolAgentModel } = await import('../src/services/agentService.js');
const {
  cancelHarnessRun,
  createHarnessRun,
  getHarnessRun,
  pauseHarnessRun,
  registerHarnessAdapter,
  resumeHarnessRun,
  runHarnessRequest,
  startHarnessRun,
  waitForHarnessRun
} = await import('../src/services/harnessRuntime/index.js');
const { startAssistantRun } = await import('../src/services/assistantService.js');
const { deepseekHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/deepseekAdapter.js');
const { fetchArxivEntry } = await import('../src/services/arxivService.js');
const { HarnessRuntimeError } = await import('../src/services/harnessRuntime/errors.js');
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

test('Legacy rejects empty patch proposals and permits a corrected unified diff', async (t) => {
  const filePath = 'no-op.tex';
  const original = 'old text\n';
  await writeFile(path.join(dataDir, 'test', filePath), original);
  const requests = [];
  const responses = [
    { tool: 'read_file', args: { path: filePath } },
    { tool: 'apply_patch', args: { path: filePath, patch: '*** Begin Patch\n*** Update File: no-op.tex\n@@\n-old text\n+new text\n*** End Patch\n' } },
    { tool: 'propose_patch', args: { path: filePath, content: original } },
    { tool: 'apply_patch', args: { path: filePath, patch: '--- no-op.tex\n+++ no-op.tex\n@@ -1 +1 @@\n-old text\n+new text\n' } },
    { content: 'Correction proposed for review.' }
  ];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return providerResponse(request, responses.shift());
  });
  const result = await runToolAgent({ ...baseRequest });
  for (const index of [2, 3]) {
    assert.match(requests[index].messages.filter(message => message.role === 'tool').at(-1).content, /No changes proposed/);
  }
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].content, 'new text\n');
  assert.match(result.patches[0].diff, /\+new text/);
  assert.equal(await fs.readFile(path.join(dataDir, 'test', filePath), 'utf8'), original);
});

test('Legacy does not queue a header-only diff for human acceptance', async (t) => {
  const responses = [
    { tool: 'read_file', args: { path: 'main.tex' } },
    { tool: 'apply_patch', args: { path: 'main.tex', patch: '--- main.tex\n+++ main.tex\n' } },
    { content: 'No change proposed.' }
  ];
  t.mock.method(globalThis, 'fetch', async (_url, init) => providerResponse(JSON.parse(init.body), responses.shift()));
  const result = await runToolAgent({ ...baseRequest });
  assert.deepEqual(result.patches, []);
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

test('Legacy and Fake Runs do not allocate or copy an unused project workspace', async (t) => {
  t.mock.method(fs, 'cp', async () => { throw new Error('unexpected project copy'); });
  t.mock.method(fs, 'mkdtemp', async () => { throw new Error('unexpected workspace allocation'); });
  t.mock.method(globalThis, 'fetch', async (_url, init) => providerResponse(JSON.parse(init.body), { content: 'review complete' }));
  for (const adapter of ['legacy', 'fake']) {
    const result = await runHarnessRequest({ ...baseRequest, adapter, fallback: false });
    assert.equal(result.ok, true, result.reply);
    assert.equal((await getHarnessRun('test', result.runId)).status, 'completed');
  }
});

test('a packed context reaches the model once without unbounded raw duplicates', async (t) => {
  let input;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    input = request.messages.find((message) => message.role === 'user').content;
    return providerResponse(request, { content: 'review complete' });
  });
  await runToolAgent({
    ...baseRequest,
    prompt: 'raw prompt outside budget', selection: 'raw selection outside budget', compileLog: 'raw log outside budget',
    contextPack: { task: 'review', instructions: { prompt: 'packed prompt', human: 'human advice' }, selection: 'packed selection', compileLog: 'packed log' }
  });
  assert.ok(!input.includes('outside budget'));
  assert.equal(input.match(/packed prompt/g).length, 1);
  assert.ok(input.includes('packed selection') && input.includes('packed log') && input.includes('human advice'));
});

test('isolated Run workspaces are reclaimed on completion, failure and cancellation; starts deduplicate', async () => {
  for (const outcome of ['completed', 'failed', 'cancelled']) {
    let workspacePath;
    let calls = 0;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let release;
    const proceed = new Promise((resolve) => { release = resolve; });
    registerHarnessAdapter({
      ...deepseekHarnessAdapter,
      async run({ workspace, signal }) {
        calls += 1;
        workspacePath = workspace;
        signalStarted();
        if (outcome === 'cancelled') {
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          return { finalResponse: 'cancelled adapter', patches: [] };
        }
        await proceed;
        if (outcome === 'failed') throw new Error('fixture adapter failure');
        return { finalResponse: 'completed adapter', patches: [] };
      }
    });
    try {
      const run = await createHarnessRun('test', { ...baseRequest, adapter: 'deepseek', fallback: false });
      await startHarnessRun('test', run.id);
      await started;
      await fs.access(workspacePath);
      await assert.rejects(startHarnessRun('test', run.id), { code: 'HARNESS_RUN_NOT_RUNNABLE', statusCode: 409 });
      assert.equal(calls, 1, 'starting a running Run must not execute its adapter twice');
      if (outcome === 'cancelled') await cancelHarnessRun('test', run.id);
      else release();
      const finished = await waitForHarnessRun('test', run.id);
      assert.equal(finished.status, outcome);
      await assert.rejects(fs.access(workspacePath), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(dataDir, 'test', 'main.tex'), 'utf8'), 'saved manuscript');
    } finally {
      release();
      registerHarnessAdapter(deepseekHarnessAdapter);
    }
  }
});

test('DeepSeek retains its isolated workspace and proposes changes without applying them', async () => {
  registerHarnessAdapter({
    ...deepseekHarnessAdapter,
    async run({ workspace, projectRoot }) {
      assert.notEqual(workspace, projectRoot);
      assert.equal(await fs.readFile(path.join(workspace, 'main.tex'), 'utf8'), 'saved manuscript');
      await fs.writeFile(path.join(workspace, 'main.tex'), 'proposed manuscript');
      return { finalResponse: 'proposed edit', patches: [] };
    }
  });
  try {
    const result = await runHarnessRequest({ ...baseRequest, adapter: 'deepseek', fallback: false });
    assert.equal(result.ok, true, result.reply);
    const run = await getHarnessRun('test', result.runId);
    assert.equal(run.patches[0].content, 'proposed manuscript');
    assert.equal(run.humanDecision.status, 'pending');
    assert.equal(await fs.readFile(path.join(dataDir, 'test', 'main.tex'), 'utf8'), 'saved manuscript');
  } finally {
    registerHarnessAdapter(deepseekHarnessAdapter);
  }
});

test('cancelling during Legacy fallback remains cancelled instead of failed', async (t) => {
  const projectId = 'test';
  let started;
  let reportStarted;
  started = new Promise((resolve) => { reportStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    reportStarted();
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  registerHarnessAdapter({
    ...deepseekHarnessAdapter,
    async run() {
      throw new HarnessRuntimeError(502, 'PROVIDER_ERROR', 'fixture failure', undefined, { retryable: true });
    }
  });
  try {
    const run = await createHarnessRun(projectId, { ...baseRequest, adapter: 'deepseek', fallback: true });
    await startHarnessRun(projectId, run.id);
    await started;
    const cancelled = await cancelHarnessRun(projectId, run.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await getHarnessRun(projectId, run.id)).status, 'cancelled');
  } finally {
    registerHarnessAdapter(deepseekHarnessAdapter);
  }
});

test('pausing during Legacy fallback preserves a resumable Run', async (t) => {
  let fallbackStarted;
  const started = new Promise((resolve) => { fallbackStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    fallbackStarted();
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  let deepseekAttempts = 0;
  registerHarnessAdapter({
    ...deepseekHarnessAdapter,
    async run() {
      deepseekAttempts += 1;
      if (deepseekAttempts === 1) {
        throw new HarnessRuntimeError(502, 'PROVIDER_ERROR', 'fixture failure', undefined, { retryable: true });
      }
      return { finalResponse: 'resumed fallback', patches: [] };
    }
  });
  try {
    const run = await createHarnessRun('test', {
      ...baseRequest, adapter: 'deepseek', fallback: true, fakeResponse: 'resumed fallback'
    });
    await startHarnessRun('test', run.id);
    await started;
    const paused = await pauseHarnessRun('test', run.id);
    assert.equal(paused.status, 'running', 'pause returns the current persisted snapshot while execution unwinds');
    const settled = await waitForHarnessRun('test', run.id);
    assert.equal(settled.status, 'paused');
    const resumed = await resumeHarnessRun('test', run.id, { wait: true, request: { fakeResponse: 'resumed fallback' } });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.reply, 'resumed fallback');
    assert.equal(resumed.attempt, 2);
  } finally {
    registerHarnessAdapter(deepseekHarnessAdapter);
  }
});

test('editor assistant requests are idempotent, source-isolated, and retain bounded context', async () => {
  const projectId = 'test';
  const request = {
    requestId: 'editor-request-01',
    task: 'polish',
    permission: 'read',
    prompt: 'Keep the terminology consistent.',
    history: Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index}` })),
    documentVersions: [{ path: 'main.tex', exists: true, sha256: (await import('../src/services/harnessRuntime/fileVersions.js')).contentHash('saved manuscript') }],
    llmConfig: { runtime: 'legacy' }
  };
  const first = await startAssistantRun(projectId, request, { adapter: 'fake', fakeResponse: 'read-only answer' });
  const repeated = await startAssistantRun(projectId, request, { adapter: 'fake', fakeResponse: 'different answer' });
  assert.equal(repeated.id, first.id);
  const result = await waitForHarnessRun(projectId, first.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.request.source, 'editor');
  assert.equal(result.contextPack.history.length, 8);
  assert.equal(result.contextPack.history.at(-1).content, 'turn-11');
  assert.equal(result.capabilities.granted.includes('patch.propose'), false);

  await assert.rejects(
    () => startAssistantRun(projectId, { ...request, prompt: 'A changed task.' }, { adapter: 'fake' }),
    (error) => error.code === 'REQUEST_ID_CONFLICT'
  );
  const stored = await getHarnessRun(projectId, first.id);
  assert.equal(stored.request.source, 'editor');
});

test('an active editor assistant Run blocks another request but permits a distinct source', async () => {
  const projectId = 'test';
  const active = await startAssistantRun(projectId, {
    requestId: 'editor-active-01', task: 'polish', permission: 'read', prompt: 'wait', llmConfig: { runtime: 'legacy' }
  }, { adapter: 'fake', fakeDelayMs: 200, fakeResponse: 'done' });
  await assert.rejects(
    () => startAssistantRun(projectId, {
      requestId: 'editor-active-02', task: 'polish', permission: 'read', prompt: 'second', llmConfig: { runtime: 'legacy' }
    }, { adapter: 'fake' }),
    (error) => error.code === 'ASSISTANT_BUSY'
  );
  await waitForHarnessRun(projectId, active.id);
  const direct = await runHarnessRequest({ projectId, adapter: 'fake', source: 'automation', fakeResponse: 'separate source' });
  assert.equal(direct.ok, true);
  assert.equal((await waitForHarnessRun(projectId, active.id)).status, 'completed');
});

test('editor Skill selection supplies server metadata then reads generic text only on demand', async (t) => {
  const folder = path.join(dataDir, 'test', '.dsh/skills/editor-proof');
  await mkdir(folder, { recursive: true });
  const document = '---\nname: editor-proof\ndescription: Check manuscript terminology with this selected Skill.\n---\nBODY_ONLY_AFTER_TOOL_143';
  await writeFile(path.join(folder, 'SKILL.md'), document);
  const requests = [];
  const responses = [{ tool: 'read_research_skill', args: { name: 'editor-proof' } }, { content: '{"reply":"Terminology checked","constraintProposal":null}' }];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return providerResponse(request, responses.shift());
  });
  const input = { requestId: 'editor-skill-143', permission: 'read', prompt: 'Check terminology', skillNames: ['editor-proof'], llmConfig: baseRequest.llmConfig,
    researchSkillMetadata: [{ name: 'editor-proof', description: 'FORGED_METADATA' }] };
  const started = await startAssistantRun('test', input, { adapter: 'legacy', modelFactory: baseRequest.modelFactory });
  const result = await waitForHarnessRun('test', started.id);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0].messages), /Check manuscript terminology with this selected Skill/);
  assert.ok(!JSON.stringify(requests[0]).includes('BODY_ONLY_AFTER_TOOL_143'));
  assert.ok(!JSON.stringify(requests[0]).includes('FORGED_METADATA'));
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('BODY_ONLY_AFTER_TOOL_143')));
  assert.deepEqual(result.skills, ['editor-proof']);
  assert.deepEqual(result.contextPack.instructions.skills[0].stages, []);
  assert.deepEqual(result.capabilities.granted, ['project.read']);
  assert.deepEqual(result.patches, []);
  assert.ok(result.events.some(event => event.type === 'tool/start' && event.name === 'read_research_skill' && event.capability === 'project.read'));
  await writeFile(path.join(folder, 'SKILL.md'), 'temporarily invalid');
  assert.equal((await startAssistantRun('test', input)).id, started.id);
  await assert.rejects(startAssistantRun('test', { ...input, skillNames: [] }), error => error.code === 'REQUEST_ID_CONFLICT');
  await writeFile(path.join(folder, 'SKILL.md'), document);
});

test('editor rejects malformed, duplicate, unavailable and cross-project Skills before creating a Run', async () => {
  const { listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
  const before = await listHarnessRuns('test', { limit: 1000 });
  const input = { requestId: 'invalid-skill-143', permission: 'read' };
  for (const skillNames of [null, 'editor-proof', ['../escape'], ['editor-proof', 'editor-proof'], [42], Array.from({ length: 21 }, (_, i) => `skill-${i}`)]) {
    await assert.rejects(startAssistantRun('test', { ...input, skillNames }), error => error.code === 'INVALID_SKILL_SELECTION');
  }
  await assert.rejects(startAssistantRun('test', { ...input, skillNames: ['missing-skill'] }), error => error.code === 'SKILL_UNAVAILABLE');
  await mkdir(path.join(dataDir, 'other-skill-project'), { recursive: true });
  await writeFile(path.join(dataDir, 'other-skill-project', 'project.json'), '{}');
  await assert.rejects(startAssistantRun('other-skill-project', { ...input, skillNames: ['editor-proof'] }), error => error.code === 'SKILL_UNAVAILABLE');
  assert.deepEqual((await listHarnessRuns('test', { limit: 1000 })).map(run => run.id), before.map(run => run.id));
  const disabled = await startAssistantRun('test', { ...input, requestId: 'empty-skills-143', skillNames: [] }, { adapter: 'fake', fakeResponse: 'No Skills' });
  const result = await waitForHarnessRun('test', disabled.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.request.researchSkills, []);
});

test('editor Skill catalog route returns sources and unavailable reasons without bodies', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerAgentRoutes } = await import('../src/routes/agent.js');
  const app = Fastify();
  registerAgentRoutes(app);
  try {
    await mkdir(path.join(dataDir, 'test', '.dsh/skills/broken-editor'), { recursive: true });
    const response = await app.inject({ method: 'GET', url: '/api/projects/test/assistant-skills' });
    assert.equal(response.statusCode, 200);
    const { skills } = response.json();
    assert.equal(skills.find(skill => skill.name === 'editor-proof').source, 'project');
    assert.equal(skills.find(skill => skill.name === 'broken-editor').reason, 'MISSING_DOCUMENT');
    assert.ok(!response.body.includes('BODY_ONLY_AFTER_TOOL_143'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/no-such-project/assistant-skills' })).statusCode, 404);
  } finally { await app.close(); }
});

test('editor catalog and selection respect project read capability and path policy', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerAgentRoutes } = await import('../src/routes/agent.js');
  const { listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
  const id = 'restricted-skills';
  const root = path.join(dataDir, id);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await mkdir(path.join(root, '.dsh/skills/local-proof'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}');
  await writeFile(path.join(root, '.dsh/skills/local-proof/SKILL.md'), '---\nname: local-proof\ndescription: restricted metadata\n---\nPRIVATE_BODY');
  const config = path.join(root, '.scienceprism/project-constraints.json');
  const app = Fastify();
  registerAgentRoutes(app);
  try {
    await writeFile(config, JSON.stringify({ allowedPaths: ['main.tex'], capabilities: ['project.read'] }));
    let response = await app.inject(`/api/projects/${id}/assistant-skills`);
    assert.equal(response.statusCode, 200);
    let skills = response.json().skills;
    assert.equal(skills.find(skill => skill.name === 'local-proof').reason, 'PERMISSION_DENIED');
    assert.equal(skills.find(skill => skill.name === 'paper-figure-style').available, true);
    assert.ok(!response.body.includes('restricted metadata'));
    await assert.rejects(startAssistantRun(id, { requestId: 'restricted-local', skillNames: ['local-proof'] }), error => error.code === 'SKILL_UNAVAILABLE' && error.details.reason === 'PERMISSION_DENIED');
    await writeFile(config, JSON.stringify({ capabilities: [] }));
    response = await app.inject(`/api/projects/${id}/assistant-skills`);
    skills = response.json().skills;
    assert.ok(skills.length > 1);
    assert.ok(skills.every(skill => !skill.available && skill.reason === 'PERMISSION_DENIED'));
    for (const name of ['local-proof', 'paper-figure-style']) {
      await assert.rejects(startAssistantRun(id, { requestId: 'no-read-capability', skillNames: [name] }), error => error.code === 'SKILL_UNAVAILABLE' && error.details.reason === 'PERMISSION_DENIED');
    }
    await writeFile(config, '{broken');
    assert.equal((await app.inject(`/api/projects/${id}/assistant-skills`)).statusCode, 400);
    await assert.rejects(startAssistantRun(id, { requestId: 'bad-constraints', skillNames: ['local-proof'] }), error => error.code === 'INVALID_PROJECT_CONSTRAINTS');
    assert.deepEqual(await listHarnessRuns(id), []);
    await writeFile(config, JSON.stringify({ capabilities: ['project.read'], fileScope: ['.dsh/skills/local-proof'] }));
    skills = (await app.inject(`/api/projects/${id}/assistant-skills`)).json().skills;
    assert.equal(skills.find(skill => skill.name === 'local-proof').available, true);
    assert.equal(skills.find(skill => skill.name === 'local-proof').description, 'restricted metadata');
  } finally { await app.close(); }
});

test('Legacy fallback retains the Run limits and reported token usage', async (t) => {
  let receivedLimits;
  t.mock.method(globalThis, 'fetch', async (_url, init) => providerResponse(JSON.parse(init.body), { content: 'fallback review' }));
  registerHarnessAdapter({
    ...deepseekHarnessAdapter,
    async run() { throw new HarnessRuntimeError(502, 'PROVIDER_ERROR', 'fixture failure', undefined, { retryable: true }); }
  });
  try {
    const result = await runHarnessRequest({
      ...baseRequest, adapter: 'deepseek', fallback: true, limits: { maxTokens: 1234 },
      modelFactory(options) { receivedLimits = options.limits; return baseRequest.modelFactory(options); }
    });
    assert.equal(result.ok, true);
    const run = await getHarnessRun('test', result.runId);
    assert.equal(run.adapter, 'legacy');
    assert.equal(receivedLimits?.maxTokens, 1234);
    assert.equal(run.tokenUsage?.totalTokens, 25);
  } finally {
    registerHarnessAdapter(deepseekHarnessAdapter);
  }
});
