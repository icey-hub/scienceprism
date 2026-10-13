import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const data=await fs.mkdtemp(path.join(os.tmpdir(),'automation-environment-stage-'));
process.env.SCIENCEPRISM_DATA_DIR=data;process.env.NODE_ENV='test';
const {initializeResearchWorkflow}=await import('../src/services/researchWorkflow/commands.js');
const {saveAutomationPolicy,readAutomation}=await import('../src/services/researchAutomation/policy.js');
const {startAutomation,getAutomation,resumeAutomation}=await import('../src/services/researchAutomation/index.js');
const {environmentService,createEnvironmentService}=await import('../src/services/experimentRunner/environments.js');
const {listHarnessRuns,registerHarnessAdapter}=await import('../src/services/harnessRuntime/index.js');
const {listExperimentRuns}=await import('../src/services/experimentRunner/index.js');
const {fakeHarnessAdapter}=await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
after(()=>fs.rm(data,{recursive:true,force:true}));
const scope={allowedPaths:[],maxPackages:0,maxPrepareMs:120000,maxOutputBytes:1024,maxEnvironments:1};
async function settled(id){for(let i=0;i<300;i++){const state=await getAutomation(id);if(!['queued','running','stopping'].includes(state.session?.status))return state;await new Promise(r=>setTimeout(r,5));}throw new Error('stage fixture did not settle');}
async function fixture(t,id,{opted=true,manual=false,badEnvironment=false,envBlocker=false}={}){
 const root=path.join(data,id);await fs.mkdir(path.join(root,'.scienceprism'),{recursive:true});await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id,name:id}));await fs.writeFile(path.join(root,'run.py'),'print("fixed stage fixture")');
 await fs.writeFile(path.join(root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['project.read','experiment.execute']}));
 const workflow=await initializeResearchWorkflow(id,{actor:'human',data:{researchQuestion:'Prepare fixed environment only'}});workflow.currentStage='replication';for(const s of workflow.stages.filter(s=>['direction','search','selection'].includes(s.id)))s.status='approved';workflow.stages.find(s=>s.id==='selection').data={selectedPapers:[{id:'paper-fixture',title:'Fixed wiring fixture'}]};await fs.writeFile(path.join(root,'.scienceprism/research-workflow.json'),JSON.stringify(workflow));
 const initial=await readAutomation(id);await saveAutomationPolicy(id,{actor:'human',expectedVersion:initial.version,policy:{enabled:true,overrides:manual?{environment:'manual'}:{},agentMode:'specialists',...(opted?{environmentScope:scope}:{})}});
 const calls={prepare:0,model:[],inputs:[]};
 const service=createEnvironmentService({resolveProject:async projectId=>{assert.equal(projectId,id);return root;},probe:async()=>({available:true}),prepare:async o=>{calls.prepare++;await o.beforeLaunch();await o.onLaunch();await o.onProcess({pid:process.pid,stopConfirmed:true});await fs.mkdir(path.join(o.directory,'bin'));await fs.writeFile(path.join(o.directory,'bin/python'),'fixed fixture interpreter');return {python:{version:'3.fixture',implementation:'fixture'},packages:[],isolation:'fixture',hardware:{platform:'fixture',arch:'fixture',cpuCount:1}};}});
 const originalPrepare=environmentService.prepareAuthorized,originalVerify=environmentService.verify;environmentService.prepareAuthorized=service.prepareAuthorized;environmentService.verify=service.verify;
 registerHarnessAdapter({...fakeHarnessAdapter,async run(input){calls.model.push(input.request.task);calls.inputs.push(input.request.input);const output=input.request.task==='research:environment_proposal'?{stage:'environment_proposal',packages:[],blockers:envBlocker?[{kind:'dependency',detail:'A required fixed wheel is unavailable'}]:[],deferred:[{kind:'dataset',detail:'No scientific dataset is registered'}],reason:'Standard library fixed code'}:{stage:'execution_proposal',missing:badEnvironment?[]:['No verified scientific dataset or protocol'],plan:badEnvironment?{dataset:'local-fixture',datasetVersion:'v1',protocol:'Fixed fixture',execution:{adapter:'python',entrypoint:'run.py',args:[],environmentId:'environment-00000000-0000-4000-8000-000000000000'},seed:0,successCriteria:['mean'],artifacts:[]}:null};return fakeHarnessAdapter.run({...input,request:{...input.request,fakeResponse:JSON.stringify(output)}});}});
 t.after(async()=>{await service.shutdown();environmentService.prepareAuthorized=originalPrepare;environmentService.verify=originalVerify;registerHarnessAdapter(fakeHarnessAdapter);});
 await startAutomation(id,{actor:'human',targetStage:'replication'},{adapter:'fake'});return {calls,service,state:await settled(id)};
}
test('environment producer and prepared artifact enter material proposal; resume does not repeat either effect',async t=>{
 const id='ready-resume',f=await fixture(t,id);assert.equal(f.state.session.error.code,'AUTOMATION_MATERIALS_REQUIRED');const step=f.state.session.steps.find(s=>s.stage==='replication'),entry=step.environmentPreparations[0];assert.equal(step.status,'blocked');assert.equal(entry.status,'completed');assert.equal(entry.deferred[0].kind,'dataset');assert.equal(entry.authorization.parentRunId,f.state.session.coordinatorRunId);
 const material=f.calls.inputs.find(input=>input.availableEnvironments);assert.equal(material.availableEnvironments[0].id,entry.environmentId);assert.equal(material.availableEnvironments[0].sha256,entry.sha256);
 const ids=(await listHarnessRuns(id)).map(r=>r.id).sort();await resumeAutomation(id,{actor:'human',expectedSessionId:f.state.session.id},{adapter:'fake'});assert.equal((await settled(id)).session.error.code,'AUTOMATION_MATERIALS_REQUIRED');assert.deepEqual((await listHarnessRuns(id)).map(r=>r.id).sort(),ids);assert.equal(f.calls.prepare,1);assert.equal(f.calls.model.length,2);assert.equal((await f.service.listJobs(id)).length,1);assert.deepEqual(await listExperimentRuns(id),[]);
});
test('manual environment part waits before model or installation and reports its actual part',async t=>{
 const f=await fixture(t,'manual',{manual:true});assert.equal(f.state.session.status,'waiting_confirmation');assert.equal(f.state.session.error.details.part,'environment');assert.equal(f.calls.model.length,0);assert.equal(f.calls.prepare,0);assert.equal((await f.service.listJobs('manual')).length,0);
});
test('old policy without scope keeps old material input and never adds environment authority',async t=>{
 const f=await fixture(t,'legacy',{opted:false});assert.equal(f.state.session.error.code,'AUTOMATION_MATERIALS_REQUIRED');assert.deepEqual(f.calls.model,['research:execution_proposal']);assert.equal(f.calls.inputs[0].availableEnvironments,undefined);assert.equal(f.calls.prepare,0);assert.equal((await f.service.listJobs('legacy')).length,0);
});
test('a Python material plan cannot substitute a different environment after preparation',async t=>{
 const f=await fixture(t,'wrong-version',{badEnvironment:true});assert.equal(f.state.session.error.code,'AUTOMATION_ENVIRONMENT_BINDING_REQUIRED');assert.equal(f.state.session.executionPlan,null);assert.deepEqual(await listExperimentRuns('wrong-version'),[]);assert.equal(f.calls.prepare,1);
});

test('an actual environment dependency blocker stops preparation before any effect',async t=>{
 const f=await fixture(t,'missing-wheel',{envBlocker:true});assert.equal(f.state.session.error.code,'AUTOMATION_ENVIRONMENT_MATERIALS_REQUIRED');assert.equal(f.calls.prepare,0);assert.deepEqual(f.calls.model,['research:environment_proposal']);assert.equal((await f.service.listJobs('missing-wheel')).length,0);
});
