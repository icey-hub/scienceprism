import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';

const cache=new URL('../../../.cache/campaign-writing-test/',import.meta.url).pathname;
await mkdir(cache,{recursive:true});
const dataDir=await mkdtemp(path.join(cache,'data-'));
process.env.SCIENCEPRISM_DATA_DIR=dataDir;process.env.TMPDIR=dataDir;process.env.NODE_ENV='test';
const {readCampaignWritingHandoff,prepareCampaignWritingRequest,campaignWritingHarness}=await import('../src/services/researchWorkflow/campaignWritingHandoff.js');
const {runUiAction}=await import('../src/services/researchWorkflow/application.js');
const {createWorkflowDocument}=await import('../src/services/researchWorkflow/stateMachine.js');
const {getResearchWorkflow}=await import('../src/services/researchWorkflow/index.js');
const {getValidationCampaign}=await import('../src/services/validationCampaign/index.js');
const {sourceHash,buildAutomationHandoff,assertAutomationHandoff}=await import('../src/services/researchAutomation/handoff.js');
const {experimentManifestHash}=await import('../src/services/experimentRunner/manifest.js');
const {RESEARCH_WORKFLOW_STAGES}=await import('../src/services/researchWorkflow/stageContracts.js');
test.after(()=>rm(dataDir,{recursive:true,force:true}));
let nextId=0;
async function fixture(){
  const projectId=`campaign-writing-${++nextId}`,root=path.join(dataDir,projectId),dir=path.join(root,'.scienceprism');await mkdir(dir,{recursive:true});
  await writeFile(path.join(root,'project.json'),JSON.stringify({id:projectId}));
  const workflow=createWorkflowDocument(projectId);workflow.currentStage='writing';workflow.status='in_progress';for(const stage of workflow.stages)stage.status=stage.id==='writing'?'in_progress':'approved';
  await writeFile(path.join(dir,'research-workflow.json'),JSON.stringify(workflow));
  const plan={ideaId:'idea',revision:2,hypothesis:{problem:'Complete negative and missing results'},evaluation:{metrics:[{name:'accuracy',direction:'increase',threshold:0.03}]}};
  const base={id:'base',projectId,command:{adapter:'node',entrypoint:'run.mjs'},code:{snapshotHash:'original-code'},dataset:{id:'data',version:'v1'},environment:{adapter:'node'},parameters:{},protocol:'original split',artifacts:[],successCriteria:[],resources:{timeoutMs:1000}};
  const campaign={id:'batch',projectId,sessionId:'session',ideaId:'idea',planRevision:2,planSha256:sourceHash(plan),plan,status:'failed',error:{code:'NEGATIVE_TEST',message:'All failures are retained'},baseRunId:'base',baseManifest:base,baseManifestSha256:experimentManifestHash(base),researchContext:{projectId,sourceStage:'experiment'},variants:[{id:'candidate',label:'Candidate',kind:'candidate',parameters:{k:3}},{id:'baseline',label:'Baseline',kind:'baseline',parameters:{k:1}}],seeds:['0','1'],budget:{maxRuns:4,maxSeconds:10},elapsedSeconds:2,policyVersion:1,trials:[
    {id:'t1',runId:'candidate-0',variantId:'candidate',seed:'0',status:'completed',manifestSha256:null,result:{metrics:[{name:'accuracy',value:-0.25}]}},
    {id:'t2',runId:'baseline-0',variantId:'baseline',seed:'0',status:'failed',manifestSha256:null,result:{errorMessage:'execution failed'}},
    {id:'t3',runId:'reserved-1',variantId:'candidate',seed:'1',status:'pending',manifestSha256:null,result:null},
    {id:'t4',runId:'reserved-2',variantId:'baseline',seed:'1',status:'pending',manifestSha256:null,result:null}]};
  const runs=campaign.trials.slice(0,2).map(trial=>({id:trial.runId,projectId,status:trial.status,manifest:{...base,id:trial.runId,researchPlan:campaign.researchContext,campaign:{campaignId:'batch',trialId:trial.id},seed:trial.seed},metrics:trial.id==='t1'?[{name:'accuracy',value:-0.25}]:[],artifacts:[],execution:{exitCode:trial.id==='t1'?0:1},error:trial.id==='t2'?{message:'execution failed'}:null}));
  await writeFile(path.join(dir,'validation-campaigns.json'),JSON.stringify({schemaVersion:1,projectId,campaigns:[campaign]}));
  await writeFile(path.join(dir,'experiment-runs.json'),JSON.stringify({schemaVersion:1,projectId,runs}));
  await writeFile(path.join(dir,'project-constraints.json'),JSON.stringify({contextTokenBudget:200000}));
  const current=await getValidationCampaign(projectId,'batch'),trialRunIds=runs.map(run=>run.id);
  const snapshot={schemaVersion:1,projectId,campaignId:current.id,sessionId:current.sessionId,ideaId:current.ideaId,planRevision:current.planRevision,planSha256:current.planSha256,plan:current.plan,baseRunId:current.baseRunId,baseManifestSha256:current.baseManifestSha256,baseManifest:current.baseManifest,variants:current.variants,seeds:current.seeds,budget:current.budget,elapsedSeconds:current.elapsedSeconds,status:current.status,error:current.error||null,trials:current.trials,trialRunIds,evaluation:current.evaluation};
  const source={campaignId:'batch',planRevision:2,planSha256:campaign.planSha256,trialRunIds,sourceSha256:sourceHash(snapshot),snapshot};
  const run={id:'review',projectId,task:'campaign_evaluation',status:'completed',createdAt:'2026-10-14T00:00:00Z',request:{source:'campaign-evaluation',requestId:'request-1',evaluationSource:source},reply:JSON.stringify({verdict:'insufficient',summary:'Negative, failed and missing results retained',findings:[{text:'Recorded negative candidate',runIds:['candidate-0']}],limitations:['Missing seed pair; no significance established'],nextPlanSuggestions:['Review missing data; not executed']})};
  await writeFile(path.join(dir,'harness-runs.json'),JSON.stringify({schemaVersion:1,projectId,runs:[run]}));
  return {projectId,root,dir,campaign,run,workflow};
}
const brief={stage:'writing_brief',title:'Complete campaign brief',claims:[],outline:['Results'],limitations:['Evidence not confirmed'],unsupportedClaims:[]};
const producer=async params=>({ok:true,runId:'controlled-writing',output:brief,validation:{ok:true,errors:[],warnings:[]}});
test('real stored full campaign and selected evaluation preserve negative/failed/missing trials, source and limitations',async()=>{
  const f=await fixture(),source=await readCampaignWritingHandoff(f.projectId,'batch','review');
  assert.equal(source.trials.length,4);assert.deepEqual(source.actualExperimentRunIds,['candidate-0','baseline-0']);assert.equal(source.actualRuns[0].metrics[0].value,-0.25);assert.equal(source.actualRuns[1].status,'failed');assert.equal(source.trials[2].result,null);assert.equal(source.comparison.verdict,'insufficient');assert.equal(source.agentEvaluation.source.snapshot.trials.length,4);assert.match(source.agentEvaluation.output.limitations[0],/Missing/);
  const next=await runUiAction(f.projectId,{action:'handoff-writing',validationCampaignId:'batch',campaignEvaluationRunId:'review',expectedVersion:f.workflow.version,experiment:{status:'completed',metrics:[{name:'accuracy',value:999}]}},'human',{runStage:async params=>{assert.deepEqual(params.input.validationCampaign,source);assert.equal(params.input.experiment.kind,'validation-campaign');assert.equal(params.input.experiment.metrics,undefined);return producer(params);}});
  assert.deepEqual(next.stages.find(stage=>stage.id==='writing').data.task.input.validationCampaign,source);
  const artifact=await readFile(path.join(f.root,'research/writing-brief.md'),'utf8');assert.match(artifact,/Validation Campaign Provenance/);assert.ok(artifact.includes('reserved-1'));assert.ok(artifact.includes('-0.25'));assert.ok(artifact.includes('Missing seed pair'));assert.ok(artifact.includes(source.sourceSha256));
});
test('no evaluation selected retains fixed comparison; conflicting single-run or delegation rejected before producer',async()=>{
  const f=await fixture(),value=await readCampaignWritingHandoff(f.projectId,'batch');assert.equal(value.agentEvaluation,null);
  let calls=0;for(const extra of [{experimentRunId:'candidate-0'},{agentMode:'multi-agent'}])await assert.rejects(()=>runUiAction(f.projectId,{action:'handoff-writing',validationCampaignId:'batch',...extra},'human',{runStage:async()=>{calls++;return producer();}}),{code:'WRITING_CAMPAIGN_MODE_CONFLICT'});assert.equal(calls,0);
});
test('old explicit single-run writing remains server-owned and separate from campaign input',async()=>{
  const f=await fixture();const result=await runUiAction(f.projectId,{action:'handoff-writing',experimentRunId:'candidate-0',expectedVersion:f.workflow.version,experiment:{status:'completed',metrics:[{name:'accuracy',value:999}]}},'human',{runStage:async params=>{assert.equal(params.input.validationCampaign,undefined);assert.equal(params.input.experimentRun.id,'candidate-0');assert.equal(params.input.experimentRun.metrics[0].value,-0.25);return producer(params);}});
  assert.equal(result.stages.find(stage=>stage.id==='writing').data.task.input.experiment.resultRun.id,'candidate-0');
});
test('completed workflow keeps old history while complete campaign provenance is refreshed in artifact',async()=>{
  const f=await fixture();f.workflow.status='completed';f.workflow.stages.find(stage=>stage.id==='writing').status='approved';
  const file=path.join(f.dir,'research-workflow.json');await writeFile(file,JSON.stringify(f.workflow));const before=await readFile(file,'utf8');
  await runUiAction(f.projectId,{action:'handoff-writing',validationCampaignId:'batch',expectedVersion:f.workflow.version},'human',{runStage:producer});
  assert.equal(await readFile(file,'utf8'),before);const artifact=await readFile(path.join(f.root,'research/writing-brief.md'),'utf8');assert.ok(artifact.indexOf('## Outline')<artifact.indexOf('## 完整来源附录'));assert.ok(artifact.includes('reserved-1'));
});
test('failed, invalid, stale and cross-project evaluation cannot enter writing',async()=>{
  for(const kind of ['failed','invalid','stale','foreign']){
    const f=await fixture();if(kind==='failed')f.run.status='failed';if(kind==='invalid')f.run.reply='broken json';if(kind==='foreign')f.run.projectId='another-project';
    if(kind==='stale'){f.campaign.error.message='Changed original result';await writeFile(path.join(f.dir,'validation-campaigns.json'),JSON.stringify({schemaVersion:1,projectId:f.projectId,campaigns:[f.campaign]}));}
    await writeFile(path.join(f.dir,'harness-runs.json'),JSON.stringify({schemaVersion:1,projectId:f.projectId,runs:[f.run]}));
    await assert.rejects(()=>readCampaignWritingHandoff(f.projectId,'batch','review'),{code:{failed:'WRITING_CAMPAIGN_EVALUATION_INCOMPLETE',invalid:'CAMPAIGN_EVALUATION_OUTPUT_INVALID',stale:'WRITING_CAMPAIGN_EVALUATION_STALE',foreign:'CAMPAIGN_EVALUATION_SOURCE_INVALID'}[kind]});
  }
});
test('source/workflow change during writing keeps old artifact and prevents task commit',async()=>{
  for(const mutate of ['campaign','workflow']){
    const f=await fixture();await mkdir(path.join(f.root,'research'));await writeFile(path.join(f.root,'research/writing-brief.md'),'old immutable brief');
    await assert.rejects(()=>runUiAction(f.projectId,{action:'handoff-writing',validationCampaignId:'batch',expectedVersion:f.workflow.version},'human',{runStage:async()=>{
      if(mutate==='campaign'){f.campaign.error.message='changed after model';await writeFile(path.join(f.dir,'validation-campaigns.json'),JSON.stringify({schemaVersion:1,projectId:f.projectId,campaigns:[f.campaign]}));}
      else {f.workflow.version++;await writeFile(path.join(f.dir,'research-workflow.json'),JSON.stringify(f.workflow));}return producer();
    }}),{code:mutate==='campaign'?'WRITING_CAMPAIGN_SOURCE_CHANGED':'VERSION_CONFLICT'});
    assert.equal(await readFile(path.join(f.root,'research/writing-brief.md'),'utf8'),'old immutable brief');assert.equal((await getResearchWorkflow(f.projectId)).stages.find(stage=>stage.id==='writing').data.task,undefined);
  }
});
test('actual context truncation and configured context ceiling stop before model; original prepared Run is cancelled',async()=>{
  await assert.rejects(()=>prepareCampaignWritingRequest('p',{prompt:'full source'},{resolveRoot:async()=>'.',readConstraints:async()=>({contextTokenBudget:256})}),{code:'WRITING_CAMPAIGN_CONTEXT_LIMIT'});
  let executed=0,cancelled=0;const runner=campaignWritingHarness('p',{prepareRequest:async(_projectId,request)=>request,createRun:async()=>({id:'prepared',contextPack:{instructions:{prompt:'truncated',promptTruncated:true}}}),execute:async()=>{executed++;},cancel:async()=>{cancelled++;}});
  await assert.rejects(()=>runner({prompt:'complete fixed source'}),{code:'WRITING_CAMPAIGN_CONTEXT_INCOMPLETE'});assert.equal(executed,0);assert.equal(cancelled,1);
});
test('large complete writing input gets matching total-token budget and retains explicit ceilings before dispatch',async()=>{
  const options=constraints=>({resolveRoot:async()=>'.',readConstraints:async()=>constraints});
  const request={prompt:'a'.repeat(500487),limits:{timeoutMs:12345,retryLimit:0}};
  const prepared=await prepareCampaignWritingRequest('p',request,options({}));
  assert.ok(prepared.limits.maxTokens>157482+32768);assert.ok(prepared.limits.maxTokens<=1_000_000);assert.equal(prepared.limits.timeoutMs,12345);assert.equal(prepared.limits.retryLimit,0);assert.equal(prepared.prompt,request.prompt);
  await assert.rejects(()=>prepareCampaignWritingRequest('p',request,options({maxTokens:49152})),{code:'WRITING_CAMPAIGN_TOKEN_LIMIT'});
  assert.equal(prepared.limits.maxTokens,Math.ceil(Buffer.byteLength(JSON.stringify(request.prompt))/2)+40960);
  const allowed=await prepareCampaignWritingRequest('p',request,options({maxTokens:350000}));assert.equal(allowed.limits.maxTokens,350000);
  await assert.rejects(()=>prepareCampaignWritingRequest('p',{...request,limits:{maxTokens:49152}},options({maxTokens:350000})),{code:'WRITING_CAMPAIGN_TOKEN_LIMIT'});
  const bounded=await prepareCampaignWritingRequest('p',{...request,limits:{maxTokens:400000}},options({maxTokens:350000}));assert.equal(bounded.limits.maxTokens,350000);
  await assert.rejects(()=>prepareCampaignWritingRequest('p',request,options({maxTokens:1000001})),{code:'WRITING_CAMPAIGN_TOKEN_LIMIT'});
  let created=0;const runner=campaignWritingHarness('p',{prepareRequest:(projectId,input)=>prepareCampaignWritingRequest(projectId,input,options({maxTokens:49152})),createRun:async()=>{created++;}});
  await assert.rejects(()=>runner(request),{code:'WRITING_CAMPAIGN_TOKEN_LIMIT'});assert.equal(created,0);
});
test('batch handoff includes all actual identities and evaluation SHA while old single-run contract stays unchanged',()=>{
  const workflow={id:'wf',projectId:'p',version:2,stages:RESEARCH_WORKFLOW_STAGES.map(stage=>({id:stage.id,data:{}}))},session={id:'s',workflowId:'wf',coordinatorRunId:'parent',steps:[{stage:'experiment',experimentRunId:'single'}]};
  workflow.stages.find(stage=>stage.id==='experiment').data={automaticResult:{id:'single'}};
  const input={projectId:'p',workflow,session,stage:'writing',role:'writer'},old=buildAutomationHandoff(input);assert.equal(old.inputArtifacts[0].experimentRunId,'single');assert.equal(Object.hasOwn(old.inputArtifacts[0],'experimentRunIds'),false);
  const step=session.steps[0];step.campaignId='batch';step.result={validationCampaign:{id:'batch',actualExperimentRunIds:['a','b'],sourceSha256:'a'.repeat(64)}};step.campaignRunIds=['a','b','reserved'];step.campaignEvaluation={campaignId:'batch',runId:'review',status:'completed'};
  const full=buildAutomationHandoff(input);assert.deepEqual(full.inputArtifacts[0].experimentRunIds,['a','b']);assert.equal(full.inputArtifacts[0].experimentRunId,null);assert.equal(full.inputArtifacts[0].evaluationRunId,'review');assert.equal(full.inputArtifacts[0].campaignSourceSha256,'a'.repeat(64));assertAutomationHandoff(full,input);
  step.result.validationCampaign.actualExperimentRunIds.push('c');assert.throws(()=>assertAutomationHandoff(full,input),{code:'AUTOMATION_HANDOFF_INPUT_CHANGED'});
  session.steps=[];workflow.stages.find(stage=>stage.id==='experiment').data={automaticResult:{validationCampaign:{id:'batch',runIds:['a','b','reserved']}}};
  session.writingCampaignSource={id:'batch',campaignEvaluationRunId:'review',sourceSha256:'b'.repeat(64),actualExperimentRunIds:['a','b']};
  const writingOnly=buildAutomationHandoff(input);assert.deepEqual(writingOnly.inputArtifacts[0].experimentRunIds,['a','b']);assert.equal(writingOnly.inputArtifacts[0].evaluationRunId,'review');assert.equal(writingOnly.inputArtifacts[0].campaignSourceSha256,'b'.repeat(64));assertAutomationHandoff(writingOnly,input);
});
