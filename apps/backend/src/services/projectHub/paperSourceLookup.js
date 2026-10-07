import { lookupDoi, parseDoi, PaperSourceLookupError } from '../researchSources/doiLookup.js';
import { lookupArxiv, parseArxiv } from '../researchSources/arxivLookup.js';
import { listPapers, paperRevision } from './paperLibrary.js';
import { sourceConfirmations } from './paperSourceConfirmation.js';

const comparableFields = ['title', 'authors', 'year', 'venue', 'url'];

function sourceInput(input) {
  const hasDoi = Object.hasOwn(input || {}, 'doi');
  const hasArxiv = Object.hasOwn(input || {}, 'arxivId');
  if (hasDoi === hasArxiv) {
    throw new PaperSourceLookupError('INVALID_SOURCE_INPUT', 'Provide exactly one of doi or arxivId.', 400);
  }
  if (hasDoi) return { provider: 'doi', value: parseDoi(input.doi) };
  return { provider: 'arxiv', value: parseArxiv(input.arxivId) };
}

function localMatches(paper, source) {
  if (source.provider === 'doi') {
    try { return paper.doi && parseDoi(paper.doi) === source.value; } catch { return false; }
  }
  try { return paper.arxivId && parseArxiv(paper.arxivId).arxivId === source.value.arxivId; } catch { return false; }
}

function conflictsFor(paper, result) {
  const conflicts = comparableFields.flatMap((field) => {
    const local = paper[field] ?? null;
    const external = result.candidate[field] ?? null;
    return JSON.stringify(local) === JSON.stringify(external) ? [] : [{ field, local, external }];
  });
  if (result.provider === 'arxiv') {
    const localVersions = new Set();
    const recordedIds = (paper.sourceRecords || []).flatMap((record) => {
      let samePaper = false;
      try { samePaper = parseArxiv(record.id).arxivId === result.identifier; } catch { /* Other provider. */ }
      const version = samePaper && /^v[1-9]\d*$/i.test(record.externalVersion || '')
        ? `${result.identifier}${record.externalVersion}` : record.externalVersion;
      return [record.id, version];
    });
    for (const value of [paper.arxivId, paper.url, ...recordedIds]) {
      try {
        const parsed = parseArxiv(value);
        if (parsed.arxivId === result.identifier && parsed.version) localVersions.add(parsed.version);
      } catch { /* Legacy records may contain other providers or no version. */ }
    }
    if (!localVersions.size || [...localVersions].some((version) => version !== result.externalVersion)) {
      conflicts.push({ field: 'externalVersion', local: [...localVersions], external: result.externalVersion });
    }
  }
  return conflicts;
}

export async function lookupPaperSource(projectId, input, { lookup, doiLookup = lookupDoi, arxivLookup = lookupArxiv, confirmations = sourceConfirmations, signal } = {}) {
  const source = sourceInput(input);
  const papers = await listPapers(projectId, { limit: 5000 });
  const selectedLookup = lookup || (source.provider === 'doi' ? doiLookup : arxivLookup);
  const result = await selectedLookup(source.provider === 'doi' ? source.value : source.value.identifier, { signal });
  const matches = papers.filter((paper) => localMatches(paper, source)).map((paper) => ({
    paperId: paper.id,
    revision: paperRevision(paper),
    conflicts: conflictsFor(paper, result)
  }));
  const preview = { ...result, matches, writesPerformed: false };
  return { ...preview, ...confirmations.remember(projectId, preview) };
}
