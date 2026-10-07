import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaper, paperKey, sourceCheckFor } from '../src/services/projectHub/paperNormalization.js';

test('paper identity retains arXiv, DOI, URL and title precedence', () => {
  assert.equal(paperKey({ arxivId: 'https://arxiv.org/pdf/2401.01234v3.pdf', doi: '10.1/other' }), 'arxiv:2401.01234');
  assert.equal(paperKey({ metadata: { arxivId: '2401.01234v1' } }), 'arxiv:2401.01234');
  assert.equal(paperKey({ doi: 'https://doi.org/10.1000/ABC', url: 'https://example.org/other' }), 'doi:10.1000/abc');
  assert.equal(paperKey({ url: 'https://EXAMPLE.org/Paper/?query=yes#page' }), 'url:https://example.org/paper');
  assert.equal(paperKey({ title: '  A   Paper ', year: 2024 }), 'title:a paper:2024');
  assert.equal(paperKey({}), '');
});

test('metadata updates preserve human annotations, evidence, citation and import identity', () => {
  const original = normalizePaper({ id: 'stable-paper', title: 'Original title', authors: ['A Researcher'], arxivId: '2401.01234v1', source: 'arxiv', notes: 'Human note', tags: ['review'], favorite: true, readingStatus: 'reading', evidenceId: 'evidence-stable', bibtex: '@article{humanKey}', annotations: [{ id: 'note-1', text: 'Human annotation', quote: 'Original quote', page: 3 }] });
  const updated = normalizePaper({ title: 'Revised title', arxivId: '2401.01234v2', authors: ['A Researcher', 'B Researcher', 'A Researcher'] }, { existing: original });
  for (const key of ['id', 'evidenceId', 'notes', 'tags', 'favorite', 'readingStatus', 'bibtex', 'annotations', 'importedAt', 'createdAt', 'canonicalKey', 'sourceCheck']) assert.deepEqual(updated[key], original[key], key);
  assert.deepEqual(updated.authors, ['A Researcher', 'B Researcher']);
  assert.equal(updated.sourceRecords.length, 2);
  assert.deepEqual(updated.sourceRecords.map(record => record.id), ['2401.01234v1', '2401.01234v2']);
});

test('source checked remains a metadata completeness result with explicit missing fields', () => {
  assert.deepEqual(sourceCheckFor({}).issues, ['missing-title', 'missing-authors', 'missing-source-location']);
  assert.equal(sourceCheckFor({ title: 'Title', authors: ['Author'], doi: '10.1000/unverified' }).status, 'checked');
  const paper = normalizePaper({ title: 'Title', authors: ['Author'], url: 'https://example.org/paper' });
  assert.match(paper.bibtex, /@article\{author/);
  assert.equal(paper.sourceCheck.status, 'checked');
  assert.equal(paper.evidenceId, null);
});
