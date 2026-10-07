import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-selection-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { runUiAction } = await import('../src/services/researchWorkflow/application.js');
const { toFrontendWorkflow } = await import('../src/services/researchWorkflow/projection.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');

async function fixture(id) {
  await mkdir(path.join(dataDir, id), { recursive: true });
  await writeFile(path.join(dataDir, id, 'project.json'), '{}\n');
  let workflow = await initializeResearchWorkflow(id);
  workflow = await updateResearchWorkflow(id, { stageId: 'direction', data: { researchQuestion: 'Does retrieval improve accuracy?' } });
  workflow = await approveResearchWorkflow(id, { stageId: 'direction' });
  const evaluations = ['a', 'b', 'blocked'].map((paperId) => ({
    id: paperId, decision: paperId === 'blocked' ? 'reject' : 'accept',
    candidate: { id: paperId, title: `Paper ${paperId}`, url: `https://example.org/${paperId}`, abstract: 'Abstract only', retrievedAt: '2026-10-01T00:00:00Z', sourceRecords: [{ provider: 'fixture', id: paperId, version: 'v1' }] }
  }));
  workflow = await updateResearchWorkflow(id, { stageId: 'search', data: { queries: ['retrieval accuracy'], evaluations, policy: { venueLevel: 'Any' }, aiSearchStrategy: { inclusionCriteria: ['has evaluation'] } } });
  return approveResearchWorkflow(id, { stageId: 'search' });
}
const selection = (workflow) => workflow.stages.find((stage) => stage.id === 'selection').data;
const act = (id, body, actor = 'human') => runUiAction(id, { action: 'select-papers', ...body }, actor);

test('stale paper selection rejects before any evidence side effect', async () => {
  const id = 'selection-stale';
  const workflow = await fixture(id);
  const ledger = await getEvidenceLedger(id);
  await assert.rejects(act(id, { paperIds: ['a'], expectedVersion: workflow.version - 1 }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual((await getEvidenceLedger(id)).entries, ledger.entries);
  await assert.rejects(readFile(path.join(dataDir, id, '.scienceprism/evidence-ledger.json')), { code: 'ENOENT' });
  assert.deepEqual(await getResearchWorkflow(id), workflow);
});

test('human review reasons persist with source and criteria context, correction and withdrawal history', async () => {
  const id = 'selection-reasons';
  let workflow = await fixture(id);
  const review = { paperId: 'a', decision: 'include', reason: 'Reports an accuracy baseline', criterion: 'has evaluation' };
  const excluded = { paperId: 'b', decision: 'exclude', reason: 'Only a protocol', criterion: 'requires reported results' };
  workflow = await act(id, { paperIds: ['a'], reviews: [review, excluded], expectedVersion: workflow.version });
  let data = selection(await getResearchWorkflow(id));
  assert.equal(data.reviews.find((item) => item.paperId === 'a').reason, review.reason);
  assert.equal(data.reviews.find((item) => item.paperId === 'b').decision, 'exclude');
  assert.equal(data.reviewHistory.length, 2);
  const event = data.reviewHistory.find((item) => item.paperId === 'a');
  assert.equal(event.actor, 'human');
  assert.equal(event.paper.sourceRecords[0].version, 'v1');
  assert.deepEqual(event.context.queries, ['retrieval accuracy']);
  assert.deepEqual(event.context.inclusionCriteria, ['has evaluation']);
  assert.equal(toFrontendWorkflow(workflow).papers.find((item) => item.id === 'b').humanReview.reason, excluded.reason);
  const evidenceIds = data.evidenceIds;
  const ledger = await getEvidenceLedger(id);
  workflow = await act(id, { paperIds: ['a'], reviews: [{ ...review, reason: 'Corrected after checking abstract' }], expectedVersion: workflow.version });
  data = selection(workflow);
  assert.equal(data.reviewHistory.length, 3);
  assert.equal(data.reviewHistory[0].reason, review.reason);
  assert.equal(data.reviews.find((item) => item.paperId === 'b').reason, excluded.reason);
  assert.deepEqual(await getEvidenceLedger(id), ledger, 'editing reasons must not overwrite evidence');
  workflow = await act(id, { paperIds: [], reviews: [{ paperId: 'a', decision: 'undecided', reason: '', criterion: '' }], expectedVersion: workflow.version });
  assert.deepEqual(selection(workflow).selectedPaperIds, []);
  assert.equal(selection(workflow).reviewHistory.length, 4);
  assert.equal(selection(workflow).reviews.find((item) => item.paperId === 'a').decision, 'undecided');
  assert.deepEqual(await getEvidenceLedger(id), ledger, 'withdrawal retains existing evidence for downstream references');
  assert.ok(evidenceIds.length);
  await assert.rejects(approveResearchWorkflow(id, { stageId: 'selection' }), { code: 'STAGE_NOT_READY' });
});

test('invalid reviews, nonhuman selection, blocked papers and wrong stages do not write evidence', async () => {
  const id = 'selection-invalid';
  const workflow = await fixture(id);
  const ledger = await getEvidenceLedger(id);
  const bad = [
    { paperIds: ['a'], reviews: [{ paperId: 'foreign', decision: 'include' }] },
    { paperIds: ['a'], reviews: [{ paperId: 'a', decision: 'exclude', reason: 'conflict' }] },
    { paperIds: [], reviews: [{ paperId: 'a', decision: 'include', reason: 'conflict' }] },
    { paperIds: [], reviews: [{ paperId: 'a', decision: 'exclude', reason: 42 }] },
    { paperIds: [], reviews: [{ paperId: 'a', decision: 'exclude', reason: 'x'.repeat(2001) }] },
    { paperIds: [], reviews: [{ paperId: 'a', decision: 'undecided' }, { paperId: 'a', decision: 'undecided' }] },
    { paperIds: [], reviews: {} }, { paperIds: 'a' }, { paperIds: ['a', 'a'] }
  ];
  for (const body of bad) await assert.rejects(act(id, body), { code: 'INVALID_PAPER_SELECTION' });
  await assert.rejects(act(id, { paperIds: ['a'] }, 'ai'), { code: 'HUMAN_INPUT_REQUIRED' });
  await assert.rejects(act(id, { paperIds: ['blocked'] }), { code: 'QUALITY_GATE' });
  assert.deepEqual((await getEvidenceLedger(id)).entries, ledger.entries);
  await assert.rejects(readFile(path.join(dataDir, id, '.scienceprism/evidence-ledger.json')), { code: 'ENOENT' });
  assert.deepEqual(await getResearchWorkflow(id), workflow);
  await act(id, { paperIds: ['a'] });
  await approveResearchWorkflow(id, { stageId: 'selection' });
  const after = await getEvidenceLedger(id);
  await assert.rejects(act(id, { paperIds: ['b'] }), { code: 'STAGE_GATE' });
  assert.deepEqual(await getEvidenceLedger(id), after);
});

test('replay is side effect free and concurrent choices accept exactly one version', async () => {
  const id = 'selection-concurrent';
  const workflow = await fixture(id);
  const request = { paperIds: ['a'], expectedVersion: workflow.version, idempotencyKey: 'choose-a' };
  const saved = await act(id, request);
  const ledger = await getEvidenceLedger(id);
  assert.deepEqual(await act(id, request), saved);
  assert.deepEqual(await getEvidenceLedger(id), ledger);
  await assert.rejects(act(id, { ...request, reviews: [{ paperId: 'a', decision: 'include', reason: 'changed' }] }), { code: 'IDEMPOTENCY_KEY_REUSED' });
  const results = await Promise.allSettled([
    act(id, { paperIds: [], expectedVersion: saved.version, idempotencyKey: 'clear' }),
    act(id, { paperIds: ['b'], expectedVersion: saved.version, idempotencyKey: 'choose-b' })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const final = await getResearchWorkflow(id);
  const cleared = results[0].status === 'fulfilled';
  assert.deepEqual(selection(final).selectedPaperIds, cleared ? [] : ['b']);
  const finalLedger = await getEvidenceLedger(id);
  if (cleared) assert.deepEqual(finalLedger, ledger, 'losing request must not add paper b');
  else assert.equal(finalLedger.entries.length, ledger.entries.length + 1);
  assert.equal(selection(final).reviews.find((item) => item.paperId === 'a').decision, 'undecided');
  assert.equal(selection(final).reviews.find((item) => item.paperId === 'a').reason, '');
});
