const text = value => typeof value === 'string' ? value.trim() : '';
export function sourceIdentityKeys(candidate) {
  const keys = [];
  const doi = text(candidate.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  const arxiv = text(candidate.arxivId).replace(/v\d+$/i, '').toLowerCase();
  if (doi) keys.push(`doi:${doi}`);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  if (candidate.source && candidate.id) keys.push(`${candidate.source}:${candidate.id}`);
  return keys;
}
export function mergeSourceCandidates(candidates) {
  const merged = [];
  for (const candidate of candidates) {
    const keys = sourceIdentityKeys(candidate);
    const existing = merged.find(value => {
      if (value.doi && candidate.doi && value.doi.toLowerCase() !== candidate.doi.toLowerCase()) return false;
      return sourceIdentityKeys(value).some(key => keys.includes(key));
    });
    const records = candidate.sourceRecords || [candidate.sourceRecord || { provider: candidate.source, id: candidate.id, retrievedAt: candidate.retrievedAt }];
    if (!existing) { merged.push({ ...candidate, sourceRecords: records }); continue; }
    for (const [key, value] of Object.entries(candidate)) if (existing[key] === undefined || existing[key] === null || existing[key] === '') existing[key] = value;
    existing.sourceRecords = [...new Map([...existing.sourceRecords, ...records].map(record => [`${record.provider}:${record.id}`, record])).values()];
  }
  return merged;
}
