import type { PaperRanking, RankingFilter } from './paperRankingsAdapter';
import { request } from './client';

export interface SearchFilters { yearFrom: number | null; yearTo: number | null; publicationType: string; openAccessOnly: boolean }
export interface SearchCriteria { query: string; sources: string[]; pageSize: number; offset: number; filters?: SearchFilters; ranking?: RankingFilter }
export interface SearchCandidate {
  id: string; title: string; authors?: string[]; abstract?: string; year?: number | null;
  url?: string; doi?: string; arxivId?: string; venue?: string; publicationType?: string;
  rankings?: PaperRanking[]; rankingStatus?: 'known' | 'unknown';
  source: string; retrievedAt?: string; searchSessionIds?: string[];
  isOpenAccess?: boolean | null; oaPdfUrl?: string; oaVersion?: string; oaLicense?: string; issns?: string[];
  sourceRecord?: { provider?: string; id?: string; retrievedAt?: string; externalVersion?: string | null; searchSessionId?: string };
  sourceRecords?: NonNullable<SearchCandidate['sourceRecord']>[];
}
export interface PaperSearchSession {
  id: string; projectId: string; createdAt: string; criteria: SearchCriteria;
  status: 'completed' | 'partial' | 'failed'; candidates: SearchCandidate[];
  failures: { source: string; code: string; message: string; retryable?: boolean }[];
  nextOffset: number | null;
  rankingCoverage?: { total: number; matched: number; unmatched: number; returned: number; catalogCount: number; catalogVersion: number; unmatchedPapers: { id: string; venue: string; reason: string }[] };
  sourceResults?: { source: string; retrievedAt: string; total: number | null; filterMode: 'server' | 'batch'; received: number; matched: number }[];
}
export interface PaperSearchHistory {
  ok: boolean; projectName: string; sessions: PaperSearchSession[];
  sources: { id: string; label: string; priority: number; filterMode: 'server' | 'batch' }[];
}
export function loadPaperSearches(projectId: string, signal?: AbortSignal) {
  return request<PaperSearchHistory>(`/api/projects/${encodeURIComponent(projectId)}/paper-search`, { signal });
}
export function searchProjectPapers(projectId: string, criteria: SearchCriteria, signal: AbortSignal) {
  return request<{ ok: boolean; session: PaperSearchSession }>(`/api/projects/${encodeURIComponent(projectId)}/paper-search`, {
    method: 'POST', body: JSON.stringify(criteria), signal
  });
}
