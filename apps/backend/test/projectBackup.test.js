import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';

const cache = new URL('../../../.cache/project-backup-test/', import.meta.url);
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache.pathname, 'data-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { exportProjectBackup, restoreProjectBackup } = await import('../src/services/projectBackup.js');
const { registerProjectBackupRoutes } = await import('../src/routes/projectBackups.js');

async function fixture(id) {
  const root = path.join(data, id);
  await fs.mkdir(path.join(root, '.scienceprism', 'experiments', 'run-1', 'artifacts'), { recursive: true });
  const files = {
    'project.json': JSON.stringify({ id, name: 'Legacy and binary project', legacyField: 'retained' }),
    'main.tex': '\\documentclass{article}\n\\begin{document}Backup.\\end{document}',
    'image.bin': Buffer.from([0, 255, 10, 42]),
    '.env': 'SCIENCEPRISM_LLM_API_KEY=do-not-export',
    '.scienceprism/workflow.json': JSON.stringify({ version: 3, projectId: id, llmConfig: { apiKey: 'hidden', model: 'example' }, stages: [] }),
    '.scienceprism/experiments/run-1/artifacts/metrics.json': '{"metrics":[{"name":"mean","value":11}]}',
  };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, name), bytes);
  return { root, files };
}
function alterFile(backup, filePath, content) {
  const file = backup.files.find(file => file.path === filePath);
  const bytes = Buffer.from(content);
  Object.assign(file, { content: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

test('backup round trip preserves binary bytes, old metadata, lineage and excludes configuration credentials', async () => {
  const { root, files } = await fixture('roundtrip');
  const backup = await exportProjectBackup('roundtrip');
  assert.equal(backup.files.some(file => file.path === '.env'), false);
  assert.ok(!JSON.stringify(backup).includes('do-not-export'));
  const state = backup.files.find(file => file.path.endsWith('workflow.json'));
  assert.deepEqual(JSON.parse(Buffer.from(state.content, 'base64')), { version: 3, projectId: 'roundtrip', llmConfig: { model: 'example' }, stages: [] });
  await assert.rejects(restoreProjectBackup(backup), error => error.code === 'PROJECT_EXISTS');
  await fs.rename(root, path.join(data, '.saved-roundtrip'));
  const meta = await restoreProjectBackup(backup);
  assert.equal(meta.legacyField, 'retained');
  for (const name of ['main.tex', 'image.bin', '.scienceprism/experiments/run-1/artifacts/metrics.json']) assert.deepEqual(await fs.readFile(path.join(root, name)), Buffer.from(files[name]));
  assert.equal((await exportProjectBackup('roundtrip')).files.length, backup.files.length);
});

test('corruption, traversal, duplicate paths and credential insertion are rejected before creating a project', async () => {
  const { root } = await fixture('untrusted');
  const original = await exportProjectBackup('untrusted');
  await fs.rename(root, path.join(data, '.saved-untrusted'));
  for (const modify of [
    backup => { backup.files[0].sha256 = 'bad'; },
    backup => { backup.files[0].path = '../outside'; },
    backup => { backup.files.push(backup.files[0]); },
    backup => { alterFile(backup, '.scienceprism/workflow.json', JSON.stringify({ apiKey: 'injected' }, null, 2)); },
    backup => { backup.version = 999; }
  ]) {
    const backup = structuredClone(original); modify(backup);
    await assert.rejects(restoreProjectBackup(backup), error => error.statusCode === 400);
    await assert.rejects(fs.access(root));
  }
});

test('failed storage publication cleans staging and supports an unchanged backup retry', async () => {
  const { root } = await fixture('disk-failure');
  const backup = await exportProjectBackup('disk-failure');
  await fs.rename(root, path.join(data, '.saved-disk-failure'));
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('injected no space'), { code: 'ENOSPC' }); };
  try { await assert.rejects(restoreProjectBackup(backup), error => error.code === 'ENOSPC'); }
  finally { fs.rename = rename; }
  assert.equal((await fs.readdir(data)).some(name => name.startsWith('.restore-')), false);
  await assert.rejects(fs.access(root));
  await restoreProjectBackup(backup);
  assert.ok((await fs.readFile(path.join(root, 'main.tex'), 'utf8')).includes('Backup.'));
});

test('symbolic links cannot read files outside the project into backups', async () => {
  const { root } = await fixture('symlink');
  await fs.symlink(path.join(data, 'roundtrip/main.tex'), path.join(root, 'escape.tex'));
  await assert.rejects(exportProjectBackup('symlink'), error => error.code === 'BACKUP_SYMLINK');
});

test('HTTP download and restore preserve status codes and do not overwrite existing files', async () => {
  const { root } = await fixture('http-backup');
  const app = Fastify(); registerProjectBackupRoutes(app);
  try {
    const download = await app.inject({ method: 'GET', url: '/api/projects/http-backup/backup' });
    assert.equal(download.statusCode, 200); assert.ok(download.headers['content-disposition'].includes('attachment'));
    const backup = download.json();
    const remote = await app.inject({ method: 'GET', url: '/api/projects/http-backup/backup', remoteAddress: '203.0.113.7', headers: { 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(remote.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/restore-backup', payload: backup })).statusCode, 409);
    await fs.rename(root, path.join(data, '.saved-http-backup'));
    backup.files[0].sha256 = 'broken';
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/restore-backup', payload: backup })).statusCode, 400);
    backup.files[0].sha256 = download.json().files[0].sha256;
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/restore-backup', payload: backup })).statusCode, 201);
  } finally { await app.close(); }
});
