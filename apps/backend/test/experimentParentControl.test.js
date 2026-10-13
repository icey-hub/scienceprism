import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const cache = path.resolve('.cache/research-workbench-v2/experiment-broker');
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'control-test-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const runner = await import('../src/services/experimentRunner/index.js');
const { experimentManifestHash } = await import('../src/services/experimentRunner/manifest.js');
const repository = await import('../src/services/experimentRunner/repository.js');
test.after(() => fs.rm(data, { recursive: true, force: true }));

async function prepared(id, source = 'console.log("ACTUAL_EXECUTION");', codePaths) {
  const root = path.join(data, id);
  await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['experiment.execute'], maxConcurrent: 1 }));
  await fs.writeFile(path.join(root, 'run.mjs'), source);
  const run = await runner.createExperimentRun(id, { plan: {
    dataset: { id: 'controlled', version: 'v1' }, protocol: 'Controlled process test',
    execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, artifacts: [], resources: { timeoutMs: 4000 },
    ...(codePaths ? { codePaths } : {})
  } });
  const approved = await runner.decideExperimentRun(id, run.id, { decision: 'approve', actor: 'human' });
  return { root, run: approved, binding: { parentRunId: 'bound-parent', policyVersion: 'policy-v1', manifestSha256: experimentManifestHash(approved.manifest) } };
}

test('fixed parent binding rejects manifest drift before running and records actual process stop', async () => {
  const f = await prepared('binding');
  await assert.rejects(runner.startExperimentRun('binding', f.run.id, { wait: true, executionBinding: { ...f.binding, manifestSha256: '0'.repeat(64) } }), { code: 'EXPERIMENT_MANIFEST_CHANGED' });
  assert.equal((await runner.getExperimentRun('binding', f.run.id)).status, 'approved');
  let launches = 0;
  const result = await runner.startExperimentRun('binding', f.run.id, { wait: true, executionBinding: f.binding, beforeLaunch: async () => { launches++; } });
  assert.equal(result.status, 'completed'); assert.equal(launches, 1);
  assert.deepEqual(result.executionBinding, f.binding); assert.match(result.logs.stdout, /ACTUAL_EXECUTION/);
  assert.ok(result.execution.process.pid > 0); assert.equal(result.execution.process.stopConfirmed, true);
  assert.throws(() => process.kill(result.execution.process.pid, 0), { code: 'ESRCH' });
});

test('a parent-scoped workspace does not copy unrelated original files', async () => {
  const f = await prepared('scoped-copy', 'import{readFile}from"node:fs/promises";try{await readFile("private-notes.txt");console.log("LEAK")}catch(e){console.log(e.code)}', ['run.mjs']);
  await fs.writeFile(path.join(f.root,'private-notes.txt'),'private notes');
  const result = await runner.startExperimentRun('scoped-copy', f.run.id, { wait:true, executionBinding:f.binding, allowedPaths:['run.mjs'] });
  assert.equal(result.status,'completed'); assert.match(result.logs.stdout,/ENOENT/); assert.doesNotMatch(result.logs.stdout,/LEAK/);
  assert.equal(await fs.readFile(path.join(f.root,'private-notes.txt'),'utf8'),'private notes');
});

test('standalone launch rejects scope narrowing after a wider workspace was copied', async t => {
  const f = await prepared('late-scope', 'console.log("SHOULD_NOT_RUN");', ['run.mjs']);
  await fs.writeFile(path.join(f.root,'private-notes.txt'),'private notes');
  const original=fs.cp;
  fs.cp=async (source,target,options)=>{
    await original(source,target,options);
    if(source===f.root) await fs.writeFile(path.join(f.root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['experiment.execute'],allowedPaths:['run.mjs']}));
  };
  t.after(()=>{fs.cp=original;});
  const result=await runner.startExperimentRun('late-scope',f.run.id,{wait:true});
  assert.equal(result.status,'failed');assert.equal(result.error.code,'EXPERIMENT_PATH_SCOPE_CHANGED');
  assert.equal(result.execution.process.pid,null);assert.doesNotMatch(result.logs.stdout,/SHOULD_NOT_RUN/);
});

test('parent launch rejection reaches the actual spawn boundary with no process body', async () => {
  const f = await prepared('launch-revoked');
  const result = await runner.startExperimentRun('launch-revoked', f.run.id, { wait: true, executionBinding: f.binding, beforeLaunch: async () => { throw Object.assign(new Error('Parent policy revoked'), { code: 'CAPABILITY_DENIED' }); } });
  assert.equal(result.status, 'failed'); assert.equal(result.execution.process.pid, null);
  assert.equal(result.execution.process.stopConfirmed, true); assert.doesNotMatch(result.logs.stdout, /ACTUAL_EXECUTION/);
  assert.equal(await fs.readFile(path.join(f.root, 'run.mjs'), 'utf8'), 'console.log("ACTUAL_EXECUTION");');
});

test('parent cancellation waits for the spawned process to stop', async () => {
  const f = await prepared('parent-cancel', 'console.log("STARTED"); process.on("SIGTERM",()=>{}); setTimeout(()=>{},3000);');
  const controller = new AbortController();
  const pending = runner.startExperimentRun('parent-cancel', f.run.id, { wait: true, executionBinding: f.binding, signal: controller.signal });
  let pid;
  for (let i=0; i<100; i++) {
    const doc = await repository.readExperimentRuns(f.root, 'parent-cancel');
    pid = doc.runs[0].execution?.process?.pid;
    if (pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid > 0); controller.abort();
  const stopped = await pending;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.execution.process.stopConfirmed, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('restart refuses live or uncertain processes and does not convert them to retryable work', async () => {
  for (const [id, state] of [['unknown', undefined], ['preparing', { pid:null, stopConfirmed:false }], ['live', { pid:process.pid, stopConfirmed:true }]]) {
    const f = await prepared(`restart-${id}`);
    const doc = await repository.readExperimentRuns(f.root, `restart-${id}`);
    doc.runs[0].status='running'; doc.runs[0].execution={ process:state };
    await repository.writeExperimentRuns(f.root, doc);
    await assert.rejects(runner.getExperimentRun(`restart-${id}`, f.run.id), { code:'EXPERIMENT_STOP_UNCONFIRMED' });
    await assert.rejects(runner.retryExperimentRun(`restart-${id}`, f.run.id), { code:'EXPERIMENT_STOP_UNCONFIRMED' });
    assert.equal((await repository.readExperimentRuns(f.root, `restart-${id}`)).runs[0].status,'running');
  }
});

test('cancellation during running-state persistence waits for the executor settlement', async t => {
  const f = await prepared('cancel-persist');
  const original = fs.rename;
  let entered, release;
  const ready = new Promise(resolve => { entered=resolve; });
  const paused = new Promise(resolve => { release=resolve; });
  let intercepted=false;
  fs.rename = async (source, target) => {
    if (!intercepted && target===path.join(f.root,'.scienceprism/experiment-runs.json')) {
      const doc=JSON.parse(await fs.readFile(source,'utf8'));
      if (doc.runs[0].status==='running') { intercepted=true; entered(); await paused; }
    }
    return original(source,target);
  };
  t.after(()=>{ fs.rename=original; release(); });
  const start=runner.startExperimentRun('cancel-persist', f.run.id);
  await ready;
  let settled=false;
  const cancelled=runner.cancelExperimentRun('cancel-persist', f.run.id).then(result=>{ settled=true; return result; });
  await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(settled,false);
  release(); await start;
  const result=await cancelled;
  assert.equal(result.status,'cancelled'); assert.equal(result.execution.process.stopConfirmed,true);
  assert.doesNotMatch(result.logs.stdout,/ACTUAL_EXECUTION/);
});
