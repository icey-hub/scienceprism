import { request, type ProjectTask } from './client';
export type OcrRotation=0|90|180|270;
export interface OcrRegion {x:number;y:number;width:number;height:number;}
export interface OcrSource {attachmentId:string;fileSha256:string;page:number;region:OcrRegion;rotation:OcrRotation;}
export interface OcrTranslation {operationId:string;correctionRevision:number;sourceText:string;translatedText:string;providerId:string;targetLanguage:string;translatedAt:string;}
export interface ReadingOcrTask extends Omit<ProjectTask,'metadata'> {
  metadata:{ocr:{source:OcrSource&{paperId:string};operationId:string;inputHash:string;engine:string;version:string;language:string;
    raw:{text:string;lines:unknown[];basis?:unknown;width?:number;height?:number;[key:string]:unknown}|null;
    correction:{revision:number;text:string;updatedAt:string}|null;translations:OcrTranslation[];cachedFromTaskId?:string;
    worker:{pid:number|null;stopConfirmed:boolean};}};
}
export interface ReadingOcrState {capabilities:{available:boolean;engine:string;version:string;languages:string[];reason?:string};tasks:ReadingOcrTask[];}
const base=(projectId:string,paperId:string)=>`/api/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/ocr`;
async function call<T>(url:string,options?:RequestInit):Promise<T>{try{return await request<T>(url,options);}catch(cause){if(cause instanceof Error){let body:{error?:{message?:unknown;code?:unknown}}|undefined;try{body=JSON.parse(cause.message);}catch{/* Preserve plain transport errors. */}if(typeof body?.error?.message==='string')throw Object.assign(new Error(body.error.message),{code:body.error.code});}throw cause;}}
const write=(body:unknown,signal?:AbortSignal)=>({method:'POST',headers:{'x-scienceprism-actor':'human'},signal,body:JSON.stringify(body)});
export const getReadingOcr=(projectId:string,paperId:string,signal?:AbortSignal)=>call<ReadingOcrState>(base(projectId,paperId),{signal});
export const startReadingOcr=(projectId:string,paperId:string,input:{operationId:string;source:OcrSource;language:string},signal?:AbortSignal)=>call<{task:ReadingOcrTask}>(base(projectId,paperId),write(input,signal));
export const getReadingOcrTask=(projectId:string,paperId:string,taskId:string,signal?:AbortSignal)=>call<{task:ReadingOcrTask}>(`${base(projectId,paperId)}/${encodeURIComponent(taskId)}`,{signal});
export const cancelReadingOcr=(projectId:string,paperId:string,taskId:string,signal?:AbortSignal)=>call<{task:ReadingOcrTask}>(`${base(projectId,paperId)}/${encodeURIComponent(taskId)}/cancel`,write({},signal));
export const retryReadingOcr=(projectId:string,paperId:string,taskId:string,operationId:string,signal?:AbortSignal)=>call<{task:ReadingOcrTask}>(`${base(projectId,paperId)}/${encodeURIComponent(taskId)}/retry`,write({operationId},signal));
export const correctReadingOcr=(projectId:string,paperId:string,taskId:string,expectedRevision:number,text:string,signal?:AbortSignal)=>call<{task:ReadingOcrTask}>(`${base(projectId,paperId)}/${encodeURIComponent(taskId)}/correction`,{...write({expectedRevision,text},signal),method:'PATCH'});
export const translateReadingOcr=(projectId:string,paperId:string,taskId:string,input:{expectedRevision:number;operationId:string;providerId:string;targetLanguage:string},signal?:AbortSignal)=>call<{task:ReadingOcrTask;translation:OcrTranslation}>(`${base(projectId,paperId)}/${encodeURIComponent(taskId)}/translate`,write(input,signal));
export const ocrSourceKey=(source:OcrSource|null)=>source?JSON.stringify([source.attachmentId,source.fileSha256,source.page,source.rotation,source.region.x,source.region.y,source.region.width,source.region.height]):'';
