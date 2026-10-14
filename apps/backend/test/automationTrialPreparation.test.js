import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prepareAutomationTrial } from '../src/services/researchAutomation/trialPreparation.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';
import { experimentManifestHash } from '../src/services/experimentRunner/manifest.js';

const clone = value => structuredClone(value);
const failure = code => Object.assign(new Error(code), { code });

// The adapter below represents the controlled Runner boundary, not a model or
// an actual experiment. Both ledgers survive new helper invocations on disk.
async function fixture(t, options = {}) {
  const cache = path.resolve('.cache/automation-trial-preparation-tests');
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'automation.json'), runsFile = path.join(root, 'runner.json');
  const state = { version: 4, policy: { enabled: true, overrides: { execution: 'auto' } },
    session: { id: 'session', coordinatorRunId: 'coordinator', workflowId: 'workflow', currentStage: 'replication',
      status: 'running', stopRequested: false, steps: [{ stage: 'replication', handoff: { source: 'original-fixed-sources' } }] } };
  const plan = { dataset: 'dataset-fixed', datasetVersion: 'a'.repeat(64), protocol: 'fixed scientific protocol',
    execution: { adapter: 'node', entrypoint: 'experiments/baseline.mjs', args: [], codePreparationId: `code-preparation-${'b'.repeat(64)}` },
    seed: 0, successCriteria: ['retain actual output'], parameters: { split: 'fixed' }, codePaths: ['experiments/baseline.mjs'],
    resources: { timeoutMs: 1000 }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] };
  const writeState = value => fs.writeFile(stateFile, JSON.stringify(value));
  const readState = async () => JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const readRuns = async () => JSON.parse(await fs.readFile(runsFile, 'utf8'));
  const writeRuns = value => fs.writeFile(runsFile, JSON.stringify(value));
  await writeState(state); await writeRuns([]);
  const changes = [], calls = { grant: 0, create: 0, approve: 0, execute: 0, launched: 0 }, active = [], bindings = [];
  const mutateState = async mutate => { const value = await readState(); await mutate(value); await writeState(value); };
  const updateRun = async (id, mutate) => { const runs = await readRuns(), run = runs.find(item => item.id === id); assert.ok(run); await mutate(run); await writeRuns(runs); return clone(run); };
  const assertRun = async (_projectId, manifest, { executionBinding } = {}) => {
    const current = await readState(), step = current.session.steps[0];
    if (current.policy.overrides.execution === 'manual') throw failure('EXECUTION_REVOKED');
    if (current.session.stopRequested) throw failure('AUTOMATION_STOPPED');
    const entry = step.codeTrials?.find(item => sourceHash(item.authorization) === sourceHash(manifest.trial.authorization));
    if (!entry || sourceHash(entry.plan) !== sourceHash(manifest.trial.plan)) throw failure('TRIAL_GRANT_CHANGED');
    assert.equal(manifest.purpose, 'engineering-trial');
    assert.equal(manifest.command.entrypoint, entry.plan.execution.entrypoint);
    if (executionBinding) assert.equal(executionBinding.manifestSha256, experimentManifestHash(manifest));
  };
  const input = { projectId: 'project', session: clone(state.session), stage: 'replication', plan, readState,
    beforeEffect: async () => {}, signal: new AbortController().signal,
    saveStep: async patch => {
      await options.beforeSave?.(patch);
      changes.push(clone(patch));
      await mutateState(value => Object.assign(value.session.steps[0], clone(patch)));
    },
    createAuthorization: async (_projectId, request) => {
      calls.grant++;
      return { purpose: 'engineering-trial', stage: request.stage, sessionId: request.sessionId,
        parentRunId: state.session.coordinatorRunId, policyVersion: state.version, planSha256: sourceHash(request.plan),
        allowedPaths: ['experiments/baseline.mjs', 'results/metrics.json'], inputSha256: sourceHash(request.plan) };
    },
    createRun: async (_projectId, request) => {
      calls.create++;
      const current = await readState(), entries = current.session.steps[0].codeTrials;
      assert.equal(entries.length, 1, 'The grant must be durable before Runner creation.');
      assert.deepEqual(entries[0].authorization, request.authorization);
      const id = `experiment-trial-${sourceHash(request.authorization)}`, runs = await readRuns();
      const existing = runs.find(item => item.id === id);
      if (existing) return clone(existing);
      const run = { id, projectId: 'project', status: options.initialStatus || 'awaiting_approval',
        manifest: { id, projectId: 'project', purpose: 'engineering-trial', trial: clone(request), command: clone(plan.execution),
          code: { version: plan.execution.codePreparationId, snapshotHash: 'c'.repeat(64) }, dataset: { id: plan.dataset, version: plan.datasetVersion },
          environment: {}, permissions: { approval: 'human-required' } }, metrics: [], artifacts: [], execution: null };
      runs.push(run); await writeRuns(runs); return clone(run);
    },
    readRun: async (_projectId, id) => { const run = (await readRuns()).find(item => item.id === id); assert.ok(run, 'The saved original Run must still exist.'); return run; },
    approve: async (_projectId, id, sessionId) => {
      calls.approve++; assert.equal(sessionId, state.session.id);
      const run = await updateRun(id, value => { value.status = 'approved'; value.manifest.permissions.approval = 'user-policy-authorized'; });
      await options.afterApprove?.({ run, mutateState, updateRun }); return run;
    },
    assertRun,
    onRun: async id => { active.push(id); },
    execute: async (_projectId, id, request) => {
      calls.execute++;
      bindings.push(request);
      await options.beforeLaunch?.({ request, mutateState, updateRun });
      await request.beforeLaunch(); request.signal?.throwIfAborted();
      const entry = (await readState()).session.steps[0].codeTrials[0];
      assert.equal(entry.runId, id); assert.equal(entry.status, 'executing');
      assert.equal(entry.manifestSha256, request.executionBinding.manifestSha256, 'The approved SHA must be durable before launch.');
      calls.launched++;
      await updateRun(id, value => { value.status = 'running'; value.execution = { process: { pid: null, stopConfirmed: false } }; });
      await options.duringExecution?.({ request, mutateState, updateRun, id });
      return updateRun(id, value => { value.status = options.terminalStatus || 'completed';
        value.execution = { process: { pid: null, stopConfirmed: true }, exitCode: value.status === 'failed' ? 1 : 0 };
        value.error = value.status === 'failed' ? { code: 'EXPERIMENT_EXIT_NONZERO', message: 'fixed controlled failure' } : null;
      });
    } };
  return { root, input, plan, state, calls, changes, active, bindings, readState, readRuns, mutateState, updateRun };
}

test('trial persists grant, original Run and post-approval SHA before controlled execution', async t => {
  const f = await fixture(t), run = await prepareAutomationTrial(f.input), entry = (await f.readState()).session.steps[0].codeTrials[0];
  assert.equal(f.changes[0].codeTrials[0].runId, null);
  assert.equal(entry.runId, run.id); assert.equal(entry.status, 'completed');
  assert.equal(entry.manifestSha256, experimentManifestHash(run.manifest));
  assert.equal(run.manifest.permissions.approval, 'user-policy-authorized');
  assert.deepEqual(f.bindings[0].executionBinding, { parentRunId: 'coordinator', policyVersion: '4', manifestSha256: entry.manifestSha256 });
  assert.equal(f.bindings[0].signal, f.input.signal); assert.equal(f.bindings[0].wait, true);
  assert.deepEqual(f.bindings[0].allowedPaths, entry.authorization.allowedPaths);
  assert.deepEqual(f.active, [run.id, null]);
});

test('Runner-created then receipt-save crash reconnects exactly the original persistent Run', async t => {
  let failSave = true;
  const f = await fixture(t, { beforeSave: async patch => {
    if (failSave && patch.codeTrials[0].runId) { failSave = false; throw failure('RECEIPT_SAVE_FAULT'); }
  } });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'RECEIPT_SAVE_FAULT' });
  const first = (await f.readRuns())[0];
  assert.equal((await f.readState()).session.steps[0].codeTrials[0].runId, null);
  assert.equal(f.calls.execute, 0);
  const resumed = await prepareAutomationTrial({ ...f.input, session: (await f.readState()).session });
  assert.equal(resumed.id, first.id); assert.equal((await f.readRuns()).length, 1);
  assert.equal(f.calls.create, 2); assert.equal(f.calls.grant, 1); assert.equal(f.calls.launched, 1);
});

test('completed cold receipt replay reads the same Run without creation, approval or execution', async t => {
  const f = await fixture(t), first = await prepareAutomationTrial(f.input), before = clone(f.calls);
  const resumed = await prepareAutomationTrial({ ...f.input, session: (await f.readState()).session });
  assert.equal(resumed.id, first.id); assert.deepEqual(f.calls, before);
  assert.equal((await f.readState()).session.steps[0].codeTrials[0].result.supportsSuccessfulFinding, false);
});

test('actual controlled Runner failure remains only in codeTrials and does not consume formal materials', async t => {
  const f = await fixture(t, { terminalStatus: 'failed' });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_FAILED' });
  const session = (await f.readState()).session, step = session.steps[0], entry = step.codeTrials[0];
  assert.equal(entry.status, 'failed'); assert.equal(entry.result.status, 'failed');
  assert.equal(entry.result.supportsSuccessfulFinding, false); assert.equal((await f.readRuns())[0].execution.process.stopConfirmed, true);
  for (const key of ['result', 'experimentRunId', 'executionPlanBinding']) assert.equal(Object.hasOwn(step, key), false);
  assert.equal(Object.hasOwn(session, 'executionPlan'), false); assert.deepEqual(entry.plan, f.plan);
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_FAILED' });
  assert.equal(f.calls.launched, 1); assert.deepEqual(f.active, [entry.runId, null]);
});

test('running original trial is retained and never restarted by another helper invocation', async t => {
  const f = await fixture(t, { initialStatus: 'running' });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_UNRESOLVED' });
  const entry = (await f.readState()).session.steps[0].codeTrials[0]; assert.ok(entry.runId);
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_UNRESOLVED' });
  assert.equal(f.calls.create, 1); assert.equal(f.calls.approve, 0); assert.equal(f.calls.execute, 0);
});

test('changing scientific materials under the same fixed code version cannot create a second trial', async t => {
  const f = await fixture(t); await prepareAutomationTrial(f.input);
  await assert.rejects(prepareAutomationTrial({ ...f.input, plan: { ...f.plan, seed: 7 } }), { code: 'AUTOMATION_TRIAL_INPUT_CHANGED' });
  assert.equal(f.calls.create, 1); assert.equal(f.calls.launched, 1); assert.equal((await f.readRuns()).length, 1);
});

test('a changed approved manifest is refused before execution and keeps its original receipt', async t => {
  const f = await fixture(t); const run = await prepareAutomationTrial(f.input);
  await f.updateRun(run.id, value => { value.status = 'approved'; value.manifest.permissions.approval = 'changed'; });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_MANIFEST_CHANGED' });
  assert.equal(f.calls.launched, 1); assert.equal((await f.readRuns()).length, 1);
});

test('execution revocation between approval and launch prevents effects and clears active Run tracking', async t => {
  const f = await fixture(t, { beforeLaunch: async ({ mutateState }) => mutateState(value => { value.policy.overrides.execution = 'manual'; value.version++; }) });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'EXECUTION_REVOKED' });
  assert.equal(f.calls.launched, 0); assert.equal(f.active.length, 2); assert.equal(f.active[1], null);
  assert.equal((await f.readState()).session.steps[0].codeTrials[0].error.code, 'EXECUTION_REVOKED');
});

test('parent cancellation before launch starts nothing and clears the tracked original Run', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { beforeLaunch: async () => controller.abort(failure('PARENT_CANCELLED')) });
  await assert.rejects(prepareAutomationTrial({ ...f.input, signal: controller.signal }), { code: 'PARENT_CANCELLED' });
  assert.equal(f.calls.launched, 0); assert.equal(f.active.length, 2); assert.equal(f.active[1], null);
  const step = (await f.readState()).session.steps[0]; assert.ok(step.codeTrials[0].runId); assert.equal(Object.hasOwn(step, 'result'), false);
});

test('cancellation while the controlled Runner is active awaits its retained terminal record before tracking clears', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { duringExecution: async ({ request, updateRun, id }) => {
    assert.equal(request.signal, controller.signal); controller.abort(failure('PARENT_CANCELLED'));
    await updateRun(id, value => { value.status = 'cancelled'; value.execution.process.stopConfirmed = true; });
    request.signal.throwIfAborted();
  } });
  await assert.rejects(prepareAutomationTrial({ ...f.input, signal: controller.signal }), { code: 'PARENT_CANCELLED' });
  assert.equal(f.calls.launched, 1); assert.equal(f.active[1], null);
  const run = (await f.readRuns())[0], step = (await f.readState()).session.steps[0];
  assert.equal(run.status, 'cancelled'); assert.equal(run.execution.process.stopConfirmed, true);
  assert.equal(step.codeTrials[0].runId, run.id); assert.notEqual(step.codeTrials[0].status, 'completed');
  assert.equal(Object.hasOwn(step, 'result'), false);
});

test('failure to persist the initial grant prevents all Runner operations', async t => {
  const f = await fixture(t, { beforeSave: async () => { throw failure('GRANT_SAVE_FAULT'); } });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'GRANT_SAVE_FAULT' });
  assert.equal(f.calls.create, 0); assert.equal(f.calls.approve, 0); assert.equal(f.calls.execute, 0);
  assert.equal((await f.readRuns()).length, 0); assert.equal((await f.readState()).session.steps[0].codeTrials, undefined);
});

test('durable stopped session rejects the original trial without creation or execution', async t => {
  const f = await fixture(t); await f.mutateState(value => { value.session.stopRequested = true; });
  await assert.rejects(prepareAutomationTrial(f.input), { code: 'AUTOMATION_TRIAL_OWNER_CHANGED' });
  assert.equal(f.calls.grant, 0); assert.equal(f.calls.create, 0); assert.equal(f.calls.execute, 0);
});

test('bound plan after planner-save crash uses the original completed read-only certificate without new effects', async t => {
  const f = await fixture(t), first = await prepareAutomationTrial(f.input);
  await f.mutateState(value => { value.session.executionPlan = clone(f.plan);
    value.session.steps[0].executionPlanBinding = { version: 1, sha256: sourceHash(f.plan) }; });
  const beforeCalls = clone(f.calls), beforeState = await f.readState(), beforeSaves = f.changes.length;
  let certificates = 0;
  const recovered = await prepareAutomationTrial({ ...f.input, session: beforeState.session,
    assertRun: async () => { assert.fail('A consumed plan must use its completed certificate, not active draft authorization.'); },
    assertCompleted: async (projectId, actualRun, context) => {
      certificates++; assert.equal(projectId, 'project'); assert.equal(actualRun.id, first.id);
      assert.equal(actualRun.status, 'completed'); assert.equal(actualRun.execution.process.stopConfirmed, true);
      assert.deepEqual(context, { sessionId: 'session', stage: 'replication', plan: f.plan });
      const receipt = (await f.readState()).session.steps[0].codeTrials[0];
      assert.equal(receipt.runId, actualRun.id); assert.equal(receipt.manifestSha256, experimentManifestHash(actualRun.manifest));
    } });
  assert.equal(recovered.id, first.id); assert.equal(certificates, 1);
  assert.deepEqual(f.calls, beforeCalls); assert.equal(f.changes.length, beforeSaves);
  assert.deepEqual(await f.readState(), beforeState); assert.equal((await f.readRuns()).length, 1);
});

test('bound plan without its original trial receipt refuses any new grant or Runner operation', async t => {
  const f = await fixture(t);
  await f.mutateState(value => { value.session.executionPlan = clone(f.plan);
    value.session.steps[0].executionPlanBinding = { version: 1, sha256: sourceHash(f.plan) }; });
  let certificates = 0;
  await assert.rejects(prepareAutomationTrial({ ...f.input,
    assertCompleted: async () => { certificates++; } }), { code: 'AUTOMATION_TRIAL_RECEIPT_REQUIRED' });
  assert.deepEqual(f.calls, { grant: 0, create: 0, approve: 0, execute: 0, launched: 0 });
  assert.equal(certificates, 0); assert.equal(f.changes.length, 0); assert.equal((await f.readRuns()).length, 0);
});
