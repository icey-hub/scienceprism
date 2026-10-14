import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, degrees } from 'pdf-lib';
import { capabilities, recognize } from '../src/services/readingOcr/vision.js';
const directory = path.resolve('.cache/research-workbench-v2/reading-ocr-tests'); await fs.mkdir(directory, { recursive: true });
const work = await fs.mkdtemp(path.join(directory, 'actual-')); after(() => fs.rm(work, { recursive: true, force: true }));
async function fixture(rotation = 0, crop = false) {
  const canvas = createCanvas(800, 600), context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 800, 600);
  context.fillStyle = 'black'; context.font = '44px Arial'; context.fillText('TOP REGION TEXT', 70, 130); context.fillText('CROP VISIBLE TEXT', 90, 270); context.fillText('BOTTOM OUTSIDE REGION', 50, 510);
  const document = await PDFDocument.create(), page = document.addPage([800, 600]), image = await document.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 0, y: 0, width: 800, height: 600 }); page.setRotation(degrees(rotation)); if (crop) page.setCropBox(50, 200, 700, 200);
  const file = path.join(work, `image-only-${rotation}${crop ? "-crop" : ""}.pdf`); await fs.writeFile(file, await document.save()); return file;
}
const base = { page: 1, region: { x: 0, y: 0, width: 1, height: 0.5 }, rotation: 0, language: 'en' };
test('actual local Vision on image-only PDF: crop provenance, coordinates, intrinsic rotation is not applied twice, PID stopped', { skip: process.platform !== 'darwin' }, async () => {
  const capability = await capabilities();
  assert.equal(capability.available, true, capability.reason); assert.equal(capability.engine, 'apple-vision'); assert.ok(capability.languages.includes('zh-Hans')); assert.ok(capability.languages.includes('en-US'));
  const file = await fixture(), rotated = await fixture(90), processEvents = [];
  const result = await recognize({ ...base, pdfPath: file, onProcess: async state => processEvents.push(state) });
  assert.match(result.text, /TOP REGION TEXT/); assert.doesNotMatch(result.text, /BOTTOM|OUTSIDE/); assert.equal(result.basis, 'crop-image-top-left-normalized'); assert.equal(result.pdfRotation, 0); assert.equal(result.rotation, 0);
  assert.equal(result.width, 2400); assert.equal(result.height, 900); assert.equal(processEvents.length, 2); assert.equal(processEvents[0].stopConfirmed, false); assert.equal(processEvents[1].stopConfirmed, true); assert.throws(() => process.kill(processEvents[1].pid, 0), { code: 'ESRCH' });
  for (const line of result.lines) { assert.ok(line.confidence >= 0 && line.confidence <= 1); assert.ok(line.rect.x >= 0 && line.rect.y >= 0 && line.rect.x + line.rect.width <= 1.000001 && line.rect.y + line.rect.height <= 1.000001); }
  const intrinsic = await recognize({ ...base, pdfPath: rotated }); assert.equal(intrinsic.pdfRotation, 90); assert.equal(intrinsic.rotation, 0); assert.equal(intrinsic.text, result.text); assert.equal(intrinsic.width, result.width); assert.equal(intrinsic.height, result.height);
  const viewer = await recognize({ ...base, pdfPath: rotated, rotation: 90 }); assert.equal(viewer.rotation, 90); assert.equal(viewer.width, 900); assert.equal(viewer.height, 2400);
  const cropFile = await fixture(0, true), cropRotatedFile = await fixture(90, true);
  const cropped = await recognize({ ...base, pdfPath: cropFile }); assert.match(cropped.text, /CROP VISIBLE TEXT/); assert.doesNotMatch(cropped.text, /TOP REGION|BOTTOM/); assert.deepEqual(cropped.visibleBox, { x: 50, y: 200, width: 700, height: 200 }); assert.equal(cropped.width, 2100); assert.equal(cropped.height, 300);
  const croppedIntrinsic = await recognize({ ...base, pdfPath: cropRotatedFile }); assert.equal(croppedIntrinsic.text, cropped.text); assert.equal(croppedIntrinsic.pdfRotation, 90);
  const croppedViewer = await recognize({ ...base, pdfPath: cropRotatedFile, rotation: 90 }); assert.equal(croppedViewer.width, 300); assert.equal(croppedViewer.height, 2100);
  await fs.writeFile(path.join(directory, 'latest-actual.json'), JSON.stringify({ capability, result, intrinsic, viewer, cropped, croppedIntrinsic, croppedViewer, processEvents }, null, 2));
});
test('real cancellation awaits worker close; invalid page/region/symlink never becomes a result', { skip: process.platform !== 'darwin' }, async () => {
  const file = await fixture(), controller = new AbortController(), events = [];
  await assert.rejects(recognize({ ...base, pdfPath: file, signal: controller.signal, onProcess: async state => { events.push(state); if (!state.stopConfirmed) controller.abort(); } }), { code: 'OCR_CANCELLED' });
  assert.equal(events.at(-1).stopConfirmed, true); assert.throws(() => process.kill(events.at(-1).pid, 0), { code: 'ESRCH' });
  await assert.rejects(recognize({ ...base, pdfPath: file, region: { x: 0.9, y: 0, width: 0.2, height: 1 } }), { code: 'OCR_INPUT_INVALID' });
  await assert.rejects(recognize({ ...base, pdfPath: file, page: 2 }), { code: 'OCR_PDF_INVALID' });
  const link = path.join(work, 'link.pdf'); await fs.symlink(file, link); await assert.rejects(recognize({ ...base, pdfPath: link }), { code: 'OCR_PDF_INVALID' });
});
