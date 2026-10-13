import { datasetService } from '../datasets/index.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { readAutomation } from './policy.js';
import { DATASET_HF_CDN_HOSTS } from '../datasets/download.js';
import { createDatasetAuthorization, assertDatasetAuthorization, validateDatasetProposal } from './datasetAuthorization.js';
import { sourceHash } from './handoff.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
const fail=(code,message)=>{throw new ResearchWorkflowError(409,code,message);};

/** The application consumes an AI suggestion through its one data service.
 * The saved grant belongs to a specific stage/producer and never comes from
 * an execution plan or a model-supplied authority field. */
export async function acquireAutomationDataset({projectId,session,stage,proposal,sourceRunId,evidenceQuote='',saveStep,beforeEffect,signal,
  service=datasetService,readState=()=>readAutomation(projectId),readRun=id=>getHarnessRun(projectId,id)}){
  if(typeof saveStep!=='function'||typeof beforeEffect!=='function')fail('AUTOMATION_DATASET_CONTEXT_REQUIRED','数据获取缺少当前研究任务上下文。');
  const input=validateDatasetProposal(proposal),producer=await readRun(sourceRunId);
  if(producer.projectId!==projectId||producer.id!==sourceRunId||producer.status!=='completed'||producer.task!=='research:dataset_discovery'
    ||producer.parentRunId!==session.coordinatorRunId||producer.automationSessionId!==session.id||producer.stage!==stage)fail('AUTOMATION_DATASET_PRODUCER_CHANGED','数据建议不属于当前阶段的已完成Agent任务。');
  let initial=await readState();
  const step=initial.session?.steps.find(item=>item.stage===stage);
  if(!step?.calls?.some(call=>call.runId===sourceRunId&&call.task==='research:dataset_discovery'))fail('AUTOMATION_DATASET_PRODUCER_CHANGED','阶段没有保存这条数据建议调用。');
  let acquisitions=[...(step.datasetAcquisitions||[])];
  let entry=acquisitions.find(item=>item.authorization.sourceRunId===sourceRunId&&item.authorization.proposalSha256===sourceHash(input));
  if(!entry){
    const authorization=createDatasetAuthorization({projectId,session:initial.session,stage,policyVersion:initial.version,policy:initial.policy,proposal:input,sourceRunId});
    const count=initial.session.steps.reduce((sum,item)=>sum+(item.datasetAcquisitions?.length||0),0);
    if(count>=authorization.scope.maxDatasets)fail('AUTOMATION_DATASET_LIMIT','本研究链路已达到数据获取数量预算。');
    entry={authorization,evidenceQuote,sourceAssociationConfirmed:false,status:'prepared',attempt:initial.session.attempt||0,jobId:null,datasetId:null};acquisitions.push(entry);
    await beforeEffect();await saveStep({datasetAcquisitions:acquisitions});
  }else if(['failed','cancelled'].includes(entry.status)&&(entry.attempt||0)>=(initial.session.attempt||0))fail('AUTOMATION_DATASET_FAILED','已有失败数据任务已保留；请从研究链路继续，不会在同次尝试内重跑。');
  const authorization=structuredClone(entry.authorization);
  const assertAuthorized=async(request)=>{await beforeEffect();signal?.throwIfAborted();const current=await readState();
    if(!current.session?.steps.find(item=>item.stage===stage)?.calls?.some(call=>call.runId===sourceRunId&&call.task==='research:dataset_discovery'))fail('AUTOMATION_DATASET_PRODUCER_CHANGED','当前阶段的数据来源调用已变化。');
    const result=assertDatasetAuthorization(authorization,{projectId,session:current.session,stage,policyVersion:current.version,policy:current.policy,proposal:input,sourceRunId});
    if(request?.url){const actualHost=new URL(request.url).hostname,originalHost=new URL(input.url).hostname;
      const permitted=authorization.scope.allowedHosts.includes(actualHost)&&current.policy.datasetScope.allowedHosts.includes(actualHost);
      const hfTransport=originalHost==='huggingface.co'&&authorization.scope.allowedHosts.includes(originalHost)&&current.policy.datasetScope.allowedHosts.includes(originalHost)&&DATASET_HF_CDN_HOSTS.includes(actualHost);
      if(!permitted&&!hfTransport)fail('AUTOMATION_DATASET_HOST_DENIED','下载重定向超出当前数据来源授权。');}
    const bound=current.session.steps.find(item=>item.stage===stage)?.datasetAcquisitions?.find(item=>item.authorization.proposalSha256===authorization.proposalSha256&&item.authorization.sourceRunId===sourceRunId);
    if(!bound||sourceHash(bound.authorization)!==sourceHash(authorization))fail('AUTOMATION_DATASET_AUTHORIZATION_CHANGED','已保存的数据任务授权发生变化。');return result;};
  const persist=async patch=>{entry={...entry,...patch};acquisitions=acquisitions.map(item=>item.authorization.sourceRunId===sourceRunId&&item.authorization.proposalSha256===authorization.proposalSha256?entry:item);await saveStep({datasetAcquisitions:acquisitions});};
  try{
    const admitted=await assertAuthorized();
    const result=await service.acquireAuthorized(projectId,admitted.datasetRequest,{authorization,assertAuthorized,signal,onPrepared:async job=>{
      if(entry.jobId&&entry.jobId!==job.id)fail('AUTOMATION_DATASET_JOB_CHANGED','原数据任务身份发生变化。');
      await persist({jobId:job.id,status:job.status,attempt:initial.session.attempt||0});
    }});
    await persist({status:'completed',jobId:result.job.id,datasetId:result.dataset.id,sha256:result.dataset.sha256,currentPolicyVersion:(await readState()).version});
    return result.dataset;
  }catch(error){await persist({status:signal?.aborted?'cancelled':'failed',error:{code:error.code||'AUTOMATION_DATASET_FAILED',message:error.message}});throw error;}
}
