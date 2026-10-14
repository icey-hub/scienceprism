import { request, type IdeaPlan, type IdeaHypothesis, type IdeaEvaluation } from './client';
export interface IdeaPlanRevisionSource {campaignId:string;evaluationRunId:string;sourceSha256:string;evaluatedPlanRevision:number;suggestionIndexes:number[];suggestions:string[];idempotencyKey?:string;}
export type RevisionIdeaPlan=IdeaPlan&{revisionSource?:IdeaPlanRevisionSource};
export interface IdeaPlanAttempt {id:string;ideaId:string;planRevision:number;planSha256:string;source:IdeaPlanRevisionSource;createdAt:string;actor:string;fromWorkflowVersion:number;previousStages:{id:string;status:string;data:Record<string,unknown>}[];previousAutomation:null|{sessionId:string;coordinatorRunId?:string|null;status:string};idempotencyKey?:string;}
export interface NextPlanInput {expectedVersion:number;expectedRevision:number;campaignId:string;evaluationRunId:string;suggestionIndexes:number[];idempotencyKey:string;}
export interface NextPlanResult {ok:boolean;plan:RevisionIdeaPlan;history:RevisionIdeaPlan[];workflowVersion:number;}
export interface IdeaPlanAttempts {ok:boolean;attempts:IdeaPlanAttempt[];workflowVersion:number;activeAttemptId?:string;}
const base=(projectId:string,ideaId:string)=>`/api/projects/${encodeURIComponent(projectId)}/research-workflow/ideas/${encodeURIComponent(ideaId)}/plan`;
async function call<T>(url:string,options?:RequestInit):Promise<T>{try{return await request<T>(url,options);}catch(cause){if(cause instanceof Error){let value:{error?:{message?:string;code?:string}}|undefined;try{value=JSON.parse(cause.message);}catch{/* Preserve transport errors. */}if(value?.error?.message)throw Object.assign(new Error(value.error.message),{code:value.error.code});}throw cause;}}
const post=<T>(url:string,input:unknown,signal?:AbortSignal)=>call<T>(url,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input),signal});
export const saveNextIdeaPlan=(projectId:string,ideaId:string,input:NextPlanInput&{hypothesis:IdeaHypothesis;evaluation:IdeaEvaluation},signal?:AbortSignal)=>post<NextPlanResult>(`${base(projectId,ideaId)}/next-version`,input,signal);
export const generateNextIdeaPlan=(projectId:string,ideaId:string,input:NextPlanInput,signal?:AbortSignal)=>post<NextPlanResult>(`${base(projectId,ideaId)}/generate-next`,input,signal);
export const startNextIdeaPlanAttempt=(projectId:string,ideaId:string,revision:number,input:{expectedVersion:number;idempotencyKey:string},signal?:AbortSignal)=>post<{ok:boolean;workflow:unknown;attempt:IdeaPlanAttempt}>(`${base(projectId,ideaId)}/${revision}/next-attempt`,input,signal);
export const getIdeaPlanAttempts=(projectId:string,ideaId:string,signal?:AbortSignal)=>call<IdeaPlanAttempts>(`${base(projectId,ideaId)}/attempts`,{signal});
