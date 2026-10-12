import { request } from './client';

export interface SearchCriteria { query: string; sources: string[]; pageSize: number; offset: number }
export interface SearchCandidate {
  id: string; title: string; authors?: string[]; abstract?: string; year?: number | null;
  url?: string; doi?: string; arxivId?: string; venue?: string; publicationType?: string;
  source: string; retrievedAt?: string;
  sourceRecord?: { provider?: string; id?: string; retrievedAt?: string; externalVersion?: string | null };
}
export interface PaperSearchSession {
  id: string; projectId: string; createdAt: string; criteria: SearchCriteria;
  status: 'completed' | 'partial' | 'failed'; candidates: SearchCandidate[];
  failures: { source: string; code: string; message: string; retryable?: boolean }[];
  nextOffset: number | null;
}
export interface PaperSearchHistory {
  ok: boolean; projectName: string; sessions: PaperSearchSession[];
  sources: { id: string; label: string; priority: number }[];
}
export function loadPaperSearches(projectId: string, signal?: AbortSignal) {
  return request<PaperSearchHistory>(`/api/projects/${encodeURIComponent(projectId)}/paper-search`, { signal });
}
export function searchProjectPapers(projectId: string, criteria: SearchCriteria, signal: AbortSignal) {
  return request<{ ok: boolean; session: PaperSearchSession }>(`/api/projects/${encodeURIComponent(projectId)}/paper-search`, {
    method: 'POST', body: JSON.stringify(criteria), signal
  });
}
