import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { readCampaignWritingHandoff } from '../researchWorkflow/campaignWritingHandoff.js';
import { sourceHash } from './handoff.js';

const fail=message=>{throw new ResearchWorkflowError(409,'AUTOMATION_PLAN_ATTEMPT_CHANGED',message);};
/** Bind a new coordinator to the original workflow's explicit plan attempt. */
export function resolveAutomationPlanAttempt(workflow,attemptId,design) {
  const active=workflow.activePlanAttempt;
  if(attemptId===undefined){
    if(active&&['method','experiment'].includes(workflow.currentStage))fail('请从当前新尝试入口继续，原会话不能替代新版方案。');
    return null;
  }
  if(typeof attemptId!=='string'||!attemptId||attemptId!==attemptId.trim()||attemptId.length>200||!attemptId.isWellFormed())fail('请提供明确的新尝试标识。');
  const attempt=Array.isArray(workflow.planAttempts)?workflow.planAttempts.find(item=>item.id===attemptId):null;
  if(!active||active.id!==attemptId||!attempt||active.ideaId!==attempt.ideaId||active.planRevision!==attempt.planRevision||active.planSha256!==attempt.planSha256)fail('所选新尝试不是当前方案的原保存记录。');
  const plans=workflow.stages.find(stage=>stage.id==='ideation')?.data?.ideaPlans;
  const plan=plans&&Object.hasOwn(plans,active.ideaId)?plans[active.ideaId]?.at(-1):null;
  if(!plan?.readiness?.ready||plan.revision!==active.planRevision||sourceHash(plan)!==active.planSha256||plan.evaluation?.researchType==='theoretical')fail('新版方案已变化或尚不具备可执行条件。');
  if(!plan.revisionSource||sourceHash(plan.revisionSource)!==sourceHash(attempt.source))fail('新版方案与原评价建议来源不一致。');
  if(design&&(design.ideaId!==active.ideaId||design.expectedPlanRevision!==active.planRevision))fail('条件设计必须使用当前新尝试确认的方案版本。');
  return {id:active.id,ideaId:active.ideaId,planRevision:active.planRevision,planSha256:active.planSha256,source:structuredClone(attempt.source)};
}

export async function assertAutomationPlanAttempt(projectId,workflow,binding,{readSource=readCampaignWritingHandoff}={}) {
  if(!binding)return;
  const current=resolveAutomationPlanAttempt(workflow,binding.id);
  if(sourceHash(current)!==sourceHash(binding))fail('新尝试绑定已变化，原任务与结果保留。');
  const source=await readSource(projectId,binding.source.campaignId,binding.source.evaluationRunId);
  if(source.sourceSha256!==binding.source.sourceSha256)fail('原完整批次或评价来源已变化，不能替换新尝试的科学依据。');
}
