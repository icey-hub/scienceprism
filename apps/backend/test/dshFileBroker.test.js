import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDshFileBroker } from '../src/services/harnessRuntime/dshFileBroker.js';

async function fixture(t, options = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'dsh-broker-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'main.tex'), 'old\nsecond');
  let policy = { projectId: 'project', runId: 'run', role: 'writer', task: 'draft', version: 1, active: true, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } };
  const decisions = [];
  const events = [];
  const broker = await createDshFileBroker({ workspace, readPolicy: async () => policy, onDecision: async event => { decisions.push(event); await options.audit?.(event); }, signal: options.signal, skillProjection: options.skillProjection, emit: event => events.push(event) });
  t.after(() => broker.close());
  return { root, workspace, broker, decisions, events, update: update => { policy = { ...policy, ...update }; }, policy: () => policy };
}
const read = (path = 'main.tex') => ({ tool: 'project_read_file', callId: 'read-1', arguments: { path } });
const write = (content, expectedSha256, path = 'main.tex') => ({ tool: 'project_propose_patch', callId: 'write-1', arguments: { path, content, expectedSha256 } });
const hash = value => createHash('sha256').update(value).digest('hex');

test('DSH broker reads bounded text and atomically proposes a CAS edit with persisted audit', async t => {
  const f = await fixture(t);
  const result = await f.broker.execute(read());
  assert.equal(result.content, 'old\nsecond');
  assert.equal(result.sha256, hash('old\nsecond'));
  const proposed = await f.broker.execute(write('new', result.sha256));
  assert.equal(proposed.proposed, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'new');
  assert.equal(f.decisions.length, 2);
  assert.equal(f.decisions[1].actor, 'system');
  assert.equal(f.decisions[1].capability, 'patch.propose');
  assert.ok(!JSON.stringify(f.decisions).includes('second'));
});

test('DSH broker serializes conflicting edits and refuses stale or missing expected hash', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.broker.execute(write('first', hash('old\nsecond'))), f.broker.execute(write('second', hash('old\nsecond')))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'DSH_FILE_CONFLICT');
  await assert.rejects(f.broker.execute(write('bad', null)), { code: 'DSH_FILE_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'first');
});

test('DSH broker rechecks asynchronous policy after audit and refuses policy changes', async t => {
  let f;
  f = await fixture(t, { audit: async event => { if (event.decision === 'allow') f.update({ version: 2, capabilities: { ...f.policy().capabilities, granted: [] } }); } });
  await assert.rejects(f.broker.execute(write('bad', hash('old\nsecond'))), { code: 'CAPABILITY_DENIED' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old\nsecond');
  assert.deepEqual(f.decisions.map(event => event.decision), ['allow', 'deny']);
});

test('DSH broker checks cancellation after async audit before any write', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal, audit: async event => { if (event.decision === 'allow') controller.abort(); } });
  await assert.rejects(f.broker.execute(write('bad', hash('old\nsecond'))), { code: 'DSH_CANCELLED' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old\nsecond');
});

test('DSH broker binds owner and initial paths as a ceiling; policy expansion cannot grant a new file', async t => {
  const f = await fixture(t);
  f.update({ capabilities: { ...f.policy().capabilities, allowedPaths: [] } });
  await assert.rejects(f.broker.execute(write('bad', null, 'new.tex')), { code: 'PATH_DENIED' });
  f.update({ runId: 'other' });
  await assert.rejects(f.broker.execute(read()), { code: 'DSH_OWNER_CHANGED' });
});

test('DSH broker rejects unknown tools, invalid arguments, traversal and sensitive paths', async t => {
  const f = await fixture(t);
  for (const tool of ['bash', 'run_code', 'mcp__file', 'spawn_agent', 'constructor']) await assert.rejects(f.broker.execute({ ...read(), tool }), { code: 'DSH_TOOL_NOT_BOUND' });
  for (const path of ['../secret', '/etc/passwd', '.env', '.dsh/policy.json', 'nested/../main.tex', 'main.tex/']) await assert.rejects(f.broker.execute(read(path)), { code: 'PATH_DENIED' });
  await assert.rejects(f.broker.execute({ ...read(), arguments: { path: 'main.tex', extra: true } }), { code: 'DSH_ARGUMENTS_INVALID' });
  await assert.rejects(f.broker.execute(write('bad', undefined)), { code: 'DSH_ARGUMENTS_INVALID' });
});

test('DSH broker rejects symbolic files, symbolic parent directories and hardlinks', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.workspace, 'main.tex'));
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(f.workspace, 'main.tex'));
  await assert.rejects(f.broker.execute(read()), { code: 'PATH_DENIED' });
  await fs.unlink(path.join(f.workspace, 'main.tex'));
  await fs.link(outside, path.join(f.workspace, 'main.tex'));
  await assert.rejects(f.broker.execute(read()), { code: 'PATH_DENIED' });
  await fs.unlink(path.join(f.workspace, 'main.tex'));
  await fs.symlink(f.root, path.join(f.workspace, 'main.tex'));
  await assert.rejects(f.broker.execute(read('main.tex/outside')), { code: 'PATH_DENIED' });
});

test('DSH broker denies manual/inactive/closed runs and a failed audit', async t => {
  const f = await fixture(t);
  f.update({ mode: 'manual' });
  await assert.rejects(f.broker.execute(read()), { code: 'DSH_APPROVAL_UNAVAILABLE' });
  f.update({ mode: 'auto', active: false });
  await assert.rejects(f.broker.execute(read()), { code: 'DSH_RUN_INACTIVE' });
  await f.broker.close();
  await assert.rejects(f.broker.execute(read()), { code: 'DSH_CANCELLED' });
  const bad = await fixture(t, { audit: async () => { throw new Error('audit storage unavailable'); } });
  await assert.rejects(bad.broker.execute(write('bad', hash('old\nsecond'))));
  assert.equal(await fs.readFile(path.join(bad.workspace, 'main.tex'), 'utf8'), 'old\nsecond');
});

test('selected Skill reads require exact frozen versions, remain read-only, and report their actual source', async t => {
  const skillPath = '.dsh/skills/paper-notes/SKILL.md';
  const content = '# Paper notes\nUse the verified paper sources.';
  const document = { projectionPath: skillPath, skillName: 'paper-notes', source: 'project', sourceRelativePath: '.agents/skills/paper-notes/SKILL.md', versionId: 'sha256:test', sha256: hash(content), bytes: Buffer.byteLength(content) };
  const projection = { documents: [document] };
  const f = await fixture(t, { skillProjection: projection });
  await fs.mkdir(path.dirname(path.join(f.workspace, skillPath)), { recursive: true });
  await fs.writeFile(path.join(f.workspace, skillPath), content);
  assert.equal((await f.broker.execute(read(skillPath))).content, content);
  assert.deepEqual(f.events.at(-1).data.skillSource, { skillName: 'paper-notes', source: 'project', sourceRelativePath: '.agents/skills/paper-notes/SKILL.md', versionId: 'sha256:test', sha256: hash(content), bytes: Buffer.byteLength(content) });
  await assert.rejects(f.broker.execute(write('changed', hash(content), skillPath)), { code: 'PATH_DENIED' });
  await assert.rejects(f.broker.execute(read('.dsh/skills/unselected/SKILL.md')), { code: 'PATH_DENIED' });
  await fs.writeFile(path.join(f.workspace, skillPath), 'changed');
  document.sha256 = hash('changed'); document.bytes = 7;
  await assert.rejects(f.broker.execute(read(skillPath)), { code: 'DSH_SKILL_VERSION_CHANGED' });
  assert.equal(f.events.length, 1);
  f.update({ capabilities: { ...f.policy().capabilities, granted: [] } });
  await assert.rejects(f.broker.execute(read(skillPath)), { code: 'CAPABILITY_DENIED' });
});

test('Skill manifests cannot grant runtime controls, symlinks, traversal or scripts', async t => {
  for (const projectionPath of ['.dsh/policy.json', '.dsh/skills/paper-notes/../private.md', '.dsh/skills/paper-notes/script.js', '.dsh/skills/paper-notes/linked\\secret.md']) {
    await assert.rejects(fixture(t, { skillProjection: { documents: [{ projectionPath, sha256: hash('x'), bytes: 1 }] } }), { code: 'DSH_SKILL_PROJECTION_INVALID' });
  }
  const skillPath = '.dsh/skills/paper-notes/SKILL.md';
  const f = await fixture(t, { skillProjection: { documents: [{ projectionPath: skillPath, sha256: hash('private'), bytes: 7 }] } });
  await fs.mkdir(path.dirname(path.join(f.workspace, skillPath)), { recursive: true });
  const outside = path.join(f.root, 'private.md'); await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(f.workspace, skillPath));
  await assert.rejects(f.broker.execute(read(skillPath)), { code: 'PATH_DENIED' });
  assert.equal(f.events.length, 0);
});
