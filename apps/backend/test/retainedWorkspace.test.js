import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRetainedWorkspace } from '../src/services/harnessRuntime/retainedWorkspace.js';

const moduleUrl = new URL('../src/services/harnessRuntime/retainedWorkspace.js', import.meta.url).href;
const sha = value => createHash('sha256').update(value).digest('hex');
const versions = { runtime: 'dsh-fixture-v1', codex: 'codex-fixture-v1', toolsHash: sha('tools') };
const code = suffix => error => error.code === `HARNESS_WORKSPACE_${suffix}`;
async function fixture(t) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/retained-workspace/', import.meta.url));
  await fsp.mkdir(cache, { recursive: true });
  const base = await fsp.mkdtemp(path.join(cache, 'test-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, 'data', 'project');
  await fsp.mkdir(projectRoot, { recursive: true });
  const config = { projectRoot, runId: 'parent', attempt: 1, expectedVersions: versions };
  return { base, projectRoot, config, create: options => createRetainedWorkspace({ ...config, ...options }) };
}
async function processFixture(t, source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  let stdout = ''; let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0])); });
    child.once('exit', () => { if (!stdout.includes('\n')) reject(new Error(stderr || 'Fixture exited before readiness.')); });
  });
  return { child, exit, ready: await ready };
}
const childMetadata = (pid, overrides = {}) => ({ runId: 'worker', parentRunId: 'parent', parentAttempt: 1,
  workerRoot: 'delegated-worker/controls', pid, threadId: 'thread', turnId: 'turn', status: 'running', stopConfirmed: false, ...overrides });

test('stable private roots retain files and checkpoints after explicit stopped release', async t => {
  const f = await fixture(t); const first = await f.create();
  assert.equal(path.dirname(path.dirname(first.root)), path.dirname(f.projectRoot));
  assert.match(path.basename(first.root), /^[a-f0-9]{64}$/); assert.equal(first.recovered, false);
  assert.equal(fs.statSync(first.root).mode & 0o777, 0o700);
  await fsp.writeFile(path.join(first.workspace, 'main.tex'), 'retained draft');
  const baseFiles = [{ path: 'main.tex', sha256: sha('before'), bytes: 6 }];
  await first.update({ status: 'running', baseFiles });
  const released = await first.release({ status: 'completed', stopConfirmed: true });
  assert.equal(released.revision, 2); assert.equal(fs.statSync(path.join(first.root, 'checkpoint.json')).mode & 0o777, 0o600);
  await assert.rejects(first.read, code('OWNER_CLOSED'));
  const reopened = await f.create({ recover: true });
  assert.equal(reopened.root, first.root); assert.equal(reopened.recovered, true);
  assert.equal((await reopened.read()).status, 'completed'); assert.deepEqual((await reopened.read()).baseFiles, baseFiles);
  assert.equal(await fsp.readFile(path.join(reopened.workspace, 'main.tex'), 'utf8'), 'retained draft');
  const separate = await f.create({ attempt: 2 }); assert.notEqual(separate.root, first.root);
  await separate.release({ status: 'cancelled', stopConfirmed: true });
  await reopened.release({ status: 'completed', stopConfirmed: true });
});

test('another live instance cannot take ownership even in the same process', async t => {
  const f = await fixture(t); const owner = await f.create();
  await assert.rejects(f.create({ recover: true }), code('OWNER_ACTIVE'));
  await assert.rejects(f.create(), code('RECOVERY_REQUIRED'));
  assert.equal((await owner.read()).revision, 0);
  await owner.release({ status: 'cancelled', stopConfirmed: true });
});

test('a real dead owner can be reopened without resetting its checkpoint or workspace', async t => {
  const f = await fixture(t);
  const proc = await processFixture(t, `import {createRetainedWorkspace} from ${JSON.stringify(moduleUrl)};
    import fs from 'node:fs'; const h=await createRetainedWorkspace(${JSON.stringify(f.config)});
    await h.update({status:'running'}); fs.writeFileSync(h.workspace+'/result.txt','persisted');
    console.log(JSON.stringify({root:h.root,pid:process.pid})); setInterval(()=>{},1000);`);
  await assert.rejects(f.create({ recover: true }), code('OWNER_ACTIVE'));
  proc.child.kill('SIGKILL'); await proc.exit;
  assert.throws(() => process.kill(proc.ready.pid, 0), error => error.code === 'ESRCH');
  const reopened = await f.create({ recover: true });
  assert.equal(reopened.root, proc.ready.root); assert.equal((await reopened.read()).revision, 1);
  assert.equal(await fsp.readFile(path.join(reopened.workspace, 'result.txt'), 'utf8'), 'persisted');
  await reopened.release({ status: 'ambiguous', stopConfirmed: true });
});

test('a real live child blocks recovery and release until OS-confirmed exit', async t => {
  const f = await fixture(t);
  const worker = await processFixture(t, 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);');
  const owner = await processFixture(t, `import {createRetainedWorkspace} from ${JSON.stringify(moduleUrl)};
    const h=await createRetainedWorkspace(${JSON.stringify(f.config)}); await h.update({children:[${JSON.stringify(childMetadata(worker.ready.pid))}]});
    console.log(JSON.stringify({root:h.root,pid:process.pid})); setInterval(()=>{},1000);`);
  owner.child.kill('SIGKILL'); await owner.exit;
  await assert.rejects(f.create({ recover: true }), code('OWNER_ACTIVE'));
  worker.child.kill('SIGKILL'); await worker.exit;
  const reopened = await f.create({ recover: true });
  assert.equal((await reopened.read()).children[0].pid, worker.ready.pid);
  await reopened.release({ status: 'ambiguous', stopConfirmed: true });
});

test('missing child PID and an unconfirmed active lease never authorize recovery', async t => {
  const f = await fixture(t); const handle = await f.create();
  await handle.update({ children: [childMetadata(null)] });
  await assert.rejects(handle.release({ status: 'completed', stopConfirmed: true }), code('CHILD_ACTIVE'));
  await handle.release({ status: 'ambiguous', stopConfirmed: false });
  await assert.rejects(f.create({ recover: true }), code('OWNER_ACTIVE'));
});

test('child metadata cannot drop an active process, forge stopping, or escape controls', async t => {
  const f = await fixture(t); const handle = await f.create();
  await assert.rejects(handle.update({ children: [childMetadata(process.pid, { stopConfirmed: true, status: 'completed' })] }), code('CHILD_ACTIVE'));
  await assert.rejects(handle.update({ children: [childMetadata(null, { workerRoot: '../outside' })] }), code('INPUT_INVALID'));
  await assert.rejects(handle.update({ children: [childMetadata(null, { workerRoot: 'workspace/controls' })] }), code('STORAGE_INVALID'));
  await fsp.symlink(f.projectRoot, path.join(handle.root, 'linked-worker'));
  await assert.rejects(handle.update({ children: [childMetadata(null, { workerRoot: 'linked-worker/not-yet-created' })] }), code('STORAGE_INVALID'));
  await handle.update({ children: [childMetadata(process.pid)] });
  await assert.rejects(handle.update({ children: [] }), code('CHILD_CONFLICT'));
  await assert.rejects(handle.update({ children: [childMetadata(null)] }), code('CHILD_CONFLICT'));
  await handle.release({ status: 'ambiguous', stopConfirmed: false });
});

test('strict checkpoints reject credentials, changed versions, identity, and duplicate manifests', async t => {
  const f = await fixture(t); const handle = await f.create();
  await assert.rejects(handle.update({ prompt: 'secret' }), code('INPUT_INVALID'));
  await assert.rejects(handle.update({ versions: { ...versions, apiKey: 'secret' } }), code('INPUT_INVALID'));
  await assert.rejects(handle.update({ runId: 'other' }), code('INPUT_INVALID'));
  await assert.rejects(handle.update({ versions: { ...versions, codex: 'other' } }), code('VERSION_CONFLICT'));
  const record = { path: 'main.tex', sha256: sha('a'), bytes: 1 };
  await assert.rejects(handle.update({ baseFiles: [record, record] }), code('INPUT_INVALID'));
  await handle.update({ baseFiles: [record], skills: [record] });
  await assert.rejects(handle.update({ baseFiles: [{ ...record, sha256: sha('b') }] }), code('VERSION_CONFLICT'));
  await handle.release({ status: 'completed', stopConfirmed: true });
  await assert.rejects(f.create({ recover: true, expectedVersions: { ...versions, runtime: 'changed' } }), code('VERSION_CONFLICT'));
  const stateFile = path.join(handle.root, 'checkpoint.json');
  const state = JSON.parse(await fsp.readFile(stateFile)); state.runId = 'wrong';
  await fsp.writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(f.create({ recover: true }), code('IDENTITY_CONFLICT'));
});

test('invalid owner tokens, directory modes, symbolic links and hard links are refused', async t => {
  const f = await fixture(t); const handle = await f.create(); const checkpoint = path.join(handle.root, 'checkpoint.json');
  const original = await fsp.readFile(checkpoint);
  await fsp.link(checkpoint, path.join(handle.root, 'linked'));
  await assert.rejects(handle.read, code('STORAGE_INVALID')); await fsp.unlink(path.join(handle.root, 'linked'));
  await fsp.unlink(checkpoint); await fsp.symlink(path.join(f.projectRoot, 'missing'), checkpoint);
  await assert.rejects(handle.read, code('STORAGE_INVALID'));
  await fsp.unlink(checkpoint); await fsp.writeFile(checkpoint, original, { mode: 0o600 });
  await fsp.chmod(handle.workspace, 0o755); await assert.rejects(handle.read, code('STORAGE_INVALID')); await fsp.chmod(handle.workspace, 0o700);
  const ownerPath = path.join(handle.root, 'owner.json'); const owner = JSON.parse(await fsp.readFile(ownerPath)); owner.token = '00000000-0000-4000-8000-000000000001';
  await fsp.writeFile(ownerPath, JSON.stringify(owner)); await assert.rejects(handle.read, code('OWNER_CONFLICT'));
});

test('linked project paths and linked private containers never permit initialization', async t => {
  const f = await fixture(t); const linked = path.join(f.base, 'linked-project'); await fsp.symlink(f.projectRoot, linked);
  await assert.rejects(createRetainedWorkspace({ ...f.config, projectRoot: linked }), code('STORAGE_INVALID'));
  const outside = path.join(f.base, 'outside'); await fsp.mkdir(outside, { mode: 0o700 });
  await fsp.symlink(outside, path.join(path.dirname(f.projectRoot), '.scienceprism-runtime'));
  await assert.rejects(f.create(), code('STORAGE_INVALID'));
  assert.deepEqual(await fsp.readdir(outside), []);
});

test('corrupt, oversized, and excessive metadata fail without losing the original checkpoint', async t => {
  const f = await fixture(t); const handle = await f.create(); const checkpoint = path.join(handle.root, 'checkpoint.json');
  const original = await fsp.readFile(checkpoint);
  const records = Array.from({ length: 4096 }, (_, index) => ({ path: `${index}-${'a'.repeat(500)}`, sha256: sha('x'), bytes: 1 }));
  await assert.rejects(handle.update({ baseFiles: records }), code('CAPACITY'));
  assert.deepEqual(await fsp.readFile(checkpoint), original);
  await assert.rejects(handle.update({ children: Array.from({ length: 17 }, (_, n) => childMetadata(null, { runId: String(n), workerRoot: `worker-${n}` })) }), code('INPUT_INVALID'));
  await fsp.writeFile(checkpoint, '{broken'); await assert.rejects(handle.read, code('STATE_INVALID'));
  await fsp.writeFile(checkpoint, Buffer.alloc(1_048_577)); await assert.rejects(handle.read, code('CAPACITY'));
});

test('a real filesystem commit failure leaves the old checkpoint usable and cleans temporary files', async t => {
  const f = await fixture(t); const handle = await f.create(); const checkpoint = path.join(handle.root, 'checkpoint.json');
  const original = await fsp.readFile(checkpoint); const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === checkpoint) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' }); return rename(source, target); };
  try { await assert.rejects(handle.update({ status: 'running' }), code('SAVE_FAILED')); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(await fsp.readFile(checkpoint), original); assert.equal((await handle.read()).revision, 0);
  assert.equal((await fsp.readdir(handle.root)).some(name => name.endsWith('.tmp')), false);
  await handle.update({ status: 'running' }); assert.equal((await handle.read()).revision, 1);
  await handle.release({ status: 'cancelled', stopConfirmed: true });
});

test('an unexplained recovery claim is kept and cannot be aged into an ownership grant', async t => {
  const f = await fixture(t); const handle = await f.create(); await handle.release({ status: 'completed', stopConfirmed: true });
  await fsp.writeFile(path.join(handle.root, 'claim'), '', { mode: 0o600 });
  await assert.rejects(f.create({ recover: true }), code('BUSY'));
  assert.equal(fs.existsSync(path.join(handle.root, 'claim')), true);
});

test('unknown process visibility and valid-but-external checkpoint changes fail closed', async t => {
  const f = await fixture(t); const handle = await f.create();
  await handle.release({ status: 'completed', stopConfirmed: true });
  const ownerPath = path.join(handle.root, 'owner.json');
  const owner = JSON.parse(await fsp.readFile(ownerPath)); owner.pid = 2147480000;
  await fsp.writeFile(ownerPath, JSON.stringify(owner));
  const kill = process.kill;
  process.kill = pid => { if (pid === owner.pid) throw Object.assign(new Error('unknown fixture process'), { code: 'EPERM' }); return kill(pid, 0); };
  try { await assert.rejects(f.create({ recover: true }), code('OWNER_ACTIVE')); }
  finally { process.kill = kill; }
  const reopened = await f.create({ recover: true });
  const checkpoint = path.join(reopened.root, 'checkpoint.json');
  const state = JSON.parse(await fsp.readFile(checkpoint)); state.versions.runtime = 'silently-upgraded';
  await fsp.writeFile(checkpoint, JSON.stringify(state));
  await assert.rejects(reopened.read, code('STATE_CONFLICT'));
});
