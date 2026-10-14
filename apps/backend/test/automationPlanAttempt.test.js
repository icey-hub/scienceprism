import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutomationPlanAttempt, assertAutomationPlanAttempt } from '../src/services/researchAutomation/planAttempt.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';

function fixture(){
  const source={campaignId:'original-negative',evaluationRunId:'original-evaluator',sourceSha256:'a'.repeat(64),evaluatedPlanRevision:1,suggestionIndexes:[0],suggestions:['Test the revised prediction separately']};
  const plan={ideaId:'idea',revision:2,readiness:{ready:true},evaluation:{researchType:'computational'},revisionSource:source};
  const binding={id:'new-attempt',ideaId:'idea',planRevision:2,planSha256:sourceHash(plan)};
  return {currentStage:'method',activePlanAttempt:binding,planAttempts:[{...binding,source}],stages:[{id:'ideation',data:{ideaPlans:{idea:[plan]}}}]};
}
test('only explicit current plan attempt can open a new method-to-experiment coordinator',()=>{
  const workflow=fixture();
  assert.throws(()=>resolveAutomationPlanAttempt(workflow),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
  const advanced=structuredClone(workflow);advanced.currentStage='experiment';assert.throws(()=>resolveAutomationPlanAttempt(advanced),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
  const binding=resolveAutomationPlanAttempt(workflow,'new-attempt',{ideaId:'idea',expectedPlanRevision:2});
  assert.equal(binding.source.campaignId,'original-negative');
  for(const id of ['old-attempt',' new-attempt','another-project'])assert.throws(()=>resolveAutomationPlanAttempt(workflow,id),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
  assert.throws(()=>resolveAutomationPlanAttempt(workflow,'new-attempt',{ideaId:'idea',expectedPlanRevision:1}),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
});
test('new plan, stale readiness and changed original evaluation cannot replace saved attempt provenance',async()=>{
  const workflow=fixture(),binding=resolveAutomationPlanAttempt(workflow,'new-attempt');
  await assertAutomationPlanAttempt('p',workflow,binding,{readSource:async(projectId,campaignId,evaluationId)=>{
    assert.deepEqual([projectId,campaignId,evaluationId],['p','original-negative','original-evaluator']);return{sourceSha256:'a'.repeat(64)};
  }});
  await assert.rejects(()=>assertAutomationPlanAttempt('p',workflow,binding,{readSource:async()=>({sourceSha256:'b'.repeat(64)})}),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
  for(const kind of ['revision','ready','plan','source']){
    const changed=structuredClone(workflow),plan=changed.stages[0].data.ideaPlans.idea[0];
    if(kind==='revision')plan.revision=3;if(kind==='ready')plan.readiness.ready=false;if(kind==='plan')plan.evaluation.researchType='theoretical';if(kind==='source')changed.planAttempts[0].source.evaluationRunId='different-evaluator';
    assert.throws(()=>resolveAutomationPlanAttempt(changed,'new-attempt'),{code:'AUTOMATION_PLAN_ATTEMPT_CHANGED'});
  }
});
test('historical workflows without a plan attempt retain their original automatic path',()=>{
  assert.equal(resolveAutomationPlanAttempt({currentStage:'method'}),null);
  const workflow=fixture();workflow.currentStage='writing';assert.equal(resolveAutomationPlanAttempt(workflow),null);
});
