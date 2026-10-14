import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlanAttemptExploration } from '../src/services/projectHub/planAttemptExploration.js';
import { sourceHash } from '../src/services/researchAutomation/handoff.js';

test('new-version graph distinguishes AI production, manual derivation and an actual coordinator; corrupt references create no pretend attempts',()=>{
  const snapshot={projectId:'p',campaignId:'old',ideaId:'idea',planRevision:1,planSha256:'original-plan',trialRunIds:[],evaluation:{verdict:'refuted'}};
  const source={campaignId:'old',planRevision:1,planSha256:'original-plan',trialRunIds:[],snapshot,sourceSha256:sourceHash(snapshot)};
  const origin={campaignId:'old',evaluationRunId:'evaluation',sourceSha256:'a'.repeat(64),evaluatedPlanRevision:1,suggestionIndexes:[0],suggestions:['Test a separate revised prediction']};
  const ai={ideaId:'idea',revision:2,sourceRunId:'generator',revisionSource:origin,readiness:{ready:true}};
  const {sourceRunId,...derived}=ai;
  const manual={...derived,revision:3,generatedFromRunId:sourceRunId,hypothesis:{prediction:'Human revised threshold'}};
  const attempt={id:'attempt',ideaId:'idea',planRevision:3,planSha256:sourceHash(manual),source:origin};
  const runs=[{id:'evaluation',projectId:'p',task:'campaign_evaluation',status:'completed',request:{source:'campaign-evaluation',evaluationSource:source},reply:JSON.stringify({verdict:'refuted',summary:'Original negative retained',findings:[],limitations:['Unverified results'],nextPlanSuggestions:origin.suggestions})},
    {id:'generator',projectId:'p',status:'completed',request:{source:'idea-plan-revision',revisionIdentity:{ideaId:'idea'},input:{expectedRevision:1,revisionSource:origin}},outputValidation:{data:{ideaId:'idea'}}},
    {id:'coordinator',projectId:'p',kind:'research-coordinator',coordinatorSessionId:'session'}];
  const workflow={id:'workflow',stages:[{id:'ideation',data:{ideaPlans:{idea:[ai,manual]}}}],planAttempts:[attempt,{...attempt,id:'imaginary',planRevision:99}],activePlanAttempt:{id:'attempt'}};
  function graph(value=workflow){const nodes=new Map(runs.map(run=>[`harness:${run.id}`,run])),edges=[];addPlanAttemptExploration({projectId:'p',workflow:value,automation:{session:{id:'session',workflowId:'workflow',coordinatorRunId:'coordinator',planAttempt:{id:'attempt',planSha256:attempt.planSha256}}},harnessRuns:runs,nodes,addNode:node=>nodes.set(node.id,node),addEdge:(from,to,type,sourceRef)=>edges.push({from,to,type,sourceRef})});return{nodes,edges};}
  const result=graph();
  assert.ok(result.edges.some(edge=>edge.from==='harness:generator'&&edge.to==='idea-plan:idea:2'&&edge.type==='produces'));
  assert.ok(result.edges.some(edge=>edge.from==='harness:generator'&&edge.to==='idea-plan:idea:3'&&edge.type==='provides'));
  assert.equal(result.edges.some(edge=>edge.to==='idea-plan:idea:3'&&edge.type==='produces'),false);
  assert.ok(result.edges.some(edge=>edge.from==='plan-attempt:attempt'&&edge.to==='harness:coordinator'&&edge.sourceRef.field==='session.planAttempt.id'));
  assert.equal(result.nodes.has('plan-attempt:imaginary'),false);
  const corrupt=structuredClone(workflow);corrupt.stages[0].data.ideaPlans.idea[1].revisionSource.suggestions=['Not in the original evaluator'];assert.equal(graph(corrupt).nodes.has('plan-attempt:attempt'),false);
  assert.deepEqual(workflow.stages[0].data.ideaPlans.idea,[ai,manual]);
});
