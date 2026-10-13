import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDshExperimentBroker } from '../src/services/harnessRuntime/dshExperimentBroker.js';
import { HarnessRuntimeError } from '../src/services/harnessRuntime/errors.js';
import { ExperimentRunnerError } from '../src/services/experimentRunner/errors.js';

const manifest = { id: 'experiment', projectId: 'project', code: { version: 'git:version', snapshotHash: 'a'.repeat(64) },
  dataset: { id: 'data', version: 'snapshot', evidenceId: 'dataset-evidence' }, environment: { node: 'v22', platform: 'darwin', runner: 'runner/1' },
  command: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: '7' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const args = { runId: 'experiment', expectedManifestSha256: digest(manifest) };
const call = (callId = 'call', input = args) => ({ tool: 'research_run_experiment', callId, arguments: input });
const binding = { parentRunId: 'parent', policyVersion: 'v1', manifestSha256: args.expectedManifestSha256 };
const terminal = overrides => ({ execution: { exitCode: 0, isolation: 'node-permission', startedAt: '2026-10-13', finishedAt: '2026-10-13', process: { pid: null, stopConfirmed: true } },
  status: 'completed', metrics: [{ name: 'accuracy', value: 0.8, unit: '%' }],
  artifacts: [{ id: 'artifact', name: 'metrics', kind: 'metric', path: '.scienceprism/experiment-runs/experiment/artifacts/results.json', sha256: 'b'.repeat(64) }],
  evidence: { runId: 'experiment-evidence', artifactIds: ['artifact-evidence'] }, ...overrides });

async function fixture(t, options = {}) {
  let policy = { projectId: 'project', runId: 'parent', role: 'experimenter', task: 'execute', version: 'v1', active: true, mode: 'auto',
    capabilities: { granted: ['experiment.execute'], allowedPaths: [], networkAllowlist: [] }, ...options.policy };
  let run = { id: 'experiment', projectId: 'project', manifest: structuredClone(manifest), status: 'approved', approval: { decision: 'approve', actor: 'human' }, ...options.run };
  const decisions = [], events = [], reads = [], starts = [], effects = [];
  const f = { setPolicy: patch => { policy = { ...policy, ...patch }; }, setRun: patch => { run = { ...run, ...patch }; },
    policy: () => structuredClone(policy), run: () => structuredClone(run), decisions, events, reads, starts, effects };
  const broker = await createDshExperimentBroker({ readPolicy: async () => structuredClone(policy),
    onDecision: async decision => { decisions.push(decision); await options.onDecision?.(decision, f); }, signal: options.signal,
    emit: event => events.push(event), getRun: async (...input) => { reads.push(input); await options.beforeRead?.(f); return structuredClone(run); },
    start: async (projectId, runId, controls) => {
      starts.push({ projectId, runId, controls });
      if (options.start) return options.start(f, controls);
      f.setRun({ status: 'running', executionBinding: structuredClone(controls.executionBinding) });
      await options.beforeLaunch?.(f); await controls.beforeLaunch(); effects.push('spawn');
      f.setRun(terminal(options.terminal)); return f.run();
    } });
  t.after(() => broker.close()); return { ...f, broker };
}

test('approved fixed experiment uses spawn hook and returns actual artifacts without scientific confirmation', async t => {
  const f = await fixture(t); const result = await f.broker.execute(call());
  assert.equal(f.starts.length, 1); assert.deepEqual(f.starts[0].controls.executionBinding, binding);
  assert.equal(f.starts[0].controls.wait, true); assert.ok(f.starts[0].controls.signal instanceof AbortSignal);
  assert.deepEqual(f.effects, ['spawn']); assert.ok(f.reads.every(input => input[0] === 'project' && input[1] === 'experiment'));
  assert.equal(result.actualRunId, 'experiment'); assert.equal(result.status, 'completed'); assert.equal(result.execution.exitCode, 0);
  assert.equal(result.execution.isolation, 'node-permission'); assert.equal(result.code.snapshotHash, 'a'.repeat(64));
  assert.equal(result.dataset.version, 'snapshot'); assert.equal(result.environment.runner, 'runner/1');
  assert.equal(result.metrics[0].value, 0.8); assert.equal(result.artifacts[0].sha256, 'b'.repeat(64));
  assert.equal(result.evidence.runId, 'experiment-evidence'); assert.equal(result.evidenceConfirmed, false); assert.equal(result.supportsSuccessfulFinding, false);
  assert.equal(f.events[0].type, 'research/experiment'); assert.equal(f.events[0].data.name, call().tool);
  assert.equal(f.events[0].data.callId, 'call'); assert.equal(f.decisions[0].actor, 'system'); assert.equal(f.decisions[0].policyVersion, 'v1');
});

test('strict messages and arguments reject commands, URL, roles, approval and malformed identities', async t => {
  const f = await fixture(t);
  for (const input of [{ ...args, cmd: 'rm -rf' }, { ...args, projectId: 'other' }, { ...args, url: 'https://example.org' },
    { ...args, role: 'owner' }, { ...args, approve: true }, { ...args, execution: {} }, { runId: 'experiment' },
    { ...args, runId: 'bad\0id' }, { ...args, expectedManifestSha256: 'A'.repeat(64) }, []]) {
    await assert.rejects(f.broker.execute(call('invalid', input)), { code: 'DSH_ARGUMENTS_INVALID' });
  }
  for (const message of [{ ...call(), tool: 'run_shell' }, { ...call(), callId: 'bad\n' }, { ...call(), method: 'tools/call' }, { ...call(), callId: '' }]) {
    await assert.rejects(f.broker.execute(message), { code: 'DSH_ARGUMENTS_INVALID' });
  }
  assert.equal(f.starts.length, 0); assert.equal(f.reads.length, 0);
});

test('initial and current owner, activity, automatic mode and capability ceilings remain enforced', async t => {
  for (const patch of [{ projectId: 'other' }, { runId: 'other' }, { task: 'other' }, { role: 'other' }, { active: false }, { mode: 'manual' },
    { capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } }]) {
    const f = await fixture(t); f.setPolicy(patch);
    await assert.rejects(f.broker.execute(call()), error => ['DSH_OWNER_CHANGED', 'DSH_RUN_INACTIVE', 'DSH_APPROVAL_UNAVAILABLE', 'CAPABILITY_DENIED'].includes(error.code));
    assert.equal(f.starts.length, 0); assert.equal(f.decisions.at(-1).decision, 'deny');
  }
  const f = await fixture(t, { policy: { capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } } });
  f.setPolicy({ capabilities: { granted: ['experiment.execute'], allowedPaths: [], networkAllowlist: [] } });
  await assert.rejects(f.broker.execute(call()), { code: 'CAPABILITY_DENIED' }); assert.equal(f.starts.length, 0);
});

test('audit persistence failure or revocation during allow stops before starting any experiment', async t => {
  const broken = await fixture(t, { onDecision: async () => { throw new Error('secret-audit'); } });
  await assert.rejects(broken.broker.execute(call()), error => error.code === 'DSH_AUDIT_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(broken.starts.length, 0);
  for (const patch of [{ version: 'v2' }, { capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } }]) {
    const f = await fixture(t, { onDecision: async (decision, target) => { if (decision.decision === 'allow') target.setPolicy(patch); } });
    await assert.rejects(f.broker.execute(call()), error => ['DSH_POLICY_CHANGED', 'CAPABILITY_DENIED'].includes(error.code));
    assert.equal(f.starts.length, 0); assert.equal(f.reads.length, 0);
  }
});

test('manifest identity, project and exact hash must match before start', async t => {
  for (const patch of [{ projectId: 'other' }, { id: 'other' }, { manifest: { ...manifest, projectId: 'other' } },
    { manifest: { ...manifest, seed: '8' } }]) {
    const f = await fixture(t, { run: patch });
    await assert.rejects(f.broker.execute(call()), error => ['EXPERIMENT_MANIFEST_CHANGED', 'DSH_EXPERIMENT_RESULT_INVALID'].includes(error.code));
    assert.equal(f.starts.length, 0);
  }
});

test('model cannot approve an awaiting, rejected, failed, cancelled or running experiment', async t => {
  for (const status of ['awaiting_approval', 'rejected', 'failed', 'cancelled', 'running']) {
    const f = await fixture(t, { run: { status } });
    await assert.rejects(f.broker.execute(call()), { code: 'EXPERIMENT_APPROVAL_REQUIRED' }); assert.equal(f.starts.length, 0);
  }
  const f = await fixture(t, { run: { approval: null } });
  await assert.rejects(f.broker.execute(call()), { code: 'EXPERIMENT_APPROVAL_REQUIRED' }); assert.equal(f.starts.length, 0);
});

test('completed records are read without restart only for the same parent and manifest binding', async t => {
  const f = await fixture(t, { run: { ...terminal(), executionBinding: { ...binding, policyVersion: 'older' } } });
  assert.equal((await f.broker.execute(call())).status, 'completed'); assert.equal(f.starts.length, 0);
  for (const executionBinding of [null, { ...binding, parentRunId: 'other' }, { ...binding, manifestSha256: 'f'.repeat(64) }, { ...binding, unexpected: true }]) {
    const other = await fixture(t, { run: { ...terminal(), executionBinding } });
    await assert.rejects(other.broker.execute(call()), { code: 'EXPERIMENT_OWNER_CHANGED' }); assert.equal(other.starts.length, 0);
  }
  const other = await fixture(t, { run: { executionBinding: { ...binding, parentRunId: 'other' } } });
  await assert.rejects(other.broker.execute(call()), { code: 'EXPERIMENT_OWNER_CHANGED' }); assert.equal(other.starts.length, 0);
});

test('spawn hook rechecks policy, fixed manifest, existing approval and exact running owner binding', async t => {
  for (const mutation of ['policy', 'manifest', 'owner', 'approval', 'status']) {
    const f = await fixture(t, { beforeLaunch: target => {
      if (mutation === 'policy') target.setPolicy({ version: 'v2' });
      if (mutation === 'manifest') target.setRun({ manifest: { ...manifest, seed: '9' } });
      if (mutation === 'owner') target.setRun({ executionBinding: { ...binding, parentRunId: 'other' } });
      if (mutation === 'approval') target.setRun({ approval: { decision: 'reject' } });
      if (mutation === 'status') target.setRun({ status: 'approved' });
    } });
    await assert.rejects(f.broker.execute(call()), error => ['DSH_POLICY_CHANGED', 'EXPERIMENT_MANIFEST_CHANGED', 'EXPERIMENT_OWNER_CHANGED'].includes(error.code));
    assert.deepEqual(f.effects, []); assert.equal(f.events.length, 0);
  }
});

test('same identity shares in-flight work, conflicts reject and cross-call repeats never start twice', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeLaunch: async () => { entered(); await gate; } });
  const first = f.broker.execute(call()), repeated = f.broker.execute(call('call', { expectedManifestSha256: args.expectedManifestSha256, runId: args.runId }));
  const second = f.broker.execute(call('another'));
  await assert.rejects(f.broker.execute(call('call', { ...args, expectedManifestSha256: 'f'.repeat(64) })), { code: 'DSH_CALL_CONFLICT' });
  await ready; release(); assert.deepEqual(await first, await repeated); assert.deepEqual(await first, await second);
  assert.equal(f.starts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.events.length, 2);
  const copy = await f.broker.execute(call()); copy.metrics[0].value = 99;
  assert.equal((await f.broker.execute(call())).metrics[0].value, 0.8);
  f.setRun({ executionBinding: { ...binding, parentRunId: 'other' } });
  await assert.rejects(f.broker.execute(call()), { code: 'EXPERIMENT_OWNER_CHANGED' });
  f.setRun({ executionBinding: binding });
  f.setPolicy({ version: 'v2' }); await assert.rejects(f.broker.execute(call()), { code: 'DSH_POLICY_CHANGED' });
});

test('runner archival of pre-launch failures retains the typed policy denial and zero process starts', async t => {
  const f = await fixture(t, { start: async (target, controls) => {
    target.setRun({ status: 'running', executionBinding: controls.executionBinding });
    target.setPolicy({ capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } });
    try { await controls.beforeLaunch(); target.effects.push('spawn'); }
    catch { target.setRun({ status: 'failed', execution: { exitCode: null }, error: { code: 'EXPERIMENT_FAILED' } }); }
    return target.run();
  } });
  await assert.rejects(f.broker.execute(call()), { code: 'CAPABILITY_DENIED' });
  assert.equal(f.run().status, 'failed'); assert.deepEqual(f.effects, []); assert.equal(f.events.length, 0);
});

test('cross-call cannot retry a failed attempt even if storage stayed approved', async t => {
  const f = await fixture(t, { start: async () => { throw new ExperimentRunnerError(503, 'EXPERIMENT_SANDBOX_UNAVAILABLE', 'secret-path'); } });
  await assert.rejects(f.broker.execute(call()), { code: 'EXPERIMENT_SANDBOX_UNAVAILABLE' });
  await assert.rejects(f.broker.execute(call('another')), { code: 'DSH_EXPERIMENT_ALREADY_REQUESTED' });
  assert.equal(f.starts.length, 1);
});

test('nonzero execution returns actual failed process results with sanitized error metadata', async t => {
  const f = await fixture(t, { terminal: { status: 'failed', execution: { exitCode: 7, isolation: 'node-permission', process: { pid: null, stopConfirmed: true } },
    error: { code: 'EXPERIMENT_EXIT_NONZERO', message: 'Bearer private-secret', retryable: true }, logs: { stdout: 'private-secret' } } });
  const result = await f.broker.execute(call()); assert.equal(result.status, 'failed'); assert.equal(result.execution.exitCode, 7);
  assert.equal(result.error.code, 'EXPERIMENT_EXIT_NONZERO'); assert.equal(JSON.stringify(result).includes('private-secret'), false);
  await assert.rejects(f.broker.execute(call('another')), { code: 'EXPERIMENT_APPROVAL_REQUIRED' }); assert.equal(f.starts.length, 1);
});

test('fixed experiment files outside the current path scope never start', async t => {
  const f = await fixture(t, { policy: { capabilities: { granted: ['experiment.execute'], allowedPaths: ['other.mjs'], networkAllowlist: [] } } });
  await assert.rejects(f.broker.execute(call()), { code: 'PATH_DENIED' }); assert.equal(f.starts.length, 0);
});

test('completed records without confirmed process stop cannot be reused', async t => {
  const f = await fixture(t, { run: { ...terminal(), executionBinding: binding, execution: { exitCode: 0, process: { pid: null, stopConfirmed: false } } } });
  await assert.rejects(f.broker.execute(call()), { code: 'EXPERIMENT_STOP_UNCONFIRMED' }); assert.equal(f.starts.length, 0);
});

test('close aborts active execution and drains queued calls without another start', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { start: async (_target, controls) => { entered(); await new Promise((resolve, reject) => controls.signal.addEventListener('abort', () => reject(new Error('cancelled-secret')), { once: true })); } });
  const first = assert.rejects(f.broker.execute(call()), { code: 'DSH_CANCELLED' });
  const queued = assert.rejects(f.broker.execute(call('queued')), { code: 'DSH_CANCELLED' });
  await ready; await f.broker.close(); await first; await queued; assert.equal(f.starts.length, 1); assert.equal(f.events.length, 0);
  await assert.rejects(f.broker.execute(call('late')), { code: 'DSH_CANCELLED' });
});

test('external cancellation and late policy drift prevent delivering stale terminal results', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal, terminal: {}, start: async (target, controls) => {
    target.setRun({ ...terminal(), executionBinding: controls.executionBinding }); controller.abort(); return target.run();
  } });
  await assert.rejects(f.broker.execute(call()), { code: 'DSH_CANCELLED' }); assert.equal(f.events.length, 0);
  const changed = await fixture(t, { start: async (target, controls) => { target.setRun({ ...terminal(), executionBinding: controls.executionBinding }); target.setPolicy({ version: 'v2' }); return target.run(); } });
  await assert.rejects(changed.broker.execute(call()), { code: 'DSH_POLICY_CHANGED' }); assert.equal(changed.events.length, 0);
});

test('32 identity limit retains previous outcomes and output summaries remain bounded', async t => {
  const f = await fixture(t, { run: { ...terminal({ metrics: Array.from({ length: 300 }, () => ({ name: '论'.repeat(10000), value: '\u0001'.repeat(10000) })),
    artifacts: Array.from({ length: 200 }, () => ({ id: 'id', path: '\u0001'.repeat(10000), sha256: 'b'.repeat(64) })) }), executionBinding: binding } });
  const result = await f.broker.execute(call('large')); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
  assert.equal(result.truncated, true); assert.equal(result.id, 'experiment'); assert.equal(result.metrics[0].name.isWellFormed(), true);
  f.setRun({ ...terminal(), executionBinding: binding });
  for (let index = 0; index < 31; index++) await f.broker.execute(call(`call-${index}`));
  await assert.rejects(f.broker.execute(call('call-33')), { code: 'DSH_EXPERIMENT_LIMIT' });
  assert.equal((await f.broker.execute(call('call-0'))).status, 'completed'); assert.equal(f.starts.length, 0);
});

test('arbitrary and typed failures never expose upstream error messages', async t => {
  for (const error of [new Error('Bearer private-secret'), new HarnessRuntimeError(409, 'CUSTOM_DENY', 'private-secret'), new ExperimentRunnerError(409, 'EXPERIMENT_CODE_CHANGED', 'private-secret')]) {
    const f = await fixture(t, { start: async () => { throw error; } });
    await assert.rejects(f.broker.execute(call()), reason => reason instanceof HarnessRuntimeError && !reason.message.includes('private-secret')
      && reason.code === (error.code || 'DSH_EXPERIMENT_FAILED'));
  }
});
