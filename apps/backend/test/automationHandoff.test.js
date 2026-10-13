import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAutomationHandoff, assertAutomationHandoff } from '../src/services/researchAutomation/handoff.js';
import { ResearchWorkflowError } from '../src/services/researchWorkflow/errors.js';
import { RESEARCH_WORKFLOW_STAGES } from '../src/services/researchWorkflow/stageContracts.js';

function fixture(stage = 'ideation') {
  const workflow = { id: 'workflow', projectId: 'project', version: 12, currentStage: stage,
    stages: RESEARCH_WORKFLOW_STAGES.map(value => ({ id: value.id, status: 'approved', data: {} })) };
  workflow.stages[0].data = { researchQuestion: 'Read and reproduce the paper', hiddenCredential: 'private-never-publish' };
  workflow.stages[1].data = { papers: [{ id: 'paper', title: 'A paper' }], searchSessionIds: ['search-b', 'search-a'],
    task: { harness: { runId: 'search-producer' }, output: { searchSessionIds: ['search-a'] }, status: 'approved', humanDecision: { decision: 'approve' } } };
  workflow.stages[2].data = { selectedPaperIds: ['paper'], task: { harness: { runId: 'selection-producer' } } };
  workflow.stages[3].data = { automaticResult: { id: 'replication-run', status: 'completed', evidenceConfirmed: false } };
  const session = { id: 'session', workflowId: workflow.id, coordinatorRunId: 'coordinator', steps: [
    { stage: 'search', runIds: ['search-producer', 'query-producer'] }, { stage: 'selection', runIds: ['selection-producer'] },
    { stage: 'replication', runIds: ['plan-producer'], experimentRunId: 'replication-run' }
  ] };
  if (!session.steps.some(value => value.stage === stage)) session.steps.push({ stage, runIds: [] });
  return { projectId: 'project', workflow, session, stage, role: 'critic' };
}

test('handoff contains only versioned references, full-data hashes and the actual coordinator identity', () => {
  const input = fixture(), handoff = buildAutomationHandoff(input);
  assert.equal(handoff.schemaVersion, 1); assert.equal(handoff.projectId, 'project'); assert.equal(handoff.sessionId, 'session');
  assert.equal(handoff.workflowId, 'workflow'); assert.equal(handoff.workflowVersion, 12); assert.equal(handoff.stage, 'ideation');
  assert.equal(handoff.role, 'critic'); assert.equal(handoff.parentRunId, 'coordinator');
  assert.deepEqual(handoff.inputArtifacts.map(value => value.stage), ['direction', 'search', 'selection', 'replication']);
  assert.deepEqual(handoff.inputArtifacts[1].producerRunIds, ['query-producer', 'search-producer']);
  assert.deepEqual(handoff.inputArtifacts[1].searchSessionIds, ['search-a', 'search-b']);
  assert.equal(handoff.inputArtifacts[3].experimentRunId, 'replication-run');
  assert.ok(handoff.inputArtifacts.every(value => value.workflowId === 'workflow' && value.workflowVersion === 12 && /^[a-f0-9]{64}$/.test(value.dataSha256)));
  const encoded = JSON.stringify(handoff); assert.equal(encoded.includes('private-never-publish'), false); assert.equal(encoded.includes('A paper'), false);
  assert.equal(encoded.includes('capability'), false); assert.equal(encoded.includes('policy'), false); assert.equal(assertAutomationHandoff(handoff, input), handoff);
});

test('stable JSON hashes ignore key order while retaining the full saved source data', () => {
  const input = fixture('search'); input.workflow.stages[0].data = { z: [1, { b: 2, a: 1 }], a: 'question' };
  const handoff = buildAutomationHandoff(input);
  assert.equal(handoff.inputArtifacts[0].dataSha256, createHash('sha256').update('{"a":"question","z":[1,{"a":1,"b":2}]}').digest('hex'));
  input.workflow.stages[0].data = { a: 'question', z: [1, { a: 1, b: 2 }] };
  assertAutomationHandoff(handoff, input);
  input.workflow.stages[0].data.z.reverse();
  assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_INPUT_CHANGED' });
});

test('source prose, nested approval and producer/search/experiment reference changes all conflict', () => {
  for (const mutate of [
    input => { input.workflow.stages[0].data.researchQuestion = 'Changed question'; },
    input => { input.workflow.stages[1].data.task.humanDecision.decision = 'reject'; },
    input => { input.workflow.stages[1].data.task.harness.runId = 'other'; },
    input => { input.session.steps[0].runIds.push('other-run'); },
    input => { input.workflow.stages[1].data.searchSessionIds.push('other-search'); },
    input => { input.session.steps[2].experimentRunId = 'other-experiment'; input.workflow.stages[3].data.automaticResult.id = 'other-experiment'; },
    input => { input.workflow.stages[2].data = {}; }
  ]) {
    const input = fixture(), handoff = buildAutomationHandoff(input); mutate(input); input.workflow.version++;
    assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_INPUT_CHANGED' });
  }
});

test('workflow version and current or later stage data can advance without invalidating captured inputs', () => {
  const input = fixture(), handoff = buildAutomationHandoff(input);
  input.workflow.version = 19; input.workflow.currentStage = 'writing';
  input.workflow.stages[4].data = { ideas: [{ id: 'idea', selected: true }] };
  input.workflow.stages[5].data = { method: { title: 'Method' } }; input.session.steps.find(value => value.stage === 'ideation').runIds.push('new-current-producer');
  assert.equal(assertAutomationHandoff(handoff, input), handoff);
  assert.equal(handoff.workflowVersion, 12); assert.equal(handoff.inputArtifacts[0].workflowVersion, 12);
  input.workflow.version = 11; assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_INVALID' });
});

test('changing parent, session, target role or stage cannot reuse another specialist handoff', () => {
  for (const change of [input => { input.session.coordinatorRunId = 'new-parent'; }, input => { input.session.id = 'new-session'; },
    input => { input.role = 'writer'; }, input => { input.stage = 'method'; }]) {
    const input = fixture(), handoff = buildAutomationHandoff(input); change(input);
    assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_OWNER_CHANGED' });
  }
  const input = fixture(), handoff = buildAutomationHandoff(input);
  input.projectId = 'other-project'; input.workflow.projectId = input.projectId; input.session.projectId = input.projectId;
  assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_OWNER_CHANGED' });
  const other = fixture(); const saved = buildAutomationHandoff(other); other.workflow.id = 'other-workflow'; other.session.workflowId = other.workflow.id;
  assert.throws(() => assertAutomationHandoff(saved, other), { code: 'AUTOMATION_HANDOFF_OWNER_CHANGED' });
});

test('missing actual coordinator, cross-workflow source and malformed identities are typed errors', () => {
  for (const change of [input => { delete input.session.coordinatorRunId; }, input => { input.session.workflowId = 'different'; },
    input => { input.workflow.projectId = 'other'; }, input => { input.session.projectId = 'other'; }, input => { input.session.id = 'bad\0'; },
    input => { input.role = 'x'.repeat(201); }, input => { input.stage = 'unknown'; }, input => { input.workflow.version = 0; },
    input => { input.session.coordinatorRunId = ' parent'; }]) {
    const input = fixture(); change(input);
    assert.throws(() => buildAutomationHandoff(input), error => error instanceof ResearchWorkflowError && error.code === 'AUTOMATION_HANDOFF_CONTEXT_INVALID');
  }
});

test('empty source stages are omitted but later addition of source content invalidates the transfer', () => {
  const input = fixture('method'); input.session.steps = input.session.steps.filter((value, index, all) => all.findIndex(other => other.stage === value.stage) === index);
  const handoff = buildAutomationHandoff(input); assert.equal(handoff.inputArtifacts.some(value => value.stage === 'ideation'), false);
  input.workflow.stages[4].data = { ideas: ['new source'] };
  assert.throws(() => assertAutomationHandoff(handoff, input), { code: 'AUTOMATION_HANDOFF_INPUT_CHANGED' });
  const initial = fixture('direction'); initial.session.steps = [{ stage: 'direction', runIds: [] }];
  assert.deepEqual(buildAutomationHandoff(initial).inputArtifacts, []);
});

test('ambiguous stages, source identities or experimental references never create provenance', () => {
  for (const change of [input => { input.workflow.stages.pop(); }, input => { input.workflow.stages[1].id = 'direction'; },
    input => { input.session.steps.push({ stage: 'search' }); }, input => { input.session.steps[0].runIds = ['']; },
    input => { input.workflow.stages[1].data.searchSessionIds = 'search-id'; }, input => { input.session.steps[2].experimentRunId = 'different'; },
    input => { input.workflow.stages[0].data = null; }]) {
    const input = fixture(); change(input);
    assert.throws(() => buildAutomationHandoff(input), error => error instanceof ResearchWorkflowError && /^AUTOMATION_HANDOFF_/.test(error.code));
  }
});

test('input arrays, hash, artifact version and authority fields cannot be injected into public handoff', () => {
  for (const change of [handoff => { handoff.capabilities = ['experiment.execute']; }, handoff => { handoff.inputArtifacts[0].data = { prose: 'raw' }; },
    handoff => { handoff.inputArtifacts[0].dataSha256 = 'a'.repeat(64); }, handoff => { handoff.inputArtifacts[0].workflowVersion++; },
    handoff => { handoff.inputArtifacts.reverse(); }, handoff => { handoff.inputArtifacts[0].producerRunIds.push('fake-run'); }]) {
    const input = fixture(), handoff = buildAutomationHandoff(input); change(handoff);
    assert.throws(() => assertAutomationHandoff(handoff, input), error => error instanceof ResearchWorkflowError
      && ['AUTOMATION_HANDOFF_INVALID', 'AUTOMATION_HANDOFF_INPUT_CHANGED'].includes(error.code));
  }
});

test('non-JSON and recursive source data fail typed without leaking raw contents', () => {
  const input = fixture(); const cyclic = { private: 'secret' }; cyclic.self = cyclic; input.workflow.stages[0].data = cyclic;
  assert.throws(() => buildAutomationHandoff(input), error => error.code === 'AUTOMATION_HANDOFF_INPUT_INVALID' && !error.message.includes('secret'));
  input.workflow.stages[0].data = { value: undefined };
  assert.throws(() => buildAutomationHandoff(input), { code: 'AUTOMATION_HANDOFF_INPUT_INVALID' });
});
