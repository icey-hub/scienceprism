import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-evidence-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
  checkClaimEvidence,
  validateStageEvidence,
  getClaimEvidenceMatrix,
  getEvidenceGraph,
  getEvidenceImpact,
  getEvidenceLedger,
  linkEvidence,
  upsertEvidence
} = await import('../src/services/evidenceLedger/index.js');
const { registerEvidenceLedgerRoutes } = await import('../src/routes/evidenceLedger.js');
const { runResearchHarnessStage } = await import('../src/services/researchResearch/harnessAdapter.js');
const { initializeResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');

async function createProject(id) {
  const root = path.join(dataDir, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  return root;
}

test('Evidence Ledger persists provenance, relations, and claim support status', async () => {
  const projectId = 'evidence-core';
  await createProject(projectId);
  const paper = await upsertEvidence(projectId, {
    id: 'paper-1',
    kind: 'paper',
    title: 'A verified paper',
    summary: 'Paper abstract excerpt.',
    sourceUrl: 'https://example.test/paper-1',
    acquiredAt: '2026-09-21T00:00:00.000Z',
    verificationStatus: 'human-confirmed',
    version: 'v1'
  });
  const claim = await upsertEvidence(projectId, {
    id: 'claim-1',
    kind: 'paper-claim',
    summary: 'The method improves the reported metric.',
    verificationStatus: 'pending',
    metadata: { evidenceIds: ['paper-1'], confidence: 0.8 },
    evidenceVersions: { 'paper-1': 'v1' }
  });
  await linkEvidence(projectId, { type: 'supports', fromId: 'paper-1', toId: 'claim-1' });

  const matrix = await getClaimEvidenceMatrix(projectId);
  assert.equal(matrix.ok, true);
  assert.equal(matrix.rows[0].status, 'supported');
  assert.equal(matrix.rows[0].evidence[0].source.url, 'https://example.test/paper-1');
  assert.equal(paper.entry.sha256, null);
  assert.equal(claim.entry.verificationStatus, 'pending');

  const graph = await getEvidenceGraph(projectId);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges[0].type, 'supports');
  const impact = await getEvidenceImpact(projectId, 'paper-1');
  assert.deepEqual(impact.affectedClaimIds, ['claim-1']);
});

test('explicit counterevidence remains visible and prevents supported claims in either relation direction', async () => {
  const projectId = 'counterevidence';
  await createProject(projectId);
  await upsertEvidence(projectId, { id: 'support', kind: 'paper', verificationStatus: 'human-confirmed' });
  await upsertEvidence(projectId, { id: 'counter', kind: 'result', summary: 'A counterexample', verificationStatus: 'human-confirmed' });
  for (const id of ['forward', 'reverse', 'ordinary']) {
    await upsertEvidence(projectId, { id, kind: 'paper-claim', summary: id, metadata: { evidenceIds: ['support'] } });
  }
  await linkEvidence(projectId, { type: 'contradicts', fromId: 'counter', toId: 'forward' });
  await linkEvidence(projectId, { type: 'contradicts', fromId: 'reverse', toId: 'counter' });
  await linkEvidence(projectId, { type: 'supports', fromId: 'support', toId: 'ordinary' });
  const before = await getEvidenceLedger(projectId);
  const matrix = await getClaimEvidenceMatrix(projectId);
  assert.equal(matrix.ok, false);
  assert.equal(matrix.needsVerificationClaims, 2);
  assert.equal(matrix.supportedClaims, 1);
  for (const id of ['forward', 'reverse']) {
    const row = matrix.rows.find((item) => item.id === id);
    assert.equal(row.status, 'needs-verification');
    assert.deepEqual(row.contradictingEvidenceIds, ['counter']);
    assert.deepEqual(row.evidenceIds, ['support', 'counter']);
    assert.equal(row.evidence.find((item) => item.id === 'counter').summary, 'A counterexample');
  }
  assert.deepEqual(matrix.rows.find((item) => item.id === 'ordinary').contradictingEvidenceIds, []);
  const output = { claims: [{ id: 'forward', text: 'Overstated claim', evidenceIds: ['support'] }] };
  const checked = await validateStageEvidence(projectId, 'writing', output);
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.errors[0].details.contradictingEvidenceIds, ['counter']);
  const missing = checkClaimEvidence({ ...before, entries: before.entries.filter((entry) => entry.id !== 'counter') }, output.claims);
  assert.equal(missing.rows[0].status, 'unsupported');
  assert.deepEqual(missing.rows[0].missingEvidenceIds, ['counter']);
  assert.deepEqual(missing.rows[0].contradictingEvidenceIds, ['counter']);
  assert.deepEqual(await getEvidenceLedger(projectId), before);
});

test('legacy evidence JSON is migrated into the canonical Ledger shape', async () => {
  const projectId = 'evidence-legacy';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'evidence.json'), JSON.stringify([
    { id: 'legacy-experiment', kind: 'experiment', referenceId: 'run-1', summary: 'Legacy result', source: 'results/run.log', status: 'verified' }
  ]));
  const ledger = await getEvidenceLedger(projectId);
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.entries[0].kind, 'experiment');
  assert.equal(ledger.entries[0].source.path, 'results/run.log');
  assert.equal(ledger.entries[0].metadata.referenceId, 'run-1');
  assert.equal(ledger.entries[0].verificationStatus, 'verified');
});

test('claim matrix detects missing, unverified, and stale evidence', async () => {
  const projectId = 'evidence-integrity';
  await createProject(projectId);
  await upsertEvidence(projectId, { id: 'dataset-1', kind: 'dataset', summary: 'Dataset', verificationStatus: 'pending', version: 'v2' });
  const matrix = await getClaimEvidenceMatrix(projectId, {
    claims: [
      { id: 'claim-missing', text: 'Missing source', evidenceIds: ['does-not-exist'] },
      { id: 'claim-unverified', text: 'Pending source', evidenceIds: ['dataset-1'], evidenceVersions: { 'dataset-1': 'v1' } },
      { id: 'claim-empty', text: 'No source', evidenceIds: [] }
    ]
  });
  assert.equal(matrix.ok, false);
  assert.equal(matrix.unsupportedClaims, 2);
  assert.equal(matrix.needsVerificationClaims, 1);
  assert.deepEqual(matrix.missingEvidenceIds, ['does-not-exist']);
  assert.deepEqual(matrix.staleEvidenceIds, ['dataset-1']);
});

test('material edits invalidate prior confirmation even when the external version stays unchanged', async () => {
  const projectId = 'evidence-material-edits';
  await createProject(projectId);
  const original = { id: 'paper-edit', kind: 'paper', title: 'Paper', summary: 'Original excerpt', sourceUrl: 'https://example.test/v1', version: 'v1', verificationStatus: 'human-confirmed', verifiedAt: '2026-01-01T00:00:00.000Z' };
  await upsertEvidence(projectId, original);
  const claims = [{ id: 'claim-edit', text: 'Claim', evidenceIds: [original.id], evidenceVersions: { [original.id]: 'v1' } }];
  assert.equal((await getClaimEvidenceMatrix(projectId, { claims })).rows[0].status, 'supported');
  const unchanged = await upsertEvidence(projectId, { ...original, tags: ['reading'] });
  assert.equal(unchanged.entry.verificationStatus, 'human-confirmed');
  const changed = await upsertEvidence(projectId, { ...original, summary: 'Corrected excerpt' });
  assert.equal(changed.entry.verificationStatus, 'pending');
  assert.equal(changed.entry.verifiedAt, null);
  assert.equal((await getClaimEvidenceMatrix(projectId, { claims })).rows[0].status, 'needs-verification');
  const confirmed = await upsertEvidence(projectId, { id: original.id, verificationStatus: 'human-confirmed' });
  assert.equal(confirmed.entry.verificationStatus, 'human-confirmed');
  assert.notEqual(confirmed.entry.verifiedAt, original.verifiedAt);
  for (const patch of [{ sourceUrl: 'https://example.test/corrected' }, { location: 'Section 3' }, { version: 'v2' }, { sha256: 'changed-hash' }]) {
    const result = await upsertEvidence(projectId, { id: original.id, ...patch });
    assert.equal(result.entry.verificationStatus, 'pending');
    assert.equal(result.entry.verifiedAt, null);
    await upsertEvidence(projectId, { id: original.id, verificationStatus: 'human-confirmed' });
  }
  const nested = await upsertEvidence(projectId, { id: original.id, source: { url: 'https://example.test/nested', locator: 'Section 4' } });
  assert.equal(nested.entry.sourceUrl, 'https://example.test/nested');
  assert.equal(nested.entry.location, 'Section 4');
  assert.equal(nested.entry.verificationStatus, 'pending');
  await upsertEvidence(projectId, { id: original.id, verificationStatus: 'human-confirmed' });
  const cleared = await upsertEvidence(projectId, { id: original.id, sourceUrl: null, location: null });
  assert.equal(cleared.entry.source.url, null);
  assert.equal(cleared.entry.source.locator, null);
  assert.equal(cleared.entry.verificationStatus, 'pending');
  await upsertEvidence(projectId, { id: original.id, verificationStatus: 'human-confirmed' });
  const rejected = await upsertEvidence(projectId, { id: original.id, summary: 'Rejected correction', verificationStatus: 'rejected' });
  assert.equal(rejected.entry.verificationStatus, 'rejected');
});

test('human citations bind source material and remain stale after a source is confirmed again', async () => {
  const projectId = 'evidence-citations';
  await createProject(projectId);
  const paper = await upsertEvidence(projectId, { id: 'citation-paper', kind: 'paper', summary: 'Original material', version: 'v1', sourceUrl: 'https://example.test/v1', verificationStatus: 'human-confirmed' });
  const citation = { evidenceId: paper.entry.id, sourceVersion: 'v1', excerpt: 'Original material', section: 'Methods' };
  const claim = await upsertEvidence(projectId, { id: 'citation-claim', kind: 'paper-claim', summary: 'Human claim', citations: [citation] }, { actor: 'human', expectedVersion: paper.ledgerVersion });
  assert.equal(claim.entry.citations[0].sourceSnapshot.url, paper.entry.sourceUrl);
  assert.match(claim.entry.citations[0].materialFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(claim.entry.citations[0].page, '');
  assert.equal(claim.entry.citations[0].actor, 'human');
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
  await upsertEvidence(projectId, { id: paper.entry.id, tags: ['read'] });
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
  await upsertEvidence(projectId, { id: paper.entry.id, summary: 'Corrected material' });
  await upsertEvidence(projectId, { id: paper.entry.id, verificationStatus: 'human-confirmed' });
  const matrix = await getClaimEvidenceMatrix(projectId);
  assert.equal(matrix.rows[0].status, 'needs-verification');
  assert.deepEqual(matrix.rows[0].staleEvidenceIds, [paper.entry.id]);
  assert.deepEqual(matrix.rows[0].citations, claim.entry.citations);
  const before = await getEvidenceLedger(projectId);
  for (const [citations, actor, code] of [
    [[{ ...citation, sourceVersion: 'v0' }], 'human', 'CITATION_SOURCE_CHANGED'],
    [[{ ...citation, evidenceId: 'absent' }], 'human', 'CITATION_SOURCE_NOT_FOUND'],
    [[citation], 'ai', 'HUMAN_CITATION_REQUIRED'],
    [[{ ...citation, materialFingerprint: 'forged' }], 'human', 'INVALID_CITATIONS'],
    [[{ ...citation, excerpt: 'x'.repeat(4001) }], 'human', 'INVALID_CITATIONS']
  ]) {
    await assert.rejects(upsertEvidence(projectId, { id: claim.entry.id, citations }, { actor, expectedVersion: before.version }), (error) => error.code === code);
    assert.deepEqual(await getEvidenceLedger(projectId), before);
  }
  await assert.rejects(upsertEvidence(projectId, { id: claim.entry.id, citations: [citation] }), (error) => error.code === 'CITATION_VERSION_REQUIRED');
  await assert.rejects(upsertEvidence(projectId, { id: claim.entry.id, citations: [citation] }, { expectedVersion: paper.ledgerVersion }), (error) => error.code === 'VERSION_CONFLICT');
  await upsertEvidence(projectId, { id: claim.entry.id, citations: [{ ...citation, excerpt: 'Corrected material' }] }, { expectedVersion: before.version });
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
  const app = Fastify();
  registerEvidenceLedgerRoutes(app);
  const current = await getEvidenceLedger(projectId);
  const url = `/api/projects/${projectId}/evidence/${claim.entry.id}`;
  for (const actor of [undefined, 'ai']) {
    const response = await app.inject({ method: 'PUT', url, payload: { citations: [citation], expectedVersion: current.version, actor } });
    assert.equal(response.statusCode, 403);
  }
  const empty = await app.inject({ method: 'PUT', url, payload: { citations: [{ evidenceId: paper.entry.id, sourceVersion: 'v1' }], expectedVersion: current.version, actor: 'human' } });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(await getEvidenceLedger(projectId), current);
  const attempts = await Promise.all([1, 2].map(() => app.inject({ method: 'PUT', url, payload: { citations: [citation], expectedVersion: current.version, actor: 'human' } })));
  assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 409]);
  const saved = await getEvidenceLedger(projectId);
  await upsertEvidence(projectId, { id: claim.entry.id, tags: ['reviewing'] });
  assert.deepEqual((await getEvidenceLedger(projectId)).entries.find((entry) => entry.id === claim.entry.id).citations, saved.entries.find((entry) => entry.id === claim.entry.id).citations);
  await upsertEvidence(projectId, { id: claim.entry.id, evidenceVersions: { [paper.entry.id]: 'v1' } });
  await upsertEvidence(projectId, { id: paper.entry.id, version: 'v2' });
  await upsertEvidence(projectId, { id: paper.entry.id, verificationStatus: 'human-confirmed' });
  const versionTwo = await getEvidenceLedger(projectId);
  await upsertEvidence(projectId, { id: claim.entry.id, citations: [{ ...citation, sourceVersion: 'v2' }] }, { expectedVersion: versionTwo.version });
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
  const removed = await getEvidenceLedger(projectId);
  removed.entries = removed.entries.filter((entry) => entry.id !== paper.entry.id);
  await writeFile(path.join(dataDir, projectId, '.scienceprism', 'evidence-ledger.json'), JSON.stringify(removed));
  const missing = (await getClaimEvidenceMatrix(projectId)).rows[0];
  assert.equal(missing.status, 'unsupported');
  assert.deepEqual(missing.missingEvidenceIds, [paper.entry.id]);
  assert.equal(missing.citations[0].sourceSnapshot.url, 'https://example.test/v1');
  await app.close();
});

test('ledger reads preserve per-entry timestamps and unversioned citation bindings', async () => {
  const projectId = 'evidence-stable-read';
  const root = await createProject(projectId);
  const saved = await upsertEvidence(projectId, { id: 'timed-note', kind: 'human-note', summary: 'Original note', verificationStatus: 'human-confirmed' });
  const ledger = await getEvidenceLedger(projectId);
  ledger.entries = [saved.entry];
  ledger.updatedAt = '2099-01-01T00:00:00.000Z';
  await writeFile(path.join(root, '.scienceprism', 'evidence-ledger.json'), JSON.stringify(ledger));
  const reread = await getEvidenceLedger(projectId);
  assert.equal(reread.entries[0].updatedAt, saved.entry.updatedAt);
  await upsertEvidence(projectId, { id: 'timed-claim', kind: 'paper-claim', summary: 'Claim', citations: [{ evidenceId: saved.entry.id, sourceVersion: saved.entry.updatedAt, section: 'Notes' }] }, { expectedVersion: reread.version });
  assert.equal((await getEvidenceLedger(projectId)).entries.find((entry) => entry.id === saved.entry.id).updatedAt, saved.entry.updatedAt);
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
});

test('unversioned citations use material snapshots rather than tag update timestamps', async () => {
  const projectId = 'evidence-citations-unversioned';
  await createProject(projectId);
  const note = await upsertEvidence(projectId, { id: 'manual-note', kind: 'human-note', summary: 'Human transcription', verificationStatus: 'human-confirmed' });
  const saved = await upsertEvidence(projectId, { id: 'manual-claim', kind: 'paper-claim', summary: 'Claim', citations: [{ evidenceId: note.entry.id, sourceVersion: note.entry.updatedAt, section: 'Human notes' }] }, { expectedVersion: note.ledgerVersion });
  await upsertEvidence(projectId, { id: note.entry.id, tags: ['read'] });
  assert.equal((await getClaimEvidenceMatrix(projectId)).rows[0].status, 'supported');
  assert.equal(saved.entry.citations[0].actor, 'human');
});

test('research Harness rejects a writing output that cites no confirmed Evidence', async () => {
  const projectId = 'evidence-harness';
  await createProject(projectId);
  await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Question' } });
  const output = JSON.stringify({
    stage: 'writing_brief',
    title: 'Draft',
    claims: [{ id: 'claim-1', text: 'Unsupported result', evidenceIds: ['missing'], confidence: 0.9 }],
    outline: ['Introduction'],
    citationPaperIds: [],
    limitations: [],
    unsupportedClaims: []
  });
  const result = await runResearchHarnessStage({ projectId, stage: 'writing', runHarness: async () => ({ ok: true, reply: output, runId: null }) });
  assert.equal(result.ok, false);
  assert.equal(result.validation.errors[0].code, 'UNSUPPORTED_CLAIM');
});

test('an unsupported claim is accepted once declared, and only then', async () => {
  const projectId = 'evidence-declared-uncertainty';
  await createProject(projectId);
  await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Question' } });

  const brief = (unsupportedClaims) => JSON.stringify({
    stage: 'writing_brief',
    title: 'Draft',
    claims: [{ id: 'claim-1', text: 'Unsupported result', evidenceIds: ['missing'], confidence: 0.4 }],
    outline: ['Introduction'],
    citationPaperIds: [],
    limitations: [],
    unsupportedClaims
  });
  const run = (unsupportedClaims) => runResearchHarnessStage({
    projectId,
    stage: 'writing',
    runHarness: async () => ({ ok: true, reply: brief(unsupportedClaims), runId: null })
  });

  // C-11: naming the claim is what makes the uncertainty explicit, which is
  // exactly what the stage contract asks the model to do.
  const declared = await run(['claim-1 rests on a preprint with no confirmed Evidence.']);
  assert.equal(declared.ok, true, JSON.stringify(declared.validation?.errors || []));

  // Omitting it is the silent uncertainty C-11 forbids.
  const undeclared = await run([]);
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.validation.errors[0].code, 'UNSUPPORTED_CLAIM');

  // Naming a different claim must not count as declaring this one.
  const wrongClaim = await run(['claim-10 is unsupported.']);
  assert.equal(wrongClaim.ok, false);
  assert.equal(wrongClaim.validation.errors[0].code, 'UNSUPPORTED_CLAIM');
});

test('Evidence Ledger routes expose entries, matrix, graph, and version conflicts', async () => {
  const projectId = 'evidence-routes';
  await createProject(projectId);
  const app = Fastify();
  registerEvidenceLedgerRoutes(app);

  const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/evidence`, payload: { id: 'note-1', kind: 'human-note', summary: 'A note' } });
  assert.equal(created.statusCode, 200);
  const version = created.json().result.ledgerVersion;
  const ledger = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/evidence` });
  assert.equal(ledger.statusCode, 200);
  assert.equal(ledger.json().ledger.entries[0].id, 'note-1');

  const conflict = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/evidence`, payload: { id: 'note-2', kind: 'human-note', summary: 'stale', expectedVersion: version - 1 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'VERSION_CONFLICT');
  const confirmed = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/evidence/note-1`, payload: { verificationStatus: 'human-confirmed', actor: 'human', expectedVersion: version } });
  assert.equal(confirmed.statusCode, 200);
  const tagged = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/evidence/note-1`, payload: { tags: ['reviewed'], actor: 'human', expectedVersion: confirmed.json().result.ledgerVersion } });
  assert.equal(tagged.statusCode, 200);
  assert.equal(tagged.json().result.entry.verificationStatus, 'human-confirmed');
  assert.equal(tagged.json().result.entry.metadata.actor, undefined);
  assert.equal(tagged.json().result.entry.metadata.expectedVersion, undefined);
  await app.close();
});
