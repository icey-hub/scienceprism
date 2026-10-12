import { normalizePaperCandidate } from './qualityGate.js';
import { mergeSourceCandidates, sourceIdentityKeys } from '../researchSources/candidateIdentity.js';

/** Compatibility exports use the same exact identities as project search. */
export function paperIdentityKeys(input) {
  return sourceIdentityKeys(normalizePaperCandidate(input));
}

export function mergePaperCandidates(records = []) {
  return mergeSourceCandidates((Array.isArray(records) ? records : []).map(normalizePaperCandidate))
    .map(paper => ({ ...paper, identityKeys: sourceIdentityKeys(paper) }));
}

export function validatePaperMetadata(input) {
  const paper = normalizePaperCandidate(input);
  const required = ['title', 'authors', 'year', 'abstract', 'url'];
  const missing = required.filter((field) => {
    const value = paper[field];
    return Array.isArray(value) ? value.length === 0 : value === null || value === undefined || value === '';
  });
  return {
    ok: missing.length === 0,
    missing,
    verifiedFields: required.filter((field) => !missing.includes(field)),
    sourceCount: Array.isArray(input?.sourceRecords) ? input.sourceRecords.length : (input?.source ? 1 : 0),
    warnings: missing.length ? ['Metadata is incomplete and requires human verification.'] : []
  };
}

export function prioritizePaperCandidates(records = [], { sourcePriorities = {} } = {}) {
  return [...records].sort((left, right) => {
    const leftPriority = Number(sourcePriorities[left.source] ?? 0) + Number(left.sourceCount || 0);
    const rightPriority = Number(sourcePriorities[right.source] ?? 0) + Number(right.sourceCount || 0);
    return rightPriority - leftPriority || String(left.title || '').localeCompare(String(right.title || ''));
  });
}
