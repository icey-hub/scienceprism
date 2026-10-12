import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getProjectRoot } from './projectService.js';
import { listResearchSourceAdapters, searchResearchSources } from './researchSources/index.js';
import { readHubJson, withHubLock, writeHubJson } from './projectHub/repository.js';

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
  return { query, sources: [...new Set(sources)], pageSize, offset };
}

export async function loadPaperSearches(projectId) {
  const root = await getProjectRoot(projectId);
  const meta = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
  const history = await readHubJson(projectId, FILE, () => ({ sessions: [] }));
  return { projectName: typeof meta.name === 'string' ? meta.name : '', sessions: history.sessions, sources: listResearchSourceAdapters() };
}

/** Shared search command. It never selects a manuscript or writes bibliography files. */
export async function searchProjectPapers(projectId, input, { signal, search = searchResearchSources } = {}) {
  await getProjectRoot(projectId);
  const criteria = normalizeSearchInput(input);
  signal?.throwIfAborted();
  const result = await search({ queries: [criteria.query], sources: criteria.sources, maxResults: criteria.pageSize + 1, offset: criteria.offset, signal });
  signal?.throwIfAborted();
  const candidates = result.batches.flatMap(batch => batch.candidates.slice(0, criteria.pageSize));
  const session = {
    id: randomUUID(), projectId, createdAt: new Date().toISOString(), criteria,
    status: result.failures.length ? (result.batches.length ? 'partial' : 'failed') : 'completed',
    candidates, failures: result.failures,
    nextOffset: criteria.offset < 5000 && result.batches.some(batch => batch.candidates.length > criteria.pageSize)
      ? Math.min(5000, criteria.offset + criteria.pageSize) : null
  };
  await withHubLock(projectId, async () => {
    signal?.throwIfAborted();
    const history = await readHubJson(projectId, FILE, () => ({ sessions: [] }));
    await writeHubJson(projectId, FILE, { schemaVersion: 1, sessions: [session, ...history.sessions].slice(0, HISTORY_LIMIT) });
  });
  return session;
}
