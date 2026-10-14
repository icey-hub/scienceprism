import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationStageHarness } from '../src/services/researchAutomation/stageHarness.js';
import { createCodeAuthorization } from '../src/services/researchAutomation/codeAuthorization.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';
import { buildResearchHarnessPrompt } from '../src/services/researchResearch/harnessAdapter.js';
import { RESEARCH_STAGE_CONTRACTS } from '../src/services/researchResearch/schemas.js';

const clone = value => structuredClone(value);
function fixture() {
  const session = { id: 'session-stage', coordinatorRunId: 'coordinator-stage', attempt: 1, status: 'running', currentStage: 'replication' };
  const step = { stage: 'replication', handoff: { sessionId: session.id, projectId: 'stage-project', stage: 'replication', role: 'replication-agent', inputSha256: 'a'.repeat(64) }, calls: [] };
  const request = { projectId: 'stage-project', stage: 'replication', task: 'research:execution_proposal', role: 'replication-agent',
    input: { dataset: 'dataset-fixed', protocol: 'Fixed original protocol' }, context: { automationHandoff: clone(step.handoff) },
    prompt: 'Fixture stage request', researchSkills: [] };
  const runs = new Map(), effects = [], executed = [], saves = [];
  const controller = new AbortController();
  let creates = 0, checkpoints = 0;
  const dependencies = {
    projectId: 'stage-project', session, stage: 'replication', step, signal: controller.signal,
    beforeEffect: async () => { checkpoints++; effects.push('checkpoint'); },
    createRun: async (projectId, value, options) => {
      assert.equal(projectId, 'stage-project'); assert.equal(options.automationSessionId, session.id);
      const run = { id: `real-fixture-${++creates}`, projectId, kind: 'research-stage', automationSessionId: session.id,
        parentRunId: value.parentRunId, status: 'created', adapter: 'deepseek', request: clone(value), patches: [], events: [] };
      runs.set(run.id, run); effects.push('created'); return clone(run);
    },
    readRun: async (projectId, id) => { assert.equal(projectId, 'stage-project'); assert.ok(runs.has(id)); return clone(runs.get(id)); },
    listRuns: async (projectId, query) => { assert.equal(projectId, 'stage-project'); assert.equal(query.limit, 100);
      return [...runs.values()].filter(run => query.parentRunId ? run.parentRunId === query.parentRunId : run.request.requestId === query.requestId).map(clone); },
    saveStep: async value => { saves.push(clone(value)); Object.assign(step, clone(value)); effects.push('saved'); },
    execute: async (value, options) => {
      assert.equal(options.automationSessionId, session.id); assert.equal(value.signal, controller.signal);
      assert.ok(step.calls.some(call => call.runId === value.existingRunId));
      const run = runs.get(value.existingRunId); assert.ok(run); executed.push(value.existingRunId); effects.push('executed');
      Object.assign(run, { status: 'completed', reply: 'Actual fixture execution receipt', patches: [{ path: 'experiments/run.py', content: 'fixture' }] });
      return { ok: true, runId: run.id, patches: clone(run.patches), reply: run.reply };
    }
  };
  return { session, step, request, runs, effects, executed, saves, controller, dependencies,
    harness: overrides => createAutomationStageHarness({ ...dependencies, ...overrides }),
    creates: () => creates, checkpoints: () => checkpoints };
}
const reject = code => error => error.code === code;

test('real call receipt and onPrepared producer binding precede any execution', async () => {
  const f = fixture(), run = f.harness();
  const result = await run(f.request, { onPrepared: async prepared => {
    assert.equal(prepared.status, 'created'); assert.ok(f.step.calls.some(call => call.runId === prepared.id));
    assert.deepEqual(f.step.runIds, [prepared.id]); f.step.producerRunId = prepared.id; f.effects.push('bound');
  } });
  assert.equal(result.runId, f.step.producerRunId); assert.equal(f.creates(), 1);
  assert.deepEqual(f.effects, ['checkpoint', 'created', 'saved', 'bound', 'checkpoint', 'executed']);
  assert.equal(f.step.calls[0].task, f.request.task); assert.equal(f.step.calls[0].attempt, 1);
});

test('completed cached call keeps its original ID, authenticates onPrepared and executes no second time', async () => {
  const f = fixture(), run = f.harness(), first = await run(f.request), originalCalls = clone(f.step.calls);
  let preparedId;
  const cached = await run(f.request, { onPrepared: prepared => { preparedId = prepared.id; } });
  assert.equal(cached.runId, first.runId); assert.equal(cached.ok, true); assert.equal(preparedId, first.runId);
  assert.deepEqual(cached.patches, f.runs.get(first.runId).patches);
  assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [first.runId]); assert.deepEqual(f.step.calls, originalCalls);
});

test('created and paused recovered calls continue the same durable Run with no new creation', async () => {
  for (const status of ['created', 'paused']) {
    const f = fixture();
    await assert.rejects(f.harness()(f.request, { onPrepared: () => { throw new Error('Bind checkpoint unavailable'); } }), /Bind checkpoint unavailable/);
    const id = f.step.calls[0].runId, recorded = f.runs.get(id);
    recorded.status = status;
    if (status === 'paused') { recorded.retainedWorkspace = { attempt: 1 }; recorded.recovery = { status: 'ready' }; }
    const result = await f.harness()(f.request, { onPrepared: run => assert.equal(run.id, id) });
    assert.equal(result.runId, id); assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [id]);
  }
});

test('creation followed by step persistence failure is cold-reattached through the original requestId', async () => {
  const f = fixture();
  await assert.rejects(f.harness({ saveStep: async () => { throw new Error('Step disk unavailable'); } })(f.request), /Step disk unavailable/);
  assert.equal(f.creates(), 1); assert.deepEqual(f.step.calls, []); assert.deepEqual(f.executed, []);
  const id = [...f.runs.keys()][0];
  const result = await f.harness()(f.request, { onPrepared: prepared => {
    assert.equal(prepared.id, id); assert.ok(f.step.calls.some(call => call.runId === id));
  } });
  assert.equal(result.runId, id); assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [id]); assert.deepEqual(f.step.runIds, [id]);
});

test('requireExisting refuses an absent receipt without creating or executing a new Run', async () => {
  const f = fixture(); let bound = false;
  await assert.rejects(f.harness()(f.request, { requireExisting: true, onPrepared: () => { bound = true; } }), reject('AUTOMATION_RUN_UNRESOLVED'));
  assert.equal(f.creates(), 0); assert.equal(bound, false); assert.deepEqual(f.executed, []); assert.deepEqual(f.step.calls, []);
});

test('requireExisting cold-reentry attaches only the original orphan Run and does not create another', async () => {
  const f = fixture();
  await assert.rejects(f.harness({ saveStep: async () => { throw new Error('Step disk unavailable'); } })(f.request), /Step disk unavailable/);
  const id = [...f.runs.keys()][0]; let boundId;
  const receipt = await f.harness()(f.request, { requireExisting: true, onPrepared: prepared => { boundId = prepared.id; } });
  assert.equal(receipt.runId, id); assert.equal(boundId, id); assert.equal(f.creates(), 1);
  assert.deepEqual(f.executed, [id]); assert.deepEqual(f.step.runIds, [id]);
});

test('multiple orphan receipts for the same input refuse reconciliation without starting another Run', async () => {
  const f = fixture();
  await assert.rejects(f.harness({ saveStep: async () => { throw new Error('Step disk unavailable'); } })(f.request), /Step disk unavailable/);
  const first = [...f.runs.values()][0]; f.runs.set('duplicate-orphan', { ...clone(first), id: 'duplicate-orphan' });
  await assert.rejects(f.harness()(f.request), reject('AUTOMATION_RUN_UNRESOLVED'));
  assert.equal(f.creates(), 1); assert.deepEqual(f.executed, []); assert.deepEqual(f.step.calls, []);
});

test('changed recorded materials or wrong parent/session/kind never reuse a saved call', async () => {
  for (const kind of ['input', 'parent', 'session', 'kind']) {
    const f = fixture(), first = await f.harness()(f.request), stored = f.runs.get(first.runId);
    if (kind === 'input') stored.request.input.protocol = 'Changed protocol';
    if (kind === 'parent') stored.parentRunId = 'foreign-parent';
    if (kind === 'session') stored.automationSessionId = 'foreign-session';
    if (kind === 'kind') stored.kind = 'codex-worker';
    await assert.rejects(f.harness()(f.request), reject(kind === 'input' ? 'AUTOMATION_RUN_INPUT_CHANGED' : 'AUTOMATION_RUN_OWNER_CHANGED'));
    assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [first.runId]);
  }
});

test('full stage handoff is required even when request and stored orphan share a session ID', async () => {
  const f = fixture(), wrong = clone(f.request); delete wrong.context.automationHandoff.inputSha256;
  await assert.rejects(f.harness()(wrong), reject('AUTOMATION_RUN_OWNER_CHANGED'));
  assert.equal(f.creates(), 1); assert.deepEqual(f.executed, []); assert.deepEqual(f.step.calls, []);
  await assert.rejects(f.harness()(wrong), reject('AUTOMATION_RUN_OWNER_CHANGED'));
  assert.equal(f.creates(), 1);
});

test('onPrepared failure leaves original created call durable and executes nothing', async () => {
  const f = fixture();
  await assert.rejects(f.harness()(f.request, { onPrepared: () => { throw new Error('Authorization binding failed'); } }), /Authorization binding failed/);
  assert.equal(f.creates(), 1); assert.equal(f.step.calls.length, 1); assert.deepEqual(f.executed, []);
  assert.equal(f.runs.get(f.step.calls[0].runId).status, 'created');
});

test('initial or post-binding authorization checkpoint denial prevents all unauthorized execution', async () => {
  for (const denyAt of [1, 2]) {
    const f = fixture(); let checks = 0, bound = false;
    await assert.rejects(f.harness({ beforeEffect: async () => { if (++checks === denyAt) throw new Error('Current policy revoked'); } })(f.request,
      { onPrepared: () => { bound = true; } }), /Current policy revoked/);
    assert.equal(f.creates(), denyAt === 1 ? 0 : 1); assert.equal(bound, denyAt === 2); assert.deepEqual(f.executed, []);
  }
});

test('pre-abort and abort during producer binding stop before model execution', async () => {
  for (const kind of ['before', 'binding']) {
    const f = fixture();
    if (kind === 'before') f.controller.abort(new Error('Stopped by parent'));
    await assert.rejects(f.harness()(f.request, { onPrepared: () => { f.controller.abort(new Error('Stopped by parent')); } }), /Stopped by parent/);
    assert.equal(f.creates(), kind === 'before' ? 0 : 1); assert.deepEqual(f.executed, []);
  }
});

test('retained, interrupted and unknown calls remain unresolved and never restart blindly', async () => {
  for (const change of [{ cleanup: { modelSlotRetained: true } }, { error: { code: 'HARNESS_INTERRUPTED' } },
    { status: 'paused', retainedWorkspace: { attempt: 1 }, recovery: { status: 'unresolved' } }, { status: 'running' }]) {
    const f = fixture(), first = await f.harness()(f.request); Object.assign(f.runs.get(first.runId), change);
    await assert.rejects(f.harness()(f.request), reject('AUTOMATION_RUN_UNRESOLVED'));
    assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [first.runId]);
  }
});

test('failed or cancelled scope-bound code call cannot be newly dispatched by increasing session attempt', async () => {
  for (const status of ['failed', 'cancelled']) {
    const f = fixture(); f.request.task = 'research:code-preparation'; f.request.role = 'experiment-code-producer';
    f.request.context.codeAuthorization = createCodeAuthorization({ projectId: 'stage-project', session: f.session, stage: 'replication',
      inputSha256: sourceHash(f.request.input), policyVersion: 1, policy: { enabled: true, overrides: {},
        codeScope: { allowedPaths: ['experiments'], maxTokens: 5000, timeoutMs: 30000, maxVersions: 2 } } });
    const first = await f.harness()(f.request); f.runs.get(first.runId).status = status; f.session.attempt = 2;
    await assert.rejects(f.harness()(f.request), reject('AUTOMATION_RUN_UNRESOLVED'));
    assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [first.runId]);
  }
});

test('legacy non-code failed stage can be explicitly retried in a later session attempt', async () => {
  const f = fixture(), first = await f.harness()(f.request); f.runs.get(first.runId).status = 'failed'; f.session.attempt = 2;
  const next = await f.harness()(f.request);
  assert.notEqual(next.runId, first.runId); assert.equal(f.creates(), 2); assert.deepEqual(f.executed, [first.runId, next.runId]);
});

function reproductionFixture() {
  const f = fixture(), contract = clone(RESEARCH_STAGE_CONTRACTS.reproduction_plan);
  f.request.task = 'research:reproduction_plan';
  const current = { ...clone(f.request), stageContract: contract,
    prompt: buildResearchHarnessPrompt({ stage: 'reproduction_plan', input: f.request.input, context: f.request.context }) };
  const oldContract = { ...clone(contract), fields: contract.fields.filter(field => !field.startsWith('evaluationProtocol')),
    notes: ['paperId must be a paper id taken from the stage input.'] };
  const block = /Required output fields \(name: type\) for reproduction_plan:\n[\s\S]*?(?=Stage-specific project skills:\n)/;
  f.request.stageContract = oldContract;
  f.request.prompt = current.prompt.replace(block, `Required output fields (name: type) for reproduction_plan:\n\n${oldContract.fields.map(field => `- ${field}`).join('\n')}\n\nOutput contract rules:\n\n${oldContract.rules.map(rule => `- ${rule}`).join('\n')}\n\nField semantics:\n- ${oldContract.notes.join('\n- ')}\n\n`);
  return { ...f, current };
}

test('optional reproduction contract migration reuses completed and created original Runs with their exact stored prompt', async () => {
  for (const status of ['completed', 'created']) {
    const f = reproductionFixture();
    if (status === 'created') await assert.rejects(f.harness()(f.request, { onPrepared: () => { throw new Error('Saved before model launch'); } }), /Saved before model launch/);
    else await f.harness()(f.request);
    const id = f.step.calls[0].runId, calls = clone(f.step.calls);
    const result = await f.harness({ execute: async (request, options) => {
      assert.equal(request.prompt, f.request.prompt); assert.deepEqual(request.stageContract, f.request.stageContract);
      return f.dependencies.execute(request, options);
    } })(f.current);
    assert.equal(result.runId, id); assert.equal(f.creates(), 1); assert.deepEqual(f.step.calls, calls);
    assert.deepEqual(f.executed, [id]);
  }
});

test('optional reproduction migration rejects different inputs, repair instructions, tampered ledger hashes and foreign ownership', async () => {
  for (const change of [f => { f.current.input.protocol = 'Changed protocol'; }, f => { f.current.prompt += '\n\nYour previous reply was rejected: different repair'; },
    f => { f.step.calls[0].inputHash = '0'.repeat(64); }, f => { f.runs.get(f.step.calls[0].runId).parentRunId = 'foreign-owner'; }]) {
    const f = reproductionFixture(); await f.harness()(f.request); change(f);
    await assert.rejects(f.harness()(f.current), error => ['AUTOMATION_RUN_INPUT_CHANGED', 'AUTOMATION_RUN_OWNER_CHANGED'].includes(error.code));
    assert.equal(f.creates(), 1); assert.deepEqual(f.executed, [f.step.calls[0].runId]);
  }
});

test('legacy reproduction orphan is recovered by actual parent identity; multiple matching old Runs are refused', async () => {
  const f = reproductionFixture();
  await assert.rejects(f.harness({ saveStep: async () => { throw new Error('Step disk unavailable'); } })(f.request), /Step disk unavailable/);
  const id = [...f.runs.keys()][0];
  const result = await f.harness()(f.current);
  assert.equal(result.runId, id); assert.equal(f.creates(), 1); assert.deepEqual(f.step.runIds, [id]); assert.deepEqual(f.executed, [id]);
  const ambiguous = reproductionFixture(); await ambiguous.harness()(ambiguous.request);
  const original = [...ambiguous.runs.values()][0]; ambiguous.runs.set('other-original', { ...clone(original), id: 'other-original' });
  await assert.rejects(ambiguous.harness()(ambiguous.current), reject('AUTOMATION_RUN_UNRESOLVED'));
  assert.equal(ambiguous.creates(), 1); assert.deepEqual(ambiguous.executed, [original.id]);
});
