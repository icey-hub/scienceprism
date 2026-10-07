import { queryArxiv } from './arxivClient.js';

function asText(value) {
  return value === undefined || value === null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function entryToCandidate(entry) {
  const authors = Array.isArray(entry?.author) ? entry.author : [entry?.author].filter(Boolean);
  const url = asText(entry?.id);
  const arxivId = url.split('/').pop() || url;
  return {
    id: arxivId,
    arxivId,
    title: asText(entry?.title),
    abstract: asText(entry?.summary),
    authors: authors.map((author) => asText(author?.name)).filter(Boolean),
    year: entry?.published ? Number(asText(entry.published).slice(0, 4)) : null,
    url,
    source: 'arxiv',
    publicationType: 'preprint',
    peerReviewed: null,
    metadataSource: 'arxiv'
  };
}

export const arxivSourceAdapter = Object.freeze({
  id: 'arxiv',
  label: 'arXiv',
  priority: 10,
  async search({ query, maxResults = 20, signal } = {}) {
    const limit = Math.min(50, Math.max(1, Number(maxResults) || 20));
    const entries = await queryArxiv({ search_query: `all:${query}`, start: 0, max_results: limit }, { signal });
    return entries.map(entryToCandidate);
  }
});

export { entryToCandidate as normalizeArxivEntry };
