import { getValidationCampaign } from '../validationCampaign/index.js';
import { campaignEvaluationService, assertCampaignEvaluationSource, validateCampaignEvaluationOutput } from '../validationCampaign/agentEvaluation.js';
import { readExperimentRuns, resolveExperimentProjectRoot } from '../experimentRunner/repository.js';
import { experimentRunSummary } from '../experimentRunner/index.js';
import { createHarnessRun, getHarnessRun, runHarnessRequest, readProjectConstraints, cancelHarnessRun } from '../harnessRuntime/index.js';
import { resolveHarnessProjectRoot } from '../harnessRuntime/repository.js';
import { readEvidenceLedger } from '../evidenceLedger/repository.js';
import { sourceHash } from '../researchAutomation/handoff.js';
import { ResearchWorkflowError } from './errors.js';

const fail=(code,message,status=409)=>{throw new ResearchWorkflowError(status,code,message);};
const identity=value=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value);
/** Read one complete campaign; never execute, recover or confirm its research. */
export async function readCampaignWritingHandoff(projectId,campaignId,evaluationRunId,{readCampaign=getValidationCampaign,
  readExperiments=async()=>readExperimentRuns(await resolveExperimentProjectRoot(projectId),projectId),
  readLedger=async()=>readEvidenceLedger(await resolveExperimentProjectRoot(projectId),projectId,{readOnly:true}),
  readRun=getHarnessRun,listEvaluations=campaignEvaluationService.list}={}) {
  if(!identity(campaignId)||evaluationRunId!==undefined&&evaluationRunId!==null&&!identity(evaluationRunId))fail('WRITING_CAMPAIGN_INPUT_INVALID','请提供有效的批次及评价Run标识。',400);
  const campaign=await readCampaign(projectId,campaignId);
  if(campaign.projectId!==projectId||campaign.id!==campaignId||!['completed','failed','cancelled','budget_exhausted'].includes(campaign.status))fail('WRITING_CAMPAIGN_NOT_TERMINAL','只能交接本项目已经终结的完整批次。');
  if(sourceHash(campaign.plan)!==campaign.planSha256)fail('WRITING_CAMPAIGN_PLAN_CHANGED','冻结方案与原摘要不一致，不能交接写作。');
  const [experiments,ledger]=await Promise.all([readExperiments(),readLedger()]);
  const actualRuns=[];
  for(const trial of campaign.trials) {
    const run=experiments.runs.find(item=>item.id===trial.runId);
    if(!run)continue; // Pending reserved ids remain in trials, without invented executions.
    if(run.projectId!==projectId||run.manifest?.campaign?.campaignId!==campaignId||run.manifest.campaign.trialId!==trial.id)fail('WRITING_CAMPAIGN_TRIAL_SOURCE_INVALID','实际Run与冻结批次/试验归属不一致。');
    actualRuns.push(JSON.parse(JSON.stringify(experimentRunSummary(run,ledger.entries))));
  }
  let agentEvaluation=null;
  if(evaluationRunId) {
    const run=await readRun(projectId,evaluationRunId),source=assertCampaignEvaluationSource(run,projectId,campaignId);
    if(run.status!=='completed')fail('WRITING_CAMPAIGN_EVALUATION_INCOMPLETE','指定评价尚未成功完成，不能作为写作材料。');
    const output=validateCampaignEvaluationOutput(run.reply,source);
    const view=(await listEvaluations(projectId,campaignId)).evaluations.find(item=>item.runId===evaluationRunId);
    if(!view||view.status!=='completed'||!view.sourceCurrent)fail('WRITING_CAMPAIGN_EVALUATION_STALE','指定评价来源已经变化或不可用，请明确选择当前来源的评价。');
    agentEvaluation={runId:run.id,status:run.status,sourceSha256:source.sourceSha256,source:structuredClone(source),output,usage:run.tokenUsage||null};
  }
  const material={schemaVersion:1,...structuredClone(campaign),campaignId,comparison:structuredClone(campaign.evaluation),
    actualExperimentRunIds:actualRuns.map(run=>run.id),actualRuns,agentEvaluation,
    verificationNote:'完整批次仅为写作审阅材料；保留失败、缺失、负结果和固定条件局限。AI评价与写作均不使Evidence自动verified，下一方案建议尚未执行。'};
  return {...material,sourceSha256:sourceHash(material)};
}

/** Raise only the request budget, within the explicitly configured project ceiling. */
export async function prepareCampaignWritingRequest(projectId,request,{readConstraints=readProjectConstraints,resolveRoot=resolveHarnessProjectRoot}={}) {
  const inputBytes=Buffer.byteLength(JSON.stringify(request.prompt||''));
  const required=Math.ceil(inputBytes/4)+8192;
  const constraints=await readConstraints(await resolveRoot(projectId));
  if(required>200000||constraints.contextTokenBudget!==undefined&&(!Number.isFinite(Number(constraints.contextTokenBudget))||Number(constraints.contextTokenBudget)<required))fail('WRITING_CAMPAIGN_CONTEXT_LIMIT','完整批次超过可用上下文，未调用写作模型；请明确调整项目上限。',413);
  // Total usage includes the complete input as well as the reply. Use a more
  // conservative input estimate than the ContextPack's display estimate.
  const requiredTotal=Math.ceil(inputBytes/2)+8192+32768;
  const ceilings=[constraints.maxTokens,request.limits?.maxTokens].filter(value=>value!==undefined).map(Number);
  if(requiredTotal>1_000_000||ceilings.some(value=>!Number.isSafeInteger(value)||value<1||value>1_000_000||value<requiredTotal))fail('WRITING_CAMPAIGN_TOKEN_LIMIT','完整写作输入与输出余量超过已设置的总token预算，未调用模型；请明确提高项目任务预算后发起新任务。',413);
  const maxTokens=ceilings.length?Math.min(...ceilings):requiredTotal;
  return {...request,contextTokenBudget:required,limits:{...request.limits,maxTokens}};
}
export function assertCampaignWritingContext(run,request) {
  if(run.contextPack?.instructions?.prompt!==request.prompt||run.contextPack.instructions.promptTruncated)fail('WRITING_CAMPAIGN_CONTEXT_INCOMPLETE','写作上下文未保留完整批次，未调用模型。',413);
}
export function campaignWritingHarness(projectId,{createRun=createHarnessRun,readRun=getHarnessRun,execute=runHarnessRequest,cancel=cancelHarnessRun,prepareRequest=prepareCampaignWritingRequest}={}) {
  return async request=>{
    const preparedRequest=await prepareRequest(projectId,request);
    const prepared=request.existingRunId?await readRun(projectId,request.existingRunId):await createRun(projectId,preparedRequest);
    try{assertCampaignWritingContext(prepared,preparedRequest);}catch(error){if(!request.existingRunId)await cancel(projectId,prepared.id);throw error;}
    return execute({...preparedRequest,existingRunId:prepared.id});
  };
}
