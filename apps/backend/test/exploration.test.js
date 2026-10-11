import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
const dataDir=await mkdtemp(path.resolve('.cache/exploration-'));
process.env.SCIENCEPRISM_DATA_DIR=dataDir;
const {getProjectExploration}=await import('../src/services/projectHub/exploration.js');
const {registerExplorationRoutes}=await import('../src/routes/exploration.js');
const {createWorkflowDocument}=await import('../src/services/researchWorkflow/stateMachine.js');
const {getEvidenceGraph}=await import('../src/services/evidenceLedger/index.js');
const {RESEARCH_WORKFLOW_STAGES}=await import('../src/services/researchWorkflow/stageContracts.js');
test.after(()=>rm(dataDir,{recursive:true,force:true}));
async function snapshot(root) {
 const result={};
 for(const entry of await readdir(root,{withFileTypes:true})) {
  const file=path.join(root,entry.name);
  if(entry.isDirectory()) Object.assign(result,await snapshot(file));
  else result[file]={bytes:await readFile(file,'utf8'),modified:(await stat(file)).mtimeMs};
 }
 return result;
}
async function fixture(id) {
 const root=path.join(dataDir,id);await mkdir(path.join(root,'.scienceprism'),{recursive:true});await mkdir(path.join(root,'.openprism'));
 await writeFile(path.join(root,'project.json'),JSON.stringify({id,name:'Graph fixture'}));
 const workflow=createWorkflowDocument(id);workflow.stages[0].data={task:{harness:{runId:'parent'}},evidenceIds:['material']};
 await writeFile(path.join(root,'.openprism','research-workflow.json'),JSON.stringify(workflow));
 await writeFile(path.join(root,'.scienceprism','harness-runs.json'),JSON.stringify({schemaVersion:1,projectId:id,runs:[
  {id:'parent',status:'running',stage:'direction',task:'test',attempt:1,events:[{id:'e1',attempt:1,type:'tool/call',name:'read_file',callId:'c1'},{id:'e2',attempt:1,type:'tool/result',callId:'c1',outcome:'success'}]},
  {id:'child',status:'completed',parentRunId:'parent',replayOf:'missing',events:[]}
 ],archivedRuns:[{id:'archived',status:'completed',archived:true}]}));
 await writeFile(path.join(root,'.scienceprism','experiment-runs.json'),JSON.stringify({schemaVersion:1,projectId:id,runs:[{id:'exp',status:'completed',manifest:{researchPlan:{sourceStage:'experiment'}},evidence:{runId:'run-evidence'},artifacts:[{id:'artifact',name:'Raw data',path:'.scienceprism/experiment-runs/exp/artifacts/result.json',sha256:'abc',bytes:3}]}]}));
 await writeFile(path.join(root,'.openprism','evidence-ledger.json'),JSON.stringify({projectId:id,entries:[
  {id:'material',kind:'paper',title:'Same title',verificationStatus:'human-confirmed',version:'v2'},
  {id:'counter',kind:'paper',title:'Same title',verificationStatus:'human-confirmed',version:'v1'},
  {id:'claim',kind:'paper-claim',summary:'Claim',verificationStatus:'unverified',metadata:{evidenceIds:['material']},evidenceVersions:{material:'v1'}},
  {id:'run-evidence',kind:'experiment-run',verificationStatus:'pending',metadata:{runId:'exp',status:'completed'}}
 ],relations:[{id:'counter-relation',type:'contradicts',fromId:'counter',toId:'material'}]}));
 return root;
}
test('exploration reads legacy and running records without recovery, migration, approval or timestamp writes',async()=>{
 const id='readonly',root=await fixture(id),before=await snapshot(root);
 const execution=await getProjectExploration(id);
 const evidence=await getProjectExploration(id,{lens:'evidence'});
 await getEvidenceGraph(id);
 assert.deepEqual(await snapshot(root),before);
 assert.equal(execution.nodes.find(node=>node.id==='harness:parent').status,'running');
 assert.ok(execution.edges.some(edge=>edge.type==='delegates'&&edge.sourceRef.field==='parentRunId'));
 assert.equal(execution.nodes.find(node=>node.id==='harness:missing').retained,false);
 assert.equal(execution.nodes.find(node=>node.id==='harness:archived').retention,'summary');
 assert.equal(execution.nodes.find(node=>node.kind==='call').status,'success');
 assert.equal(evidence.nodes.find(node=>node.id==='evidence:material@v1').status,'stale-reference');
 assert.equal(evidence.nodes.find(node=>node.id==='claim:claim').status,'needs-verification');
 assert.equal(evidence.nodes.find(node=>node.id==='experiment:exp').status,'completed');
 assert.equal(evidence.nodes.find(node=>node.sourceRef.id==='run-evidence').status,'pending');
 assert.ok(evidence.edges.some(edge=>edge.type==='contradicts'&&edge.sourceRef.id==='counter-relation'));
 assert.ok(evidence.edges.every(edge=>evidence.nodes.some(node=>node.id===edge.from)&&evidence.nodes.some(node=>node.id===edge.to)));
 const again=await getProjectExploration(id,{lens:'evidence'});assert.deepEqual(again.nodes,evidence.nodes);
});
test('exploration HTTP validates lenses, bounds nodes and exposes sourced adjacency',async()=>{
 const id='http';await fixture(id);const app=Fastify();registerExplorationRoutes(app);
 try {
  const response=await app.inject({url:`/api/projects/${id}/exploration?lens=execution&rootId=harness%3Aparent&limit=2`});
  assert.equal(response.statusCode,200);const graph=response.json().graph;assert.equal(graph.schemaVersion,1);assert.equal(graph.nodes.length,2);assert.equal(graph.scope.nodeLimit,2);
  assert.ok(graph.scope.totalNodes>2);assert.ok(graph.warnings.length>0);
  assert.equal((await app.inject({url:`/api/projects/${id}/exploration?lens=bad`})).statusCode,400);
  assert.equal((await app.inject({url:'/api/projects/missing/exploration'})).statusCode,404);
 } finally {await app.close();}
});

test('replication graph edges cite the actual replication manifest field', async () => {
 const root = await fixture('replication-source');
 await writeFile(path.join(root, '.scienceprism/experiment-runs.json'), JSON.stringify({
  schemaVersion: 1, projectId: 'replication-source', runs: [{ id: 'replication-run', status: 'completed', manifest: { replication: { sourceStage: 'replication' } } }]
 }));
 const graph = await getProjectExploration('replication-source');
 const edge = graph.edges.find(edge => edge.from === 'stage:replication' && edge.to === 'experiment:replication-run');
 assert.equal(edge.sourceRef.field, 'manifest.replication.sourceStage');
});

test('workflow context exposes eight ordered stages while execution edges stay sourced and read-only',async()=>{
 const id='stage-spine',root=await fixture(id);
 const file=path.join(root,'.scienceprism/harness-runs.json'),runs=JSON.parse(await readFile(file,'utf8'));
 runs.runs[1].stage='direction';runs.archivedRuns[0].stage='replication';
 runs.runs.push({id:'unbound',task:'writing',status:'completed',events:[]});
 await writeFile(file,JSON.stringify(runs));
 const before=await snapshot(root),graph=await getProjectExploration(id);
 assert.deepEqual(graph.workflow.stageOrder,RESEARCH_WORKFLOW_STAGES.map(stage=>stage.id));
 assert.deepEqual(graph.workflow.optionalStageIds,['replication']);
 assert.equal(graph.workflow.currentStage,'direction');
 assert.equal(graph.nodes.filter(node=>node.kind==='stage').length,8);
 assert.equal(graph.nodes.find(node=>node.id==='stage:search').status,'pending');
 const direct=graph.edges.filter(edge=>edge.from==='stage:direction' && edge.to==='harness:parent');
 assert.equal(direct.length,1);assert.equal(direct[0].sourceRef.field,'data.task.harness.runId');
 assert.equal(graph.edges.find(edge=>edge.from==='stage:direction' && edge.to==='harness:child').sourceRef.field,'stage');
 assert.equal(graph.edges.find(edge=>edge.from==='stage:replication' && edge.to==='harness:archived').sourceRef.field,'stage');
 assert.equal(graph.edges.some(edge=>edge.from.startsWith('stage:') && edge.to==='harness:unbound'),false,'task title must not infer a stage');
 assert.equal(graph.edges.some(edge=>edge.from.startsWith('stage:') && edge.to.startsWith('stage:')),false,'stage order is presentation context, not a stored execution');
 assert.deepEqual(await snapshot(root),before);
 await rm(path.join(root,'.openprism/research-workflow.json'));
 const missing=await getProjectExploration(id);
 assert.equal(missing.workflow,null);assert.equal(missing.nodes.some(node=>node.kind==='stage'),false);
});
