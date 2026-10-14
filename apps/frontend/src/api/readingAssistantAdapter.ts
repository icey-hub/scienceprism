import { request } from './client';
import type { HarnessRun } from './assistantAdapter';
import type { ReadingSelection } from './paperReaderAdapter';

export interface ReadingGlossarySource {paperId:string;attachmentId:string;fileSha256:string;page:number;quote:string;rects:ReadingSelection['rects'];}
export interface ReadingGlossaryEntry {id:string;term:string;definition:string;sourceLanguage:string;targetLanguage:string;source?:ReadingGlossarySource|null;createdAt:string;updatedAt:string;}
export interface ReadingGlossaryState {ok:boolean;entries:ReadingGlossaryEntry[];revision:number;}
export type ReadingGlossaryInput=Pick<ReadingGlossaryEntry,'term'|'definition'|'sourceLanguage'|'targetLanguage'> & {source?:ReadingGlossarySource|null};
export type ReadingExplanationRun=HarnessRun & {request?:NonNullable<HarnessRun['request']>&{readingSource?:{paperId:string;selection:ReadingSelection;targetLanguage:string;question?:string};}};
const glossary=(projectId:string)=>`/api/projects/${encodeURIComponent(projectId)}/reading-glossary`;
const explanations=(projectId:string,paperId:string)=>`/api/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/explanations`;
async function call<T>(url:string,options?:RequestInit):Promise<T>{try{return await request<T>(url,options);}catch(cause){if(cause instanceof Error){let data:{error?:{message?:unknown;code?:unknown}}|undefined;try{data=JSON.parse(cause.message);}catch{/* Plain network errors remain available. */}if(typeof data?.error?.message==='string')throw Object.assign(new Error(data.error.message),{code:data.error.code});}throw cause;}}
export const getReadingGlossary=(projectId:string,signal?:AbortSignal)=>call<ReadingGlossaryState>(glossary(projectId),{signal});
export const createReadingTerm=(projectId:string,expectedRevision:number,entry:ReadingGlossaryInput,signal?:AbortSignal)=>call<ReadingGlossaryState>(glossary(projectId),{method:'POST',headers:{'x-scienceprism-actor':'human'},signal,body:JSON.stringify({expectedRevision,entry})});
export const updateReadingTerm=(projectId:string,entryId:string,expectedRevision:number,patch:Partial<ReadingGlossaryInput>,signal?:AbortSignal)=>call<ReadingGlossaryState>(`${glossary(projectId)}/${encodeURIComponent(entryId)}`,{method:'PATCH',headers:{'x-scienceprism-actor':'human'},signal,body:JSON.stringify({expectedRevision,patch})});
export const deleteReadingTerm=(projectId:string,entryId:string,expectedRevision:number,signal?:AbortSignal)=>call<ReadingGlossaryState>(`${glossary(projectId)}/${encodeURIComponent(entryId)}`,{method:'DELETE',headers:{'x-scienceprism-actor':'human'},signal,body:JSON.stringify({expectedRevision})});
export const listReadingExplanations=(projectId:string,paperId:string,signal?:AbortSignal)=>call<{ok:boolean;runs:ReadingExplanationRun[]}>(explanations(projectId,paperId),{signal});
export const createReadingExplanation=(projectId:string,paperId:string,input:{requestId:string;selection:ReadingSelection;targetLanguage:'zh-CN';question?:string},signal?:AbortSignal)=>call<{ok:boolean;run:ReadingExplanationRun}>(explanations(projectId,paperId),{method:'POST',headers:{'x-scienceprism-actor':'human'},signal,body:JSON.stringify(input)});
export const readingSelectionKey=(selection:ReadingSelection|null)=>selection?JSON.stringify([selection.attachmentId,selection.fileSha256,selection.page,selection.text,selection.rects.map(rect=>[rect.x,rect.y,rect.width,rect.height])]):'';
