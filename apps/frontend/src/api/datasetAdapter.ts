import { request, getCollabToken } from './client';
export interface DatasetSource { kind: string; url: string | null; revision: string | null }
export interface DatasetVersion { id: string; filename: string; name: string; sha256: string; byteLength: number; source: DatasetSource; license: { label: string; verified: boolean }; split: string; acquiredAt: string; readOnly: true; preview: { format: string; columns: string[]; rows: string[][]; truncated: boolean; rowCount?: number; warning?: string } }
export interface DatasetJob { id: string; status: string; receivedBytes: number; totalBytes: number | null; datasetId: string | null; error?: { code: string; message: string } | null; message?: string; configuration: { version: number; filename: string; source: DatasetSource; maxBytes: number }; configurationSha256: string }
export interface DatasetState { datasets: DatasetVersion[]; jobs: DatasetJob[]; supportedHosts: string[]; maxBytes: number }
export interface DatasetDownloadInput { url: string; filename: string; license?: string; split: string; maxBytes: number; expectedSha256?: string; refresh?: boolean }
const base = (project: string) => `/api/projects/${encodeURIComponent(project)}/datasets`;
async function call<T>(url: string, options?: RequestInit) {
  try { return await request<T>(url, options); }
  catch (error) { if (error instanceof Error) { try { const value=JSON.parse(error.message); if(typeof value?.error?.message==='string')throw new Error(value.error.message); } catch(parsed) { if(parsed instanceof Error && !(parsed instanceof SyntaxError))throw parsed; } } throw error; }
}
export const listDatasets = (project: string, signal?: AbortSignal) => call<DatasetState>(base(project), { signal });
export function importDataset(project: string, file: File, signal?: AbortSignal) { const body=new FormData(); body.append('file',file); return call<{dataset: DatasetVersion}>(`${base(project)}/import`,{method:'POST',body,signal}); }
export const acquireDataset = (project: string, input: DatasetDownloadInput, signal?: AbortSignal) => call<{job: DatasetJob; dataset?: DatasetVersion; cached: boolean}>(`${base(project)}/download`,{method:'POST',body:JSON.stringify(input),signal});
export const resumeDataset = (project: string, job: DatasetJob, signal?: AbortSignal) => call(`${base(project)}/jobs/${encodeURIComponent(job.id)}/resume`,{method:'POST',body:JSON.stringify({expectedConfigurationVersion:job.configuration.version}),signal});
export const cancelDataset = (project: string, job: DatasetJob, signal?: AbortSignal) => call(`${base(project)}/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',body:'{}',signal});
export async function downloadDatasetContent(project: string, dataset: DatasetVersion, signal?: AbortSignal) {
  const token=getCollabToken(); const response=await fetch(`${base(project)}/${encodeURIComponent(dataset.id)}/content`,{signal,headers:token?{Authorization:`Bearer ${token}`}:{}});
  if(!response.ok) { const result=await response.json().catch(()=>null); throw new Error(result?.error?.message||'原始数据不可下载，请刷新版本记录。'); }
  return response.blob();
}
