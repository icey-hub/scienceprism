import { sourceHash } from '../researchAutomation/handoff.js';
import { assertCampaignEvaluationSource, validateCampaignEvaluationOutput } from '../validationCampaign/agentEvaluation.js';

/** Only saved plan versions and explicit attempts form links; never infer a run. */
export function addPlanAttemptExploration({projectId,workflow,automation,harnessRuns,nodes,addNode,addEdge}) {
  if(!workflow)return;
  const runs=new Map(harnessRuns.map(run=>[run.id,run])),plans=new Map();
  const histories=workflow.stages.find(stage=>stage.id==='ideation')?.data?.ideaPlans||{};
  const href=ideaId=>`/editor/${encodeURIComponent(projectId)}/research/innovation?idea=${encodeURIComponent(ideaId)}`;
  for(const [ideaId,history] of Object.entries(histories))for(const plan of Array.isArray(history)?history:[]) {
    const origin=plan.revisionSource,review=runs.get(origin?.evaluationRunId);
    if(!origin||plan.ideaId!==ideaId||!Number.isSafeInteger(plan.revision)||!/^[a-f0-9]{64}$/.test(origin.sourceSha256||'')||!review||!nodes.has(`harness:${review.id}`))continue;
    try {
      const source=assertCampaignEvaluationSource(review,projectId,origin.campaignId),output=validateCampaignEvaluationOutput(review.reply,source);
      if(review.status!=='completed'||source.snapshot.ideaId!==ideaId||source.snapshot.planRevision!==origin.evaluatedPlanRevision
        ||sourceHash(origin.suggestionIndexes.map(index=>output.nextPlanSuggestions[index]))!==sourceHash(origin.suggestions))continue;
    }catch{continue;}
    const id=`idea-plan:${ideaId}:${plan.revision}`,ref=field=>({kind:'stage',id:'ideation',field:`data.ideaPlans.${ideaId}.${plan.revision-1}.${field}`});
    addNode({id,kind:'plan',title:`评价后的方案 v${plan.revision}`,status:plan.readiness?.ready?'prepared':'incomplete',version:plan.revision,retained:true,href:`${href(ideaId)}&revision=${plan.revision}`,sourceRef:ref('revisionSource')});
    addEdge(`harness:${review.id}`,id,'provides',ref('revisionSource.evaluationRunId'));
    const producer=runs.get(plan.sourceRunId||plan.generatedFromRunId);
    if(producer?.projectId===projectId&&producer.request?.source==='idea-plan-revision'&&producer.status==='completed'&&producer.request.revisionIdentity?.ideaId===ideaId&&nodes.has(`harness:${producer.id}`)) {
      const input=producer.request.input;
      if(plan.sourceRunId&&input?.expectedRevision+1===plan.revision&&sourceHash(input.revisionSource||null)===sourceHash(origin)&&producer.outputValidation?.data?.ideaId===ideaId)addEdge(`harness:${producer.id}`,id,'produces',ref('sourceRunId'));
      else if(!plan.sourceRunId&&plan.generatedFromRunId)addEdge(`harness:${producer.id}`,id,'provides',ref('generatedFromRunId'));
    }
    plans.set(`${ideaId}:${plan.revision}`,{id,plan});
  }
  for(const attempt of workflow.planAttempts||[]) {
    const saved=plans.get(`${attempt.ideaId}:${attempt.planRevision}`);
    if(!saved||saved.plan&&sourceHash(saved.plan)!==attempt.planSha256||sourceHash(saved.plan.revisionSource)!==sourceHash(attempt.source))continue;
    const id=`plan-attempt:${attempt.id}`,ref=field=>({kind:'workflow',id:workflow.id,field:`planAttempts.${attempt.id}.${field}`});
    addNode({id,kind:'plan',title:`新尝试 · 方案 v${attempt.planRevision}`,status:workflow.activePlanAttempt?.id===attempt.id?'current':'historical',version:attempt.planRevision,retained:true,href:`${href(attempt.ideaId)}&attempt=${encodeURIComponent(attempt.id)}`,sourceRef:ref('id')});
    addEdge(saved.id,id,'defines',ref('planSha256'));
    const previous=runs.get(attempt.previousAutomation?.coordinatorRunId);
    if(previous?.kind==='research-coordinator'&&previous.coordinatorSessionId===attempt.previousAutomation.sessionId&&nodes.has(`harness:${previous.id}`))addEdge(`harness:${previous.id}`,id,'provides',ref('previousAutomation.coordinatorRunId'));
    const session=automation?.session,coordinator=runs.get(session?.coordinatorRunId);
    if(session?.workflowId===workflow.id&&session.planAttempt?.id===attempt.id&&session.planAttempt.planSha256===attempt.planSha256&&coordinator?.projectId===projectId&&coordinator.kind==='research-coordinator'&&coordinator.coordinatorSessionId===session.id&&nodes.has(`harness:${coordinator.id}`))addEdge(id,`harness:${coordinator.id}`,'runs',{kind:'automation',id:session.id,field:'session.planAttempt.id'});
  }
}
