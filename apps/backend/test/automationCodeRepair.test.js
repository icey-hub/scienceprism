import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAutomationCodeTrial } from '../src/services/researchAutomation/codeRepair.js';

const error = code => Object.assign(new Error(code), { code });
function fixture() {
  const plan = { protocol: 'fixed', dataset: 'original', seed: 0, parameters: { split: 'unchanged' },
    successCriteria: ['original threshold'], execution: { codePreparationId: 'original-code', environmentId: 'fixed-env' } };
  const original = { preparationId: 'original-code', sha256: 'source-sha', paths: ['code/main.py'],
    authorization: { original: true }, input: { codePreparationVersion: 2, papers: [{ id: 'paper' }], executionPlan: plan } };
  const step = { codePreparations: [original], codeTrials: [{ plan, runId: 'failed-run' }] };
  const state = { session: { steps: [{ stage: 'replication', ...step }] } };
  const failure = { runId: 'failed-run', codePreparationId: 'original-code', exitCode: 1, stderr: 'NameError: missing_name', stdout: '' };
  let requests = [], trials = [], stopped = false;
  const options = { projectId: 'project', session: { id: 'session' }, stage: 'replication', plan,
    beforeEffect: async () => { if (stopped) throw error('STOPPED'); } };
  const deps = {
    readState: async () => state,
    readRun: async () => ({ id: 'failed-run' }),
    assertFailure: async () => structuredClone(failure),
    service: { verify: async () => ({ files: [{ path: 'code/main.py', content: 'bad()', sha256: 'sha', baseVersion: { exists: false, sha256: null } }] }) },
    trial: async ({ plan: current }) => { trials.push(structuredClone(current)); if (current.execution.codePreparationId === 'original-code') throw error('AUTOMATION_TRIAL_FAILED'); },
    prepareCode: async request => { requests.push(request); await request.beforeEffect(); return { preparation: { id: 'repaired-code' } }; }
  };
  return { options, deps, failure, original, step: state.session.steps[0], requests, trials, stop: () => { stopped = true; } };
}

test('repair receives actual failure and previous overlay against original base; only code version changes', async () => {
  const f = fixture(), before = structuredClone(f.step), result = await prepareAutomationCodeTrial(f.options, f.deps);
  assert.deepEqual(result, { ...f.options.plan, execution: { ...f.options.plan.execution, codePreparationId: 'repaired-code' } });
  assert.equal(f.requests.length, 1); assert.equal(f.trials.length, 2);
  assert.deepEqual(f.requests[0].repairOf, { trialRunId: 'failed-run', codePreparationId: 'original-code', repairIndex: 1 });
  assert.equal(f.requests[0].input.engineeringRepair.failure.stderr, f.failure.stderr);
  assert.deepEqual(f.requests[0].input.engineeringRepair.sourceFiles[0].baseVersion, { exists: false, sha256: null });
  assert.equal(f.requests[0].input.codePreparationVersion, undefined, 'Version is assigned by the producer, avoiding legacy prompt changes on resume');
  assert.deepEqual(f.step, before, 'No original failure or scientific fields are rewritten');
});

test('success requires no repair and an ineligible failure cannot dispatch a model', async () => {
  const f = fixture(); f.deps.trial = async () => {};
  assert.equal(await prepareAutomationCodeTrial(f.options, f.deps), f.options.plan); assert.equal(f.requests.length, 0);
  f.deps.trial = async () => { throw error('EXPERIMENT_INTERRUPTED'); };
  await assert.rejects(prepareAutomationCodeTrial(f.options, f.deps), { code: 'EXPERIMENT_INTERRUPTED' });
  f.deps.trial = async () => { throw error('AUTOMATION_TRIAL_FAILED'); };
  f.deps.assertFailure = async () => { throw error('NOT_REPAIRABLE'); };
  await assert.rejects(prepareAutomationCodeTrial(f.options, f.deps), { code: 'NOT_REPAIRABLE' });
  assert.equal(f.requests.length, 0);
});

test('second failure is retained and never triggers a second repair; a repaired input is also bounded', async () => {
  const f = fixture(); f.deps.trial = async () => { throw error('AUTOMATION_TRIAL_FAILED'); };
  await assert.rejects(prepareAutomationCodeTrial(f.options, f.deps), { code: 'AUTOMATION_TRIAL_FAILED' });
  assert.equal(f.requests.length, 1);
  f.original.repairOf = { repairIndex: 1 };
  await assert.rejects(prepareAutomationCodeTrial(f.options, f.deps), { code: 'AUTOMATION_CODE_REPAIR_LIMIT' });
  assert.equal(f.requests.length, 1);
});

test('cancel and changed real failure interrupt producer checkpoints before another effect', async () => {
  const f = fixture(); f.deps.prepareCode = async request => { f.stop(); await request.beforeEffect(); assert.fail('must stop'); };
  await assert.rejects(prepareAutomationCodeTrial(f.options, f.deps), { code: 'STOPPED' });
  const g = fixture(); g.deps.prepareCode = async request => { g.failure.stderr = 'changed'; await request.beforeEffect(); assert.fail('must stop'); };
  await assert.rejects(prepareAutomationCodeTrial(g.options, g.deps), { code: 'AUTOMATION_CODE_REPAIR_SOURCE_CHANGED' });
});
