import { request } from './client';

export interface CodePreparation {
  id: string;
  sha256: string;
  projectId: string;
  status: 'ready';
  source: { runId: string; childRunIds: string[] };
  files: { path: string; sha256: string; bytes: number; baseVersion: { exists: boolean; sha256: string | null } }[];
  createdAt: string;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/code-preparations`;
async function call<T>(url: string, options?: RequestInit): Promise<T> {
  try { return await request<T>(url, options); }
  catch (error) {
    if (error instanceof Error) {
      let value: unknown;
      try { value = JSON.parse(error.message); } catch { throw error; }
      const message = (value as { error?: { message?: unknown } })?.error?.message;
      if (typeof message === 'string') throw new Error(message);
    }
    throw error;
  }
}

export const listCodePreparations = (projectId: string, signal?: AbortSignal) =>
  call<{ preparations: CodePreparation[] }>(base(projectId), { signal });
export const getCodePreparation = (projectId: string, id: string, signal?: AbortSignal) =>
  call<{ preparation: CodePreparation }>(`${base(projectId)}/${encodeURIComponent(id)}`, { signal });
export const prepareCode = (projectId: string, sourceRunId: string, paths: string[], signal?: AbortSignal) =>
  call<{ preparation: CodePreparation; cached: boolean }>(base(projectId), { method: 'POST', body: JSON.stringify({ sourceRunId, paths }), signal });
