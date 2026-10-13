import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache=fileURLToPath(new URL('../../../.cache/research-workbench-v2/dataset-runner-tests/',import.meta.url));
await fs.mkdir(cache,{recursive:true});
const data=await fs.mkdtemp(path.join(cache,'projects-'));
process.env.SCIENCEPRISM_DATA_DIR=data;
const {datasetService}=await import('../src/services/datasets/index.js');
const {createExperimentRun,decideExperimentRun,startExperimentRun}=await import('../src/services/experimentRunner/index.js');
after(async()=>{await datasetService.shutdown();await fs.rm(data,{recursive:true,force:true});});

async function project(id,{scope=['run.mjs','data','results'],bytes=Buffer.from('1\n2\n3\n'),code}={}){
  const root=path.join(data,id);await fs.mkdir(path.join(root,'.scienceprism'),{recursive:true});
  await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id,name:id}));
  await fs.writeFile(path.join(root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['project.read','experiment.execute'],allowedPaths:scope,maxConcurrent:1}));
  await fs.writeFile(path.join(root,'run.mjs'),code||`import fs from 'node:fs/promises';
const input=JSON.parse(await fs.readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT,'utf8'));
const bytes=await fs.readFile(input.dataset.input.path,'utf8');
const values=bytes.trim().split(/\\s+/).map(Number);
await fs.mkdir('results',{recursive:true});
await fs.writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'mean',value:values.reduce((a,b)=>a+b)/values.length}]}));`);
  const {dataset}=await datasetService.importData(id,{bytes,filename:'values.txt'});
  const plan={dataset:{id:dataset.id,version:dataset.sha256},protocol:'Read the fixed input and record the actual mean.',execution:{adapter:'node',entrypoint:'run.mjs',args:[]},seed:0,codePaths:['run.mjs'],resources:{timeoutMs:5000,maxArtifactBytes:65536},artifacts:[{path:'results/metrics.json',kind:'metric'}]};
  return {root,dataset,bytes,plan};
}
async function execute(id,plan){const run=await createExperimentRun(id,{plan});await decideExperimentRun(id,run.id,{decision:'approve',actor:'human'});return startExperimentRun(id,run.id,{wait:true});}

test('actual Node execution consumes an isolated verified input and archives its immutable source',async()=>{
  const id='actual-input',fixture=await project(id),run=await execute(id,fixture.plan);
  assert.equal(run.status,'completed',JSON.stringify(run.error));assert.equal(run.metrics.find(m=>m.name==='mean').value,2);
  assert.equal(run.execution.process.stopConfirmed,true);
  const source=run.artifacts.find(a=>a.name===`inputs/${run.manifest.dataset.input.path}`);assert.ok(source);assert.equal(source.sha256,fixture.dataset.sha256);
  assert.deepEqual(await fs.readFile(path.join(fixture.root,source.path)),fixture.bytes);
  const snapshot=run.artifacts.find(a=>a.name==='input-snapshot.json'),record=JSON.parse(await fs.readFile(path.join(fixture.root,snapshot.path)));
  assert.equal(record.dataset.artifactId,source.id);assert.equal(record.dataset.verified,true);assert.equal(record.complete,true);
  assert.deepEqual((await datasetService.content(id,fixture.dataset.id)).bytes,fixture.bytes);
  assert.equal(await fs.stat(path.join(fixture.root,'data')).then(()=>true,()=>false),false);
});
test('fixed raw data version rejects a wrong hash and another project before creating a Run',async()=>{
  const id='version-binding',{plan,dataset}=await project(id);
  await assert.rejects(createExperimentRun(id,{plan:{...plan,dataset:{id:dataset.id,version:'0'.repeat(64)}}}),{code:'EXPERIMENT_DATASET_VERSION_INVALID'});
  await project('foreign-input',{bytes:Buffer.from('4\n5\n6\n')});await assert.rejects(createExperimentRun('foreign-input',{plan}),{code:'EXPERIMENT_DATASET_NOT_FOUND'});
});
test('project scope must include the fixed data location before execution can start',async()=>{
  const id='input-scope',{plan}=await project(id,{scope:['run.mjs','results']});
  const run=await createExperimentRun(id,{plan});await decideExperimentRun(id,run.id,{decision:'approve',actor:'human'});
  await assert.rejects(startExperimentRun(id,run.id,{wait:true}),{code:'EXPERIMENT_PATH_DENIED'});
});
test('a narrower parent scope cannot gain access to data allowed by the project',async()=>{
  const id='parent-input-scope',{plan}=await project(id,{scope:[]});
  const run=await createExperimentRun(id,{plan});await decideExperimentRun(id,run.id,{decision:'approve',actor:'human'});
  await assert.rejects(startExperimentRun(id,run.id,{wait:true,allowedPaths:['run.mjs','results']}),{code:'EXPERIMENT_PATH_DENIED'});
});
test('input data cannot collide with declared output or existing snapshot code',async()=>{
  const id='input-collision',{root,plan,dataset}=await project(id),relative=`data/${dataset.sha256}/${dataset.filename}`;
  await assert.rejects(createExperimentRun(id,{plan:{...plan,artifacts:[{path:relative,kind:'output'}]}}),{code:'EXPERIMENT_DATASET_COLLISION'});
  await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),'preserve');
  await assert.rejects(createExperimentRun(id,{plan:{...plan,codePaths:['run.mjs',relative]}}),{code:'EXPERIMENT_DATASET_COLLISION'});
  const run=await execute(id,plan);assert.equal(run.status,'failed');assert.equal(run.error.code,'EXPERIMENT_DATASET_INPUT_COLLISION');assert.equal(await fs.readFile(path.join(root,relative),'utf8'),'preserve');
});
test('the aggregate retained input budget includes data, not only each code file',async()=>{
  const id='archive-budget',{plan}=await project(id,{bytes:Buffer.alloc(1000,0x31)});
  const run=await execute(id,{...plan,resources:{timeoutMs:5000,maxArtifactBytes:1024}});
  assert.equal(run.status,'failed');assert.equal(run.error.code,'EXPERIMENT_DATASET_BUDGET');assert.equal(run.metrics.length,0);assert.equal(run.execution.process?.pid||null,null);
});
test('attempting to mutate fixed raw input fails while the archived source stays exact',async()=>{
  const code=`import fs from 'node:fs/promises';
const input=JSON.parse(await fs.readFile(process.env.SCIENCEPRISM_EXPERIMENT_INPUT,'utf8'));
await fs.chmod(input.dataset.input.path,0o600);await fs.writeFile(input.dataset.input.path,'changed');
await fs.mkdir('results',{recursive:true});await fs.writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'forged',value:1}]}));`;
  const id='input-mutation',fixture=await project(id,{code}),run=await execute(id,fixture.plan);
  assert.equal(run.status,'failed');assert.equal(run.execution.process.stopConfirmed,true);
  const source=run.artifacts.find(a=>a.name===`inputs/${run.manifest.dataset.input.path}`);assert.ok(source);assert.equal(source.sha256,fixture.dataset.sha256);
  assert.deepEqual((await datasetService.content(id,fixture.dataset.id)).bytes,fixture.bytes);
});
