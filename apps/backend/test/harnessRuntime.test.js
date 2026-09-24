import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
  applyHarnessRunPatches,
  cancelHarnessRun,
  copyWorkspace,
  createHarnessRun,
  decideHarnessRun,
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
const { buildInput, childEnvironment } = await import('../src/services/harnessRuntime/adapters/deepseekAdapter.js');
const { PROJECT_CONSTRAINT_LIMITS } = await import('../src/config/projectConstraintDefaults.js');

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

test('DeepSeek runs fail closed when granted capabilities cannot be enforced before tool use', async () => {
  const projectId = 'harness-deepseek-unenforceable';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({
    capabilities: ['project.read', 'experiment.execute'],
    featureFlags: { advancedHarness: true }
  }));
  const run = await createHarnessRun(projectId, {
    adapter: 'deepseek',
    capabilities: ['project.read', 'experiment.execute'],
    fallback: false
  });

  const result = await startHarnessRun(projectId, run.id, { wait: true });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CAPABILITY_POLICY_UNENFORCEABLE');
  assert.deepEqual(result.capabilities.granted, ['project.read', 'experiment.execute']);
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

test('Harness workspace physically contains only allowed project paths', async () => {
  const projectId = 'harness-allowed-paths';
  const root = await createProject(projectId);
  await mkdir(path.join(root, 'sections'), { recursive: true });
  await writeFile(path.join(root, 'sections', 'allowed.tex'), 'allowed\n');
  await writeFile(path.join(root, 'sections', 'denied.tex'), 'denied\n');
  await writeFile(path.join(root, 'outside.tex'), 'outside\n');
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-workspace-'));

  await copyWorkspace(root, workspace, { allowedPaths: ['sections/allowed.tex'] });

  assert.equal(await readFile(path.join(workspace, 'sections', 'allowed.tex'), 'utf8'), 'allowed\n');
  await assert.rejects(() => access(path.join(workspace, 'sections', 'denied.tex')), (error) => error.code === 'ENOENT');
  await assert.rejects(() => access(path.join(workspace, 'outside.tex')), (error) => error.code === 'ENOENT');

  const invalidWorkspace = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-invalid-scope-'));
  await copyWorkspace(root, invalidWorkspace, { allowedPaths: ['../outside'] });
  await assert.rejects(() => access(path.join(invalidWorkspace, 'main.tex')), (error) => error.code === 'ENOENT');
});

test('DeepSeek Adapter prompt and child environment retain policy without leaking parent secrets', () => {
  process.env.SCIENCEPRISM_TEST_SECRET = 'must-not-leak';
  const policy = {
    granted: ['project.read', 'patch.propose'],
    allowedPaths: ['sections/method.tex'],
    networkAllowlist: ['export.arxiv.org']
  };
  const prompt = buildInput({ task: 'polish', prompt: 'Review this section.' }, policy);
  const env = childEnvironment({ apiKey: 'provider-key', baseUrl: 'https://api.example.test', dshHome: '/tmp/dsh-home' });

  assert.match(prompt, /Allowed project paths: sections\/method\.tex/);
  assert.match(prompt, /Allowed network hosts: export\.arxiv\.org/);
  assert.equal(env.HOME, '/tmp/dsh-home');
  assert.equal(env.DEEPSEEK_API_KEY, 'provider-key');
  assert.equal(env.SCIENCEPRISM_TEST_SECRET, undefined);
  delete process.env.SCIENCEPRISM_TEST_SECRET;
});

test('Harness Run limits fall back to the shared constraint defaults', async () => {
  const projectId = 'harness-limits-default';
  await createProject(projectId);

  const run = await createHarnessRun(projectId, { adapter: 'fake', task: 'limits' });

  assert.equal(run.limits.timeoutMs, PROJECT_CONSTRAINT_LIMITS.timeoutMs);
  assert.equal(run.limits.maxTokens, PROJECT_CONSTRAINT_LIMITS.maxTokens);
  assert.equal(run.limits.maxConcurrent, PROJECT_CONSTRAINT_LIMITS.maxConcurrent);
  assert.equal(run.limits.retryLimit, PROJECT_CONSTRAINT_LIMITS.retryLimit);
});

test('every real Harness adapter is rollout-gated, not only the DeepSeek one', async () => {
  const projectId = 'harness-adapter-gate';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(
    path.join(root, '.scienceprism', 'project-constraints.json'),
    JSON.stringify({ featureFlags: { advancedHarness: false } })
  );

  await assert.rejects(
    () => createHarnessRun(projectId, { adapter: 'legacy', task: 'gated' }),
    (error) => error.code === 'FEATURE_FLAG_DISABLED'
  );

  // The in-process fake adapter stays available so the suite can run without the flag.
  const exempt = await createHarnessRun(projectId, { adapter: 'fake', task: 'exempt' });
  assert.equal(exempt.adapter, 'fake');
});

test('a named role narrows the Run capabilities and is recorded on the Run', async () => {
  const projectId = 'harness-role-narrow';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(
    path.join(root, '.scienceprism', 'project-constraints.json'),
    JSON.stringify({ capabilities: ['project.read', 'patch.propose', 'research.search'] })
  );

  const run = await createHarnessRun(projectId, { adapter: 'fake', role: 'paper-reviewer', task: 'review' });

  assert.equal(run.role, 'paper-reviewer');
  assert.equal(run.roleAuthority, 'suggest-only');
  assert.deepEqual(run.capabilities.granted, ['project.read'], 'a read-only role must not keep patch.propose');
  assert.ok(run.capabilities.denied.includes('patch.propose'), 'the removal must be visible, not silent');
});

test('an unknown role fails closed instead of running unconstrained', async () => {
  const projectId = 'harness-role-unknown';
  await createProject(projectId);

  await assert.rejects(
    () => createHarnessRun(projectId, { adapter: 'fake', role: 'no-such-role' }),
    (error) => error.code === 'UNKNOWN_ROLE'
  );
});

test('a Run without a role keeps the Project grant unchanged', async () => {
  const projectId = 'harness-role-absent';
  await createProject(projectId);

  const run = await createHarnessRun(projectId, { adapter: 'fake' });

  assert.equal(run.role, null);
  assert.equal(run.roleAuthority, null);
  assert.deepEqual(run.capabilities.granted, ['project.read', 'patch.propose']);
});

async function acceptedRunWithPatch(projectId, { path: relativePath = 'main.tex', content = 'new\n', original = 'old\n' } = {}) {
  const result = await runHarnessRequest({
    projectId,
    adapter: 'fake',
    stage: 'writing',
    task: 'apply',
    capabilities: ['project.read', 'patch.propose'],
    fakePatches: [{ path: relativePath, original, content, diff: 'diff' }]
  });
  await decideHarnessRun(projectId, result.runId, { decision: 'accept', actor: 'researcher' });
  return result.runId;
}

test('a Run no human has accepted cannot have its Patches applied', async () => {
  const projectId = 'harness-apply-pending';
  const root = await createProject(projectId);
  const result = await runHarnessRequest({
    projectId,
    adapter: 'fake',
    task: 'apply',
    capabilities: ['project.read', 'patch.propose'],
    fakePatches: [{ path: 'main.tex', original: 'old\n', content: 'new\n', diff: 'diff' }]
  });

  await assert.rejects(
    () => applyHarnessRunPatches(projectId, result.runId, {}),
    (error) => error.code === 'PATCH_APPLICATION_REQUIRES_ACCEPTANCE'
  );
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n', 'the project must stay untouched');
});

test('an accepted Run applies its Patches to the project exactly once', async () => {
  const projectId = 'harness-apply-accepted';
  const root = await createProject(projectId);
  const runId = await acceptedRunWithPatch(projectId);

  const applied = await applyHarnessRunPatches(projectId, runId, { actor: 'researcher' });

  assert.deepEqual(applied.applied, ['main.tex']);
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'new\n');
  assert.deepEqual(applied.run.appliedPatches, ['main.tex']);
  assert.ok(applied.run.events.some((event) => event.type === 'patches.applied'));

  // Applying twice must refuse rather than write the same Patch again.
  await assert.rejects(
    () => applyHarnessRunPatches(projectId, runId, {}),
    (error) => error.code === 'NO_PATCHES_TO_APPLY'
  );
});

test('the apply step re-checks the current policy, not the policy at Run creation', async () => {
  const projectId = 'harness-apply-recheck';
  const root = await createProject(projectId);
  await mkdir(path.join(root, 'sections'), { recursive: true });
  await writeFile(path.join(root, 'sections', 'method.tex'), 'old\n');
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  const constraintsPath = path.join(root, '.scienceprism', 'project-constraints.json');
  await writeFile(constraintsPath, JSON.stringify({ capabilities: ['project.read', 'patch.propose'], allowedPaths: ['sections'] }));

  const runId = await acceptedRunWithPatch(projectId, { path: 'sections/method.tex' });

  // The project narrows its allowed paths after the Run was created.
  await writeFile(constraintsPath, JSON.stringify({ capabilities: ['project.read', 'patch.propose'], allowedPaths: ['other'] }));

  await assert.rejects(
    () => applyHarnessRunPatches(projectId, runId, {}),
    (error) => error.code === 'PATH_DENIED'
  );
  assert.equal(await readFile(path.join(root, 'sections', 'method.tex'), 'utf8'), 'old\n');
});

test('a Run whose Patches a human rejected cannot be applied', async () => {
  const projectId = 'harness-apply-rejected';
  const root = await createProject(projectId);
  const result = await runHarnessRequest({
    projectId,
    adapter: 'fake',
    task: 'apply',
    capabilities: ['project.read', 'patch.propose'],
    fakePatches: [{ path: 'main.tex', original: 'old\n', content: 'new\n', diff: 'diff' }]
  });
  await decideHarnessRun(projectId, result.runId, { decision: 'reject', actor: 'researcher' });

  await assert.rejects(
    () => applyHarnessRunPatches(projectId, result.runId, {}),
    (error) => error.code === 'PATCH_APPLICATION_REQUIRES_ACCEPTANCE'
  );
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
});
