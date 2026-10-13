import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixtureRuntime, incrementFixtureCounter, installFixedSource } from './fixtures/automation-process-recovery.mjs';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-process-recovery/', import.meta.url));
await fsp.mkdir(cache, { recursive: true }); const dataDir = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
process.env.SCIENCEPRISM_DATA_DIR = dataDir; process.env.NODE_ENV = 'test';
after(() => fsp.rm(dataDir, { recursive: true, force: true }));
const { getAutomation, startAutomation, resumeAutomation, stopAutomation } = await import('../src/services/researchAutomation/index.js');
const { readAutomation, saveAutomationPolicy } = await import('../src/services/researchAutomation/policy.js');
const { listHarnessRuns, getHarnessRun, createHarnessRun, startHarnessRun, registerHarnessAdapter } = await import('../src/services/harnessRuntime/index.js');
const { inspectAutomationOwner } = await import('../src/services/researchAutomation/owner.js');
const { loadPaperSearches } = await import('../src/services/paperSearch.js');
const { fakeHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
registerHarnessAdapter({ ...fakeHarnessAdapter, async run(context) { await incrementFixtureCounter(context.request.projectId, 'adapter'); return fakeHarnessAdapter.run(context); } });

async function project(id) {
  const root = path.join(dataDir, id); await fsp.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fsp.writeFile(path.join(root, 'note.txt'), 'the original stays intact');
  await fsp.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'research.search'], networkAllowlist: ['export.arxiv.org'], maxConcurrent: 1 }));
  return root;
}
async function childFixture(t, id, mode) {
  const fixture = fileURLToPath(new URL('./fixtures/automation-process-recovery.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    SCIENCEPRISM_DATA_DIR: dataDir, TMPDIR: dataDir, PROCESS_PROBE_PROJECT: id, PROCESS_PROBE_MODE: mode } });
  const exit = once(child, 'exit'); let text = '', errors = '';
  child.stderr.on('data', value => { errors += value; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture readiness timed out: ${errors}`)), 10000);
    child.stdout.on('data', value => { text += value; const line = text.split('\n').find(value => value.startsWith('{')); if (line && text.endsWith('\n')) { clearTimeout(timeout); resolve(JSON.parse(line)); } });
    child.once('exit', () => { if (!text.includes('\n')) { clearTimeout(timeout); reject(new Error(errors || 'Fixture exited before readiness.')); } });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  return { child, exit, ready: await ready };
}
async function stored(root) {
  const names = ['.scienceprism/research-automation.json', '.scienceprism/harness-runs.json', '.scienceprism/research-workflow.json',
    '.scienceprism/automation-owner/active/owner.json', '.scienceprism/process-probe-counts.json', 'note.txt'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await fsp.readFile(path.join(root, name), 'utf8')])));
}
async function settled(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await getAutomation(id);
    if (!['running', 'queued', 'stopping'].includes(state.session.status)
      && (state.session.status !== 'completed' || inspectAutomationOwner({ projectRoot: path.join(dataDir, id) })?.released === true)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Recovery chain did not settle.');
}

test('foreign views preserve actual running owner and Runs; all foreign writers reject without modifying storage', async t => {
  const id = 'foreign-live', root = await project(id), worker = await childFixture(t, id, 'hold');
  const ready = worker.ready; assert.equal(ready.pid, worker.child.pid); assert.equal(ready.owner.sessionId, ready.sessionId);
  assert.equal(ready.owner.present, true); assert.equal(ready.owner.released, false);
  const before = await stored(root);
  assert.equal((await getAutomation(id)).session.status, 'running');
  assert.equal((await getHarnessRun(id, ready.runningRunId)).status, 'running');
  const runs = await listHarnessRuns(id); assert.equal(runs.find(run => run.id === ready.completedRunId).status, 'completed');
  assert.equal(runs.find(run => run.id === ready.runningRunId).cleanup?.modelSlotRetained, undefined);
  assert.deepEqual(await stored(root), before, 'foreign read-only views must not rewrite live history');
  const policy = await readAutomation(id);
  for (const action of [
    () => startAutomation(id, { actor: 'human', question: 'replacement', targetStage: 'search' }, fixtureRuntime),
    () => resumeAutomation(id, { actor: 'human' }, fixtureRuntime), () => stopAutomation(id, { actor: 'human' }),
    () => saveAutomationPolicy(id, { actor: 'human', expectedVersion: policy.version, policy: { ...policy.policy, enabled: false } }),
    () => createHarnessRun(id, { adapter: 'fake', task: 'foreign-create', capabilities: ['project.read'] }),
    () => startHarnessRun(id, ready.createdRunId, { wait: true, request: { fakeResponse: 'must never execute' } })
  ]) {
    await assert.rejects(action(), { code: 'AUTOMATION_OWNER_BUSY' }); assert.deepEqual(await stored(root), before, 'a rejected foreign writer must leave every stored record unchanged');
  }
  worker.child.kill('SIGKILL'); await worker.exit; assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
  assert.equal(inspectAutomationOwner({ projectRoot: root }).present, false);
  assert.equal((await getAutomation(id)).session.status, 'interrupted');
  const interrupted = await getHarnessRun(id, ready.runningRunId);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.error.code, 'HARNESS_INTERRUPTED');
  assert.equal(interrupted.cleanup.workspaceRetained, true); assert.equal(interrupted.cleanup.modelSlotRetained, true);
  const completed = await getHarnessRun(id, ready.completedRunId);
  assert.equal(completed.status, 'completed'); assert.equal(completed.reply, 'actually completed fixture');
  assert(completed.events.some(event => event.type === 'turn/end'), 'completion must come from a real fixed adapter turn');
  await assert.rejects(startHarnessRun(id, ready.createdRunId, { wait: true }), { code: 'HARNESS_STOP_UNCONFIRMED' });
  t.diagnostic(`actual owner PID ${ready.pid} stopped by SIGKILL and confirmed ESRCH; foreign 6 writes rejected, completed ${completed.id} retained, running ${interrupted.id} marked failed with retained slot`);
});

test('process death during workflow commit reuses truly completed fake Run and durable search receipt without repeating either', async t => {
  const id = 'saved-recovery', root = await project(id), worker = await childFixture(t, id, 'save-crash'), ready = worker.ready;
  const saved = await readAutomation(id), searchStep = saved.session.steps.find(step => step.stage === 'search');
  assert.equal(saved.session.status, 'running'); assert.equal(searchStep.calls.length, 1); assert.equal(searchStep.searches[0].status, 'completed');
  const completed = await getHarnessRun(id, ready.completedRunId); assert.equal(completed.status, 'completed');
  assert(completed.events.some(event => event.type === 'turn/end'));
  const beforeCounts = JSON.parse(await fsp.readFile(path.join(root, '.scienceprism/process-probe-counts.json'), 'utf8'));
  assert.deepEqual(beforeCounts, { adapter: 1, source: 1 });
  const beforeSearch = await loadPaperSearches(id); assert.equal(beforeSearch.sessions.length, 1); assert.equal(beforeSearch.sessions[0].id, ready.searchSessionId);
  worker.child.kill('SIGKILL'); await worker.exit; assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
  assert.equal((await getAutomation(id)).session.status, 'interrupted'); assert.equal((await getHarnessRun(id, ready.completedRunId)).status, 'completed');
  process.env.PROCESS_PROBE_PROJECT = id; await installFixedSource();
  await resumeAutomation(id, { actor: 'human' }, fixtureRuntime); const resumed = await settled(id);
  assert.equal(resumed.session.status, 'completed', JSON.stringify(resumed.session)); assert.equal(resumed.session.id, ready.sessionId);
  assert.equal(resumed.session.coordinatorRunId, ready.coordinatorRunId);
  const afterCounts = JSON.parse(await fsp.readFile(path.join(root, '.scienceprism/process-probe-counts.json'), 'utf8'));
  assert.deepEqual(afterCounts, beforeCounts, 'resume must consume completed Run and search receipts, with no second adapter/source call');
  const runs = await listHarnessRuns(id); assert.equal(runs.length, 2); assert(runs.every(run => run.status === 'completed'));
  assert.equal((await loadPaperSearches(id)).sessions.length, 1); assert.equal((await loadPaperSearches(id)).sessions[0].id, ready.searchSessionId);
  assert.equal(resumed.session.steps.find(step => step.stage === 'search').calls[0].runId, ready.completedRunId);
  assert.equal(await fsp.readFile(path.join(root, 'note.txt'), 'utf8'), 'the original stays intact');
  assert.equal(inspectAutomationOwner({ projectRoot: root }).released, true);
  t.diagnostic(`actual crash PID ${ready.pid} stopped with ESRCH; same coordinator ${ready.coordinatorRunId}, completed stage ${ready.completedRunId}, source ${ready.searchSessionId}; adapter/source counters remained 1/1`);
});
