import { request } from './client';
export interface RankingFilter { scheme?: string | null; editionYear?: number | null; subject?: string | null; ranks?: string[]; unknown?: 'include' | 'exclude' | 'only' }
export interface PaperRanking { catalogId: string; catalogLabel: string; scheme: string; editionYear: number; subject: string; rank: string; venue: string; matchedBy: 'issn' | 'venue'; provenance: { label: string; url?: string; license?: string }; importedAt: string }
export interface RankingCatalog { id: string; label: string; scheme: string; editionYear: number; recordCount: number; ranks: string[]; subjects: string[]; provenance: PaperRanking['provenance']; supersededBy?: string }
export interface RankingCatalogue { version: number; catalogs: RankingCatalog[] }
export const getRankingCatalogs = (projectId: string, signal?: AbortSignal) => request<RankingCatalogue>(`/api/projects/${encodeURIComponent(projectId)}/paper-rankings`, { signal });
export const importRankingCatalog = (projectId: string, input: { expectedVersion: number; scheme: string; editionYear: number; label: string; provenance: PaperRanking['provenance']; csv: string; replaceCatalogId?: string }) => request<{ version: number; duplicate: boolean; catalog: RankingCatalog }>(`/api/projects/${encodeURIComponent(projectId)}/paper-rankings`, { method: 'POST', body: JSON.stringify(input) });
