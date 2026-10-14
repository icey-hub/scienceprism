import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCodePreparationService } from '../src/services/experimentRunner/codePreparations.js';
import { prepareAutomationCode } from '../src/services/researchAutomation/codePreparation.js';

const relative = 'code/baseline.py', code = 'print("proposal fixture")\n';
async function fixture(t, options = {}) {
  const cache = path.resolve('.cache/automation-code-preparation-tests'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'case-')), projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, 'main.tex'), 'original manuscript');
  const state = { version: 1, policy: { enabled: true, overrides: { code: 'inherit' }, codeScope: { allowedPaths: ['code'], maxTokens: 2048, timeoutMs: 5000, maxVersions: 2 } },
    session: { id: 'session', projectId: 'project', coordinatorRunId: 'coordinator', status: 'running', currentStage: 'replication', attempt: 0,
      steps: [{ stage: 'replication', handoff: { sessionId: 'session', stage: 'replication', source: 'fixed-materials' }, calls: [] }] } };
  const file = path.join(root, 'automation.json'), runs = new Map(), saves = [], requests = [], dispatchOptions = [], createdRuns = [];
  const writeState = () => fs.writeFile(file, JSON.stringify(state)), readState = async () => JSON.parse(await fs.readFile(file, 'utf8')); await writeState();
  const readRun = async id => { const run = runs.get(id); if (!run) throw new Error('Run missing'); return structuredClone(run); };
  const serviceOptions = { resolveProject: async id => { assert.equal(id, 'project'); return projectRoot; }, getRun: async (projectId, id) => { assert.equal(projectId, 'project'); return readRun(id); },
    listRuns: async (_id, query) => [...runs.values()].filter(run => run.parentRunId === query.parentRunId) };
  const service = createCodePreparationService(serviceOptions);
  const input = { projectId: 'project', session: structuredClone(state.session), stage: 'replication', input: { protocolPath: 'protocol.json', datasetId: 'fixed-data', output: 'results/metrics.json' }, paths: [relative], service, readState, readRun,
    beforeEffect: async () => {}, saveStep: async patch => { saves.push(structuredClone(patch)); Object.assign(state.session.steps[0], structuredClone(patch)); await writeState(); } };
  const source = id => runs.get(id);
  input.runHarness = async (request, { onPrepared, requireExisting = false }) => {
    requests.push(structuredClone(request));
    dispatchOptions.push({ requireExisting });
    const before = (await readState()).session.steps[0].codePreparations[0]; assert.equal(before.authorization.actor, 'system');
    const id = options.runId || 'producer', old = runs.get(id);
    if (requireExisting && !old) throw Object.assign(new Error('Original producer missing'), { code: 'AUTOMATION_CODE_RUN_UNRESOLVED' });
    if (!old) createdRuns.push(id);
    const run = old || { id, projectId: 'project', kind: 'research-stage', task: request.task, role: request.role, stage: request.stage,
      parentRunId: state.session.coordinatorRunId, automationSessionId: state.session.id, adapter: 'deepseek', status: 'created', attempt: 1, request: structuredClone(request), patches: [], events: [] };
    runs.set(id, run);
    if (!state.session.steps[0].calls.some(call => call.runId === id)) state.session.steps[0].calls.push({ runId: id, task: request.task });
    await writeState(); await options.beforePrepared?.({ state, run, writeState });
    await onPrepared(structuredClone(run));
    assert.equal((await readState()).session.steps[0].codePreparations[0].producerRunId, id, 'Producer ID must be durably bound before any simulated worker effect.');
    await options.afterPrepared?.({ state, run, writeState });
    if (options.failure) { run.status = 'failed'; throw Object.assign(new Error('fixed producer failure'), { code: 'HARNESS_WORKER_FAILED' }); }
    const patch = { path: relative, content: code, baseVersion: { exists: false, sha256: null } };
    const child = { id: 'child', projectId: 'project', parentRunId: id, parentAttempt: run.attempt, kind: 'codex-worker', adapter: 'codex', status: 'completed',
      recovery: { phase: 'handed-off' }, workerStorage: { stopConfirmed: true }, workerResult: { ok: true }, patches: [structuredClone(patch)] };
    runs.set(child.id, child); run.patches = [structuredClone(patch)]; run.status = 'completed';
    run.events = [{ type: 'runtime/delegation', runtime: 'codex', phase: 'completed', parentRunId: id, childRunId: child.id, attempt: run.attempt }];
    await options.completed?.({ state, run, child, writeState });
    return { ok: true, runId: options.resultRunId || id };
  };
  return { root, projectRoot, state, input, service, serviceOptions, runs, saves, requests, dispatchOptions, createdRuns, source, writeState, readState };
}

test('grant then calls then producer identity are persisted before the worker; actual C1 code version verifies and cold reread starts nothing', async t => {
  const f = await fixture(t), result = await prepareAutomationCode(f.input), entry = (await f.readState()).session.steps[0].codePreparations[0];
  assert.equal(entry.status, 'completed'); assert.equal(entry.producerRunId, 'producer'); assert.equal(entry.preparationId, result.preparation.id);
  assert.equal(f.saves[0].codePreparations[0].producerRunId, null); assert.equal(result.files[0].content, code);
  const request = f.requests[0]; assert.equal(request.kind, 'research-stage'); assert.equal(request.adapter, 'deepseek'); assert.equal(request.fallback, false);
  assert.deepEqual(request.capabilities, ['project.read', 'patch.propose']); assert.deepEqual(request.limits, { maxTokens: 2048, timeoutMs: 5000, retryLimit: 0, maxConcurrent: 1 });
  assert.match(request.prompt, /delegating.*Codex/); assert.match(request.prompt, /absolute path to a JSON file/); assert.match(request.prompt, /never parse the environment variable itself/);
  const again = await prepareAutomationCode({ ...f.input, service: createCodePreparationService(f.serviceOptions) });
  assert.equal(again.preparation.id, result.preparation.id); assert.equal(f.requests.length, 1); assert.equal((await f.service.list('project')).preparations.length, 1);
  assert.deepEqual(await fs.readdir(f.projectRoot), ['main.tex']); assert.equal(await fs.readFile(path.join(f.projectRoot, 'main.tex'), 'utf8'), 'original manuscript');
});

test('completed producer without a published version reuses its original Run and publishes no new model request', async t => {
  const f = await fixture(t); await prepareAutomationCode(f.input);
  Object.assign(f.state.session.steps[0].codePreparations[0], { preparationId: null, sha256: null, status: 'producing' }); await f.writeState();
  const result = await prepareAutomationCode(f.input); assert.ok(result.preparation.id); assert.equal(f.requests.length, 1);
});

test('prepared original Run is resumed with onPrepared on the same ID, never a replacement producer', async t => {
  const f = await fixture(t); await prepareAutomationCode(f.input);
  Object.assign(f.state.session.steps[0].codePreparations[0], { preparationId: null, sha256: null, status: 'producing' });
  const run = f.source('producer'); run.status = 'created'; run.patches = []; run.events = []; f.runs.delete('child'); await f.writeState();
  const result = await prepareAutomationCode(f.input); assert.equal(result.preparation.source.runId, run.id); assert.equal(f.requests.length, 2); assert.equal(f.runs.size, 2);
});

test('failed or retained producers cannot trigger a new automatic request in another chain attempt', async t => {
  const f = await fixture(t, { failure: true }); await assert.rejects(prepareAutomationCode(f.input), { code: 'HARNESS_WORKER_FAILED' });
  f.state.session.attempt++; await f.writeState();
  await assert.rejects(prepareAutomationCode(f.input), { code: 'AUTOMATION_CODE_RUN_UNRESOLVED' }); assert.equal(f.requests.length, 1);
  f.source('producer').status = 'completed'; f.source('producer').cleanup = { modelSlotRetained: true };
  await assert.rejects(prepareAutomationCode(f.input), { code: 'AUTOMATION_CODE_PRODUCER_CHANGED' }); assert.equal(f.requests.length, 1);
});

test('wrong onPrepared calls linkage, source identity or returned Run cannot create a code preparation', async t => {
  for (const kind of ['calls', 'project', 'result']) {
    const f = await fixture(t, { resultRunId: kind === 'result' ? 'other-result' : undefined,
      beforePrepared: async ({ state, run, writeState }) => { if (kind === 'calls') state.session.steps[0].calls = []; if (kind === 'project') run.projectId = 'other'; await writeState(); } });
    await assert.rejects(prepareAutomationCode(f.input), { code: 'AUTOMATION_CODE_PRODUCER_CHANGED' }); assert.equal((await f.service.list('project')).preparations.length, 0);
  }
});

test('revocation after producer persistence prevents code publication while preserving its original ID', async t => {
  const f = await fixture(t, { completed: async ({ state, writeState }) => { state.policy.overrides.code = 'manual'; state.version++; await writeState(); } });
  await assert.rejects(prepareAutomationCode(f.input), { code: 'AUTOMATION_CODE_DISABLED' });
  assert.equal(f.state.session.steps[0].codePreparations[0].producerRunId, 'producer'); assert.equal((await f.service.list('project')).preparations.length, 0);
});

test('parent cancellation before or during production prevents all code publication', async t => {
  const first = await fixture(t), pre = new AbortController(); pre.abort();
  await assert.rejects(prepareAutomationCode({ ...first.input, signal: pre.signal }), { code: 'AUTOMATION_CODE_CANCELLED' }); assert.equal(first.requests.length, 0);
  const controller = new AbortController(), f = await fixture(t, { afterPrepared: async () => controller.abort() });
  await assert.rejects(prepareAutomationCode({ ...f.input, signal: controller.signal }), { code: 'AUTOMATION_CODE_CANCELLED' });
  assert.equal(f.state.session.steps[0].codePreparations[0].producerRunId, 'producer'); assert.equal((await f.service.list('project')).preparations.length, 0);
});

test('same material cannot change selected paths and exhausted chain version budget cannot create a producer', async t => {
  const f = await fixture(t); await prepareAutomationCode(f.input);
  await assert.rejects(prepareAutomationCode({ ...f.input, paths: ['code/other.py'] }), { code: 'AUTOMATION_CODE_INPUT_CHANGED' });
  f.state.policy.codeScope.maxVersions = 1; f.state.version++; await f.writeState();
  await assert.rejects(prepareAutomationCode({ ...f.input, input: { protocolPath: 'different.json' } }), { code: 'AUTOMATION_CODE_LIMIT' }); assert.equal(f.requests.length, 1);
});

test('real C1 rejects missing completed Codex identity and preparation replay rechecks immutable source contents', async t => {
  const invalid = await fixture(t, { completed: async ({ child }) => { child.workerStorage.stopConfirmed = false; } });
  await assert.rejects(prepareAutomationCode(invalid.input), { code: 'CODE_PREPARATION_HANDOFF_MISMATCH' });
  const f = await fixture(t); await prepareAutomationCode(f.input); f.source('producer').patches[0].content = 'changed after preparation';
  await assert.rejects(prepareAutomationCode(f.input), { code: 'CODE_PREPARATION_HANDOFF_MISMATCH' }); assert.equal(f.requests.length, 1);
});

test('failed producer binding persistence cannot start the simulated worker and does not publish a preparation', async t => {
  const f = await fixture(t), save = f.input.saveStep; let attempts = 0;
  f.input.saveStep = async patch => { if (++attempts === 2) throw new Error('fixed persistence failure'); return save(patch); };
  await assert.rejects(prepareAutomationCode(f.input), /fixed persistence failure/);
  assert.equal(f.source('producer').status, 'created'); assert.equal(f.runs.has('child'), false); assert.equal((await f.service.list('project')).preparations.length, 0);
});

test('helper rejects forged verified producer, file paths or contents even when a service returns them', async t => {
  for (const kind of ['producer', 'paths', 'content']) {
    const f = await fixture(t); await prepareAutomationCode(f.input);
    const service = { verify: async (...args) => {
      const result = await f.service.verify(...args);
      if (kind === 'producer') result.preparation.source.runId = 'another-producer';
      if (kind === 'paths') { result.preparation.files[0].path = 'code/other.py'; result.files[0].path = 'code/other.py'; }
      if (kind === 'content') result.files[0].content = 'wrong verified content';
      return result;
    } };
    await assert.rejects(prepareAutomationCode({ ...f.input, service }), { code: 'AUTOMATION_CODE_VERSION_CHANGED' }); assert.equal(f.requests.length, 1);
  }
});

test('cold recovery verifies an already published preparation before marking its original entry complete', async t => {
  const f = await fixture(t), result = await prepareAutomationCode(f.input);
  f.state.session.steps[0].codePreparations[0].status = 'verifying'; await f.writeState();
  const again = await prepareAutomationCode(f.input); assert.equal(again.preparation.id, result.preparation.id);
  assert.equal(f.state.session.steps[0].codePreparations[0].status, 'completed'); assert.equal(f.requests.length, 1);
});

test('failed unbound grant reconnects only its real created orphan without creating another producer', async t => {
  let interrupted = false;
  const f = await fixture(t, { beforePrepared: async () => { if (!interrupted) { interrupted = true; throw new Error('Crash before producer binding'); } } });
  await assert.rejects(prepareAutomationCode(f.input), /Crash before producer binding/);
  const entry = f.state.session.steps[0].codePreparations[0]; assert.equal(entry.status, 'failed'); assert.equal(entry.producerRunId, null);
  assert.equal(f.source('producer').status, 'created');
  const result = await prepareAutomationCode(f.input); assert.equal(result.preparation.source.runId, 'producer');
  assert.equal(f.dispatchOptions[1].requireExisting, true); assert.deepEqual(f.createdRuns, ['producer']);
});

test('failed unbound grant without its original orphan refuses a fresh producer even on the next attempt', async t => {
  let interrupted = false;
  const f = await fixture(t, { beforePrepared: async () => { if (!interrupted) { interrupted = true; throw new Error('Crash before producer binding'); } } });
  await assert.rejects(prepareAutomationCode(f.input), /Crash before producer binding/);
  f.runs.clear(); f.state.session.steps[0].calls = []; f.state.session.attempt++; await f.writeState();
  await assert.rejects(prepareAutomationCode(f.input), { code: 'AUTOMATION_CODE_RUN_UNRESOLVED' });
  assert.equal(f.dispatchOptions[1].requireExisting, true); assert.deepEqual(f.createdRuns, ['producer']); assert.equal(f.runs.size, 0);
});
