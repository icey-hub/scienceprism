import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { claimAutomationOwner, inspectAutomationOwner } from '../src/services/researchAutomation/owner.js';

const moduleUrl = new URL('../src/services/researchAutomation/owner.js', import.meta.url).href;
async function fixture(t) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-owner/', import.meta.url));
  await fsp.mkdir(cache, { recursive: true }); const root = await fsp.mkdtemp(path.join(cache, 'test-'));
  const projectRoot = fs.realpathSync(root);
  t.after(() => fsp.rm(projectRoot, { recursive: true, force: true }));
  const container = path.join(projectRoot, '.scienceprism', 'automation-owner');
  return { projectRoot, container, active: path.join(container, 'active'), archive: path.join(container, 'archive'),
    claim: (sessionId = 'session') => claimAutomationOwner({ projectRoot, sessionId }) };
}
async function childFixture(t, f, sessionId, { barrier } = {}) {
  const source = `import fs from 'node:fs'; import {claimAutomationOwner} from ${JSON.stringify(moduleUrl)};
    const send=value=>fs.writeSync(1,JSON.stringify(value)+'\\n');
    ${barrier ? `const rename=fs.renameSync;
      fs.renameSync=(from,to)=>{ if(from.endsWith('/active')) { send({barrier:true}); const limit=Date.now()+10000;
        while(!fs.existsSync(process.env.OWNER_GO)) { if(Date.now()>limit) throw new Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } }
        return rename(from,to); };` : ''}
    try { const lease=claimAutomationOwner({projectRoot:process.env.OWNER_ROOT,sessionId:process.env.OWNER_SESSION});
      send({claimed:true,pid:process.pid,sessionId:lease.sessionId}); const timer=setInterval(()=>{},1000);
      process.stdin.on('data',value=>{if(String(value).trim()==='release'){lease.release({stopConfirmed:true});send({released:true});clearInterval(timer);process.exit(0);}});
    } catch(error) {send({claimed:false,code:error.code});process.exit(0);}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: f.projectRoot, OWNER_ROOT: f.projectRoot, OWNER_SESSION: sessionId, OWNER_GO: barrier || '' } });
  const exit = once(child, 'exit'), messages = []; let pending = '', stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  child.stdout.on('data', value => { pending += value; while (pending.includes('\n')) { const end = pending.indexOf('\n'); messages.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000;
    while (!messages.some(predicate)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(stderr || 'Owner fixture ended before expected message.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return messages.find(predicate);
  };
  return { child, exit, messages, waitFor };
}

test('synchronous lease is private and false release retains the active owner', async t => {
  const f = await fixture(t), lease = f.claim();
  assert.equal(lease.pid, process.pid); assert.equal(lease.sessionId, 'session'); assert.equal(lease.assertOwned(), true);
  assert.equal(fs.statSync(f.active).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(f.active, 'owner.json')).mode & 0o777, 0o600);
  assert.equal(lease.release({ stopConfirmed: false }), false); assert.equal(lease.assertOwned(), true);
  assert.throws(() => f.claim('other'), { code: 'AUTOMATION_OWNER_BUSY' });
  assert.equal(lease.release({ stopConfirmed: true }), true); assert.throws(lease.assertOwned, { code: 'AUTOMATION_OWNER_CLOSED' });
  const next = f.claim('next'); assert.equal(next.assertOwned(), true); assert.equal(fs.readdirSync(f.archive).length, 1);
  next.release({ stopConfirmed: true });
});

test('a genuinely live other process blocks takeover until its explicit stopped release', async t => {
  const f = await fixture(t), worker = await childFixture(t, f, 'child');
  const ready = await worker.waitFor(value => value.claimed === true); assert.equal(ready.pid, worker.child.pid);
  assert.throws(() => f.claim('other'), { code: 'AUTOMATION_OWNER_BUSY' });
  worker.child.stdin.write('release\n'); await worker.exit;
  const lease = f.claim('after-release'); assert.equal(lease.assertOwned(), true); lease.release({ stopConfirmed: true });
});

test('OS-confirmed process death permits recovery without trusting elapsed time or old session', async t => {
  const f = await fixture(t), worker = await childFixture(t, f, 'crashed'); await worker.waitFor(value => value.claimed === true);
  const before = JSON.parse(fs.readFileSync(path.join(f.active, 'owner.json'), 'utf8'));
  worker.child.kill('SIGKILL'); await worker.exit;
  assert.throws(() => process.kill(worker.child.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(inspectAutomationOwner({ projectRoot: f.projectRoot }), { pid: worker.child.pid, sessionId: 'crashed', released: false, present: false });
  const lease = f.claim('new-session'); assert.equal(lease.sessionId, 'new-session');
  assert.equal(fs.readFileSync(path.join(f.archive, before.token, 'owner.json'), 'utf8').includes('crashed'), true);
  lease.release({ stopConfirmed: true });
});

test('two real reclaimers racing the same released token cannot rename away the new winner', async t => {
  const f = await fixture(t), initial = f.claim(); initial.release({ stopConfirmed: true });
  const go = path.join(f.projectRoot, 'go');
  const [a, b] = await Promise.all([childFixture(t, f, 'a', { barrier: go }), childFixture(t, f, 'b', { barrier: go })]);
  await Promise.all([a.waitFor(value => value.barrier), b.waitFor(value => value.barrier)]); fs.writeFileSync(go, 'go');
  const outcomes = await Promise.all([a.waitFor(value => value.claimed !== undefined), b.waitFor(value => value.claimed !== undefined)]);
  assert.equal(outcomes.filter(value => value.claimed).length, 1); assert.equal(outcomes.filter(value => value.code === 'AUTOMATION_OWNER_BUSY').length, 1);
  const winner = outcomes[0].claimed ? a : b; const record = JSON.parse(fs.readFileSync(path.join(f.active, 'owner.json'), 'utf8'));
  assert.equal(record.pid, winner.child.pid); assert.equal(record.released, false); assert.equal(fs.readdirSync(f.archive).length, 1);
  assert.throws(() => f.claim('third'), { code: 'AUTOMATION_OWNER_BUSY' });
  winner.child.stdin.write('release\n'); await winner.exit;
});

test('permission errors and unknown PID checks fail closed instead of assuming death', async t => {
  const f = await fixture(t), lease = f.claim();
  const record = JSON.parse(fs.readFileSync(path.join(f.active, 'owner.json'), 'utf8')); record.pid = 123456;
  fs.writeFileSync(path.join(f.active, 'owner.json'), JSON.stringify(record));
  for (const code of ['EPERM', 'EIO']) {
    const original = process.kill; process.kill = () => { const reason = new Error('unknown'); reason.code = code; throw reason; };
    try { assert.throws(() => f.claim('recovery'), { code: 'AUTOMATION_OWNER_BUSY' }); } finally { process.kill = original; }
  }
  assert.throws(lease.assertOwned, { code: 'AUTOMATION_OWNER_LOST' });
});

test('release only saves its own token and cannot release a replacement session', async t => {
  const f = await fixture(t), lease = f.claim(); const target = path.join(f.active, 'owner.json');
  const record = JSON.parse(fs.readFileSync(target, 'utf8')); record.sessionId = 'replacement'; fs.writeFileSync(target, JSON.stringify(record));
  assert.throws(() => lease.release({ stopConfirmed: true }), { code: 'AUTOMATION_OWNER_LOST' });
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).released, false);
});

test('empty, corrupt, over-limit and invalid owner records remain reserved', async t => {
  for (const text of ['', '{bad', JSON.stringify({ schemaVersion: 1, pid: 0, token: 'invalid', sessionId: 'old', released: false }), 'x'.repeat(4097)]) {
    const f = await fixture(t); f.claim(); fs.writeFileSync(path.join(f.active, 'owner.json'), text);
    assert.throws(() => f.claim('new'), error => ['AUTOMATION_OWNER_UNKNOWN', 'AUTOMATION_OWNER_STORAGE_INVALID'].includes(error.code));
  }
  const f = await fixture(t); f.claim(); fs.unlinkSync(path.join(f.active, 'owner.json'));
  assert.throws(() => f.claim('new'), { code: 'AUTOMATION_OWNER_UNKNOWN' }); assert.equal(fs.existsSync(f.active), true);
});

test('canonical identity and project/metadata/active/archive symlink boundaries are enforced', async t => {
  const f = await fixture(t);
  for (const sessionId of ['', 'x'.repeat(201), 'bad\0', ' session']) assert.throws(() => f.claim(sessionId), { code: 'AUTOMATION_OWNER_INPUT_INVALID' });
  const alias = `${f.projectRoot}-alias`; fs.symlinkSync(f.projectRoot, alias); t.after(() => fsp.unlink(alias));
  assert.throws(() => claimAutomationOwner({ projectRoot: alias, sessionId: 'session' }), { code: 'AUTOMATION_OWNER_STORAGE_INVALID' });
  for (const component of ['.scienceprism', 'active', 'archive']) {
    const linked = await fixture(t); linked.claim().release({ stopConfirmed: true });
    const target = component === '.scienceprism' ? path.join(linked.projectRoot, component) : path.join(linked.container, component);
    fs.renameSync(target, `${target}-original`); fs.symlinkSync(`${target}-original`, target);
    assert.throws(() => linked.claim('new'), { code: 'AUTOMATION_OWNER_STORAGE_INVALID' });
  }
});

test('owner.json cannot be followed through symbolic or hard links', async t => {
  for (const kind of ['symbolic', 'hard']) {
    const f = await fixture(t); f.claim(); const target = path.join(f.active, 'owner.json'), original = path.join(f.projectRoot, 'original-owner.json');
    fs.renameSync(target, original); if (kind === 'symbolic') fs.symlinkSync(original, target); else fs.linkSync(original, target);
    assert.throws(() => f.claim('other'), { code: 'AUTOMATION_OWNER_STORAGE_INVALID' });
    assert.throws(() => inspectAutomationOwner({ projectRoot: f.projectRoot }), { code: 'AUTOMATION_OWNER_STORAGE_INVALID' });
    assert.equal(JSON.parse(fs.readFileSync(original, 'utf8')).released, false);
  }
});

test('inspection creates no storage and returns only public read-only live and release state', async t => {
  const f = await fixture(t); assert.equal(inspectAutomationOwner({ projectRoot: f.projectRoot }), null);
  assert.deepEqual(fs.readdirSync(f.projectRoot), []);
  const lease = f.claim(); const target = path.join(f.active, 'owner.json');
  const before = fs.readFileSync(target, 'utf8'), stat = fs.statSync(target, { bigint: true });
  assert.deepEqual(inspectAutomationOwner({ projectRoot: f.projectRoot }), { pid: process.pid, sessionId: 'session', released: false, present: true });
  assert.equal(fs.readFileSync(target, 'utf8'), before); const after = fs.statSync(target, { bigint: true });
  assert.equal(after.mtimeNs, stat.mtimeNs); assert.equal(after.ctimeNs, stat.ctimeNs);
  assert.deepEqual(fs.readdirSync(f.active), ['owner.json']);
  lease.release({ stopConfirmed: true });
  const result = inspectAutomationOwner({ projectRoot: f.projectRoot }); assert.equal(result.released, true); assert.equal(result.present, true);
  assert.equal(Object.hasOwn(result, 'token'), false);
  fs.renameSync(f.active, path.join(f.archive, 'test-absent')); assert.equal(inspectAutomationOwner({ projectRoot: f.projectRoot }), null);
});

test('inspection reports uncertain PID evidence without changing or exposing the owner', async t => {
  const f = await fixture(t); f.claim(); const target = path.join(f.active, 'owner.json'), before = fs.readFileSync(target, 'utf8');
  for (const code of ['EPERM', 'EIO']) {
    const original = process.kill; process.kill = () => { const reason = new Error('uncertain'); reason.code = code; throw reason; };
    try { assert.deepEqual(inspectAutomationOwner({ projectRoot: f.projectRoot }), { pid: process.pid, sessionId: 'session', released: false, present: null }); }
    finally { process.kill = original; }
  }
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  fs.writeFileSync(target, '{invalid');
  assert.throws(() => inspectAutomationOwner({ projectRoot: f.projectRoot }), { code: 'AUTOMATION_OWNER_UNKNOWN' });
});
