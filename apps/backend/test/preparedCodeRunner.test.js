import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cache=fileURLToPath(new URL('../../../.cache/research-workbench-v2/prepared-code-runner-tests/',import.meta.url));
await fs.mkdir(cache,{recursive:true});const data=await fs.mkdtemp(path.join(cache,'projects-'));
process.env.SCIENCEPRISM_DATA_DIR=data;
const {codePreparationService}=await import('../src/services/experimentRunner/codePreparations.js');
const {datasetService}=await import('../src/services/datasets/index.js');
const {createExperimentRun,decideExperimentRun,startExperimentRun}=await import('../src/services/experimentRunner/index.js');
after(async()=>{await datasetService.shutdown();await fs.rm(data,{recursive:true,force:true});});
const hash=value=>createHash('sha256').update(value).digest('hex');
const code=`import fs from 'node:fs/promises';
const job=JSON.parse(await fs.readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT,'utf8'));
const values=(await fs.readFile(job.dataset.input.path,'utf8')).trim().split(/\\s+/).map(Number);
await fs.mkdir('results',{recursive:true});
await fs.writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'mean',value:values.reduce((a,b)=>a+b)/values.length}]}));`;

// These are explicit provenance fixtures, not real model/CLI completion proof.
// The tests exercise actual domain persistence, overlay, OS execution and archive.
async function project(id,{existing=false,content=code}={}){
  const root=path.join(data,id),relative='generated/run.mjs';await fs.mkdir(path.join(root,'.scienceprism'),{recursive:true});
  await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id,name:id}));
  await fs.writeFile(path.join(root,'main.tex'),'original manuscript');
  await fs.writeFile(path.join(root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['project.read','patch.propose','experiment.execute'],allowedPaths:['generated','data','results','main.tex'],maxConcurrent:1}));
  if(existing){await fs.mkdir(path.join(root,'generated'));await fs.writeFile(path.join(root,relative),'throw new Error("original code remains untouched");');}
  const original=existing?await fs.readFile(path.join(root,relative),'utf8'):null;
  const patch={path:relative,content,baseVersion:{exists:existing,sha256:existing?hash(original):null},deleted:false};
  const parent={id:`${id}-parent`,projectId:id,adapter:'deepseek',attempt:1,status:'completed',patches:[patch],events:[]};
  const child={id:`${id}-child`,projectId:id,kind:'codex-worker',adapter:'codex',status:'completed',parentRunId:parent.id,parentAttempt:1,recovery:{phase:'handed-off'},workerStorage:{stopConfirmed:true},workerResult:{ok:true},patches:[patch]};
  await fs.writeFile(path.join(root,'.scienceprism/harness-runs.json'),JSON.stringify({schemaVersion:1,projectId:id,runs:[parent,child]}));
  const {preparation}=await codePreparationService.create(id,{sourceRunId:parent.id,paths:[relative]});
  const {dataset}=await datasetService.importData(id,{bytes:Buffer.from('1\n2\n3\n'),filename:'values.txt'});
  const plan={dataset:{id:dataset.id,version:dataset.sha256},protocol:'Actual fixed-code and data input fixture; no scientific claim.',execution:{adapter:'node',entrypoint:relative,args:[],codePreparationId:preparation.id},codePaths:[relative],resources:{timeoutMs:5000,maxArtifactBytes:65536},artifacts:[{path:'results/metrics.json',kind:'metric'}]};
  return {root,relative,original,preparation,plan};
}
async function approved(id,plan){const run=await createExperimentRun(id,{plan});await decideExperimentRun(id,run.id,{decision:'approve',actor:'human'});return run;}
for(const existing of [false,true])test(`prepared ${existing?'replacement':'new'} code executes and archives without applying the original project`,async()=>{
  const id=existing?'replace-code':'new-code',f=await project(id,{existing}),created=await approved(id,f.plan),run=await startExperimentRun(id,created.id,{wait:true});
  assert.equal(run.status,'completed',JSON.stringify(run.error));assert.equal(run.metrics.find(m=>m.name==='mean').value,2);
  assert.equal(run.manifest.code.preparation.id,f.preparation.id);assert.equal(run.manifest.command.codePreparationId,f.preparation.id);
  assert.notEqual(run.manifest.code.originalSnapshotHash,run.manifest.code.snapshotHash);
  const archived=run.artifacts.find(a=>a.name===`inputs/${f.relative}`);assert.ok(archived);assert.equal(archived.sha256,hash(code));
  assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),'original manuscript');
  assert.equal(await fs.readFile(path.join(f.root,f.relative),'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),f.original);
  assert.equal(run.execution.process.stopConfirmed,true);
});
test('prepared source files cannot bypass a narrower parent scope',async()=>{
  const id='parent-code-scope',f=await project(id),run=await approved(id,f.plan);
  await assert.rejects(startExperimentRun(id,run.id,{wait:true,allowedPaths:['data','results']}),{code:'EXPERIMENT_PATH_DENIED'});
});
test('prepared code and output declarations cannot name the same file',async()=>{
  const id='code-output-collision',f=await project(id);
  await assert.rejects(createExperimentRun(id,{plan:{...f.plan,artifacts:[{path:f.relative,kind:'output'}]}}),{code:'EXPERIMENT_CODE_OUTPUT_COLLISION'});
});
test('a project source edit after freezing code fails before process launch',async()=>{
  const id='stale-base',f=await project(id,{existing:true}),run=await approved(id,f.plan);
  await fs.writeFile(path.join(f.root,f.relative),'new user code must be preserved');
  const final=await startExperimentRun(id,run.id,{wait:true});assert.equal(final.status,'failed');assert.equal(final.error.code,'EXPERIMENT_CODE_CHANGED');
  assert.equal(final.execution.process?.pid||null,null);assert.equal(await fs.readFile(path.join(f.root,f.relative),'utf8'),'new user code must be preserved');
});
test('a source ledger change after freezing is rejected even when the project snapshot is unchanged',async()=>{
  const id='stale-producer',f=await project(id),run=await approved(id,f.plan);
  const file=path.join(f.root,'.scienceprism/harness-runs.json'),ledger=JSON.parse(await fs.readFile(file));ledger.runs[1].workerStorage.stopConfirmed=false;await fs.writeFile(file,JSON.stringify(ledger));
  const final=await startExperimentRun(id,run.id,{wait:true});assert.equal(final.status,'failed');assert.equal(final.error.code,'CODE_PREPARATION_CHILD_CHANGED');assert.equal(final.execution.process?.pid||null,null);
});
test('attempting to modify fixed prepared code fails and retains the original executed source',async()=>{
  const id='readonly-code',content=`import fs from 'node:fs/promises';const file='generated/run.mjs';const original=await fs.readFile(file);await fs.chmod(file,0o600);await fs.writeFile(file,'changed');await fs.writeFile(file,original);await fs.chmod(file,0o400);await fs.mkdir('results',{recursive:true});await fs.writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'forged',value:1}]}));`;
  const f=await project(id,{content}),run=await approved(id,f.plan),final=await startExperimentRun(id,run.id,{wait:true});
  assert.equal(final.status,'failed');assert.equal(final.execution.process.stopConfirmed,true);
  assert.equal(final.artifacts.find(a=>a.name===`inputs/${f.relative}`).sha256,hash(content));assert.equal(await fs.stat(path.join(f.root,f.relative)).then(()=>true,()=>false),false);
});
