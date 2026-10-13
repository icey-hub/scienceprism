import { request } from './client';

export interface EnvironmentPackage { path: string; sha256: string }
export interface PythonEnvironment {
  id: string;
  python: { version: string; implementation: string; executable?: string };
  packages: { name: string; version: string }[];
  isolation: string;
  hardware: { platform: string; arch: string; cpuCount: number };
  sha256: string;
}
export interface EnvironmentJob {
  id: string;
  status: 'queued' | 'preparing' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  configuration: { version: 1; packages: EnvironmentPackage[]; timeoutMs: number; maxOutputBytes: number };
  configurationSha256: string;
  process?: { pid: number; stopConfirmed: boolean };
  logs?: { stdout: string; stderr: string };
  environment?: PythonEnvironment;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}
export interface EnvironmentState {
  jobs: EnvironmentJob[];
  capability: {
    local: { available: boolean; reason?: string };
    container: { available: false; reason: string };
    remote: { available: false; reason: string };
  };
}
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/environments`;
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
export const listEnvironments = (projectId: string, signal?: AbortSignal) => call<EnvironmentState>(base(projectId), { signal });
export const getEnvironmentJob = (projectId: string, jobId: string, signal?: AbortSignal) => call<{ job: EnvironmentJob }>(`${base(projectId)}/${encodeURIComponent(jobId)}`, { signal });
export const prepareEnvironment = (projectId: string, packages: EnvironmentPackage[], signal?: AbortSignal) => call<{ job: EnvironmentJob }>(base(projectId), { method: 'POST', body: JSON.stringify({ packages }), signal });
export const retryEnvironment = (projectId: string, jobId: string, signal?: AbortSignal) => call<{ job: EnvironmentJob }>(`${base(projectId)}/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}', signal });
export const cancelEnvironment = (projectId: string, jobId: string, signal?: AbortSignal) => call<{ job: EnvironmentJob }>(`${base(projectId)}/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}', signal });
