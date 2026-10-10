import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after } from 'node:test';

const repoRoot = path.resolve(new URL('../../../', import.meta.url).pathname);
await mkdir(path.join(repoRoot, '.cache'), { recursive: true });
const fixture = await mkdtemp(path.join(repoRoot, '.cache', 'collab-auth-'));
process.env.SCIENCEPRISM_DATA_DIR = fixture;
after(() => rm(fixture, { recursive: true, force: true }));

delete process.env.SCIENCEPRISM_COLLAB_TOKEN_SECRET;
delete process.env.OPENPRISM_COLLAB_TOKEN_SECRET;
process.env.SCIENCEPRISM_TUNNEL = 'false';
const { requireAuthIfRemote, isLocalAddress } = await import('../src/utils/authUtils.js');
const { issueToken, verifyToken } = await import('../src/services/collab/tokenService.js');

test('forwarded headers cannot grant remote clients local access', () => {
  assert.equal(requireAuthIfRemote({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }).ok, false);
  assert.equal(requireAuthIfRemote({ ip: '127.0.0.1', headers: {} }).ok, true);
  assert.equal(isLocalAddress('::ffff:127.0.0.1.attacker'), false);
  const token = issueToken({ projectId: 'project-a' });
  assert.equal(requireAuthIfRemote({ ip: '203.0.113.9', headers: { authorization: `Bearer ${token}` } }).payload.projectId, 'project-a');
});

test('a publicly known development secret cannot forge default collaboration tokens', () => {
  const body = Buffer.from(JSON.stringify({ v: 1, pid: 'project-a', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const signature = createHmac('sha256', 'scienceprism-collab-dev').update(body).digest('base64url');
  assert.equal(verifyToken(`op1.${body}.${signature}`), null);
  assert.equal(verifyToken(issueToken({ projectId: 'project-a' })).projectId, 'project-a');
});

test('a loopback tunnel proxy still requires a valid collaboration token', () => {
  const source = `import {requireAuthIfRemote,getClientIp,isLocalAddress} from './apps/backend/src/utils/authUtils.js';import {issueToken} from './apps/backend/src/services/collab/tokenService.js';const req={ip:'127.0.0.1',headers:{'x-forwarded-for':'127.0.0.1'}};console.log(JSON.stringify({anonymous:requireAuthIfRemote(req).ok,local:isLocalAddress(getClientIp(req)),authorized:requireAuthIfRemote({...req,headers:{authorization:'Bearer '+issueToken({projectId:'p'})}}).ok}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('../../../', import.meta.url), env: { ...process.env, SCIENCEPRISM_TUNNEL: 'ngrok' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { anonymous: false, local: false, authorized: true });
});

test('project invitations authorize only their own project APIs and scoped global commands', async () => {
  const { registerApiAuth } = await import('../src/utils/authUtils.js');
  const app = Fastify();
  registerApiAuth(app);
  app.get('/api/projects/:id/file', async () => ({ content: 'PRIVATE_SOURCE' }));
  app.post('/api/compile', async () => ({ ok: true }));
  app.post('/api/projects', async () => ({ ok: true }));
  app.post('/api/templates/upload', async () => ({ ok: true }));
  const token = issueToken({ projectId: 'project-a' });
  const headers = { authorization: `Bearer ${token}`, 'x-forwarded-for': '127.0.0.1' };
  try {
    assert.equal((await app.inject({ url: '/api/projects/project-a/file', headers, remoteAddress: '203.0.113.9' })).statusCode, 200);
    const other = await app.inject({ url: '/api/projects/project-b/file', headers, remoteAddress: '203.0.113.9' });
    assert.equal(other.statusCode, 403);
    assert.ok(!other.body.includes('PRIVATE_SOURCE'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/compile', headers, remoteAddress: '203.0.113.9', payload: { projectId: 'project-a' } })).statusCode, 200);
    for (const request of [{ method: 'POST', url: '/api/compile', payload: { projectId: 'project-b' } }, { method: 'POST', url: '/api/compile', payload: {} }, { method: 'POST', url: '/api/projects', payload: {} }, { method: 'POST', url: '/api/projects', payload: { projectId: 'project-a' } }, { method: 'POST', url: '/api/templates/upload', payload: { projectId: 'project-a' } }]) {
      assert.equal((await app.inject({ ...request, headers, remoteAddress: '203.0.113.9' })).statusCode, 403);
    }
    assert.equal((await app.inject({ url: '/api/projects/project-b/file?projectId=project-a', headers, remoteAddress: '203.0.113.9' })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/projects/project-b/file', remoteAddress: '127.0.0.1' })).statusCode, 200);
  } finally { await app.close(); }
});

test('project listing reveals only the invited project while local users retain their projects', async () => {
  const { registerApiAuth } = await import('../src/utils/authUtils.js');
  const { registerProjectRoutes } = await import('../src/routes/projects.js');
  for (const id of ['project-a', 'project-b']) {
    await mkdir(path.join(fixture, id));
    await writeFile(path.join(fixture, id, 'project.json'), JSON.stringify({ id, name: `${id} private title` }));
  }
  const app = Fastify(); registerApiAuth(app); registerProjectRoutes(app);
  try {
    const shared = await app.inject({ url: '/api/projects', remoteAddress: '203.0.113.9', headers: { authorization: `Bearer ${issueToken({ projectId: 'project-a' })}` } });
    assert.deepEqual(shared.json().projects.map(project => project.id), ['project-a']);
    assert.ok(!shared.body.includes('project-b'));
    assert.equal((await app.inject({ url: '/api/projects', remoteAddress: '127.0.0.1' })).json().projects.length, 2);
  } finally { await app.close(); }
});
