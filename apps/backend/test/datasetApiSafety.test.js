import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/dataset-api-safety/', import.meta.url));
await fsp.mkdir(cache, { recursive: true }); const data = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
process.env.SCIENCEPRISM_DATA_DIR = data; process.env.NODE_ENV = 'test'; after(() => fsp.rm(data, { recursive: true, force: true }));
const { registerProjectRoutes } = await import('../src/routes/projects.js');
const { datasetService } = await import('../src/services/datasets/index.js');
const { listTasks, cancelTask, retryTask } = await import('../src/services/projectHub/taskCenter.js');
after(() => datasetService.shutdown());

async function fixture(t, id) {
  const root = path.join(data, id); await fsp.mkdir(root); await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fsp.writeFile(path.join(root, 'note.txt'), 'ordinary project text');
  const imported = await datasetService.importData(id, { filename: 'data.csv', bytes: Buffer.from('x,y\n1,2\n') });
  const indexPath = path.join(root, '.scienceprism/datasets/index.json'), index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  // The acquisition actually completed above. Add only representative private
  // response metadata to prove bulk project views cannot disclose this index.
  index.jobs[0].resolvedUrl = 'https://cdn-lfs.hf.co/data?signature=private-listing-fixture';
  await fsp.writeFile(indexPath, JSON.stringify(index));
  const app = Fastify(); await app.register(multipart, { preservePath: true }); registerProjectRoutes(app); t.after(() => app.close());
  return { root, imported, app, base: `/api/projects/${id}`, id };
}
async function protectedSnapshot(root) {
  const result = {};
  const walk = async relative => {
    for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
      const target = path.join(relative, entry.name); if (entry.isDirectory()) await walk(target);
      else result[target] = { bytes: (await fsp.readFile(path.join(root, target))).toString('base64'), mode: (await fsp.stat(path.join(root, target))).mode & 0o777 };
    }
  };
  await walk('.scienceprism/datasets'); return result;
}

test('generic relative file/blob/mutation APIs cannot expose or edit data storage or rename/delete its parents', async t => {
  const f = await fixture(t, 'relative-guard'), before = await protectedSnapshot(f.root);
  const files = await f.app.inject({ method: 'GET', url: `${f.base}/files` });
  assert(files.statusCode === 200 && files.json().files.some(file => file.path === 'note.txt')
    && files.json().files.every(file => !file.path.startsWith('.scienceprism/datasets/')) && !files.body.includes('private-listing-fixture'));
  const tree = await f.app.inject({ method: 'GET', url: `${f.base}/tree` });
  assert(tree.statusCode === 200 && tree.json().items.some(file => file.path === 'note.txt')
    && tree.json().items.every(file => !file.path.startsWith('.scienceprism/datasets')) && !tree.body.includes('private-listing-fixture'));
  const index = '.scienceprism/datasets/index.json', blob = `.scienceprism/datasets/blobs/${f.imported.dataset.sha256}`;
  const requests = [
    { method: 'GET', url: `${f.base}/file?path=${encodeURIComponent(index)}` }, { method: 'GET', url: `${f.base}/blob?path=${encodeURIComponent(blob)}` },
    { method: 'PUT', url: `${f.base}/file`, payload: { path: index, content: '{}' } },
    { method: 'PUT', url: `${f.base}/file`, payload: { path: blob, content: 'replace raw data' } },
    { method: 'POST', url: `${f.base}/folder`, payload: { path: '.scienceprism/datasets/extra' } },
    { method: 'POST', url: `${f.base}/rename`, payload: { from: '.scienceprism', to: 'moved-private-parent' } },
    { method: 'POST', url: `${f.base}/rename`, payload: { from: '.scienceprism/datasets', to: 'moved-data' } },
    { method: 'POST', url: `${f.base}/rename`, payload: { from: 'note.txt', to: index } },
    { method: 'DELETE', url: `${f.base}/file?path=${encodeURIComponent('.scienceprism')}` },
    { method: 'DELETE', url: `${f.base}/file?path=${encodeURIComponent('.scienceprism/datasets')}` }
  ];
  const boundary = 'private-upload-boundary'; requests.push({ method: 'POST', url: `${f.base}/upload`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${index}"\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--\r\n` });
  for (const request of requests) {
    const response = await f.app.inject(request); assert.equal(response.statusCode, 409, `${request.method} ${request.url} must reject private dataset access`);
    assert.equal(response.json().code, 'DATASET_IMMUTABLE'); assert.deepEqual(await protectedSnapshot(f.root), before);
    assert.equal(await fsp.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'ordinary project text');
  }
});

test('absolute and sibling-normalized aliases of private dataset paths receive the same generic API guard', async t => {
  const f = await fixture(t, 'aliases'), before = await protectedSnapshot(f.root);
  for (const target of [path.join(f.root, '.scienceprism/datasets/index.json'), `../${f.id}/.scienceprism/datasets/index.json`,
    path.join(f.root, '.scienceprism/datasets/blobs', f.imported.dataset.sha256)]) {
    const read = await f.app.inject({ method: 'GET', url: `${f.base}/file?path=${encodeURIComponent(target)}` });
    assert.equal(read.statusCode, 409, `resolved private path must not bypass guard: ${target}`); assert.equal(read.json().code, 'DATASET_IMMUTABLE');
    assert.deepEqual(await protectedSnapshot(f.root), before);
  }
});

test('legal normal project file reads, writes, rename and delete remain usable through generic routes', async t => {
  const f = await fixture(t, 'normal'), before = await protectedSnapshot(f.root);
  const absolute = path.join(f.root, 'note.txt');
  assert.equal((await f.app.inject({ method: 'GET', url: `${f.base}/file?path=${encodeURIComponent(absolute)}` })).json().content, 'ordinary project text');
  const saved = await f.app.inject({ method: 'PUT', url: `${f.base}/file`, payload: { path: 'note.txt', content: 'human changed ordinary text' } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().ok, true);
  const renamed = await f.app.inject({ method: 'POST', url: `${f.base}/rename`, payload: { from: 'note.txt', to: 'renamed.txt' } });
  assert.equal(renamed.statusCode, 200); assert.equal(await fsp.readFile(path.join(f.root, 'renamed.txt'), 'utf8'), 'human changed ordinary text');
  const removed = await f.app.inject({ method: 'DELETE', url: `${f.base}/file?path=renamed.txt` }); assert.equal(removed.statusCode, 200);
  assert.equal(fs.existsSync(path.join(f.root, 'renamed.txt')), false); assert.deepEqual(await protectedSnapshot(f.root), before);
});

test('TaskCenter projects the singleton acquisition, cancels safely during commit and retries the same completed job', async t => {
  const id = 'task-center', root = path.join(data, id); await fsp.mkdir(root); await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const copy = fsp.copyFile.bind(fsp); let copies = 0;
  t.mock.method(fsp, 'copyFile', async (...args) => {
    if (String(args[1]).includes('/datasets/blobs/')) { copies++; entered(); await gate; }
    return copy(...args);
  });
  const acquisition = datasetService.importData(id, { filename: 'task.csv', bytes: Buffer.from('name,value\nA,1\n') }); await ready;
  const tasks = await listTasks(id, { kind: 'dataset-acquisition' }); assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[0].metadata.configurationVersion, 1); assert.equal(tasks[0].metadata.source.kind, 'import');
  assert.equal(JSON.stringify(tasks).includes('resolvedUrl'), false); assert.equal(JSON.stringify(tasks).includes('etag'), false);
  // Commit has begun: stopping preserves its atomic result instead of aborting
  // the raw publication. The TaskCenter still calls the real singleton owner.
  const cancellation = cancelTask(id, tasks[0].id); release();
  const [imported, cancelled] = await Promise.all([acquisition, cancellation]);
  assert.equal(cancelled.task.status, 'completed'); assert.equal(cancelled.task.metadata.jobId, imported.job.id);
  const before = await fsp.readFile(path.join(root, '.scienceprism/datasets/index.json'), 'utf8');
  const retried = await retryTask(id, tasks[0].id); assert.equal(retried.task.metadata.jobId, imported.job.id); assert.equal(retried.task.status, 'completed');
  assert.equal(copies, 1); assert.equal(await fsp.readFile(path.join(root, '.scienceprism/datasets/index.json'), 'utf8'), before);
  assert.equal((await datasetService.list(id)).jobs.length, 1);
});
