import {environmentService} from '../experimentRunner/environments.js';
import {getHarnessRun} from '../harnessRuntime/index.js';
import {readAutomation} from './policy.js';
import {createEnvironmentAuthorization,assertEnvironmentAuthorization,validateEnvironmentProposal} from './environmentAuthorization.js';
import {sourceHash} from './handoff.js';
import {ResearchWorkflowError} from '../researchWorkflow/errors.js';
const fail=(code,message)=>{throw new ResearchWorkflowError(409,code,message);};

/** A producer proposes a fixed dependency lock. The application alone acquires
 * the environment through its preparation service and retains the effect ID. */
export async function prepareAutomationEnvironment({projectId,session,stage,proposal,sourceRunId,reason='',deferred=[],saveStep,beforeEffect,signal,
  service=environmentService,readState=()=>readAutomation(projectId),readRun=id=>getHarnessRun(projectId,id)}) {
  if(typeof saveStep!=='function'||typeof beforeEffect!=='function')fail('AUTOMATION_ENVIRONMENT_CONTEXT_REQUIRED','环境准备缺少当前研究任务上下文。');
  const input=validateEnvironmentProposal(proposal),producer=await readRun(sourceRunId);
  if(producer.projectId!==projectId||producer.id!==sourceRunId||producer.status!=='completed'||producer.task!=='research:environment_proposal'||producer.parentRunId!==session.coordinatorRunId||producer.automationSessionId!==session.id||producer.stage!==stage)fail('AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED','环境建议不属于当前阶段的已完成Agent任务。');
  const initial=await readState(),step=initial.session?.steps.find(s=>s.stage===stage);
  if(initial.session?.id!==session.id||initial.session?.coordinatorRunId!==session.coordinatorRunId)fail('AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED','环境建议来自另一条研究会话。');
  if(!step?.calls?.some(call=>call.runId===sourceRunId&&call.task==='research:environment_proposal'))fail('AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED','阶段没有保存这条环境建议调用。');
  let preparations=[...(step.environmentPreparations||[])],entry=preparations.find(item=>item.authorization.sourceRunId===sourceRunId&&item.authorization.proposalSha256===sourceHash(input));
  if(!entry){const authorization=createEnvironmentAuthorization({projectId,session:initial.session,stage,policyVersion:initial.version,policy:initial.policy,proposal:input,sourceRunId});
    if(initial.session.steps.reduce((sum,s)=>sum+(s.environmentPreparations?.length||0),0)>=authorization.scope.maxEnvironments)fail('AUTOMATION_ENVIRONMENT_LIMIT','本研究链路已达到环境准备数量预算。');
    entry={authorization,reason,deferred,status:'prepared',attempt:initial.session.attempt||0,jobId:null,environmentId:null};preparations.push(entry);await beforeEffect();await saveStep({environmentPreparations:preparations});
  }else if(['failed','cancelled'].includes(entry.status)&&(entry.attempt||0)>=(initial.session.attempt||0))fail('AUTOMATION_ENVIRONMENT_FAILED','已有环境失败记录已保留；请从原研究链路继续。');
  const authorization=structuredClone(entry.authorization);
  const assertAuthorized=async()=>{await beforeEffect();signal?.throwIfAborted();const current=await readState();
    const currentStep=current.session?.steps.find(s=>s.stage===stage);
    if(!currentStep?.calls?.some(call=>call.runId===sourceRunId&&call.task==='research:environment_proposal'))fail('AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED','当前环境来源调用已改变。');
    const admitted=assertEnvironmentAuthorization(authorization,{projectId,session:current.session,stage,policyVersion:current.version,policy:current.policy,proposal:input,sourceRunId});
    const bound=currentStep.environmentPreparations?.find(item=>item.authorization.sourceRunId===sourceRunId&&item.authorization.proposalSha256===authorization.proposalSha256);
    if(!bound||sourceHash(bound.authorization)!==sourceHash(authorization))fail('AUTOMATION_ENVIRONMENT_AUTHORIZATION_CHANGED','已保存的环境任务授权发生变化。');return admitted;
  };
  const persist=async patch=>{entry={...entry,...patch};preparations=preparations.map(item=>item.authorization.sourceRunId===sourceRunId&&item.authorization.proposalSha256===authorization.proposalSha256?entry:item);await saveStep({environmentPreparations:preparations});};
  try{const {environmentRequest}=await assertAuthorized();
    const result=await service.prepareAuthorized(projectId,environmentRequest,{authorization,assertAuthorized,signal,jobId:entry.jobId,onPrepared:async job=>{
      if(entry.jobId&&entry.jobId!==job.id)fail('AUTOMATION_ENVIRONMENT_JOB_CHANGED','原环境准备任务身份发生变化。');await persist({jobId:job.id,status:job.status,attempt:initial.session.attempt||0});
    }});
    await persist({status:'completed',jobId:result.job.id,environmentId:result.environment.id,sha256:result.environment.sha256,cached:result.job.cached===true,currentPolicyVersion:(await readState()).version});return result.environment;
  }catch(error){await persist({status:signal?.aborted?'cancelled':'failed',error:{code:error.code||'AUTOMATION_ENVIRONMENT_FAILED',message:error.message}});throw error;}
}
