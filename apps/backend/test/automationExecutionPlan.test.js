import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAutomationExecutionPlan, applyAutomationExecutionPlan, bindAutomationExecutionPlan, isAutomationExecutionPlanLocked, prepareAutomationExecutionMaterials } from '../src/services/researchAutomation/executionPlan.js';
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

// Structural completed preparation/trial fixtures for this pure transition.
// The caller must verify actual domain versions, authorization and stopped Run.
function materialFixture({ environment = false, implicitPaths = false, code = true } = {}) {
  const original = { ...plan(), execution: { adapter: environment ? 'python' : 'node', entrypoint: environment ? 'run.py' : 'run.mjs', args: [] },
    ...(implicitPaths ? {} : { codePaths: ['protocol.json'] }) };
  const current = initializeAutomationExecutionPlan({ ...session(original), status: 'running', currentStage: 'replication', coordinatorRunId: 'coordinator', executionPlanOrigin: 'human' });
  const codeId = `code-preparation-${'a'.repeat(64)}`, environmentId = 'environment-11111111-1111-4111-8111-111111111111';
  const target = { ...structuredClone(current.executionPlan), execution: { ...current.executionPlan.execution,
    ...(code ? { codePreparationId: codeId } : {}), ...(environment ? { environmentId } : {}) },
    ...(code ? { codePaths: ['protocol.json', current.executionPlan.execution.entrypoint] } : {}) };
  const step = current.steps[1], input = { executionPlan: structuredClone(current.executionPlan), availableFiles: [{ path: 'protocol.json' }] };
  if (code) {
    step.calls = [{ runId: 'code-producer', task: 'research:code-preparation' }];
    step.codePreparations = [{ status: 'completed', preparationId: codeId, sha256: 'a'.repeat(64), producerRunId: 'code-producer',
      paths: [current.executionPlan.execution.entrypoint], input,
      authorization: { sessionId: current.id, parentRunId: current.coordinatorRunId, stage: 'replication', inputSha256: sourceHash(input) } }];
    step.codeTrials = [{ status: 'completed', runId: 'actual-trial', plan: structuredClone(target), manifestSha256: 'b'.repeat(64),
      authorization: { sessionId: current.id, parentRunId: current.coordinatorRunId, stage: 'replication', code: { id: codeId, sha256: 'a'.repeat(64) }, draftPlanSha256: sourceHash(target) } }];
  }
  if (environment) {
    step.calls = [...(step.calls || []), { runId: 'environment-producer', task: 'research:environment_proposal' }];
    step.environmentPreparations = [{ status: 'completed', environmentId, sha256: 'c'.repeat(64), jobId: 'original-environment-job',
      authorization: { sessionId: current.id, parentRunId: current.coordinatorRunId, stage: 'replication', sourceRunId: 'environment-producer' } }];
  }
  return { current, target, step };
}

test('material completion retains original human plan/version/hash, increments once and leaves formal consumption to bind', () => {
  for (const options of [{}, { environment: true }, { implicitPaths: true }, { environment: true, code: false }]) {
    const f = materialFixture(options), before = structuredClone(f.current);
    const prepared = prepareAutomationExecutionMaterials(f.current, 'replication', f.target);
    assert.deepEqual(f.current, before); assert.deepEqual(prepared.executionPlan, f.target);
    assert.equal(prepared.executionPlanVersion, 2); assert.equal(prepared.executionPlanSha256, sourceHash(f.target));
    assert.equal(prepared.executionPlanOrigin, 'human'); assert.equal(prepared.steps[1].executionPlanBinding, undefined);
    assert.deepEqual(prepared.steps[1].materialPreparation, { sourcePlan: before.executionPlan, sourceVersion: 1, sourceSha256: before.executionPlanSha256,
      preparedSha256: sourceHash(f.target), preparedVersion: 2 });
    assert.deepEqual(prepareAutomationExecutionMaterials(prepared, 'replication', f.target), prepared);
    assert.deepEqual(initializeAutomationExecutionPlan(prepared), prepared);
    const bound = bindAutomationExecutionPlan(prepared, 'replication', f.target);
    assert.deepEqual(bound.steps[1].executionPlanBinding, { version: 2, sha256: sourceHash(f.target) });
    assert.deepEqual(bound.steps[1].materialPreparation, prepared.steps[1].materialPreparation);
  }
  const absent = initializeAutomationExecutionPlan(session());
  assert.deepEqual(prepareAutomationExecutionMaterials(absent, 'replication', plan()), absent);
});

test('material completion refuses scientific changes, explicit version replacement and unproven code paths', () => {
  const f = materialFixture();
  for (const change of [{ dataset: 'different' }, { datasetVersion: 'different' }, { protocol: 'looser' }, { seed: 2 },
    { parameters: {} }, { resources: { timeoutMs: 2000 } }, { artifacts: [] }, { successCriteria: ['easier'] },
    { execution: { ...f.target.execution, args: ['different'] } }, { execution: { ...f.target.execution, entrypoint: 'different.mjs' } },
    { execution: { ...f.target.execution, adapter: 'python' } }]) {
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', { ...f.target, ...change }), { code: 'AUTOMATION_EXECUTION_MATERIALS_PROTOCOL_CHANGED' });
  }
  for (const field of ['codePreparationId', 'environmentId']) {
    const original = structuredClone(f.current);
    original.executionPlan.execution[field] = field === 'codePreparationId' ? `code-preparation-${'d'.repeat(64)}` : 'environment-22222222-2222-4222-8222-222222222222';
    original.executionPlanSha256 = sourceHash(original.executionPlan);
    assert.throws(() => prepareAutomationExecutionMaterials(original, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_MATERIALS_PROTOCOL_CHANGED' });
  }
  for (const paths of [['run.mjs'], ['protocol.json', 'run.mjs', 'main.tex'], ['protocol.json'], ['protocol.json', 'run.mjs', 'run.mjs']]) {
    const value = materialFixture(), target = { ...value.target, codePaths: paths };
    value.step.codeTrials[0].plan = target; value.step.codeTrials[0].authorization.draftPlanSha256 = sourceHash(target);
    assert.throws(() => prepareAutomationExecutionMaterials(value.current, 'replication', target), { code: 'AUTOMATION_EXECUTION_MATERIALS_PATHS_CHANGED' });
  }
});

test('material completion requires unique original completed producers, environment records and exact successful engineering trial', () => {
  for (const change of [f => { f.step.codePreparations[0].status = 'failed'; }, f => { f.step.codePreparations.push(structuredClone(f.step.codePreparations[0])); },
    f => { f.step.codePreparations[0].authorization.parentRunId = 'other'; }, f => { f.step.codePreparations[0].input.executionPlan.seed = 99; },
    f => { f.step.calls = []; }, f => { f.step.codePreparations[0].sha256 = 'b'.repeat(64); }]) {
    const f = materialFixture(); change(f);
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_MATERIALS_CODE_REQUIRED' });
  }
  for (const change of [f => { f.step.codeTrials[0].status = 'failed'; }, f => { f.step.codeTrials[0].plan.seed = 99; },
    f => { f.step.codeTrials[0].manifestSha256 = null; }, f => { f.step.codeTrials[0].authorization.code.id = `code-preparation-${'d'.repeat(64)}`; }]) {
    const f = materialFixture(); change(f);
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_MATERIALS_TRIAL_REQUIRED' });
  }
  for (const change of [f => { f.step.environmentPreparations[0].status = 'failed'; }, f => { f.step.environmentPreparations[0].authorization.stage = 'experiment'; },
    f => { f.step.environmentPreparations[0].jobId = null; }, f => { f.step.environmentPreparations[0].sha256 = null; }]) {
    const f = materialFixture({ environment: true, code: false }); change(f);
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_MATERIALS_ENVIRONMENT_REQUIRED' });
  }
});

test('material completion stays closed after consumption or stopping and rejects corrupted restoration receipts', () => {
  for (const marker of [{ prepared: true }, { result: { status: 'failed' } }, { experimentRunId: 'original-run' }, { calls: [{ task: 'research:reproduction_plan' }] }]) {
    const f = materialFixture(); Object.assign(f.step, marker);
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_PLAN_LOCKED' });
  }
  for (const change of [f => { f.current.status = 'paused'; }, f => { f.current.currentStage = 'experiment'; }, f => { f.current.stopRequested = true; }]) {
    const f = materialFixture(); change(f);
    assert.throws(() => prepareAutomationExecutionMaterials(f.current, 'replication', f.target), { code: 'AUTOMATION_EXECUTION_MATERIALS_INACTIVE' });
  }
  const f = materialFixture(), prepared = prepareAutomationExecutionMaterials(f.current, 'replication', f.target);
  for (const change of [record => { record.sourceVersion = 0; }, record => { record.sourcePlan.seed = 99; },
    record => { record.sourceSha256 = 'd'.repeat(64); }, record => { record.preparedVersion = 9; }, record => { record.preparedSha256 = 'd'.repeat(64); },
    record => { record.extra = true; }]) {
    const changed = structuredClone(prepared); change(changed.steps[1].materialPreparation);
    assert.throws(() => initializeAutomationExecutionPlan(changed), { code: 'AUTOMATION_EXECUTION_MATERIALS_CHANGED' });
  }
  assert.throws(() => prepareAutomationExecutionMaterials(prepared, 'replication', { ...f.target, seed: 99 }), { code: 'AUTOMATION_EXECUTION_MATERIALS_LOCKED' });
});
