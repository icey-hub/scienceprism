import { extractArxivId, fetchArxivEntry, buildArxivBibtex } from '../services/arxivService.js';
import { arxivSourceAdapter } from '../services/researchSources/arxivAdapter.js';
import { searchWithAdapter } from '../services/researchSources/sourceAdapter.js';

export function registerArxivRoutes(fastify) {
  fastify.post('/api/arxiv/search', async (req) => {
    const { query, maxResults } = req.body || {};
    if (!query || !String(query).trim()) {
      return { ok: false, error: 'Missing query.' };
    }
    const max = Math.min(10, Math.max(1, Number(maxResults) || 5));
    try {
      const result = await searchWithAdapter(arxivSourceAdapter, { query: String(query), maxResults: max });
      return { ok: true, papers: result.candidates };
    } catch (error) {
      return { ok: false, error: error.message || 'arXiv search failed.' };
    }
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
