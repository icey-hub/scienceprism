import { normalizeIssn, normalizeRankingFilter, object, PaperRankingError, parseRankingCsv, venueKey } from './validation.js';
import { createPaperRankingRepository } from './repository.js';

const active = catalogs => catalogs.filter(catalog => !catalog.supersededBy);

/** Match only asserted publication identities; paper year is not a catalog edition selector. */
export function annotatePaperRankings(candidates, catalogs) {
  if (!Array.isArray(candidates) || candidates.length > 500 || !Array.isArray(catalogs)) {
    throw new PaperRankingError('RANKING_INVALID_INPUT', '单次分级匹配最多接受 500 篇论文。');
  }
  const byIssn = new Map(); const byVenue = new Map(); const ambiguityCache = new Map();
  const scopeKey = entry => JSON.stringify([entry.catalog.scheme, entry.catalog.editionYear, venueKey(entry.record.subject)]);
  const add = (map, key, value) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const catalog of active(catalogs)) for (const record of catalog.records) {
    const entry = { catalog, record };
    for (const issn of record.issns) add(byIssn, issn, entry);
    add(byVenue, venueKey(record.venue), entry);
  }
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new PaperRankingError('RANKING_INVALID_INPUT', '论文匹配参数无效。');
    const issns = new Set((Array.isArray(candidate.issns) ? candidate.issns : [candidate.issn]).map(normalizeIssn).filter(Boolean));
    const matches = new Map();
    for (const issn of issns) for (const entry of byIssn.get(issn) || []) matches.set(entry, 'issn');
    const name = venueKey(candidate.venue); const venueEntries = byVenue.get(name) || [];
    if (!issns.size && venueEntries.length > 1000) throw new PaperRankingError('RANKING_MATCH_LIMIT', '该发表载体对应超过 1000 条分级，请缩小导入目录范围。', 413);
    if (!issns.size && !ambiguityCache.has(name)) {
      const groups = new Map();
      for (const entry of venueEntries) { const key = scopeKey(entry); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); }
      const ambiguous = new Map();
      for (const [key, entries] of groups) {
        const identities = [];
        for (const entry of entries) {
          if (!entry.record.issns.length) continue;
          const joined = new Set(entry.record.issns);
          for (let i = identities.length - 1; i >= 0; i--) if ([...identities[i]].some(issn => joined.has(issn))) {
            for (const issn of identities[i]) joined.add(issn); identities.splice(i, 1);
          }
          identities.push(joined);
        }
        if (identities.length > 1) ambiguous.set(key, { code: 'ambiguous-venue', scheme: entries[0].catalog.scheme, editionYear: entries[0].catalog.editionYear, subject: entries[0].record.subject });
      }
      ambiguityCache.set(name, ambiguous);
    }
    const ambiguous = !issns.size ? ambiguityCache.get(name) : new Map();
    for (const entry of venueEntries) {
      if (!ambiguous.has(scopeKey(entry)) && !matches.has(entry) && (!issns.size || !entry.record.issns.length)) matches.set(entry, 'venue');
    }
    if (matches.size > 1000) throw new PaperRankingError('RANKING_MATCH_LIMIT', '该发表载体对应超过 1000 条分级，请缩小导入目录范围。', 413);
    const rankings = [...matches].map(([{ catalog, record }, matchedBy]) => ({
      scope: 'venue', catalogId: catalog.id, catalogLabel: catalog.label, scheme: catalog.scheme, editionYear: catalog.editionYear,
      subject: record.subject, rank: record.rank, venue: record.venue, issns: [...record.issns],
      provenance: { ...catalog.provenance }, importedAt: catalog.importedAt, matchedBy
    })).sort((a, b) => a.scheme.localeCompare(b.scheme) || b.editionYear - a.editionYear || a.subject.localeCompare(b.subject));
    return { ...candidate, rankings, rankingIssues: [...ambiguous.values()] };
  });
}

function inScope(ranking, filter) {
  return (!filter.scheme || ranking.scheme === filter.scheme)
    && (!filter.editionYear || ranking.editionYear === filter.editionYear)
    && (!filter.subject || venueKey(ranking.subject) === venueKey(filter.subject));
}

/** Coverage describes available ranking metadata in this retrieved batch, before rank filtering. */
export function filterPaperRankings(candidates, input = {}) {
  const filter = normalizeRankingFilter(input);
  const unmatched = []; const filtered = []; let matched = 0;
  for (const candidate of candidates) {
    const scoped = (candidate.rankings || []).filter(ranking => inScope(ranking, filter));
    const known = scoped.length > 0;
    const ambiguous = (candidate.rankingIssues || []).some(issue => issue.code === 'ambiguous-venue' && inScope(issue, filter));
    if (known) matched++;
    else unmatched.push({ id: candidate.id || null, venue: typeof candidate.venue === 'string' ? candidate.venue : '',
      reason: ambiguous ? 'ambiguous-venue' : !venueKey(candidate.venue) && !(Array.isArray(candidate.issns) ? candidate.issns : []).some(normalizeIssn) && !normalizeIssn(candidate.issn) ? 'missing-venue' : 'not-in-catalog' });
    const include = known ? filter.unknown !== 'only' && (!filter.ranks.length || scoped.some(ranking => filter.ranks.includes(ranking.rank))) : filter.unknown !== 'exclude';
    if (include) filtered.push({ ...candidate, rankingStatus: known ? 'known' : 'unknown' });
  }
  return { candidates: filtered, filters: filter, coverage: {
    scope: 'retrieved-batch', total: candidates.length, matched, unmatched: candidates.length - matched,
    ratio: candidates.length ? matched / candidates.length : null, returned: filtered.length, unmatchedPapers: unmatched
  } };
}

export function applyPaperRankings(candidates, catalogs, filter = {}) {
  const result = filterPaperRankings(annotatePaperRankings(candidates, catalogs), filter);
  result.coverage.catalogCount = active(catalogs).filter(catalog => (!result.filters.scheme || catalog.scheme === result.filters.scheme)
    && (!result.filters.editionYear || catalog.editionYear === result.filters.editionYear)).length;
  if (!result.coverage.catalogCount) for (const paper of result.coverage.unmatchedPapers) paper.reason = 'no-catalog';
  return result;
}

export function rankingCatalogSummary(catalog) {
  const { records, ...metadata } = catalog;
  return { ...metadata, recordCount: records.length, subjects: [...new Set(records.map(record => record.subject))].sort(),
    ranks: [...new Set(records.map(record => record.rank))].sort(),
    venueNameCount: new Set(records.map(record => venueKey(record.venue)).filter(Boolean)).size,
    issnCount: new Set(records.flatMap(record => record.issns)).size };
}

export function createPaperRankingsService({ repository = createPaperRankingRepository() } = {}) {
  async function list(projectId) {
    const index = await repository.read(projectId);
    return { version: index.version, catalogs: index.catalogs.map(rankingCatalogSummary) };
  }
  async function importCatalog(projectId, input) {
    let payload = input;
    if (input && typeof input === 'object' && Object.hasOwn(input, 'csv')) {
      if (Object.hasOwn(input, 'records')) throw new PaperRankingError('RANKING_INVALID_INPUT', '请提供 records 或 csv 中的一项。');
      const { csv, ...metadata } = input; payload = { ...metadata, records: parseRankingCsv(csv) };
    }
    const result = await repository.importCatalog(projectId, payload);
    return { ...result, catalog: rankingCatalogSummary(result.catalog) };
  }
  async function get(projectId, id, { offset = 0, limit = 100 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new PaperRankingError('RANKING_INVALID_INPUT', '目录分页参数无效。');
    const index = await repository.read(projectId); const catalog = index.catalogs.find(item => item.id === id);
    if (!catalog) throw new PaperRankingError('RANKING_CATALOG_NOT_FOUND', '项目内不存在此分级目录。', 404);
    return { version: index.version, catalog: rankingCatalogSummary(catalog), records: catalog.records.slice(offset, offset + limit), pagination: { offset, limit, total: catalog.records.length } };
  }
  async function match(projectId, input) {
    object(input, '论文匹配', ['candidates', 'filters']);
    const index = await repository.read(projectId);
    return { version: index.version, ...applyPaperRankings(input.candidates, index.catalogs, input.filters) };
  }
  return { load: repository.read, list, importCatalog, get, match };
}

const service = createPaperRankingsService();
export const loadRankingCatalogs = projectId => service.load(projectId);
export const listRankingCatalogs = projectId => service.list(projectId);
export const importRankingCatalog = (projectId, input) => service.importCatalog(projectId, input);
