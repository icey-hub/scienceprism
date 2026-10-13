import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/dataset-service/', import.meta.url));
await fsp.mkdir(cache, { recursive: true }); const dataDir = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
process.env.SCIENCEPRISM_DATA_DIR = dataDir; process.env.NODE_ENV = 'test';
after(() => fsp.rm(dataDir, { recursive: true, force: true }));
const { createDatasetService, DatasetError } = await import('../src/services/datasets/index.js');
const { createDatasetRepository } = await import('../src/services/datasets/repository.js');
const { registerDatasetRoutes } = await import('../src/routes/datasets.js');
const { inspectAutomationOwner } = await import('../src/services/researchAutomation/owner.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const url = 'https://raw.githubusercontent.com/owner/repo/main/data.csv';
const privateUrl = 'https://cdn-lfs.hf.co/data?signature=fixture-private-signature';
async function project(id) {
  const root = path.join(dataDir, id); await fsp.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  return root;
}
function fixedDownload(body, calls = []) {
  return async (source, { destination, onProgress, resume, signal }) => {
    signal.throwIfAborted(); calls.push({ source, resume });
    await fsp.writeFile(destination, body, { mode: 0o600 });
    await onProgress({ receivedBytes: body.length, totalBytes: body.length, etag: '"fixed-v1"', resolvedUrl: privateUrl });
    return { sha256: sha(body), byteLength: body.length, resolvedUrl: privateUrl, etag: '"fixed-v1"' };
  };
}
async function waitJob(service, id, jobId, desired) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await service.getJob(id, jobId);
    if ((desired ? job.status === desired : ['completed', 'failed', 'cancelled'].includes(job.status))
      && (!['completed', 'failed', 'cancelled'].includes(job.status)
        || inspectAutomationOwner({ projectRoot: path.join(dataDir, id, '.scienceprism/datasets') })?.released === true)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Dataset job did not reach its durable final state.');
}
function serviceFor(t, options) { const service = createDatasetService(options); t.after(() => service.shutdown()); return service; }

test('actual local import stores one exact immutable version with hash, bounded preview and explicit unverified license', async t => {
  const id = 'import', root = await project(id), service = serviceFor(t), bytes = Buffer.from('name,value\nA,1\nB,2\n');
  const first = await service.importData(id, { filename: 'data.csv', bytes, license: 'CC-BY-4.0', split: 'train' });
  assert.equal(first.job.status, 'completed'); assert.equal(first.dataset.id, `dataset-${sha(bytes)}`);
  assert.equal(first.dataset.byteLength, bytes.length); assert.equal(first.dataset.readOnly, true); assert.equal(first.dataset.split, 'train');
  assert.equal(first.dataset.license.label, 'CC-BY-4.0'); assert.equal(first.dataset.license.verified, false);
  assert.deepEqual(first.dataset.preview.columns, ['name', 'value']); assert.deepEqual(first.dataset.preview.rows, [['A', '1'], ['B', '2']]);
  const blob = path.join(root, '.scienceprism/datasets/blobs', first.dataset.sha256);
  assert.equal(fs.statSync(blob).mode & 0o777, 0o400); assert.deepEqual((await service.content(id, first.dataset.id)).bytes, bytes);
  const duplicate = await service.importData(id, { filename: 'other.csv', bytes });
  assert.equal(duplicate.job.duplicate, true); assert.equal(duplicate.dataset.id, first.dataset.id); assert.equal((await service.list(id)).datasets.length, 1);
});

test('same frozen download configuration reuses completed content and privately retains response validators', async t => {
  const id = 'cache', root = await project(id), calls = [], body = Buffer.from('x,y\n1,2\n'), service = serviceFor(t, { download: fixedDownload(body, calls) });
  const started = await service.startDownload(id, { url, filename: 'data.csv', maxBytes: 20 }), final = await waitJob(service, id, started.job.id, 'completed');
  assert.equal(final.receivedBytes, body.length); assert.equal(final.configuration.version, 1); assert.equal(final.configuration.authority, 'human');
  const again = await service.startDownload(id, { url, filename: 'data.csv', maxBytes: 20 }); assert.equal(again.cached, true); assert.equal(again.job.id, final.id); assert.equal(calls.length, 1);
  const publicData = JSON.stringify(await service.list(id)); assert.equal(publicData.includes('fixture-private-signature'), false);
  assert.equal(Object.hasOwn(final, 'resolvedUrl'), false); assert.equal(Object.hasOwn(final, 'etag'), false);
  assert.equal(publicData.includes('"resolvedUrl"'), false); assert.equal(publicData.includes('"etag"'), false);
  const stored = JSON.parse(await fsp.readFile(path.join(root, '.scienceprism/datasets/index.json'), 'utf8')).jobs[0];
  assert.equal(stored.resolvedUrl, privateUrl); assert.equal(stored.etag, '"fixed-v1"');
});

test('mismatched expected hash never creates a dataset version even when bytes were actually written', async t => {
  const id = 'wrong-hash', root = await project(id), service = serviceFor(t, { download: fixedDownload(Buffer.from('actual')) });
  const started = await service.startDownload(id, { url, filename: 'data.txt', expectedSha256: 'f'.repeat(64) });
  const failed = await waitJob(service, id, started.job.id, 'failed'); assert.equal(failed.error.code, 'DATASET_HASH_MISMATCH');
  assert.equal((await service.list(id)).datasets.length, 0); assert.equal(failed.datasetId, null);
  assert.equal(await fsp.readFile(path.join(root, '.scienceprism/datasets/parts', `${started.job.id}.part`), 'utf8'), 'actual');
});

test('cancel and same-ID resume preserve frozen config and append the actual partial without accepting stale version', async t => {
  const id = 'cancel-resume'; await project(id); let attempts = 0, ready;
  const partialReady = new Promise(resolve => { ready = resolve; });
  const service = serviceFor(t, { download: async (_source, options) => {
    attempts++;
    if (attempts === 1) {
      await fsp.writeFile(options.destination, 'abc', { mode: 0o600 });
      await options.onProgress({ receivedBytes: 3, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl }); ready();
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    assert.deepEqual(options.resume, { receivedBytes: 3, etag: '"fixed-v1"', resolvedUrl: privateUrl });
    assert.equal(await fsp.readFile(options.destination, 'utf8'), 'abc'); await fsp.appendFile(options.destination, 'def');
    await options.onProgress({ receivedBytes: 6, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl });
    return { sha256: sha('abcdef'), byteLength: 6, resolvedUrl: privateUrl, etag: '"fixed-v1"' };
  } });
  const started = await service.startDownload(id, { url, filename: 'data.txt', maxBytes: 6 }); await partialReady;
  const cancelled = await service.cancel(id, started.job.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.receivedBytes, 3);
  await assert.rejects(service.resume(id, started.job.id, { expectedConfigurationVersion: 0 }), { code: 'DATASET_CONFIGURATION_CONFLICT' });
  assert.equal(attempts, 1);
  const resumed = await service.resume(id, started.job.id, { expectedConfigurationVersion: 1 }); assert.equal(resumed.job.id, started.job.id);
  const completed = await waitJob(service, id, started.job.id, 'completed'); assert.equal(completed.configurationSha256, started.job.configurationSha256);
  assert.equal(attempts, 2); assert.equal((await service.content(id, completed.datasetId)).bytes.toString(), 'abcdef');
});

test('per-job byte quota blocks commit and cross-project lookup cannot expose jobs or raw content', async t => {
  const id = 'quota'; await project(id); await project('other-project'); const service = serviceFor(t, { download: fixedDownload(Buffer.from('too large')) });
  const started = await service.startDownload(id, { url, filename: 'data.txt', maxBytes: 2 }), final = await waitJob(service, id, started.job.id, 'failed');
  assert.equal(final.error.code, 'DATASET_TOO_LARGE'); assert.equal((await service.list(id)).datasets.length, 0);
  await assert.rejects(service.getJob('other-project', started.job.id), { code: 'DATASET_JOB_NOT_FOUND', statusCode: 404 });
  const imported = await service.importData(id, { bytes: Buffer.from('one'), filename: 'local.txt' });
  await assert.rejects(service.get('other-project', imported.dataset.id), { code: 'DATASET_NOT_FOUND', statusCode: 404 });
  await assert.rejects(service.content('other-project', imported.dataset.id), { code: 'DATASET_NOT_FOUND', statusCode: 404 });
});

test('tampered configuration and immutable raw content cannot resume or masquerade as the same dataset', async t => {
  const id = 'tamper', root = await project(id), service = serviceFor(t);
  const imported = await service.importData(id, { filename: 'data.txt', bytes: Buffer.from('original') });
  const file = path.join(root, '.scienceprism/datasets/index.json'), index = JSON.parse(await fsp.readFile(file, 'utf8'));
  index.jobs[0].configuration.maxBytes++; await fsp.writeFile(file, JSON.stringify(index));
  await assert.rejects(service.getJob(id, imported.job.id), { code: 'DATASET_CONFIGURATION_CHANGED' });
  await assert.rejects(service.resume(id, imported.job.id, { expectedConfigurationVersion: 1 }), { code: 'DATASET_CONFIGURATION_CHANGED' });
  const blob = path.join(root, '.scienceprism/datasets/blobs', imported.dataset.sha256); await fsp.chmod(blob, 0o600); await fsp.writeFile(blob, 'tampered');
  await assert.rejects(service.content(id, imported.dataset.id), { code: 'DATASET_HASH_MISMATCH' });
});

test('repository rejects symbolic and hard-linked raw files while preserving their targets', async t => {
  for (const kind of ['symbolic', 'hard']) {
    const id = `link-${kind}`, root = await project(id), service = serviceFor(t);
    const imported = await service.importData(id, { filename: 'data.txt', bytes: Buffer.from('original') });
    const blob = path.join(root, '.scienceprism/datasets/blobs', imported.dataset.sha256), original = path.join(root, 'preserved.txt');
    await fsp.rename(blob, original); if (kind === 'symbolic') await fsp.symlink(original, blob); else await fsp.link(original, blob);
    await assert.rejects(service.content(id, imported.dataset.id), error => ['DATASET_UNSAFE_STORAGE', 'DATASET_FILE_UNAVAILABLE'].includes(error.code));
    assert.equal(await fsp.readFile(original, 'utf8'), 'original');
  }
});

test('strict import/download inputs reject forged actor or capability fields before creating a job', async t => {
  const id = 'strict'; await project(id); let network = 0;
  const service = serviceFor(t, { download: async () => { network++; throw new Error('must not execute'); } });
  for (const patch of [{ actor: 'ai' }, { capabilities: ['dataset.acquire'] }, { authority: 'model' }, { configuration: { version: 2 } }]) {
    await assert.rejects(service.startDownload(id, { url, filename: 'data.txt', ...patch }), { code: 'DATASET_INVALID_INPUT' });
    await assert.rejects(service.importData(id, { filename: 'data.txt', bytes: Buffer.from('one'), ...patch }), { code: 'DATASET_INVALID_INPUT' });
  }
  assert.equal(network, 0); assert.equal((await service.list(id)).jobs.length, 0);
});

test('actual Fastify multipart/import/download/content/resume/cancel routes preserve schema and DTO boundaries', async t => {
  const id = 'http'; await project(id); const service = serviceFor(t, { download: fixedDownload(Buffer.from('http data')) });
  const app = Fastify(); await app.register(multipart); registerDatasetRoutes(app, { service }); t.after(() => app.close());
  const base = `/api/projects/${id}/datasets`, boundary = 'dataset-fixture-boundary';
  const imported = await app.inject({ method: 'POST', url: `${base}/import`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\nx,y\n1,2\n\r\n--${boundary}--\r\n` });
  assert.equal(imported.statusCode, 201); assert.equal(imported.json().job.status, 'completed');
  const forbiddenImport = await app.inject({ method: 'POST', url: `${base}/import`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="actor"\r\n\r\nai\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\nx,y\n1,2\n\r\n--${boundary}--\r\n` });
  assert.equal(forbiddenImport.statusCode, 400, 'multipart import must reject undeclared actor fields');
  const content = await app.inject({ method: 'GET', url: `${base}/${imported.json().dataset.id}/content` });
  assert.equal(content.statusCode, 200); assert.equal(content.body, 'x,y\n1,2\n'); assert.equal(content.headers['x-content-type-options'], 'nosniff');
  const started = await app.inject({ method: 'POST', url: `${base}/download`, payload: { url, filename: 'data.txt' } }); assert.equal(started.statusCode, 202);
  await waitJob(service, id, started.json().job.id, 'completed');
  const fetched = await app.inject({ method: 'GET', url: `${base}/jobs/${started.json().job.id}` }); assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.body.includes('fixture-private-signature'), false); assert.equal(fetched.body.includes('resolvedUrl'), false);
  const resumed = await app.inject({ method: 'POST', url: `${base}/jobs/${started.json().job.id}/resume`, payload: { expectedConfigurationVersion: 1 } }); assert.equal(resumed.statusCode, 200); assert.equal(resumed.json().cached, true);
  const cancelled = await app.inject({ method: 'POST', url: `${base}/jobs/${started.json().job.id}/cancel`, payload: {} }); assert.equal(cancelled.statusCode, 200);
  for (const suffix of ['/download', `/jobs/${started.json().job.id}/resume`, `/jobs/${started.json().job.id}/cancel`]) {
    const payload = suffix === '/download' ? { url, filename: 'data.txt', actor: 'ai' } : suffix.endsWith('/resume') ? { expectedConfigurationVersion: 1, capabilities: ['dataset.acquire'] } : { actor: 'ai' };
    const rejected = await app.inject({ method: 'POST', url: `${base}${suffix}`, payload });
    assert.equal(rejected.statusCode, 400, `${suffix} must reject unknown authority fields`);
  }
});

test('HTTP cancel stops the active acquisition and resume continues its same frozen partial job', async t => {
  const id = 'http-partial'; await project(id); let attempts = 0, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const service = serviceFor(t, { download: async (_url, options) => {
    attempts++;
    if (attempts === 1) {
      await fsp.writeFile(options.destination, 'abc', { mode: 0o600 });
      await options.onProgress({ receivedBytes: 3, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl });
      entered(); options.signal.throwIfAborted();
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    assert.equal(options.resume.receivedBytes, 3); await fsp.appendFile(options.destination, 'def');
    await options.onProgress({ receivedBytes: 6, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl });
    return { sha256: sha('abcdef'), byteLength: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl };
  } });
  const app = Fastify(); await app.register(multipart); registerDatasetRoutes(app, { service }); t.after(() => app.close());
  const base = `/api/projects/${id}/datasets`;
  const started = await app.inject({ method: 'POST', url: `${base}/download`, payload: { url, filename: 'data.txt', maxBytes: 6 } });
  assert.equal(started.statusCode, 202); await ready; const jobId = started.json().job.id;
  const cancelled = await app.inject({ method: 'POST', url: `${base}/jobs/${jobId}/cancel`, payload: {} });
  assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().job.status, 'cancelled'); assert.equal(cancelled.json().job.receivedBytes, 3);
  const stale = await app.inject({ method: 'POST', url: `${base}/jobs/${jobId}/resume`, payload: { expectedConfigurationVersion: 0 } });
  assert.equal(stale.statusCode, 409); assert.equal(attempts, 1);
  const resumed = await app.inject({ method: 'POST', url: `${base}/jobs/${jobId}/resume`, payload: { expectedConfigurationVersion: 1 } });
  assert.equal(resumed.statusCode, 200); assert.equal(resumed.json().job.id, jobId);
  const completed = await waitJob(service, id, jobId, 'completed'); assert.equal(attempts, 2);
  const content = await app.inject({ method: 'GET', url: `${base}/${completed.datasetId}/content` });
  assert.equal(content.statusCode, 200); assert.equal(content.body, 'abcdef');
});

test('actual child process death exposes interrupted job and a new service resumes its same ID and strong partial metadata', async t => {
  const id = 'process-recovery', root = await project(id);
  const script = fileURLToPath(new URL('./fixtures/dataset-process.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SCIENCEPRISM_DATA_DIR: dataDir, DATASET_PROBE_PROJECT: id, TMPDIR: dataDir } });
  const exit = once(child, 'exit'); let output = '', errors = '';
  child.stderr.on('data', value => { errors += value; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'Dataset process did not persist partial readiness.')), 10000);
    child.stdout.on('data', value => { output += value; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); } });
    child.once('exit', () => { if (!output.includes('\n')) { clearTimeout(timer); reject(new Error(errors || 'Dataset child exited before readiness.')); } });
  });
  const repository = createDatasetRepository(), resumeCalls = [], service = serviceFor(t, { repository, download: async (source, options) => {
    resumeCalls.push(source); assert.deepEqual(options.resume, { receivedBytes: 3, etag: '"fixed-v1"', resolvedUrl: privateUrl.replace('/data?', '/fixed-data?') });
    assert.equal(await fsp.readFile(options.destination, 'utf8'), 'abc'); await fsp.appendFile(options.destination, 'def');
    await options.onProgress({ receivedBytes: 6, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: privateUrl });
    return { sha256: sha('abcdef'), byteLength: 6, resolvedUrl: privateUrl, etag: '"fixed-v1"' };
  } });
  assert.equal(ready.pid, child.pid); assert.equal((await service.getJob(id, ready.jobId)).status, 'running');
  const originalIndex = await fsp.readFile(path.join(root, '.scienceprism/datasets/index.json'), 'utf8');
  await assert.rejects(service.resume(id, ready.jobId, { expectedConfigurationVersion: 1 }), { code: 'DATASET_PROJECT_BUSY' });
  assert.equal(await fsp.readFile(path.join(root, '.scienceprism/datasets/index.json'), 'utf8'), originalIndex);
  child.kill('SIGKILL'); await exit; assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal((await service.getJob(id, ready.jobId)).status, 'interrupted');
  const resumed = await service.resume(id, ready.jobId, { expectedConfigurationVersion: 1 }); assert.equal(resumed.job.id, ready.jobId);
  const completed = await waitJob(service, id, ready.jobId, 'completed'); assert.equal(resumeCalls.length, 1);
  assert.equal((await service.content(id, completed.datasetId)).bytes.toString(), 'abcdef'); assert.equal((await service.list(id)).jobs.length, 1);
  t.diagnostic(`actual dataset owner PID ${ready.pid} SIGKILL + ESRCH; same job ${ready.jobId} resumed 3→6 bytes with fixed configuration v1`);
});
