import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getProjectRoot } from './projectService.js';
import { listResearchSourceAdapters, searchResearchSources } from './researchSources/index.js';
import { readHubJson, withHubLock, writeHubJson } from './projectHub/repository.js';
import { loadRankingCatalogs, applyPaperRankings } from './paperRankings/index.js';
import { normalizeRankingFilter } from './paperRankings/validation.js';
import { mergeSourceCandidates } from './researchSources/candidateIdentity.js';

const FILE = 'paper-searches.json';
const HISTORY_LIMIT = 30;

export class PaperSearchError extends Error {
  constructor(message, code = 'INVALID_SEARCH') {
    super(message); this.code = code; this.statusCode = 400;
  }
}

export function normalizeSearchInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PaperSearchError('检索参数必须是对象。');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 1000) throw new PaperSearchError('请输入 1–1000 字符的检索关键词。');
  const available = listResearchSourceAdapters().map(source => source.id);
  const sources = input.sources ?? ['arxiv'];
  if (!Array.isArray(sources) || !sources.length || sources.some(source => !available.includes(source))) {
    throw new PaperSearchError('请选择可用的论文来源。');
  }
  const pageSize = input.pageSize ?? 20;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 40 || !Number.isInteger(offset) || offset < 0 || offset > 5000) {
    throw new PaperSearchError('检索分页参数无效。');
  }
  const filters = input.filters ?? {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !['yearFrom', 'yearTo', 'publicationType', 'openAccessOnly'].includes(key))) throw new PaperSearchError('筛选参数无效。');
  for (const key of ['yearFrom', 'yearTo']) if (filters[key] !== undefined && filters[key] !== null && (!Number.isInteger(filters[key]) || filters[key] < 1800 || filters[key] > 2100)) throw new PaperSearchError('年份需在 1800–2100 内。');
  if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) throw new PaperSearchError('起始年份不能晚于结束年份。');
  if (filters.publicationType && !['journal', 'conference', 'preprint'].includes(filters.publicationType)) throw new PaperSearchError('论文类型无效。');
  if (filters.openAccessOnly !== undefined && typeof filters.openAccessOnly !== 'boolean') throw new PaperSearchError('开放获取筛选无效。');
  return { query, sources: [...new Set(sources)], pageSize, offset, ranking: normalizeRankingFilter(input.ranking || {}), filters: {
    yearFrom: filters.yearFrom || null, yearTo: filters.yearTo || null, publicationType: filters.publicationType || '', openAccessOnly: filters.openAccessOnly === true
  } };
}

function matchesFilters(candidate, filters) {
  if (filters.yearFrom && (!candidate.year || candidate.year < filters.yearFrom)) return false;
  if (filters.yearTo && (!candidate.year || candidate.year > filters.yearTo)) return false;
  if (filters.publicationType && candidate.publicationType !== filters.publicationType) return false;
  if (filters.openAccessOnly && candidate.isOpenAccess !== true) return false;
  return true;
}

export async function loadPaperSearches(projectId) {
  const root = await getProjectRoot(projectId);
  const meta = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
  const history = await readHubJson(projectId, FILE, () => ({ sessions: [] }));
  return { projectName: typeof meta.name === 'string' ? meta.name : '', sessions: history.sessions, sources: listResearchSourceAdapters() };
}

/** Shared search command. It never selects a manuscript or writes bibliography files. */
export async function searchProjectPapers(projectId, input, { signal, search = searchResearchSources, beforeRequest, beforePersist } = {}) {
  await getProjectRoot(projectId);
  const criteria = normalizeSearchInput(input);
  signal?.throwIfAborted();
  const catalogs = await loadRankingCatalogs(projectId);
  const result = await search({ queries: [criteria.query], sources: criteria.sources, maxResults: criteria.pageSize + 1, offset: criteria.offset, filters: criteria.filters, signal, beforeRequest });
  signal?.throwIfAborted();
  const candidates = mergeSourceCandidates(result.batches.flatMap(batch => batch.candidates.slice(0, criteria.pageSize).filter(candidate => matchesFilters(candidate, criteria.filters))));
  const ranked = applyPaperRankings(candidates, catalogs.catalogs, criteria.ranking);
  const session = {
    id: randomUUID(), projectId, createdAt: new Date().toISOString(), criteria,
    status: result.failures.length ? (result.batches.length ? 'partial' : 'failed') : 'completed',
    candidates: ranked.candidates, failures: result.failures, rankingCoverage: { ...ranked.coverage, catalogVersion: catalogs.version },
    sourceResults: result.batches.map(batch => ({ source: batch.source || null, retrievedAt: batch.retrievedAt || null, total: batch.total ?? null, filterMode: batch.filterMode || 'batch', received: Math.min(batch.candidates.length, criteria.pageSize), matched: batch.candidates.slice(0, criteria.pageSize).filter(candidate => matchesFilters(candidate, criteria.filters)).length })),
    nextOffset: criteria.offset < 5000 && result.batches.some(batch => batch.candidates.length > criteria.pageSize)
      ? Math.min(5000, criteria.offset + criteria.pageSize) : null
  };
  session.candidates = session.candidates.map(candidate => ({ ...candidate, searchSessionIds: [session.id], sourceRecords: (candidate.sourceRecords || []).map(record => ({ ...record, searchSessionId: session.id })) }));
  await withHubLock(projectId, async () => {
    signal?.throwIfAborted();
    const history = await readHubJson(projectId, FILE, () => ({ sessions: [] }));
    const sessions = [session, ...history.sessions].slice(0, HISTORY_LIMIT);
    while (sessions.length > 1 && Buffer.byteLength(JSON.stringify(sessions)) > 8 * 1024 * 1024) sessions.pop();
    await beforePersist?.();
    signal?.throwIfAborted();
    await writeHubJson(projectId, FILE, { schemaVersion: 1, sessions });
  });
  return session;
}
