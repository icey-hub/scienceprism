import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { PDFDocument } from 'pdf-lib';

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-ocr-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createReadingOcrService } = await import('../src/services/readingOcr/index.js');
const { registerReadingOcrRoutes } = await import('../src/routes/readingOcr.js');
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
const { createAttachmentRepository } = await import('../src/services/paperAttachments/repository.js');
const { getStoredTask, updateTask } = await import('../src/services/projectHub/taskCenter.js');
after(() => fs.rm(data, { recursive: true, force: true }));
const capability = { available: true, engine: 'test-local', version: '1', languages: ['en-US'] };
const raw = { text: 'Original scan text', lines: [{ text: 'Original scan text', confidence: 0.8, rect: { x: 0.1, y: 0.1, width: 0.6, height: 0.1 } }], engine: capability.engine, version: capability.version, language: 'en-US', basis: 'crop-image-top-left-normalized', width: 600, height: 400 };
const human = { 'x-scienceprism-actor': 'human' };
async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  const paper = (await importPaper(id, { title: 'OCR source', authors: ['Author'] })).paper;
  const pdf = await PDFDocument.create(); pdf.addPage([200, 300]);
  const { attachment } = await createAttachmentRepository().store(id, paper.id, Buffer.from(await pdf.save()), { filename: 'scan.pdf' });
  const input = { operationId: 'first-operation', source: { attachmentId: attachment.id, fileSha256: attachment.sha256, page: 1, region: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 }, rotation: 0 }, language: 'en-US' };
  return { root, paper, input };
}
async function settled(service, project, paper, id) {
  for (let count = 0; count < 200; count++) {
    const result = await service.get(project, paper, id);
    if (!['queued', 'running'].includes(result.task.status)) return result.task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('OCR did not settle');
}
test('HTTP owner preserves source/raw, deduplicates launches and cached crops, CAS correction and versioned translation survive reload', async () => {
  const { paper, input } = await fixture('http'); let calls = 0, translations = 0;
  const engine = { capabilities: async () => capability, recognize: async ({ pdfPath }) => { assert.match((await fs.readFile(pdfPath)).toString('ascii', 0, 5), /%PDF-/); calls++; return raw; } };
  const translate = async (_, request) => { translations++; return { ...request, sourceText: request.text, translatedText: '人工修订后的译文', translatedAt: new Date().toISOString() }; };
  const service = createReadingOcrService({ engine, translate }), app = Fastify(); registerReadingOcrRoutes(app, { service });
  const base = `/api/projects/http/papers/${paper.id}/ocr`;
  assert.equal((await app.inject({ method: 'POST', url: base, payload: input })).statusCode, 403);
  const first = await app.inject({ method: 'POST', url: base, payload: input, headers: human }); assert.equal(first.statusCode, 200, first.body);
  const id = first.json().task.id; const task = await settled(service, 'http', paper.id, id); assert.equal(task.status, 'completed');
  const replay = await service.start('http', paper.id, input); assert.equal(replay.task.id, id); assert.equal(calls, 1);
  await assert.rejects(service.start('http', paper.id, { ...input, source: { ...input.source, rotation: 90 } }), { code: 'OCR_OPERATION_CONFLICT' });
  const edits = await Promise.all(['human one', 'human two'].map(text => app.inject({ method: 'PATCH', url: `${base}/${id}/correction`, headers: human, payload: { expectedRevision: 0, text } })));
  assert.deepEqual(edits.map(r => r.statusCode).sort(), [200, 409]);
  const corrected = (await service.get('http', paper.id, id)).task.metadata.ocr;
  assert.equal(corrected.raw.text, raw.text); assert.equal(corrected.correction.revision, 1);
  const request = { expectedRevision: 1, operationId: 'translate-operation', providerId: 'google-web', targetLanguage: 'zh-CN' };
  const translated = await service.translate('http', paper.id, id, request);
  assert.equal(translated.translation.sourceText, corrected.correction.text); assert.equal(translated.translation.correctionRevision, 1);
  const restored = createReadingOcrService({ engine, translate });
  assert.equal((await restored.translate('http', paper.id, id, request)).translation.translatedText, translated.translation.translatedText); assert.equal(translations, 1);
  const cache = (await restored.start('http', paper.id, { ...input, operationId: 'cached-operation' })).task.metadata.ocr;
  assert.equal(cache.cachedFromTaskId, id); assert.equal(cache.correction.revision, 0); assert.equal(cache.correction.text, raw.text); assert.equal(calls, 1);
  const wrongSource = { ...input, operationId: 'invalid-source', source: { ...input.source, fileSha256: '0'.repeat(64) } };
  await assert.rejects(service.start('http', paper.id, wrongSource), { code: 'OCR_SOURCE_CHANGED' });
  await assert.rejects(service.start('http', paper.id, { ...input, operationId: 'invalid-page', source: { ...input.source, page: 2 } }), { code: 'OCR_SOURCE_CHANGED' });
  await app.close();
});
test('cancellation waits for owner cleanup; retry creates linked task and unconfirmed stop blocks redispatch', async () => {
  const { paper, input } = await fixture('cancel'); let launched; const ready = new Promise(resolve => { launched = resolve; });
  const service = createReadingOcrService({ engine: { capabilities: async () => capability, recognize: async ({ signal, onProcess }) => {
    await onProcess({ pid: 987654, stopConfirmed: false }); launched();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    await onProcess({ pid: 987654, stopConfirmed: true }); signal.throwIfAborted();
  } } });
  const { task } = await service.start('cancel', paper.id, input); await ready;
  await assert.rejects(service.start('cancel', paper.id, { ...input, operationId: 'another-operation' }), { code: 'OCR_BUSY' });
  const cancelled = (await service.cancel('cancel', paper.id, task.id)).task;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.metadata.ocr.worker.stopConfirmed, true);
  const restored = createReadingOcrService({ engine: { capabilities: async () => capability, recognize: async () => raw } });
  const retried = (await restored.retry('cancel', paper.id, task.id, { operationId: 'retry-operation' })).task;
  assert.notEqual(retried.id, task.id); assert.equal(retried.metadata.ocr.retryOf, task.id);
  assert.equal((await settled(restored, 'cancel', paper.id, retried.id)).status, 'completed');
  let workerAlive = true;
  const unconfirmed = createReadingOcrService({ engine: { capabilities: async () => ({ ...capability, version: '2' }), recognize: async ({ onProcess }) => { await onProcess({ pid: 987654, stopConfirmed: false }); throw Object.assign(new Error('uncertain'), { code: 'OCR_STOP_UNCONFIRMED' }); } }, processAlive: pid => pid === process.pid || workerAlive });
  const paused = (await unconfirmed.start('cancel', paper.id, { ...input, operationId: 'unconfirmed-operation' })).task;
  assert.equal((await settled(unconfirmed, 'cancel', paper.id, paused.id)).status, 'paused');
  await assert.rejects(unconfirmed.retry('cancel', paper.id, paused.id, { operationId: 'unsafe-retry' }), { code: 'OCR_NOT_RETRYABLE' });
  workerAlive = false;
  assert.equal((await unconfirmed.get('cancel', paper.id, paused.id)).task.status, 'failed');
});
test('interrupted owners reconcile without launching work; corrupt receipts never silently resend', async () => {
  const { root, paper, input } = await fixture('recover'); let calls = 0;
  const engine = { capabilities: async () => capability, recognize: async () => { calls++; return raw; } };
  const original = createReadingOcrService({ engine }); const { task } = await original.start('recover', paper.id, input); await settled(original, 'recover', paper.id, task.id);
  await updateTask('recover', task.id, { status: 'running', metadata: { ocr: { ...task.metadata.ocr, worker: { ownerPid: 987654, pid: 987655, stopConfirmed: false } } } });
  const recovered = createReadingOcrService({ engine, processAlive: () => false });
  assert.equal((await recovered.get('recover', paper.id, task.id)).task.error.code, 'OCR_INTERRUPTED'); assert.equal(calls, 1);
  assert.equal((await recovered.start('recover', paper.id, input)).task.id, task.id); assert.equal(calls, 1);
  const file = path.join(root, '.scienceprism/reading-ocr-requests.json'); await fs.writeFile(file, 'broken');
  await assert.rejects(recovered.start('recover', paper.id, { ...input, operationId: 'after-corruption' }), { code: 'OCR_STORAGE_INVALID' });
  assert.equal(await fs.readFile(file, 'utf8'), 'broken'); assert.equal((await getStoredTask('recover', task.id)).status, 'failed');
});
test('simultaneous projects reserve the two-worker bound before persistent writes', async () => {
  const inputs = await Promise.all(['parallel-a', 'parallel-b', 'parallel-c'].map(fixture));
  const service = createReadingOcrService({ engine: { capabilities: async () => capability, recognize: async ({ signal }) => {
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); signal.throwIfAborted();
  } } });
  const ids = ['parallel-a', 'parallel-b', 'parallel-c'];
  const results = await Promise.allSettled(inputs.map((input, i) => service.start(ids[i], input.paper.id, input.input)));
  try {
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'OCR_BUSY');
  } finally {
    for (const [i, result] of results.entries()) if (result.status === 'fulfilled') await service.cancel(ids[i], inputs[i].paper.id, result.value.task.id);
  }
});
