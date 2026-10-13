import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAutomationExecutionPlan, applyAutomationExecutionPlan, bindAutomationExecutionPlan, isAutomationExecutionPlanLocked } from '../src/services/researchAutomation/executionPlan.js';
import { validateAutomationExecution } from '../src/services/researchAutomation/policy.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';

const plan = () => ({ dataset: ' data.json ', datasetVersion: 'snapshot-1', protocol: ' Read the saved data. ', execution: { adapter: 'node', entrypoint: 'run.mjs' },
  successCriteria: ['Record the mean'], parameters: { b: 2, a: 1 }, resources: { timeoutMs: 1000 }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] });
const session = executionPlan => ({ id: 'session', steps: [{ stage: 'search', prepared: true }, { stage: 'replication', status: 'pending' }, { stage: 'experiment', status: 'pending' }],
  ...(executionPlan === undefined ? {} : { executionPlan }) });
const replace = (value, executionPlan, extra = {}) => applyAutomationExecutionPlan(value, { executionPlan, expectedSessionId: value.id,
  expectedExecutionPlanVersion: value.executionPlanVersion, ...extra });

test('initialize uses the actual validator and stable hash without mutating the input session', () => {
  const absent = session(), empty = initializeAutomationExecutionPlan(absent);
  assert.equal(empty.executionPlanVersion, 0); assert.equal(empty.executionPlanSha256, null); assert.equal(absent.executionPlanVersion, undefined);
  const original = session(plan()), before = structuredClone(original), initialized = initializeAutomationExecutionPlan(original);
  assert.deepEqual(original, before); assert.equal(initialized.executionPlanVersion, 1);
  assert.deepEqual(initialized.executionPlan, validateAutomationExecution(plan()));
  assert.equal(initialized.executionPlanSha256, sourceHash(validateAutomationExecution(plan())));
  assert.equal(initialized.executionPlan.dataset, 'data.json'); assert.deepEqual(initialized.executionPlan.execution.args, []);
  assert.equal(initialized.executionPlan.seed, 0); assert.equal(initialized.executionPlanOrigin, 'legacy');
  assert.deepEqual(initializeAutomationExecutionPlan(initialized), initialized);
});

test('replacement requires explicit session and plan CAS even for identical materials', () => {
  const current = initializeAutomationExecutionPlan(session(plan()));
  for (const input of [{ executionPlan: plan() }, { executionPlan: plan(), expectedSessionId: 'session' },
    { executionPlan: plan(), expectedSessionId: 'session', expectedExecutionPlanVersion: -1 }]) {
    assert.throws(() => applyAutomationExecutionPlan(current, input), { code: 'AUTOMATION_EXECUTION_PLAN_VERSION_REQUIRED', statusCode: 400 });
  }
  for (const patch of [{ expectedSessionId: 'other' }, { expectedExecutionPlanVersion: 0 }]) {
    assert.throws(() => replace(current, plan(), patch), { code: 'AUTOMATION_EXECUTION_PLAN_CONFLICT', statusCode: 409 });
  }
});

test('normalized identical materials are idempotent while actual parameters, resources and outputs advance version', () => {
  const initial = initializeAutomationExecutionPlan(session(plan()));
  const same = { ...plan(), dataset: 'data.json', protocol: 'Read the saved data.', seed: 0, execution: { ...plan().execution, args: [] }, parameters: { a: 1, b: 2 } };
  assert.deepEqual(replace(initial, same), initial);
  for (const patch of [{ parameters: { a: 9, b: 2 } }, { resources: { timeoutMs: 2000 } }, { artifacts: [{ path: 'results/new.json', kind: 'output' }] },
    { datasetVersion: 'snapshot-2' }, { execution: { adapter: 'node', entrypoint: 'other.mjs' } }]) {
    const updated = replace(initial, { ...plan(), ...patch }); assert.equal(updated.executionPlanVersion, 2);
    assert.notEqual(updated.executionPlanSha256, initial.executionPlanSha256); assert.equal(updated.executionPlanOrigin, 'human');
    assert.equal(initial.executionPlanVersion, 1);
  }
});

test('omitting materials resumes normally and search preparation does not lock execution materials', () => {
  const initial = initializeAutomationExecutionPlan(session(plan()));
  assert.deepEqual(applyAutomationExecutionPlan(initial, {}), initial); assert.deepEqual(applyAutomationExecutionPlan(initial, { executionPlan: null }), initial);
  const absent = initializeAutomationExecutionPlan(session());
  const updated = replace(absent, plan()); assert.equal(updated.executionPlanVersion, 1);
  assert.equal(updated.steps[0].prepared, true); assert.equal(updated.executionPlanOrigin, 'human');
});

test('missing materials can be supplied after an execution-proposal call without redoing that call or binding history', () => {
  const original = session(); original.steps[1] = { stage: 'replication', status: 'blocked', calls: [{ runId: 'completed-proposal', task: 'research:execution_proposal', attempt: 0 }] };
  const initialized = initializeAutomationExecutionPlan(original), updated = replace(initialized, plan());
  assert.equal(isAutomationExecutionPlanLocked(initialized), false); assert.equal(isAutomationExecutionPlanLocked(updated), false);
  assert.deepEqual(updated.steps[1].calls, original.steps[1].calls); assert.equal(updated.steps[1].executionPlanBinding, undefined);
  const bound = bindAutomationExecutionPlan(updated, 'replication', plan(), { origin: 'human' });
  assert.deepEqual(bound.steps[1].executionPlanBinding, { version: 1, sha256: updated.executionPlanSha256 });
  assert.deepEqual(bound.steps[1].calls, original.steps[1].calls);
  assert.equal(isAutomationExecutionPlanLocked(bound), true);
});

test('lock projection reads real concrete consumption without initializing or mutating the session', () => {
  const original = session(plan()), before = structuredClone(original);
  assert.equal(isAutomationExecutionPlanLocked(original), false); assert.deepEqual(original, before);
  original.steps[1].prepared = true; assert.equal(isAutomationExecutionPlanLocked(original), true);
  delete original.steps[1].prepared; original.steps[1].calls = [{ task: 'research:reproduction_plan' }];
  assert.equal(isAutomationExecutionPlanLocked(original), true);
  const missing = session(); missing.steps[1].calls = [{ task: 'research:execution_proposal' }]; assert.equal(isAutomationExecutionPlanLocked(missing), false);
  missing.steps[1].experimentRunId = 'actual-run'; assert.equal(isAutomationExecutionPlanLocked(missing), true);
  delete missing.steps[1].experimentRunId; missing.steps[1].executionPlanBinding = { version: 1, sha256: 'a'.repeat(64) };
  assert.equal(isAutomationExecutionPlanLocked(missing), true);
});

test('first concrete consumption binds fixed plan version/hash and same consumption can reenter', () => {
  const original = session(), bound = bindAutomationExecutionPlan(original, 'replication', plan(), { origin: 'model' });
  assert.equal(original.executionPlanVersion, undefined); assert.equal(original.steps[1].executionPlanBinding, undefined);
  assert.equal(bound.executionPlanVersion, 1); assert.equal(bound.executionPlanOrigin, 'model');
  assert.deepEqual(bound.steps[1].executionPlanBinding, { version: 1, sha256: sourceHash(validateAutomationExecution(plan())) });
  assert.deepEqual(bindAutomationExecutionPlan(bound, 'replication', plan(), { origin: 'stage' }), bound);
  const experiment = bindAutomationExecutionPlan(bound, 'experiment', plan(), { origin: 'stage' });
  assert.deepEqual(experiment.steps[2].executionPlanBinding, bound.steps[1].executionPlanBinding);
  assert.equal(Object.hasOwn(experiment.steps[2].executionPlanBinding, 'manifestSha256'), false);
});

test('bound, prepared, executed or concrete planning calls reject different execution materials', () => {
  for (const marker of [{ prepared: true }, { result: { status: 'failed' } }, { experimentRunId: 'actual-run' },
    { calls: [{ task: 'research:reproduction_plan', runId: 'reproduction-producer' }] }, { calls: [{ task: 'research:experiment_plan', runId: 'experiment-producer' }] }]) {
    const original = session(plan()); Object.assign(original.steps[1], marker); const initialized = initializeAutomationExecutionPlan(original);
    assert.throws(() => replace(initialized, { ...plan(), parameters: { a: 2 } }), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
    assert.deepEqual(replace(initialized, plan()), initialized);
  }
  const bound = bindAutomationExecutionPlan(session(), 'replication', plan());
  assert.throws(() => replace(bound, { ...plan(), seed: 99 }), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
  assert.throws(() => bindAutomationExecutionPlan(bound, 'experiment', { ...plan(), seed: 99 }), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
});

test('legacy consumed steps stay unbound and ordinary continuation cannot retroactively certify them', () => {
  const old = session(plan()); old.steps[1].prepared = true;
  const initialized = initializeAutomationExecutionPlan(old); assert.equal(initialized.executionPlanVersion, 1); assert.equal(initialized.steps[1].executionPlanBinding, undefined);
  assert.deepEqual(applyAutomationExecutionPlan(old, {}), initialized);
  assert.throws(() => replace(initialized, { ...plan(), datasetVersion: 'other' }), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
  assert.throws(() => bindAutomationExecutionPlan(initialized, 'replication', plan()), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
  const missing = session(); missing.steps[1].experimentRunId = 'old-experiment'; const noPlan = initializeAutomationExecutionPlan(missing);
  assert.deepEqual(applyAutomationExecutionPlan(noPlan, {}), noPlan);
  assert.throws(() => replace(noPlan, plan()), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
});

test('current material tampering or forged consumed version cannot pass initialization', () => {
  const current = bindAutomationExecutionPlan(session(), 'replication', plan());
  for (const change of [value => { value.executionPlan.parameters.a = 999; }, value => { value.executionPlanSha256 = 'a'.repeat(64); },
    value => { value.steps[1].executionPlanBinding.version++; }, value => { value.steps[1].executionPlanBinding.extra = true; },
    value => { delete value.executionPlanVersion; }]) {
    const mutated = structuredClone(current); change(mutated);
    assert.throws(() => initializeAutomationExecutionPlan(mutated), { code: 'AUTOMATION_EXECUTION_PLAN_CHANGED' });
  }
});

test('invalid and nonfinite material structure is rejected instead of hashed as an authorized plan', () => {
  const current = initializeAutomationExecutionPlan(session());
  const cyclic = {}; cyclic.self = cyclic;
  for (const invalid of [{ ...plan(), shell: 'rm -rf' }, { ...plan(), parameters: { value: NaN } }, { ...plan(), parameters: { value: Infinity } },
    { ...plan(), parameters: { value: undefined } }, { ...plan(), parameters: { cyclic } }, { ...plan(), resources: { timeoutMs: Infinity } },
    { ...plan(), parameters: { value: 1n } }]) {
    assert.throws(() => replace(current, invalid), { code: 'INVALID_AUTOMATION_EXECUTION', statusCode: 400 });
  }
  assert.throws(() => bindAutomationExecutionPlan(current, 'search', plan()), { code: 'INVALID_AUTOMATION_EXECUTION_BINDING' });
  assert.throws(() => bindAutomationExecutionPlan(current, 'replication', plan(), { origin: 'untrusted-freeform' }), { code: 'INVALID_AUTOMATION_EXECUTION_BINDING' });
  assert.throws(() => bindAutomationExecutionPlan(current, 'replication', null), { code: 'INVALID_AUTOMATION_EXECUTION' });
});
