import { randomUUID } from 'node:crypto';
import { PaperSourceLookupError } from '../researchSources/doiLookup.js';
import { importPaper } from './paperLibrary.js';

// Snapshots are deliberately process-local: expiry, eviction or restart requires
// a fresh preview. Confirmation never refetches a potentially newer version.
const FIELDS = ['title', 'authors', 'year', 'venue', 'url', 'abstract'];
export function createSourceConfirmations({ now = Date.now, ttlMs = 15 * 60_000, maxEntries = 64, maxBytes = 8 * 1024 * 1024, save = importPaper } = {}) {
  const snapshots = new Map();
  let bytes = 0;
  function remove(token) {
    const entry = snapshots.get(token);
    if (entry) { snapshots.delete(token); bytes -= entry.bytes; }
  }
  function prune() {
    for (const [token, entry] of snapshots) if (entry.expiresAt <= now() && !entry.pending) remove(token);
  }
  function remember(projectId, result) {
    prune();
    const json = JSON.stringify(result);
    const size = Buffer.byteLength(json);
    if (size > maxBytes) throw new PaperSourceLookupError('SOURCE_PREVIEW_TOO_LARGE', 'Source preview exceeds the confirmation cache capacity.', 413);
    for (const [token, entry] of snapshots) {
      if (snapshots.size < maxEntries && bytes + size <= maxBytes) break;
      if (!entry.pending) remove(token);
    }
    if (snapshots.size >= maxEntries || bytes + size > maxBytes) throw new PaperSourceLookupError('SOURCE_PREVIEW_BUSY', 'Source confirmations are busy. Preview again later.', 503);
    const previewToken = randomUUID();
    const expiresAt = now() + ttlMs;
    snapshots.set(previewToken, { projectId, result: JSON.parse(json), bytes: size, expiresAt, pending: false });
    bytes += size;
    return { previewToken, expiresAt: new Date(expiresAt).toISOString(), allowedFields: FIELDS.filter((field) => Object.hasOwn(result.candidate, field)) };
  }
  async function confirm(projectId, request = {}, { actor = 'human' } = {}) {
    prune();
    const { previewToken, action, paperId = null, fields = [] } = request;
    if (Object.keys(request).some((key) => !['previewToken', 'action', 'paperId', 'fields'].includes(key))
      || typeof previewToken !== 'string' || !['create', 'keep', 'merge'].includes(action)
      || (paperId !== null && typeof paperId !== 'string') || !Array.isArray(fields)
      || fields.some((field) => !FIELDS.includes(field)) || new Set(fields).size !== fields.length
      || (action !== 'merge' && fields.length)) {
      throw new PaperSourceLookupError('INVALID_SOURCE_DECISION', 'Use a preview token and an explicit create, keep or selected-field merge decision.', 400);
    }
    const entry = snapshots.get(previewToken);
    if (!entry || entry.projectId !== projectId || entry.expiresAt <= now()) throw new PaperSourceLookupError('SOURCE_PREVIEW_EXPIRED', 'Source preview expired or is unavailable. Preview again.', 409);
    if (entry.pending) throw new PaperSourceLookupError('SOURCE_CONFIRMATION_PENDING', 'This preview is already being confirmed.', 409);
    const result = entry.result;
    const target = result.matches.find((match) => match.paperId === paperId);
    if ((action === 'create' && (result.matches.length || paperId !== null))
      || (action === 'merge' && !target) || (paperId !== null && !target)
      || fields.some((field) => !Object.hasOwn(result.candidate, field))) {
      throw new PaperSourceLookupError('INVALID_SOURCE_DECISION', 'Select a matching library record and only fields present in the preview.', 400);
    }
    entry.pending = true;
    try {
      if (action === 'keep') {
        remove(previewToken);
        return { skipped: true, writesPerformed: false };
      }
      const review = {
        id: previewToken, provider: result.provider, identifier: result.identifier,
        retrievedAt: result.retrievedAt, externalVersion: result.externalVersion ?? result.candidate.sourceRecords?.[0]?.externalVersion ?? null,
        record: result.record, checks: result.checks,
        decision: { action, fields: [...fields], actor, at: new Date(now()).toISOString(), scope: 'bibliographic-metadata' }
      };
      const saved = await save(projectId, result.candidate, { actor, confirmation: {
        action, fields, paperId, expectedRevision: target?.revision ?? null,
        sourceIdentity: { field: result.provider === 'arxiv' ? 'arxivId' : 'doi', value: result.identifier },
        sourceMatches: result.matches.map(({ paperId: id, revision }) => ({ paperId: id, revision })), sourceReview: review
      } });
      remove(previewToken);
      return { ...saved, writesPerformed: true };
    } finally { entry.pending = false; }
  }
  return { remember, confirm };
}

export const sourceConfirmations = createSourceConfirmations();
