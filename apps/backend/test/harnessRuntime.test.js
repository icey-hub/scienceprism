import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
  cancelHarnessRun,
  createHarnessRun,
  getHarnessRun,
  listHarnessRuns,
  pauseHarnessRun,
  replayHarnessRun,
  resumeHarnessRun,
  runHarnessRequest,
  startHarnessRun,
  waitForHarnessRun
} = await import('../src/services/harnessRuntime/index.js');
const { buildContextPack, estimateTokens } = await import('../src/services/harnessRuntime/contextPackager.js');
const { assertCapability, resolveCapabilityPolicy } = await import('../src/services/harnessRuntime/capabilities.js');

async function createProject(id) {
  const root = path.join(dataDir, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  await writeFile(path.join(root, 'main.tex'), 'old\n');
  return root;
}

test('Fake Adapter persists a completed Run, events, context hash, Patch, and human decision state', async () => {
  const projectId = 'harness-fake';
  await createProject(projectId);
  const result = await runHarnessRequest({
    projectId,
    adapter: 'fake',
    stage: 'writing',
    task: 'test',
    prompt: 'return a deterministic result',
    capabilities: ['project.read', 'patch.propose'],
    fakeResponse: '{"ok":true}',
    fakePatches: [{ path: 'main.tex', original: 'old\n', content: 'new\n', diff: 'diff' }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'fake');
  const run = await getHarnessRun(projectId, result.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.contextHash.length, 64);
  assert.equal(run.patches[0].path, 'main.tex');
  assert.equal(run.humanDecision.status, 'pending');
  assert.ok(run.events.some((event) => event.type === 'assistant/message'));
  assert.equal((await listHarnessRuns(projectId)).length, 1);
});

test('paused Runs can resume and cancelled Runs remain terminal', async () => {
  const projectId = 'harness-controls';
  await createProject(projectId);
  const run = await createHarnessRun(projectId, {
    adapter: 'fake',
    task: 'pause me',
    fakeDelayMs: 250,
    fakeResponse: 'resumed'
  });
  await startHarnessRun(projectId, run.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await pauseHarnessRun(projectId, run.id);
  const paused = await waitForHarnessRun(projectId, run.id);
  assert.equal(paused.status, 'paused');

  const resumed = await resumeHarnessRun(projectId, run.id, { wait: true, request: { fakeDelayMs: 0 } });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.reply, 'resumed');

  const cancelled = await createHarnessRun(projectId, { adapter: 'fake', fakeDelayMs: 250 });
  await startHarnessRun(projectId, cancelled.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelledResult = await cancelHarnessRun(projectId, cancelled.id);
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal((await getHarnessRun(projectId, cancelled.id)).status, 'cancelled');
});

test('replay creates a new Run and denied capabilities do not become grants', async () => {
  const projectId = 'harness-replay';
  await createProject(projectId);
  const original = await runHarnessRequest({ projectId, adapter: 'fake', fakeResponse: 'original' });
  const replay = await replayHarnessRun(projectId, original.runId, {
    request: { fakeResponse: 'replayed' },
    start: true
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.reply, 'replayed');
  assert.equal(replay.replayOf, original.runId);
  assert.equal((await listHarnessRuns(projectId)).length, 2);

  const policy = resolveCapabilityPolicy({
    requested: ['project.read', 'experiment.execute'],
    configured: ['project.read']
  });
  assert.deepEqual(policy.granted, ['project.read']);
  assert.deepEqual(policy.denied, ['experiment.execute']);
  assert.throws(() => assertCapability(policy, 'experiment.execute'), (error) => error.code === 'CAPABILITY_DENIED');
});

test('a capability requested outside Project Constraints is recorded as a failed Run', async () => {
  const projectId = 'harness-denied';
  await createProject(projectId);
  const result = await runHarnessRequest({
    projectId,
    adapter: 'fake',
    capabilities: ['project.read', 'experiment.execute'],
    fakeResponse: 'should not execute'
  });
  assert.equal(result.ok, false);
  const run = await getHarnessRun(projectId, result.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'CAPABILITY_DENIED');
  assert.deepEqual(run.capabilities.granted, ['project.read']);
});

test('Context Packager applies file priority, budget, sensitive filtering, and explicit uncertainty warnings', async () => {
  const projectId = 'harness-context-pack';
  const root = await createProject(projectId);
  await mkdir(path.join(root, 'sections'), { recursive: true });
  await writeFile(path.join(root, 'sections', 'method.tex'), 'Method section content.\n'.repeat(80));
  await writeFile(path.join(root, '.env'), 'SHOULD_NOT_BE_INCLUDED=secret\n');
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'research-workflow.json'), JSON.stringify({ version: 3, audit: [] }));

  const request = {
    stage: 'writing',
    task: 'build writing brief',
    activePath: 'sections/method.tex',
    contextFiles: [{ path: 'main.tex', hash: 'stale-file-hash' }],
    prompt: 'Use only confirmed evidence.',
    humanInstructions: 'Keep uncertain claims visible.',
    confirmedEvidence: [
      { id: 'e1', kind: 'paper', summary: 'Version one', version: 'v1' },
      { id: 'e1', kind: 'paper', summary: 'Version two', version: 'v2' }
    ],
    requiredEvidenceIds: ['e1', 'missing-evidence'],
    expectedContextHash: 'stale-context-hash'
  };
  const options = {
    projectId,
    request,
    policy: { granted: ['project.read'], allowedPaths: [] },
    constraints: { contextTokenBudget: 500 }
  };
  const pack = await buildContextPack(options);
  const repeat = await buildContextPack(options);
  const codes = new Set(pack.warnings.map((warning) => warning.code));

  assert.equal(pack.contextHash.length, 64);
  assert.equal(pack.contextHash, repeat.contextHash);
  assert.ok(pack.files.some((file) => file.path === 'sections/method.tex'));
  assert.ok(!pack.files.some((file) => file.path === '.env'));
  assert.ok(pack.files.find((file) => file.path === 'sections/method.tex').truncated);
  assert.ok(estimateTokens(pack) <= pack.budget.maxTokens);
  assert.ok(codes.has('STALE_CONTEXT'));
  assert.ok(codes.has('CONFLICTING_EVIDENCE_VERSIONS'));
  assert.ok(codes.has('MISSING_EVIDENCE'));

  const run = await createHarnessRun(projectId, {
    adapter: 'fake',
    stage: 'writing',
    activePath: 'sections/method.tex',
    prompt: 'persist the context manifest',
    contextTokenBudget: 500
  });
  assert.equal(run.contextHash, run.contextPack.contextHash);
  assert.equal(run.contextManifest.contextHash, run.contextHash);
  assert.ok(run.contextManifest.files.some((file) => file.path === 'sections/method.tex'));
});
