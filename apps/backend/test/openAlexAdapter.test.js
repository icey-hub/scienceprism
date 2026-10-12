import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAlexAdapter, normalizeOpenAlexWork } from '../src/services/researchSources/openAlexAdapter.js';
import { mergeSourceCandidates } from '../src/services/researchSources/candidateIdentity.js';
import { searchResearchSources, registerResearchSourceAdapter } from '../src/services/researchSources/index.js';

const work = n => ({ id: `https://openalex.org/W${n}`, title: `Paper ${n}`, doi: `https://doi.org/10.1234/${n}`, publication_year: 2024, type: 'article', authorships: [{ author: { display_name: 'A Researcher' } }], primary_location: { source: { display_name: 'Test Journal', type: 'journal', issn: ['1234-5678'] } }, open_access: { is_oa: true }, best_oa_location: { is_oa: true, pdf_url: 'https://arxiv.org/pdf/2401.01234', version: 'submittedVersion', license: 'cc-by' }, abstract_inverted_index: { 'Test': [0], 'abstract.': [1] } });
test('OpenAlex preserves identifiers, publication/OA metadata and provenance without guessing peer review', () => {
  const result = normalizeOpenAlexWork(work(1));
  assert.equal(result.doi, '10.1234/1'); assert.equal(result.abstract, 'Test abstract.');
  assert.equal(result.publicationType, 'journal'); assert.equal(result.peerReviewed, null);
  assert.equal(result.oaVersion, 'submittedVersion'); assert.deepEqual(result.issns, ['1234-5678']);
  assert.equal(result.sourceRecord.metadata.oaLocation.license, 'cc-by');
});
test('offset pagination crosses upstream boundaries without gaps; filters and key stay in supported fields', async () => {
  const calls = [];
  const adapter = createOpenAlexAdapter({ apiKey: () => 'test-secret', fetchImpl: async (address, options) => {
    const url = new URL(address); calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-secret'); assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.has('api_key'), false);
    const page = Number(url.searchParams.get('page'));
    return Response.json({ meta: { count: 210 }, results: Array.from({ length: 100 }, (_, i) => work((page - 1) * 100 + i)) });
  } });
  const result = await adapter.search({ query: 'neural networks', maxResults: 21, offset: 90, filters: { yearFrom: 2020, yearTo: 2024, publicationType: 'journal', openAccessOnly: true } });
  assert.deepEqual(result.candidates.map(paper => paper.id), Array.from({ length: 21 }, (_, i) => `https://openalex.org/W${90 + i}`));
  assert.equal(result.total, 210); assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('filter'), 'from_publication_date:2020-01-01,to_publication_date:2024-12-31,type:article,primary_location.source.type:journal,open_access.is_oa:true');
});
test('upstream rate limit enforces a cooldown without retrying and cancellation stops the second page', async () => {
  let now = 1000, calls = 0;
  const adapter = createOpenAlexAdapter({ now: () => now, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '10' } }); } });
  await assert.rejects(adapter.search({ query: 'x' }), { code: 'SOURCE_RATE_LIMITED' });
  await assert.rejects(adapter.search({ query: 'x' }), { code: 'SOURCE_RATE_LIMITED' }); assert.equal(calls, 1);
  now += 10001; await assert.rejects(adapter.search({ query: 'x' }), { code: 'SOURCE_RATE_LIMITED' }); assert.equal(calls, 2);
  const controller = new AbortController(); calls = 0;
  const cancelled = createOpenAlexAdapter({ fetchImpl: async () => { calls++; controller.abort(); return Response.json({ meta: { count: 210 }, results: Array.from({ length: 100 }, (_, i) => work(i)) }); } });
  await assert.rejects(cancelled.search({ query: 'x', offset: 90, maxResults: 21, signal: controller.signal }), { code: 'SOURCE_CANCELLED' }); assert.equal(calls, 1);
});
test('one provider failing keeps other results and records a structured failure', async () => {
  registerResearchSourceAdapter({ id: 'fixture-ok', search: async () => [work(1)] });
  registerResearchSourceAdapter({ id: 'fixture-fail', search: async () => { throw new Error('unavailable'); } });
  const result = await searchResearchSources({ queries: ['x'], sources: ['fixture-fail', 'fixture-ok'] });
  assert.equal(result.batches.length, 1); assert.equal(result.batches[0].source, 'fixture-ok');
  assert.equal(result.failures[0].source, 'fixture-fail');
});
test('deduplication uses exact identifiers; similar titles with distinct DOIs remain separate', () => {
  const candidates = [
    { id: '1', source: 'first', title: 'Same title', doi: '10.1/a', sourceRecord: { provider: 'first', id: '1' } },
    { id: '2', source: 'second', title: 'Same title', doi: '10.1/a', sourceRecord: { provider: 'second', id: '2' } },
    { id: '3', source: 'second', title: 'Same title', doi: '10.1/b' }
  ];
  const result = mergeSourceCandidates(candidates);
  assert.equal(result.length, 2); assert.equal(result[0].sourceRecords.length, 2);
  assert.equal(candidates[0].sourceRecords, undefined);
});
