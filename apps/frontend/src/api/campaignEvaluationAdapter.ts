import { request } from './client';

export interface CampaignAgentEvaluationRecord {
  runId:string;
  requestId?:string;
  automationSessionId?:string;
  status:string;
  createdAt:string;
  sourceSha256:string;
  sourceCurrent:boolean;
  source:{campaignId:string;planRevision:number;planSha256:string;trialRunIds:string[]};
  output:null|{verdict:'supported'|'refuted'|'insufficient';summary:string;findings:{text:string;runIds:string[]}[];limitations:string[];nextPlanSuggestions:string[]};
  error:null|{code:string;message:string};
  usage?:Record<string,unknown>|null;
}
const path=(projectId:string,campaignId:string)=>`/api/projects/${encodeURIComponent(projectId)}/validation-campaigns/${encodeURIComponent(campaignId)}/evaluation-agent`;
async function call<T>(url:string,options?:RequestInit):Promise<T> {
  try{return await request<T>(url,options);}catch(cause){
    if(cause instanceof Error){let data:{error?:{message?:unknown;code?:unknown}}|undefined;try{data=JSON.parse(cause.message);}catch{/* Keep plain transport errors. */}
      if(typeof data?.error?.message==='string')throw Object.assign(new Error(data.error.message),{code:data.error.code});}
    throw cause;
  }
}
export const getCampaignAgentEvaluations=(projectId:string,campaignId:string,signal?:AbortSignal)=>call<{ok:boolean;evaluations:CampaignAgentEvaluationRecord[]}>(path(projectId,campaignId),{signal});
export const startCampaignAgentEvaluation=(projectId:string,campaignId:string,requestId:string,signal?:AbortSignal)=>call<{ok:boolean;evaluation:CampaignAgentEvaluationRecord}>(path(projectId,campaignId),{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify({requestId}),signal});
