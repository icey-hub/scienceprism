import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createDatasetDownloader, parseDatasetUrl, DatasetError, MAX_DATASET_BYTES, SUPPORTED_DATASET_HOSTS } from '../src/services/datasets/download.js';

const url = 'https://raw.githubusercontent.com/owner/repo/main/data.csv';
const hf = `https://huggingface.co/datasets/owner/data/resolve/${'a'.repeat(40)}/data.csv`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const response = (parts = [], statusCode = 200, headers = {}) => Object.assign(Readable.from(parts), { statusCode, headers });
async function fixture(t) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/dataset-download/', import.meta.url));
  await fsp.mkdir(cache, { recursive: true }); const root = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, destination: path.join(root, 'partial') };
}
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
function downloader(requestImpl, options = {}) { return createDatasetDownloader({ proxyUrl: '', lookupImpl: publicLookup, requestImpl, ...options }); }

test('streamed raw data has exact hash, awaited progress, fixed public DNS and private destination', async t => {
  const f = await fixture(t), progress = [], requests = [];
  const download = downloader(async (requested, address, controls) => { requests.push({ requested, address, controls }); return response(['a,b\n', '1,2\n'], 200, { 'content-length': '8', etag: '"v1"' }); });
  const result = await download(url, { destination: f.destination, onProgress: async event => { await Promise.resolve(); progress.push(event); } });
  assert.equal(result.sha256, digest('a,b\n1,2\n')); assert.equal(result.byteLength, 8); assert.equal(result.etag, '"v1"'); assert.equal(result.resolvedUrl, url);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'a,b\n1,2\n'); assert.equal(fs.statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(progress.at(-1).receivedBytes, 8); assert.equal(progress.at(-1).totalBytes, 8); assert.deepEqual(requests[0].address, { address: '8.8.8.8', family: 4 });
  assert.equal(requests[0].controls.signal.aborted, false); assert.deepEqual(requests[0].controls.headers, {});
});

test('source URL requires supported HTTPS and HF dataset fixed revision without source secrets', () => {
  assert.equal(MAX_DATASET_BYTES, 128 * 1024 * 1024); assert.equal(SUPPORTED_DATASET_HOSTS.length, 4);
  assert.equal(parseDatasetUrl(hf).hostname, 'huggingface.co');
  for (const input of ['http://raw.githubusercontent.com/a', 'https://user:pass@zenodo.org/a', 'https://zenodo.org:8443/a', 'https://zenodo.org/a#fragment',
    'https://zenodo.org/a?api_key=secret', 'https://zenodo.org/a?access_token=secret', 'https://zenodo.org/a?authorization=secret']) {
    assert.throws(() => parseDatasetUrl(input), { code: 'DATASET_INVALID_URL' });
  }
  assert.throws(() => parseDatasetUrl('https://evil.test/data.csv'), { code: 'DATASET_SOURCE_UNSUPPORTED' });
  assert.throws(() => parseDatasetUrl(hf.replace('a'.repeat(40), 'main')), { code: 'DATASET_REVISION_REQUIRED' });
  assert.throws(() => parseDatasetUrl(hf.replace('/datasets/', '/models/')), { code: 'DATASET_REVISION_REQUIRED' });
  assert.throws(() => parseDatasetUrl(hf.replace('data.csv', 'nested%2fescape.csv')), { code: 'DATASET_INVALID_URL' });
  assert.throws(() => parseDatasetUrl('https://cdn-lfs.hf.co/data.csv'), { code: 'DATASET_SOURCE_UNSUPPORTED' });
});

test('strong matching ETag and complete Content-Range resume one exact prefix without duplication', async t => {
  const f = await fixture(t); fs.writeFileSync(f.destination, 'abc'); let controls;
  const download = downloader(async (_url, _address, options) => { controls = options; return response(['def'], 206, { 'content-length': '3', 'content-range': 'bytes 3-5/6', etag: '"same"' }); });
  const result = await download(url, { destination: f.destination, resume: { receivedBytes: 3, etag: '"same"', resolvedUrl: url } });
  assert.deepEqual(controls.headers, { Range: 'bytes=3-', 'If-Range': '"same"' }); assert.equal(result.byteLength, 6); assert.equal(result.sha256, digest('abcdef'));
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abcdef');
});

test('weak or missing validators restart from zero and a server full 200 response safely replaces the prefix', async t => {
  for (const etag of [undefined, 'W/"weak"', '"strong"']) {
    const f = await fixture(t); fs.writeFileSync(f.destination, 'old'); let headers;
    const download = downloader(async (_url, _address, controls) => { headers = controls.headers; return response(['new-file'], 200, { etag: '"new"', 'content-length': '8' }); });
    const result = await download(url, { destination: f.destination, resume: { receivedBytes: 3, etag, resolvedUrl: url } });
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'new-file'); assert.equal(result.sha256, digest('new-file'));
    assert.equal(Object.hasOwn(headers, 'Range'), etag === '"strong"');
  }
});

test('changed validator, invalid range, incomplete range and stale partial length cannot be spliced', async t => {
  for (const headers of [{ etag: '"changed"', 'content-range': 'bytes 3-5/6' }, { etag: '"same"', 'content-range': 'bytes 2-4/6' },
    { etag: '"same"', 'content-range': 'bytes 3-6/6' }, { etag: '"same"', 'content-range': 'bytes 3-5/*' },
    { etag: '"same"', 'content-range': 'bytes 3-5/6', 'content-length': '2' }]) {
    const f = await fixture(t); fs.writeFileSync(f.destination, 'abc');
    await assert.rejects(downloader(async () => response(['def'], 206, headers))(url, { destination: f.destination,
      resume: { receivedBytes: 3, etag: '"same"', resolvedUrl: url } }), { code: 'DATASET_RESUME_CONFLICT' });
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abc');
  }
  const f = await fixture(t); fs.writeFileSync(f.destination, 'abc'); let calls = 0;
  await assert.rejects(downloader(async () => { calls++; return response(); })(url, { destination: f.destination,
    resume: { receivedBytes: 2, etag: '"same"', resolvedUrl: url } }), { code: 'DATASET_RESUME_CONFLICT' }); assert.equal(calls, 0);
  await assert.rejects(downloader(async () => response(['d'], 206, { etag: '"same"', 'content-range': 'bytes 3-3/6', 'content-length': '1' }))(url,
    { destination: f.destination, resume: { receivedBytes: 3, etag: '"same"', resolvedUrl: url } }), { code: 'DATASET_DOWNLOAD_INCOMPLETE' });
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abcd');
});

test('unexpected partial responses cannot be accepted as whole data', async t => {
  const f = await fixture(t);
  await assert.rejects(downloader(async () => response(['abc'], 206, { etag: '"v1"', 'content-range': 'bytes 0-2/3' }))(url, { destination: f.destination }), { code: 'DATASET_RESUME_CONFLICT' });
  assert.equal(fs.readFileSync(f.destination).length, 0);
});

test('cancellation preserves completed chunks and their strong resume metadata', async t => {
  const f = await fixture(t), controller = new AbortController(); let last;
  const download = downloader(async () => response((async function* () { yield Buffer.from('abc'); await new Promise(() => {}); })(), 200, { etag: '"same"', 'content-length': '6' }));
  await assert.rejects(download(url, { destination: f.destination, signal: controller.signal, onProgress: async event => {
    last = event; if (event.receivedBytes === 3) controller.abort();
  } }), { code: 'DATASET_CANCELLED' });
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abc'); assert.equal(last.etag, '"same"'); assert.equal(last.receivedBytes, 3);
});

test('progress persistence failure is awaited and stops before writing further data', async t => {
  const f = await fixture(t); let callbacks = 0;
  await assert.rejects(downloader(async () => response(['abc', 'def'], 200, { etag: '"same"' }))(url, { destination: f.destination,
    onProgress: async event => { callbacks++; await Promise.resolve(); if (event.receivedBytes === 3) throw new DatasetError('DATASET_PROGRESS_SAVE_FAILED', 'Fixed persistence failure', 500); } }), { code: 'DATASET_PROGRESS_SAVE_FAILED' });
  assert.equal(callbacks, 2); assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abc');
});

test('byte budgets enforce header, streamed and resumed full size with no over-limit writes', async t => {
  for (const headers of [{ 'content-length': '9' }, {}]) {
    const f = await fixture(t); const download = downloader(async () => response(['abc', 'defghi'], 200, headers), { maxBytes: 8 });
    await assert.rejects(download(url, { destination: f.destination }), { code: 'DATASET_TOO_LARGE' });
    assert.ok(fs.statSync(f.destination).size <= 8);
  }
  const f = await fixture(t); fs.writeFileSync(f.destination, 'abc');
  await assert.rejects(downloader(async () => response(['def'], 206, { etag: '"same"', 'content-range': 'bytes 3-5/20' }), { maxBytes: 8 })(url,
    { destination: f.destination, resume: { receivedBytes: 3, etag: '"same"', resolvedUrl: url } }), { code: 'DATASET_TOO_LARGE' });
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'abc');
  assert.throws(() => downloader(async () => response(), { maxBytes: MAX_DATASET_BYTES + 1 }), { code: 'DATASET_DOWNLOAD_CONFIGURATION' });
});

test('private or inconsistent DNS results are denied before requests including every redirect hop', async t => {
  for (const records of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '2001:db8::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }], []]) {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(downloader(async () => { calls++; return response(); }, { lookupImpl: async () => records })(url, { destination: f.destination }), { code: 'DATASET_PRIVATE_ADDRESS' });
    assert.equal(calls, 0);
  }
  const f = await fixture(t); let dns = 0, calls = 0;
  await assert.rejects(downloader(async () => { calls++; return response([], 302, { location: 'https://zenodo.org/data.csv' }); },
    { lookupImpl: async () => ++dns === 1 ? publicLookup() : [{ address: '192.168.1.1', family: 4 }] })(url, { destination: f.destination }), { code: 'DATASET_PRIVATE_ADDRESS' });
  assert.equal(calls, 1); assert.equal(dns, 2);
});

test('redirects permit only exact HF CDNs from a fixed HF dataset origin and do not reuse cross-URL range', async t => {
  const f = await fixture(t), requests = [];
  const cdn = 'https://cdn-lfs.hf.co/dataset.csv?signature=private-cdn-signature';
  const download = downloader(async (requested, _address, controls) => { requests.push({ url: requested.toString(), headers: controls.headers });
    return requests.length === 1 ? response([], 302, { location: cdn }) : response(['data'], 200, { etag: '"done"' }); });
  assert.equal((await download(hf, { destination: f.destination })).resolvedUrl, cdn); assert.equal(requests.length, 2);
  for (const destination of ['https://cdn-lfs.evil.test/data.csv', 'http://zenodo.org/data.csv', 'https://user:password@zenodo.org/data.csv']) {
    const other = await fixture(t);
    await assert.rejects(downloader(async () => response([], 302, { location: destination }))(hf, { destination: other.destination }), error => error instanceof DatasetError);
  }
  const nonHf = await fixture(t);
  await assert.rejects(downloader(async () => response([], 302, { location: cdn }))(url, { destination: nonHf.destination }), { code: 'DATASET_SOURCE_UNSUPPORTED' });
  const resume = await fixture(t); fs.writeFileSync(resume.destination, 'old'); let sent;
  await downloader(async (_url, _address, controls) => { sent = controls.headers; return response(['new'], 200); })(url, { destination: resume.destination,
    resume: { receivedBytes: 3, etag: '"old"', resolvedUrl: 'https://zenodo.org/old.csv' } });
  assert.deepEqual(sent, {}); assert.equal(fs.readFileSync(resume.destination, 'utf8'), 'new');
});

test('gated source and upstream errors are explicit, sanitized, and preserve an existing partial', async t => {
  for (const status of [401, 403, 404]) {
    const f = await fixture(t); fs.writeFileSync(f.destination, 'partial');
    await assert.rejects(downloader(async () => response(['do not write'], status))(url, { destination: f.destination }),
      { code: [401, 403].includes(status) ? 'DATASET_AUTH_REQUIRED' : 'DATASET_DOWNLOAD_HTTP_ERROR' });
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'partial');
  }
  const f = await fixture(t);
  await assert.rejects(downloader(async () => { throw new Error('token=private-secret'); })(url, { destination: f.destination }),
    error => error.code === 'DATASET_DOWNLOAD_FAILED' && !error.message.includes('private-secret'));
});

test('trusted proxy delegates DNS while preserving exact source checks and cancellation', async t => {
  const f = await fixture(t); let dns = 0, proxy;
  const download = downloader(async (_url, address, controls) => { assert.equal(address, null); proxy = controls.proxyUrl; return response(['x']); },
    { proxyUrl: 'http://user:password@127.0.0.1:8888', lookupImpl: async () => { dns++; throw new Error('must not resolve through direct DNS'); } });
  await download(url, { destination: f.destination }); assert.equal(dns, 0); assert.equal(proxy.hostname, '127.0.0.1');
  assert.throws(() => downloader(async () => response(), { proxyUrl: 'socks://secret@localhost:9999' }), error => error.code === 'DATASET_PROXY_CONFIGURATION' && !error.message.includes('secret'));
  await assert.rejects(download('https://evil.test/data.csv', { destination: f.destination }), { code: 'DATASET_SOURCE_UNSUPPORTED' });
});

test('unsafe file and directory links are rejected before any source request', async t => {
  for (const kind of ['symbolic', 'hard', 'directory']) {
    const f = await fixture(t), original = path.join(f.root, 'original'); fs.writeFileSync(original, 'preserve');
    let destination = f.destination;
    if (kind === 'symbolic') fs.symlinkSync(original, destination);
    if (kind === 'hard') fs.linkSync(original, destination);
    if (kind === 'directory') { const actual = path.join(f.root, 'directory'), alias = path.join(f.root, 'alias'); fs.mkdirSync(actual); fs.symlinkSync(actual, alias); destination = path.join(alias, 'partial'); }
    let calls = 0;
    await assert.rejects(downloader(async () => { calls++; return response(['change']); })(url, { destination }), { code: 'DATASET_PATH_DENIED' });
    assert.equal(calls, 0); assert.equal(fs.readFileSync(original, 'utf8'), 'preserve');
  }
});

test('timeout and stalled stream errors preserve the partial and cannot turn into success', async t => {
  const f = await fixture(t), keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(downloader(async () => new Promise(() => {}), { timeoutMs: 20 })(url, { destination: f.destination }), { code: 'DATASET_TIMEOUT' });
  const stream = new Readable({ read() {} }); stream.statusCode = 200; stream.headers = {};
  await assert.rejects(downloader(async () => stream, { timeoutMs: 20 })(url, { destination: f.destination }), { code: 'DATASET_TIMEOUT' });
  assert.equal(stream.destroyed, true); assert.equal(fs.existsSync(f.destination), true);
});
