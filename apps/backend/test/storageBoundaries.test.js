import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
await mkdir(path.join(repoRoot, '.cache'), { recursive: true });
const fixture = await mkdtemp(path.join(repoRoot, '.cache', 'storage-boundaries-'));
const dataDir = path.join(fixture, 'data');
const outside = path.join(fixture, 'outside');
await mkdir(dataDir);
await mkdir(outside);
await writeFile(path.join(outside, 'project.json'), '{"id":"outside"}');
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { getProjectRoot } = await import('../src/services/projectService.js');
const { safeJoin } = await import('../src/utils/pathUtils.js');
const { registerProjectRoutes } = await import('../src/routes/projects.js');
const { registerHealthRoutes } = await import('../src/routes/health.js');

after(async () => { await rm(fixture, { recursive: true, force: true }); });

test('a project ID cannot select a directory outside the project store', async () => {
  await assert.rejects(() => getProjectRoot('../outside'), /Invalid storage identifier/);
  await symlink(outside, path.join(dataDir, 'linked'));
  await assert.rejects(() => getProjectRoot('linked'), /Invalid project directory/);
});

test('project paths cannot select the project root or follow a symlink outside it', async () => {
  const projectRoot = path.join(dataDir, 'valid');
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, 'project.json'), '{"id":"valid"}');
  await symlink(outside, path.join(projectRoot, 'linked'));
  await symlink(outside, path.join(fixture, 'linked-root'));

  assert.throws(() => safeJoin(projectRoot, '.'), /Invalid path/);
  assert.throws(() => safeJoin(projectRoot, 'linked/project.json'), /Invalid path/);
  assert.throws(() => safeJoin(path.join(fixture, 'linked-root'), 'project.json'), /Invalid path/);
  assert.equal(safeJoin(projectRoot, 'notes.txt'), path.join(projectRoot, 'notes.txt'));
});

test('file deletion cannot delete the whole project', async () => {
  const app = Fastify();
  registerProjectRoutes(app);
  const response = await app.inject({ method: 'DELETE', url: '/api/projects/valid/file?path=.' });
  assert.equal(response.statusCode, 400);
  await access(path.join(dataDir, 'valid', 'project.json'));
  await app.close();
});

test('template selection and upload reject traversal IDs', async () => {
  const app = Fastify();
  await app.register(multipart);
  registerProjectRoutes(app);
  registerHealthRoutes(app);

  const create = await app.inject({ method: 'POST', url: '/api/projects', payload: { template: '../outside' } });
  assert.equal(create.statusCode, 400);
  const apply = await app.inject({ method: 'POST', url: '/api/projects/valid/template', payload: { template: '../outside' } });
  assert.equal(apply.statusCode, 400);

  const boundary = 'storage-boundary-test';
  const payload = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="templateId"',
    '',
    '../outside',
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="template.zip"',
    'Content-Type: application/zip',
    '',
    'not a zip',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const upload = await app.inject({
    method: 'POST',
    url: '/api/templates/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload
  });
  assert.equal(upload.statusCode, 400);
  await app.close();
});
