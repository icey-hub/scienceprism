import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

await mkdir(path.join(process.cwd(), '.cache'), { recursive: true });
const dataDir = await mkdtemp(path.join(process.cwd(), '.cache', 'constraint-policy-runtime-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { createHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { createExperimentRun, decideExperimentRun, startExperimentRun } = await import('../src/services/experimentRunner/index.js');
const { getProjectFeatureFlags } = await import('../src/services/featureFlags.js');
const { setConstraintEnabled } = await import('../src/services/constraintRegistry/index.js');
const { registerConstraintPolicyRoutes } = await import('../src/routes/constraintPolicy.js');

async function project(id, constraints = {}) {
  const root = path.join(dataDir, id);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  await writeFile(path.join(root, 'main.tex'), 'test\n');
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), `${JSON.stringify(constraints)}\n`);
  return root;
}

test('C-10 switch changes the next Harness Run budget and records the decision', async () => {
  const id = 'runtime-budget';
  const root = await project(id, { timeoutMs: 1000, maxTokens: 123 });
  const before = await createHarnessRun(id, { adapter: 'fake', capabilities: ['project.read'] });
  assert.equal(before.limits.timeoutMs, 1000);
  assert.equal(before.limits.maxTokens, 123);
  const policy = await setConstraintEnabled(id, 'C-10', false, { actor: 'human' });
  assert.equal(policy.constraints.find((item) => item.id === 'C-10').enabled, false);
  assert.deepEqual(policy.audit.map((item) => item.action), ['disable']);
  const after = await createHarnessRun(id, { adapter: 'fake', capabilities: ['project.read'] });
  assert.equal(after.limits.timeoutMs, 24 * 60 * 60 * 1000);
  assert.equal(after.limits.maxTokens, 1_000_000);
  assert.equal(before.limits.timeoutMs, 1000, 'an existing Run keeps its recorded budget');
  await setConstraintEnabled(id, 'C-10', true, { actor: 'human' });
  const restored = await createHarnessRun(id, { adapter: 'fake', capabilities: ['project.read'] });
  assert.equal(restored.limits.timeoutMs, 1000);
  const stored = JSON.parse(await readFile(path.join(root, '.scienceprism', 'constraint-policy.json'), 'utf8'));
  assert.deepEqual(stored.audit.map((item) => item.action), ['disable', 'enable']);
});

test('C-16 switch removes only the project rollout override', async () => {
  const id = 'runtime-rollout';
  await project(id, { featureFlags: { advancedHarness: false, experimentExecution: false } });
  assert.deepEqual(await getProjectFeatureFlags(id), { advancedHarness: false, experimentExecution: false });
  await setConstraintEnabled(id, 'C-16', false, { actor: 'human' });
  assert.deepEqual(await getProjectFeatureFlags(id), { advancedHarness: true, experimentExecution: true });
  await setConstraintEnabled(id, 'C-16', true, { actor: 'human' });
  assert.deepEqual(await getProjectFeatureFlags(id), { advancedHarness: false, experimentExecution: false });
});

test('C-16 switch changes the Experiment execution gate without removing approval', async () => {
  const id = 'runtime-experiment';
  const root = await project(id, { capabilities: ['project.read', 'experiment.execute'], featureFlags: { experimentExecution: false } });
  await writeFile(path.join(root, 'run.mjs'), 'console.log("controlled fixture");\n');
  const run = await createExperimentRun(id, { plan: {
    planId: 'policy-plan', dataset: { id: 'fixture', version: 'v1' }, protocol: 'Run a controlled fixture.',
    codeVersion: 'fixture-v1', execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] },
    parameters: {}, seed: 1, successCriteria: ['process exits successfully'], artifacts: []
  } });
  await assert.rejects(() => startExperimentRun(id, run.id, { wait: true }), { code: 'EXPERIMENT_APPROVAL_REQUIRED' });
  await decideExperimentRun(id, run.id, { decision: 'approve', actor: 'human' });
  await assert.rejects(() => startExperimentRun(id, run.id, { wait: true }), { code: 'FEATURE_FLAG_DISABLED' });
  await setConstraintEnabled(id, 'C-16', false, { actor: 'human' });
  const result = await startExperimentRun(id, run.id, { wait: true });
  assert.equal(result.status, 'completed');
});

test('the decision route exposes state and refuses AI or core disabling', async () => {
  const id = 'policy-route';
  await project(id);
  const app = Fastify();
  registerConstraintPolicyRoutes(app);
  const base = `/api/projects/${id}/constraint-policy`;
  const initial = (await app.inject({ method: 'GET', url: base })).json().policy;
  assert.equal(initial.constraints.find((item) => item.id === 'C-10').enabled, true);
  const ai = await app.inject({ method: 'POST', url: `${base}/C-10/decision`, payload: { actor: 'ai', enabled: false } });
  assert.equal(ai.statusCode, 403);
  const core = await app.inject({ method: 'POST', url: `${base}/C-08/decision`, payload: { actor: 'human', enabled: false } });
  assert.equal(core.statusCode, 403);
  assert.equal(core.json().error.code, 'CORE_CONSTRAINT_IMMUTABLE');
  const disabled = await app.inject({ method: 'POST', url: `${base}/C-10/decision`, payload: { actor: 'human', enabled: false } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().policy.constraints.find((item) => item.id === 'C-10').enabled, false);
  await app.close();
});
