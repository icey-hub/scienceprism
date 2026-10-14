import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { PDFDocument } from 'pdf-lib';

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-explanations-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createReadingExplanationService } = await import('../src/services/readingExplanations.js');
const { registerReadingExplanationRoutes } = await import('../src/routes/readingExplanations.js');
const { createAttachmentRepository } = await import('../src/services/paperAttachments/repository.js');
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { startAssistantRun } = await import('../src/services/assistantService.js');
const { waitForHarnessRun, cancelHarnessRun, listHarnessRuns } = await import('../src/services/harnessRuntime/index.js');
after(() => fs.rm(data, { recursive: true, force: true }));
async function fixture(id) {
  await fs.mkdir(path.join(data, id)); await fs.writeFile(path.join(data, id, 'project.json'), JSON.stringify({ id }));
  await fs.writeFile(path.join(data, id, 'private-draft.tex'), 'DRAFT_MUST_NOT_ENTER_READING_CONTEXT');
  const { paper } = await importPaper(id, { title: 'Reading fixture', authors: ['Fixture'] });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const { attachment } = await createAttachmentRepository().store(id, paper.id, Buffer.from(await pdf.save()), { filename: 'reading.pdf' });
  return { paper, selection: { id: 'selection-1', text: 'Generalization depends on data coverage.', page: 1, attachmentId: attachment.id, fileSha256: attachment.sha256, rects: [{ x: .1, y: .2, width: .4, height: .05 }] } };
}
test('reading uses the existing ledger with no file/tool grant, real source binding and persistent request identity', async () => {
  const { paper, selection } = await fixture('reading');
  const service = createReadingExplanationService({ startRun: (project, body, options) => startAssistantRun(project, body, { ...options, adapter: 'fake', fakeResponse: 'Only a bounded reading explanation.' }) });
  const body = { requestId: 'reading-request-1', selection, targetLanguage: 'zh-CN' };
  const first = await service.explain('reading', paper.id, body);
  const run = await waitForHarnessRun('reading', first.run.id);
  assert.equal(run.status, 'completed'); assert.equal(run.request.source, 'paper-reading'); assert.equal(run.request.readingSource.paperId, paper.id);
  assert.deepEqual(run.capabilities.granted, []); assert.equal(run.fallback, false); assert.equal(run.patches.length, 0); assert.equal(run.contextPack.files.length, 0);
  assert.equal(run.reply, 'Only a bounded reading explanation.'); assert.equal(run.constraintProposal, undefined);
  const again = await createReadingExplanationService({ startRun: (project, request, options) => startAssistantRun(project, request, { ...options, adapter: 'fake', fakeResponse: 'must not replace result' }) }).explain('reading', paper.id, body);
  assert.equal(again.run.id, run.id);
  await assert.rejects(service.explain('reading', paper.id, { ...body, selection: { ...selection, rects: [{ x: .2, y: .2, width: .4, height: .05 }] } }), e => e.code === 'REQUEST_ID_CONFLICT');
  assert.equal((await service.list('reading', paper.id)).runs.length, 1);
  const { paper: other } = await importPaper('reading', { title: 'Another reading paper' });
  const pdf = await PDFDocument.create(); pdf.addPage();
  const { attachment } = await createAttachmentRepository().store('reading', other.id, Buffer.from(await pdf.save()), { filename: 'other.pdf' });
  const newer = await service.explain('reading', other.id, { requestId: 'reading-request-2', selection: { ...selection, attachmentId: attachment.id, fileSha256: attachment.sha256 } });
  await waitForHarnessRun('reading', newer.run.id);
  assert.equal((await listHarnessRuns('reading', { source: 'paper-reading', readingPaperId: paper.id, limit: 1 }))[0].id, run.id);
  assert.deepEqual((await service.list('reading', paper.id)).runs.map(item => item.id), [run.id]);
  assert.equal(await fs.readFile(path.join(data, 'reading/private-draft.tex'), 'utf8'), 'DRAFT_MUST_NOT_ENTER_READING_CONTEXT');
});
test('source or input failures prevent dispatch; unsupported configuration cannot come from the browser', async () => {
  const { paper, selection } = await fixture('invalid'); let calls = 0;
  const service = createReadingExplanationService({ startRun: async () => { calls++; throw new Error('must not dispatch'); } });
  const body = { requestId: 'invalid-request-1', selection };
  for (const input of [{ ...body, llmConfig: { apiKey: 'not-accepted' } }, { ...body, selection: { ...selection, text: '' } }, { ...body, selection: { ...selection, rects: [{ x: .9, y: 0, width: .5, height: .1 }] } }]) {
    await assert.rejects(service.explain('invalid', paper.id, input), e => e.code === 'READING_EXPLANATION_INVALID');
  }
  for (const changed of [{ ...selection, page: 2 }, { ...selection, fileSha256: 'a'.repeat(64) }]) await assert.rejects(service.explain('invalid', paper.id, { ...body, selection: changed }), e => e.code === 'READING_SOURCE_CHANGED');
  const { paper: other } = await importPaper('invalid', { title: 'Other paper' });
  await assert.rejects(service.explain('invalid', other.id, body), e => e.code === 'ATTACHMENT_NOT_FOUND');
  assert.equal(calls, 0);
});
test('the original Run cancels and retrying its request returns that result instead of creating another model run', async () => {
  const { paper, selection } = await fixture('cancel');
  const service = createReadingExplanationService({ startRun: (project, request, options) => startAssistantRun(project, request, { ...options, adapter: 'fake', fakeDelayMs: 500, fakeResponse: 'late answer' }) });
  const body = { requestId: 'cancel-request-1', selection };
  const { run } = await service.explain('cancel', paper.id, body);
  await cancelHarnessRun('cancel', run.id);
  const repeated = await service.explain('cancel', paper.id, body);
  assert.equal(repeated.run.id, run.id); assert.equal(repeated.run.status, 'cancelled'); assert.equal((await service.list('cancel', paper.id)).runs.length, 1);
});
test('reading routes preserve input errors and return only the paper reading history', async () => {
  const { paper, selection } = await fixture('route');
  const app = Fastify();
  registerReadingExplanationRoutes(app, { service: createReadingExplanationService({ startRun: (project, request, options) => startAssistantRun(project, request, { ...options, adapter: 'fake', fakeResponse: 'Reading response' }) }) });
  try {
    const url = `/api/projects/route/papers/${paper.id}/explanations`;
    assert.equal((await app.inject('/api/projects/route/papers/missing-paper/explanations')).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url, payload: { requestId: 'route-request-1', selection } }); assert.equal(response.statusCode, 200);
    await waitForHarnessRun('route', response.json().run.id);
    const listed = (await app.inject(url)).json(); assert.equal(listed.runs.length, 1); assert.equal(listed.runs[0].request.readingSource.selection.text, selection.text);
  } finally { await app.close(); }
});
