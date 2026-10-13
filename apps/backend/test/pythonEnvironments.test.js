import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { createEnvironmentService, validateEnvironmentConfiguration } from '../src/services/experimentRunner/environments.js';
import { registerEnvironmentRoutes } from '../src/routes/environments.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,prepare) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'python-environments-'));
  const projects={};for(const id of ['first','second']){const root=path.join(base,id);projects[id]=root;await fs.mkdir(path.join(root,'.scienceprism'),{recursive:true});await fs.writeFile(path.join(root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['experiment.execute'],allowedPaths:['wheels']}));}
  const service=createEnvironmentService({resolveProject:async id=>{if(!projects[id])throw new Error('not found');return projects[id];},prepare:prepare||fakePrepare,probe:async()=>({available:true})});
  t.after(async()=>{await service.shutdown();await fs.rm(base,{recursive:true,force:true});});
  return {base,projects,service};
}
async function fakePrepare(options) {
  await options.beforeLaunch();await fs.mkdir(path.join(options.directory,'bin'));await fs.writeFile(path.join(options.directory,'bin/python'),'fixed-interpreter');await options.onProcess({pid:process.pid,stopConfirmed:true});
  return {python:{version:'3.fixture',implementation:'fixture'},packages:[],isolation:'fixed-fixture',hardware:{platform:'fixture',arch:'fixture',cpuCount:1}};
}
async function settle(service,id,jobId){for(let i=0;i<200;i++){const job=await service.get(id,jobId);if(['ready','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,5));}throw new Error('fixture preparation did not settle');}

test('environment lock rejects traversal, shell-style/config extras and duplicate wheels',()=>{
  for(const input of [{command:'pip install numpy'}, {packages:[{path:'../a.whl',sha256:'a'.repeat(64)}]}, {packages:[{path:'wheels/\0a.whl',sha256:'a'.repeat(64)}]}, {packages:[{path:'.scienceprism/a.whl',sha256:'a'.repeat(64)}]}, {packages:[{path:'wheels/a.whl',sha256:'A'.repeat(64)}]}])assert.throws(()=>validateEnvironmentConfiguration(input),{code:'ENVIRONMENT_CONFIG_INVALID'});
  assert.throws(()=>validateEnvironmentConfiguration({packages:[{path:'one/a.whl',sha256:'a'.repeat(64)},{path:'two/a.whl',sha256:'b'.repeat(64)}]}),{code:'ENVIRONMENT_CONFIG_INVALID'});
});
test('ready project environment reuses actual fixed files and is unavailable across projects',async t=>{
  let calls=0;const {service}=await fixture(t,async options=>{calls++;return fakePrepare(options);});
  const created=await service.create('first',{}),ready=await settle(service,'first',created.id);assert.equal(ready.status,'ready');assert.equal(ready.configuration.version,1);assert.match(ready.environment.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await service.create('first',{})).id,created.id);assert.equal(calls,1);assert.equal((await service.listJobs('first')).length,1);
  await assert.rejects(service.verify('second',created.id),{code:'ENVIRONMENT_NOT_FOUND'});
  const verified=await service.verify('first',created.id,ready.environment.sha256);await fs.writeFile(path.join(verified.root,'bin/python'),'changed');
  await assert.rejects(service.verify('first',created.id),{code:'ENVIRONMENT_CONTENT_CHANGED'});
});
test('wheel SHA and scope are checked before preparation; retry keeps frozen input',async t=>{
  let calls=0;const {service,projects}=await fixture(t,async o=>{calls++;return fakePrepare(o);});await fs.mkdir(path.join(projects.first,'wheels'));const bytes=Buffer.from('fixed wheel input');await fs.writeFile(path.join(projects.first,'wheels/fixed.whl'),bytes);
  await assert.rejects(service.create('first',{packages:[{path:'other/fixed.whl',sha256:hash(bytes)}]}),{code:'ENVIRONMENT_PATH_DENIED'});
  const job=await service.create('first',{packages:[{path:'wheels/fixed.whl',sha256:'0'.repeat(64)}]}),failed=await settle(service,'first',job.id);assert.equal(failed.error.code,'ENVIRONMENT_WHEEL_CHANGED');assert.equal(calls,0);
  await service.retry('first',job.id);const retried=await settle(service,'first',job.id);assert.equal(retried.configurationSha256,failed.configurationSha256);assert.equal(retried.attempt,2);assert.equal(retried.status,'failed');assert.equal(calls,0);
});
test('wheel symlinks and changed project authorization are rejected before side effects',async t=>{
  const {service,projects}=await fixture(t);await fs.mkdir(path.join(projects.first,'wheels'));await fs.writeFile(path.join(projects.first,'actual.whl'),'wheel');await fs.symlink('../actual.whl',path.join(projects.first,'wheels/link.whl'));
  const job=await service.create('first',{packages:[{path:'wheels/link.whl',sha256:hash('wheel')}]}),failed=await settle(service,'first',job.id);assert.equal(failed.error.code,'ENVIRONMENT_PATH_DENIED');
  await fs.writeFile(path.join(projects.first,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:[]}));await assert.rejects(service.retry('first',job.id),{code:'ENVIRONMENT_PREPARATION_DENIED'});
});
test('cancel waits for real stop receipt before release, and retry uses a new attempt',async t=>{
  let started;const entered=new Promise(r=>started=r);let calls=0;
  const {service}=await fixture(t,async o=>{if(++calls>1)return fakePrepare(o);await o.beforeLaunch();await o.onProcess({pid:process.pid,stopConfirmed:false});started();await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));await o.onProcess({pid:process.pid,stopConfirmed:true});throw new Error('cancelled fixture');});
  const job=await service.create('first',{});await entered;const cancelled=await service.cancel('first',job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.process.stopConfirmed,true);await service.retry('first',job.id);assert.equal((await settle(service,'first',job.id)).status,'ready');
});
test('HTTP rejects replacement retry config and returns current preparation independently',async t=>{
  const {service}=await fixture(t);const app=Fastify();registerEnvironmentRoutes(app,{service});t.after(()=>app.close());
  let response=await app.inject({method:'POST',url:'/api/projects/first/environments',payload:{packages:[]}});assert.equal(response.statusCode,200);const id=response.json().job.id;await settle(service,'first',id);
  response=await app.inject({method:'POST',url:`/api/projects/first/environments/${id}/retry`,payload:{packages:[]}});assert.equal(response.statusCode,400);
  response=await app.inject({method:'GET',url:'/api/projects/first/environments'});assert.equal(response.json().jobs[0].status,'ready');assert.equal(response.json().capability.remote.available,false);
  response=await app.inject({method:'GET',url:`/api/projects/second/environments/${id}`});assert.equal(response.statusCode,404);
});

test('an interrupted launch without a PID refuses both retry and another preparation',async t=>{
  const {service,base}=await fixture(t);const job=await service.create('first',{});await settle(service,'first',job.id);
  const index=path.join(base,'.scienceprism-environments',hash('first'),'index.json');const doc=JSON.parse(await fs.readFile(index,'utf8'));
  doc.jobs[0].status='preparing';doc.jobs[0].process={pid:null,stopConfirmed:false,launchPending:true};await fs.writeFile(index,JSON.stringify(doc));
  assert.equal((await service.get('first',job.id)).status,'interrupted');
  await assert.rejects(service.retry('first',job.id),{code:'ENVIRONMENT_STOP_UNCONFIRMED'});
  await assert.rejects(service.create('first',{}),{code:'ENVIRONMENT_STOP_UNCONFIRMED'});
  assert.deepEqual(JSON.parse(await fs.readFile(index,'utf8')),doc);
});
