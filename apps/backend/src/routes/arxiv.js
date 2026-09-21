import { XMLParser } from 'fast-xml-parser';
import { extractArxivId, fetchArxivEntry, buildArxivBibtex } from '../services/arxivService.js';

export function registerArxivRoutes(fastify) {
  fastify.post('/api/arxiv/search', async (req) => {
    const { query, maxResults } = req.body || {};
    if (!query || !String(query).trim()) {
      return { ok: false, error: 'Missing query.' };
    }
    const max = Math.min(10, Math.max(1, Number(maxResults) || 5));
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(String(query))}&start=0&max_results=${max}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'scienceprism/1.0' } });
    if (!res.ok) {
      return { ok: false, error: `arXiv search failed: ${res.status}` };
    }
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(xml);
    const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : data?.feed?.entry ? [data.feed.entry] : [];
    const papers = entries.map((entry) => {
      const authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
      const authorNames = authors.map((a) => a?.name).filter(Boolean);
      const id = String(entry.id || '');
      const arxivId = id ? id.split('/').pop() : '';
      return {
        title: String(entry.title || '').replace(/\s+/g, ' ').trim(),
        abstract: String(entry.summary || '').replace(/\s+/g, ' ').trim(),
        authors: authorNames,
        url: id,
        arxivId
      };
    });
    return { ok: true, papers };
  });

  fastify.post('/api/arxiv/bibtex', async (req) => {
    const { arxivId } = req.body || {};
    const id = extractArxivId(arxivId);
    if (!id) return { ok: false, error: 'Invalid arXiv ID.' };
    const entry = await fetchArxivEntry(id);
    if (!entry) return { ok: false, error: 'No arXiv metadata found.' };
    return { ok: true, bibtex: buildArxivBibtex(entry), entry };
  });
}
