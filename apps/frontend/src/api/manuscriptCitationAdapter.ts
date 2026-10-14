import { request,type FileVersion } from './client';
export interface CitationReadingSource {attachmentId:string;sha256:string;page:number;selectionId?:string;}
export interface ManuscriptCitationInput {paperId:string;texPath:string;bibPath:string;expectedTexVersion:FileVersion;expectedBibVersion:FileVersion;position:{offset:number};citationKey?:string;readingSource?:CitationReadingSource;bibliographyImport?:{kind:'bibtex'|'biblatex';offset:number};}
export interface ManuscriptCitationSource {paperId?:string;paperRevision:string;readingSource?:CitationReadingSource;verificationStatus?:string;[key:string]:unknown;}
export interface ManuscriptCitationPreview {ok:boolean;citationKey:string;bibEntry:string;texPreview:string;bibliographyLinked:boolean;importPreview?:{kind:'bibtex'|'biblatex';offset:number;text:string};source:ManuscriptCitationSource;}
export interface ManuscriptCitationApplyInput extends ManuscriptCitationInput {requestId:string;expectedPaperRevision:string;}
export interface ManuscriptCitationResult {ok:boolean;citationKey:string;source:ManuscriptCitationSource;tex:{path:string;version:FileVersion;line:number;from:number;to:number};bib:{path:string;version:FileVersion};transactionId:string;}
export interface ManuscriptCitationRequest {ok:boolean;requestId:string;status:'applying'|'applied'|'rolled_back'|'recovery_required';transactionId:string;receipt:ManuscriptCitationResult|null;error?:{code:string;message:string};source:ManuscriptCitationSource;}
const base=(projectId:string)=>`/api/projects/${encodeURIComponent(projectId)}/manuscript-citations`;
async function call<T>(url:string,options?:RequestInit):Promise<T>{try{return await request<T>(url,options);}catch(cause){if(cause instanceof Error){let value:{error?:{message?:string;code?:string}}|undefined;try{value=JSON.parse(cause.message);}catch{/* Preserve transport errors. */}if(value?.error?.message)throw Object.assign(new Error(value.error.message),{code:value.error.code});}throw cause;}}
const post=<T>(url:string,input:unknown,signal?:AbortSignal)=>call<T>(url,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input),signal});
export const previewManuscriptCitation=(projectId:string,input:ManuscriptCitationInput&{expectedPaperRevision?:string},signal?:AbortSignal)=>post<ManuscriptCitationPreview>(`${base(projectId)}/preview`,input,signal);
export const applyManuscriptCitation=(projectId:string,input:ManuscriptCitationApplyInput,signal?:AbortSignal)=>post<ManuscriptCitationResult>(base(projectId),input,signal);
export const getManuscriptCitationRequest=(projectId:string,requestId:string,signal?:AbortSignal)=>call<ManuscriptCitationRequest>(`${base(projectId)}/requests/${encodeURIComponent(requestId)}`,{signal});

export interface CitationDraft {
  line: number; column: number; importKind: '' | 'bibtex' | 'biblatex';
  importLine: number; importColumn: number; includeReadingSource: boolean; citationKey?: string;
}
export interface PendingManuscriptCitation {
  projectId: string; paperId: string; input: ManuscriptCitationApplyInput; draft: CitationDraft;
}
const pendingKey = (projectId: string, paperId: string) => `scienceprism:manuscript-citation:${encodeURIComponent(projectId)}:${encodeURIComponent(paperId)}`;
export function loadPendingCitation(projectId: string, paperId: string): PendingManuscriptCitation | null {
  const raw = localStorage.getItem(pendingKey(projectId, paperId));
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingManuscriptCitation;
  const validVersion = (version: FileVersion | undefined) => version && (version.exists === false && version.sha256 === null || version.exists === true && /^[a-f0-9]{64}$/.test(version.sha256 || ''));
  if (!value || value.projectId !== projectId || value.paperId !== paperId || value.input?.paperId !== paperId ||
    typeof value.input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.input.requestId) || !/^[a-f0-9]{64}$/.test(value.input.expectedPaperRevision || '') || typeof value.input.texPath !== 'string' || !value.input.texPath || typeof value.input.bibPath !== 'string' || !value.input.bibPath ||
    !validVersion(value.input.expectedTexVersion) || !validVersion(value.input.expectedBibVersion) ||
    !Number.isSafeInteger(value.input.position?.offset) || value.input.position.offset < 0 || !value.draft) {
    throw new Error('保存的引用请求无法识别，请保留本地记录并检查请求状态。');
  }
  return value;
}
export function persistPendingCitation(value: PendingManuscriptCitation): void {
  const key = pendingKey(value.projectId, value.paperId), raw = JSON.stringify(value);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error('无法保存请求恢复记录，引用尚未写入。');
}
export function clearPendingCitation(projectId: string, paperId: string): void {
  localStorage.removeItem(pendingKey(projectId, paperId));
  if (localStorage.getItem(pendingKey(projectId, paperId))) throw new Error('无法清除旧请求记录，请先恢复请求。');
}
export function citationPositionOffset(content: string, line: number, column: number): number {
  const lines = content.split('\n');
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > lines.length ||
    column < 1 || column > lines[line - 1].replace(/\r$/, '').length + 1) throw new Error('行号或列号超出文稿范围，请重新选择插入位置。');
  return lines.slice(0, line - 1).reduce((offset, value) => offset + value.length + 1, 0) + column - 1;
}
