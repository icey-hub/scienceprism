import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-intent-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { updateFromRequest, runUiAction } = await import('../src/services/researchWorkflow/application.js');
const { toFrontendWorkflow } = await import('../src/services/researchWorkflow/projection.js');

async function createProject(id) {
  await mkdir(path.join(dataDir, id), { recursive: true });
  await writeFile(path.join(dataDir, id, 'project.json'), '{}\n');
  return initializeResearchWorkflow(id, { data: { researchQuestion: 'Does retrieval reduce error?' }, actor: 'human' });
}

test('direction request replay keeps its task and workflow version', async () => {
  const id = 'direction-replay';
  const initial = await createProject(id);
  const body = { direction: { question: 'Replay question' }, expectedVersion: initial.version, idempotencyKey: 'same-request' };
  const saved = await updateFromRequest(id, body, 'human');
  assert.deepEqual(await updateFromRequest(id, body, 'human'), saved);
});

test('direction condition survives save, refresh, old clients, correction and explicit clearing', async () => {
  const id = 'direction-intent';
  const initial = await createProject(id);
  assert.equal(toFrontendWorkflow(initial).direction.falsificationCondition, '');
  const body = { direction: { question: 'Does retrieval reduce error?', falsificationCondition: ' Error does not improve against the fixed baseline. ' }, expectedVersion: initial.version, idempotencyKey: 'save-intent' };
  const saved = await updateFromRequest(id, body, 'human');
  assert.equal(toFrontendWorkflow(saved).direction.falsificationCondition, body.direction.falsificationCondition.trim());
  assert.equal(saved.currentStage, 'direction');
  const replay = await updateFromRequest(id, body, 'human');
  assert.equal(replay.version, saved.version);
  assert.deepEqual(replay.audit, saved.audit);
  const legacy = await updateFromRequest(id, { direction: { question: 'Corrected question' }, expectedVersion: saved.version }, 'human');
  assert.equal(toFrontendWorkflow(legacy).direction.falsificationCondition, body.direction.falsificationCondition.trim());
  await assert.rejects(updateFromRequest(id, { ...body, idempotencyKey: 'stale' }, 'human'), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await getResearchWorkflow(id), legacy);
  const corrected = await updateFromRequest(id, { direction: { question: 'Corrected question', falsificationCondition: 'Ablation matches the proposed mechanism.' }, expectedVersion: legacy.version }, 'human');
  assert.equal(toFrontendWorkflow(await getResearchWorkflow(id)).direction.falsificationCondition, 'Ablation matches the proposed mechanism.');
  const cleared = await updateFromRequest(id, { direction: { question: 'Corrected question', falsificationCondition: '' }, expectedVersion: corrected.version }, 'human');
  assert.equal(toFrontendWorkflow(cleared).direction.falsificationCondition, '');
  const approved = await approveResearchWorkflow(id, { actor: 'human', expectedVersion: cleared.version });
  assert.equal(approved.currentStage, 'search');
});

test('invalid condition values do not mutate workflow or bypass the research question gate', async () => {
  const id = 'invalid-intent';
  const initial = await createProject(id);
  for (const value of [null, false, 1, {}, [], 'x'.repeat(2001)]) {
    await assert.rejects(updateFromRequest(id, { direction: { question: 'Question', falsificationCondition: value } }, 'human'), { code: 'INVALID_FALSIFICATION_CONDITION' });
    assert.deepEqual(await getResearchWorkflow(id), initial);
  }
  const boundary = await updateFromRequest(id, { direction: { question: '', falsificationCondition: 'x'.repeat(2000) } }, 'human');
  assert.equal(toFrontendWorkflow(boundary).direction.falsificationCondition.length, 2000);
  await assert.rejects(approveResearchWorkflow(id, { actor: 'human' }), { code: 'STAGE_NOT_READY' });
});

async function innovationProject(id) {
  await createProject(id);
  await approveResearchWorkflow(id, { actor: 'human' });
  await updateResearchWorkflow(id, { stageId: 'search', data: { queries: ['retrieval'] } });
  await approveResearchWorkflow(id, { actor: 'human' });
  await updateResearchWorkflow(id, { stageId: 'selection', data: { selectedPaperIds: ['paper-a'] } });
  await approveResearchWorkflow(id, { actor: 'human' });
  await approveResearchWorkflow(id, { actor: 'human', decision: 'skip', note: 'Contract fixture.' });
  return updateResearchWorkflow(id, { stageId: 'ideation', data: { ideas: [{ id: 'a', title: 'Gate', hypothesis: 'Gating reduces error' }, { id: 'b', title: 'Baseline' }] } });
}

const ideationData = workflow => workflow.stages.find(stage => stage.id === 'ideation').data;

test('innovation review persists, replays and preserves omitted conditions across selection changes', async () => {
  const id = 'idea-review';
  const initial = await innovationProject(id);
  const body = { action: 'select-ideas', ideaIds: ['a'], reviews: [{ ideaId: 'a', falsificationCondition: ' No improvement over baseline. ' }], expectedVersion: initial.version, idempotencyKey: 'review' };
  const saved = await runUiAction(id, body, 'human');
  assert.equal(toFrontendWorkflow(saved).ideas[0].humanReview.falsificationCondition, 'No improvement over baseline.');
  assert.equal(saved.currentStage, 'ideation');
  assert.deepEqual(await runUiAction(id, body, 'human'), saved);
  await assert.rejects(runUiAction(id, { ...body, ideaIds: ['b'] }, 'human'), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(ideationData(saved).reviewHistory[0].candidate.hypothesis, 'Gating reduces error');
  const legacy = await runUiAction(id, { action: 'select-ideas', ideaIds: ['b'] }, 'human');
  assert.deepEqual(toFrontendWorkflow(legacy).ideas[0].humanReview, toFrontendWorkflow(saved).ideas[0].humanReview);
  assert.equal(ideationData(legacy).reviewHistory.length, 1);
  const cleared = await runUiAction(id, { action: 'select-ideas', ideaIds: [], reviews: [{ ideaId: 'a', falsificationCondition: '' }] }, 'human');
  assert.equal(toFrontendWorkflow(await getResearchWorkflow(id)).ideas[0].humanReview.falsificationCondition, '');
  assert.equal(ideationData(cleared).reviewHistory.length, 2);
  await assert.rejects(approveResearchWorkflow(id, { actor: 'human' }), { code: 'STAGE_NOT_READY' });
  const selected = await runUiAction(id, { action: 'select-ideas', ideaIds: ['b'] }, 'human');
  assert.equal(toFrontendWorkflow(selected).ideas[1].humanReview, null);
  assert.equal((await approveResearchWorkflow(id, { actor: 'human' })).currentStage, 'method');
});

test('invalid or nonhuman innovation reviews cannot write; stale and concurrent commands are isolated', async () => {
  const id = 'idea-review-invalid';
  const initial = await innovationProject(id);
  for (const reviews of [null, {}, [{ ideaId: 'missing', falsificationCondition: '' }], [{ ideaId: 'a', falsificationCondition: '' }, { ideaId: 'a', falsificationCondition: '' }], [{ ideaId: 'a', falsificationCondition: 1 }], [{ ideaId: 'a', falsificationCondition: 'x'.repeat(2001) }], [{ ideaId: 'a', falsificationCondition: '', actor: 'human' }]]) {
    await assert.rejects(runUiAction(id, { action: 'select-ideas', ideaIds: ['a'], reviews }, 'human'), { code: 'INVALID_IDEA_REVIEW' });
    assert.deepEqual(await getResearchWorkflow(id), initial);
  }
  await assert.rejects(runUiAction(id, { action: 'select-ideas', ideaIds: ['a'], reviews: [] }, 'agent'), { code: 'HUMAN_INPUT_REQUIRED' });
  await assert.rejects(runUiAction(id, { action: 'select-ideas', ideaIds: ['missing'] }, 'human'), { code: 'INVALID_IDEA_SELECTION' });
  const body = { action: 'select-ideas', ideaIds: ['a'], reviews: [{ ideaId: 'a', falsificationCondition: 'x'.repeat(2000) }], expectedVersion: initial.version, idempotencyKey: 'concurrent' };
  const results = await Promise.allSettled([runUiAction(id, body, 'human'), runUiAction(id, { ...body, idempotencyKey: 'other' }, 'human')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const saved = await getResearchWorkflow(id);
  assert.equal(ideationData(saved).reviewHistory.length, 1);
  await assert.rejects(runUiAction(id, { ...body, idempotencyKey: 'stale' }, 'human'), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await getResearchWorkflow(id), saved);
});

test('generated hypotheses, validation plans and comparison survive projection without selecting candidates', async () => {
  const id = 'innovation-intent';
  await createProject(id);
  await approveResearchWorkflow(id, { actor: 'human' });
  await updateResearchWorkflow(id, { stageId: 'search', data: { queries: ['retrieval'] } });
  await approveResearchWorkflow(id, { actor: 'human' });
  await updateResearchWorkflow(id, { stageId: 'selection', data: { selectedPaperIds: ['paper-a'] } });
  await approveResearchWorkflow(id, { actor: 'human' });
  await approveResearchWorkflow(id, { actor: 'human', decision: 'skip', note: 'Metadata-only contract fixture.' });
  const output = { stage: 'innovation_ideas', humanDirection: 'Reduce retrieval error', ideas: [{ id: 'idea-a', title: 'Evidence gate', problem: 'Unsupported retrieval', motivation: 'Reduce error', hypothesis: 'Evidence gating reduces unsupported answers', novelty: 'Candidate mechanism, not verified novelty', relatedPaperIds: [], validationPlan: ['Compare baseline and ablation'], risks: ['Dataset mismatch'], confidence: 0.5 }], comparison: [{ ideaId: 'idea-a', strengths: ['Measurable'], weaknesses: ['Unverified'], differentiator: 'Evidence gate' }], caveats: ['Needs human scientific review'] };
  const generated = await runUiAction(id, { action: 'generate-ideas', adapter: 'fake', fakeResponse: JSON.stringify(output) }, 'human');
  const view = toFrontendWorkflow(await getResearchWorkflow(id));
  assert.equal(generated.currentStage, 'ideation');
  assert.equal(view.ideas[0].selected, false);
  for (const key of ['hypothesis', 'novelty', 'validationPlan', 'risks']) assert.deepEqual(view.ideas[0][key], output.ideas[0][key]);
  assert.deepEqual(view.ideaComparison, output.comparison);
  assert.equal(view.ideaHumanDirection, output.humanDirection);
  assert.deepEqual(view.ideaCaveats, output.caveats);
  const legacy = structuredClone(generated);
  legacy.stages.find(stage => stage.id === 'ideation').data = { ideas: [{ id: 'old', title: 'Legacy candidate' }] };
  const oldView = toFrontendWorkflow(legacy);
  assert.equal(oldView.ideas[0].hypothesis, '');
  assert.deepEqual(oldView.ideas[0].validationPlan, []);
  assert.equal(oldView.ideaHumanDirection, '');
  assert.deepEqual(oldView.ideaCaveats, []);
  const failed = await runUiAction(id, { action: 'generate-ideas', adapter: 'fake', fakeError: 'model unavailable' }, 'human');
  const failedView = toFrontendWorkflow(failed);
  assert.deepEqual(failedView.ideas, []);
  assert.deepEqual(failedView.ideaComparison, []);
  assert.deepEqual(failedView.ideaCaveats, []);
  assert.equal(failedView.ideaHumanDirection, '');
  await assert.rejects(approveResearchWorkflow(id, { actor: 'human' }), { code: 'STAGE_NOT_READY' });
});
