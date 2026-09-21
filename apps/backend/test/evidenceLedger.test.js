import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-evidence-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const {
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
  await app.close();
});
