const text = value => typeof value === 'string' ? value.trim() : '';
export function normalizedDoiIdentity(value) {
  return text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
}
export function normalizedArxivIdentity(value) {
  return text(value).replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/^arxiv:\s*/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
}
function arxivIdentity(candidate) {
  if (text(candidate.arxivId)) return normalizedArxivIdentity(candidate.arxivId);
  if (/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i.test(text(candidate.url))) return normalizedArxivIdentity(candidate.url);
  return '';
}
export function sourceIdentityKeys(candidate) {
  const keys = [];
  const doi = normalizedDoiIdentity(candidate.doi);
  const arxiv = arxivIdentity(candidate);
  if (doi) keys.push(`doi:${doi}`);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  const provider = typeof candidate.source === 'object' ? text(candidate.source?.provider) : text(candidate.source);
  if (provider && text(candidate.id) && !text(candidate.id).startsWith('paper-')) keys.push(`source:${provider}:${candidate.id}`);
  try {
    const url = new URL(candidate.url);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      url.hash = '';
      keys.push(`url:${url.toString().replace(/\/$/, '')}`);
    }
  } catch { /* Titles and malformed URLs are never identity evidence. */ }
  return [...new Set(keys)];
}
/** Conflicting persistent identifiers win over matching weaker source keys. */
export function papersShareIdentity(left, right) {
  const leftDoi = normalizedDoiIdentity(left.doi), rightDoi = normalizedDoiIdentity(right.doi);
  const leftArxiv = arxivIdentity(left), rightArxiv = arxivIdentity(right);
  if (leftDoi && rightDoi && leftDoi !== rightDoi) return false;
  if (leftArxiv && rightArxiv && leftArxiv !== rightArxiv) return false;
  if (/^paper-[a-f0-9-]{36}$/i.test(text(left.id)) && left.id === right.id) return true;
  const keys = sourceIdentityKeys(right);
  return sourceIdentityKeys(left).some(key => keys.includes(key));
}
export function findMatchingPapers(papers, candidate) {
  return papers.filter(paper => papersShareIdentity(paper, candidate));
}
export function mergeSourceRecords(...groups) {
  const records = groups.flat().filter(record => record && typeof record === 'object' && !Array.isArray(record));
  return [...new Map(records.map(record => [JSON.stringify([record.provider || '', record.id || '', record.url || '', record.externalVersion || '', record.searchSessionId || '']), { ...record }])).values()];
}
export function searchSessionCandidates(session) {
  return session.candidates.map(candidate => ({ ...candidate,
    searchSessionIds: [...new Set([...(candidate.searchSessionIds || []), session.id])],
    sourceRecords: mergeSourceRecords(candidate.sourceRecords?.length ? candidate.sourceRecords : [candidate.sourceRecord || {
      provider: candidate.source, id: candidate.id, retrievedAt: candidate.retrievedAt
    }]).map(record => ({ ...record, searchSessionId: session.id }))
  }));
}
export function mergeSourceCandidates(candidates) {
  const merged = [];
  for (const candidate of candidates) {
    const matches = findMatchingPapers(merged, candidate);
    // Ambiguous bridges remain separate instead of choosing by provider order.
    const existing = matches.length === 1 ? matches[0] : null;
    const records = mergeSourceRecords(candidate.sourceRecords?.length ? candidate.sourceRecords : [candidate.sourceRecord || { provider: candidate.source, id: candidate.id, retrievedAt: candidate.retrievedAt }]);
    if (!existing) { merged.push({ ...candidate, sourceRecords: records, sourceCount: records.length }); continue; }
    for (const [key, value] of Object.entries(candidate)) if (existing[key] === undefined || existing[key] === null || existing[key] === '' || (Array.isArray(existing[key]) && !existing[key].length)) existing[key] = value;
    existing.sourceRecords = mergeSourceRecords(existing.sourceRecords, records);
    existing.searchSessionIds = [...new Set([...(existing.searchSessionIds || []), ...(candidate.searchSessionIds || [])])];
    existing.sourceCount = existing.sourceRecords.length;
  }
  return merged;
}
