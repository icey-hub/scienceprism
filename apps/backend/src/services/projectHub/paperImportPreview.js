import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { createHash } from 'node:crypto';
import { importPaper, listPapers, paperRevision } from './paperLibrary.js';
import { normalizePaper, sourceCheckFor } from './paperNormalization.js';

export class PaperImportPreviewError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const MAX_BYTES = 100 * 1024;
const MAX_ENTRIES = 200;
const COMPARED_FIELDS = ['title', 'authors', 'year', 'doi', 'arxivId', 'url', 'venue', 'abstract', 'bibtex', 'citationKey'];

export async function previewPaperImport(projectId, { format = 'bibtex', text } = {}) {
  if (format !== 'bibtex') throw new PaperImportPreviewError('UNSUPPORTED_IMPORT_FORMAT', 'Only BibTeX import is supported.');
  if (typeof text !== 'string' || !text.trim()) throw new PaperImportPreviewError('EMPTY_IMPORT', 'BibTeX text is required.');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new PaperImportPreviewError('IMPORT_TOO_LARGE', 'BibTeX input exceeds 100 KiB.', 413);
  let entries;
  let citations;
  try {
    // Explicit parser selection prevents URL/identifier auto-detection and I/O.
    entries = plugins.input.data(text, '@bibtex/text');
    if (!entries.length) throw new Error('No bibliography entries found.');
    if (entries.length > MAX_ENTRIES) throw new PaperImportPreviewError('TOO_MANY_ENTRIES', 'Import at most 200 entries at a time.');
    citations = new Cite(entries, { forceType: '@bibtex/entries+list' }).data;
  } catch (error) {
    if (error instanceof PaperImportPreviewError) throw error;
    throw new PaperImportPreviewError('INVALID_BIBTEX', `Invalid BibTeX: ${error.message}`);
  }
  const papers = await listPapers(projectId, { limit: 5000 });
  const existingByKey = new Map(papers.map((paper) => [paper.canonicalKey, paper]));
  const batchByKey = new Map();
  const labels = new Set();
  const receivedAt = new Date().toISOString();
  const items = entries.map((entry, index) => {
    const fields = entry.properties;
    const citation = citations[index];
    const arxivId = /^arxiv$/i.test(fields.archiveprefix || fields.eprinttype || '') ? fields.eprint || '' : '';
    // Keep expanded BibTeX fields (including unknown fields and arXiv version),
    // not a lossy CSL export. The exact original batch is returned separately.
    const bibtex = `@${entry.type}{${entry.label},\n${Object.entries(fields).map(([key, value]) => `  ${key} = {${value}}`).join(',\n')}\n}`;
    const input = {
      title: citation.title || '',
      authors: (citation.author || []).map((author) => author.literal || [author.given, author['non-dropping-particle'], author.family, author.suffix].filter(Boolean).join(' ')),
      year: citation.issued?.['date-parts']?.[0]?.[0],
      doi: fields.doi || '', arxivId, url: fields.url || '',
      venue: citation['container-title'] || '', abstract: citation.abstract || '',
      citationKey: entry.label, bibtex, source: 'bibtex',
      sourceRecords: [{ provider: 'bibtex', id: entry.label, receivedAt, externalVersion: arxivId || null }]
    };
    const fieldCheck = sourceCheckFor(input);
    const candidate = normalizePaper(input);
    const existing = existingByKey.get(candidate.canonicalKey);
    const earlier = batchByKey.get(candidate.canonicalKey);
    const duplicates = [
      ...(existing ? [{ scope: 'project', paperId: existing.id }] : []),
      ...(earlier ? [{ scope: 'batch', index: earlier.index }] : [])
    ];
    const conflicts = [];
    for (const [scope, other] of [['project', existing], ['batch', earlier?.candidate]]) {
      if (!other) continue;
      for (const field of COMPARED_FIELDS) {
        if (JSON.stringify(other[field]) !== JSON.stringify(candidate[field])) conflicts.push({ scope, field, existing: other[field] ?? null, incoming: candidate[field] ?? null });
      }
    }
    const warnings = labels.has(entry.label) ? ['duplicate-citation-key'] : [];
    labels.add(entry.label);
    if (!earlier) batchByKey.set(candidate.canonicalKey, { index, candidate });
    return { index, candidate, expectedRevision: paperRevision(existing), duplicates, conflicts, warnings, checks: {
      fields: { status: fieldCheck.issues.length ? 'incomplete' : 'complete', issues: fieldCheck.issues },
      source: { status: 'unverified', reason: 'Imported metadata has not been matched against an external source.' }
    }, requiresDecision: true };
  });
  return { format, originalText: text, inputDigest: createHash('sha256').update(text).digest('hex'), receivedAt, items, count: items.length, writesPerformed: false };
}

export async function confirmPaperImport(projectId, request = {}, { actor = 'human' } = {}) {
  const { index, action, fields = [], expectedRevision, inputDigest } = request;
  if (!Number.isInteger(index) || index < 0 || !['create', 'keep', 'merge'].includes(action)
    || !Array.isArray(fields) || fields.some((field) => !COMPARED_FIELDS.includes(field))
    || (action === 'merge' && !fields.length)
    || (expectedRevision !== null && !/^[a-f0-9]{64}$/.test(expectedRevision || ''))
    || typeof inputDigest !== 'string') {
    throw new PaperImportPreviewError('INVALID_IMPORT_DECISION', 'A preview revision, input digest, entry index, and explicit import decision are required.');
  }
  const preview = await previewPaperImport(projectId, request);
  if (preview.inputDigest !== inputDigest || !preview.items[index]) {
    throw new PaperImportPreviewError('INVALID_IMPORT_DECISION', 'Input changed since preview or entry index is invalid.');
  }
  return importPaper(projectId, preview.items[index].candidate, { actor, confirmation: { action, fields, expectedRevision } });
}
