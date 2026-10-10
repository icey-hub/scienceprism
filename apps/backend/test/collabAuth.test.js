import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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
