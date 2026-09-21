import { randomUUID } from 'node:crypto';
import { readWorkflowFile, resolveProjectRoot } from '../researchWorkflow/repository.js';
import { EvidenceLedgerError } from './errors.js';
import {
  CONFIRMED_EVIDENCE_STATUSES,
  evidenceLedgerSchema,
  evidenceVersion,
  isConfirmedEvidence,
  normalizeEvidenceRecord,
  normalizeEvidenceRelation,
  sourceForEvidence
} from './schema.js';
import { clone, readEvidenceLedger, resolveEvidenceProjectRoot, withEvidenceLedgerLock, writeEvidenceLedger } from './repository.js';

const MAX_ENTRIES = 2_000;

function now() {
  return new Date().toISOString();
}

async function readLedger(projectId) {
  const root = await resolveEvidenceProjectRoot(projectId);
  return { root, ledger: await readEvidenceLedger(root, projectId) };
}

function ensureExpectedVersion(ledger, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  if (Number(expectedVersion) !== ledger.version) {
    throw new EvidenceLedgerError(409, 'VERSION_CONFLICT', 'Evidence Ledger changed since it was read.', { expectedVersion, actualVersion: ledger.version });
  }
}

function commitLedger(ledger) {
  const next = { ...ledger, version: ledger.version + 1, updatedAt: now() };
  return evidenceLedgerSchema.parse(next);
}

export async function getEvidenceLedger(projectId) {
  const { ledger } = await readLedger(projectId);
  return clone(ledger);
}

export async function listEvidence(projectId, { kind, verificationStatus, query, limit = 500 } = {}) {
  const { ledger } = await readLedger(projectId);
  const normalizedQuery = String(query || '').trim().toLowerCase();
  return clone(ledger.entries.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    if (verificationStatus && entry.verificationStatus !== verificationStatus) return false;
    if (normalizedQuery && !`${entry.id} ${entry.title} ${entry.summary}`.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  }).slice(0, Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 500))));
}

export async function getEvidence(projectId, evidenceId) {
  const { ledger } = await readLedger(projectId);
  const entry = ledger.entries.find((item) => item.id === evidenceId);
  if (!entry) throw new EvidenceLedgerError(404, 'EVIDENCE_NOT_FOUND', 'Evidence record not found.', { evidenceId });
  return clone(entry);
}

export async function upsertEvidence(projectId, input, { actor = 'human', expectedVersion } = {}) {
  if (!input || typeof input !== 'object') throw new EvidenceLedgerError(400, 'INVALID_EVIDENCE', 'Evidence record must be an object.');
  const root = await resolveEvidenceProjectRoot(projectId);
  return withEvidenceLedgerLock(projectId, async () => {
    const ledger = await readEvidenceLedger(root, projectId);
    ensureExpectedVersion(ledger, expectedVersion);
    const existingIndex = input.id ? ledger.entries.findIndex((item) => item.id === String(input.id)) : -1;
    const existing = existingIndex >= 0 ? ledger.entries[existingIndex] : undefined;
    const entry = normalizeEvidenceRecord({ ...input, id: input.id || `evidence-${randomUUID()}` }, { existing, now: now() });
    if (existingIndex >= 0) ledger.entries[existingIndex] = entry;
    else ledger.entries.unshift(entry);
    if (ledger.entries.length > MAX_ENTRIES) ledger.entries.length = MAX_ENTRIES;
    const next = commitLedger(ledger);
    await writeEvidenceLedger(root, next);
    return { entry: clone(entry), ledgerVersion: next.version, actor };
  });
}

export async function linkEvidence(projectId, input, { actor = 'human', expectedVersion } = {}) {
  const root = await resolveEvidenceProjectRoot(projectId);
  return withEvidenceLedgerLock(projectId, async () => {
    const ledger = await readEvidenceLedger(root, projectId);
    ensureExpectedVersion(ledger, expectedVersion);
    const relation = normalizeEvidenceRelation({ ...input, actor }, { now: now() });
    const ids = new Set(ledger.entries.map((entry) => entry.id));
    if (!ids.has(relation.fromId) || !ids.has(relation.toId)) {
      throw new EvidenceLedgerError(400, 'RELATION_TARGET_NOT_FOUND', 'Both relation targets must exist in the Evidence Ledger.', { fromId: relation.fromId, toId: relation.toId });
    }
    if (relation.evidenceIds.some((id) => !ids.has(id))) {
      throw new EvidenceLedgerError(400, 'RELATION_EVIDENCE_NOT_FOUND', 'Relation evidence references must exist in the Evidence Ledger.');
    }
    const duplicate = ledger.relations.find((item) => item.fromId === relation.fromId && item.toId === relation.toId && item.type === relation.type);
    if (duplicate) return { relation: clone(duplicate), ledgerVersion: ledger.version, actor, idempotent: true };
    ledger.relations.unshift(relation);
    const next = commitLedger(ledger);
    await writeEvidenceLedger(root, next);
    return { relation: clone(relation), ledgerVersion: next.version, actor };
  });
}

function workflowStageEvidenceIds(workflow) {
  const result = new Map();
  for (const stage of workflow?.stages || []) {
    const text = JSON.stringify(stage.data || {});
    for (const id of [...text.matchAll(/(?:evidenceId|evidenceIds|referenceId|referenceIds)[^\]}]{0,180}/g)].flatMap((match) => match[0].match(/[A-Za-z0-9._:-]{2,}/g) || [])) {
      if (!result.has(id)) result.set(id, new Set());
      result.get(id).add(stage.id);
    }
  }
  return result;
}

function claimFromEntry(entry) {
  return {
    id: entry.id,
    text: entry.summary || entry.title,
    evidenceIds: entry.metadata?.evidenceIds || Object.keys(entry.evidenceVersions || {}),
    evidenceVersions: entry.evidenceVersions || {},
    source: 'ledger',
    verificationStatus: entry.verificationStatus,
    confidence: entry.metadata?.confidence ?? null
  };
}

function claimsFromWorkflow(workflow) {
  const writing = workflow?.stages?.find((stage) => stage.id === 'writing')?.data || {};
  const candidates = [
    ...(Array.isArray(writing.claims) ? writing.claims : []),
    ...(Array.isArray(writing.evidence?.claims) ? writing.evidence.claims : []),
    ...(Array.isArray(writing.writing?.claims) ? writing.writing.claims : [])
  ];
  return candidates.filter((claim) => claim && typeof claim === 'object').map((claim, index) => ({
    id: String(claim.id || `writing-claim-${index + 1}`),
    text: String(claim.text || claim.claim || claim.summary || '').trim(),
    evidenceIds: [...new Set([...(claim.evidenceIds || []), ...(claim.evidence || [])].map(String).filter(Boolean))],
    evidenceVersions: claim.evidenceVersions && typeof claim.evidenceVersions === 'object' ? claim.evidenceVersions : {},
    source: 'workflow.writing',
    verificationStatus: claim.verificationStatus || 'unverified',
    confidence: claim.confidence ?? null
  })).filter((claim) => claim.text);
}

function claimRows(ledger, workflow, suppliedClaims) {
  const ledgerClaims = ledger.entries.filter((entry) => entry.kind === 'paper-claim').map(claimFromEntry);
  const workflowClaims = suppliedClaims || claimsFromWorkflow(workflow);
  const byId = new Map(ledgerClaims.map((claim) => [claim.id, claim]));
  for (const claim of workflowClaims) {
    const existing = byId.get(claim.id) || {};
    byId.set(claim.id, {
      ...existing,
      ...claim,
      evidenceIds: claim.evidenceIds?.length ? claim.evidenceIds : existing.evidenceIds || [],
      evidenceVersions: Object.keys(claim.evidenceVersions || {}).length ? claim.evidenceVersions : existing.evidenceVersions || {}
    });
  }
  return [...byId.values()];
}

function evaluateClaim(claim, entriesById) {
  const evidenceIds = [...new Set((claim.evidenceIds || []).map(String).filter(Boolean))];
  const evidence = evidenceIds.map((id) => entriesById.get(id)).filter(Boolean);
  const missingEvidenceIds = evidenceIds.filter((id) => !entriesById.has(id));
  const unverifiedEvidenceIds = evidence.filter((entry) => !isConfirmedEvidence(entry)).map((entry) => entry.id);
  const staleEvidenceIds = evidence.filter((entry) => claim.evidenceVersions?.[entry.id] && claim.evidenceVersions[entry.id] !== evidenceVersion(entry)).map((entry) => entry.id);
  const status = !evidenceIds.length || missingEvidenceIds.length ? 'unsupported' : staleEvidenceIds.length || unverifiedEvidenceIds.length ? 'needs-verification' : 'supported';
  return {
    id: claim.id,
    text: claim.text,
    confidence: claim.confidence,
    source: claim.source,
    evidenceIds,
    evidence: evidence.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, summary: entry.summary, verificationStatus: entry.verificationStatus, source: sourceForEvidence(entry), version: evidenceVersion(entry), sha256: entry.sha256 })),
    missingEvidenceIds,
    unverifiedEvidenceIds,
    staleEvidenceIds,
    status
  };
}

export function checkClaimEvidence(ledger, claims = []) {
  const entriesById = new Map((ledger?.entries || []).map((entry) => [entry.id, entry]));
  const rows = claims.map((claim) => evaluateClaim(claim, entriesById));
  const unsupported = rows.filter((row) => row.status === 'unsupported');
  const needsVerification = rows.filter((row) => row.status === 'needs-verification');
  return {
    ok: rows.length > 0 && unsupported.length === 0 && needsVerification.length === 0,
    totalClaims: rows.length,
    supportedClaims: rows.filter((row) => row.status === 'supported').length,
    unsupportedClaims: unsupported.length,
    needsVerificationClaims: needsVerification.length,
    missingEvidenceIds: [...new Set(unsupported.flatMap((row) => row.missingEvidenceIds))],
    unverifiedEvidenceIds: [...new Set(needsVerification.flatMap((row) => row.unverifiedEvidenceIds))],
    staleEvidenceIds: [...new Set(needsVerification.flatMap((row) => row.staleEvidenceIds))],
    rows,
    checkedAt: now()
  };
}

function collectEvidenceReferences(value, path = 'output', result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEvidenceReferences(item, `${path}.${index}`, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'evidenceId' && typeof item === 'string' && item.trim()) result.push({ id: item.trim(), path });
    else if (key === 'evidenceIds' && Array.isArray(item)) item.filter((id) => typeof id === 'string' && id.trim()).forEach((id) => result.push({ id: id.trim(), path: `${path}.${key}` }));
    else if (key === 'evidence' && Array.isArray(item)) {
      item.forEach((reference, index) => {
        if (typeof reference === 'string' && reference.trim()) result.push({ id: reference.trim(), path: `${path}.${key}.${index}` });
        else if (reference?.evidenceId || reference?.id) result.push({ id: String(reference.evidenceId || reference.id), path: `${path}.${key}.${index}` });
      });
    } else if (key !== 'relatedPaperIds' && key !== 'citationPaperIds') collectEvidenceReferences(item, `${path}.${key}`, result);
  }
  return result;
}

export async function getClaimEvidenceMatrix(projectId, { claims } = {}) {
  const { ledger } = await readLedger(projectId);
  let workflow = null;
  try {
    workflow = await readWorkflowFile(await resolveProjectRoot(projectId), projectId);
  } catch (error) {
    if (error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
  }
  return checkClaimEvidence(ledger, claimRows(ledger, workflow, claims));
}

export async function validateStageEvidence(projectId, stage, output) {
  const normalizedStage = String(stage || '').trim();
  const claims = normalizedStage === 'writing' || normalizedStage === 'writing_brief'
    ? Array.isArray(output?.claims) ? output.claims : []
    : [];
  const references = collectEvidenceReferences(output);
  const claimReferences = new Set(claims.flatMap((claim) => claim?.evidenceIds || []).map(String));
  const referenceClaims = references.filter((reference) => !claimReferences.has(reference.id)).map((reference, index) => ({
    id: `evidence-reference-${index + 1}`,
    text: `Evidence reference at ${reference.path}`,
    evidenceIds: [reference.id]
  }));
  if (!claims.length && !referenceClaims.length) return { ok: true, errors: [], warnings: normalizedStage === 'writing' || normalizedStage === 'writing_brief' ? [{ code: 'NO_PAPER_CLAIMS', message: 'No Paper Claims were returned; any prose remains a draft until claims are linked to Evidence.' }] : [] };
  const ledger = await getEvidenceLedger(projectId);
  const matrix = checkClaimEvidence(ledger, [...claims, ...referenceClaims]);
  const errors = matrix.rows.filter((row) => row.status !== 'supported').map((row) => ({
    path: row.id.startsWith('evidence-reference-') ? row.id : `claims.${row.id}.evidenceIds`,
    code: row.status === 'unsupported' ? 'UNSUPPORTED_CLAIM' : 'EVIDENCE_REQUIRES_VERIFICATION',
    message: row.status === 'unsupported' ? 'Paper Claim has no complete Evidence chain.' : 'Paper Claim references missing, unverified, or stale Evidence.',
    details: { missingEvidenceIds: row.missingEvidenceIds, unverifiedEvidenceIds: row.unverifiedEvidenceIds, staleEvidenceIds: row.staleEvidenceIds }
  }));
  return { ok: errors.length === 0, errors, warnings: [], matrix };
}

export async function getEvidenceGraph(projectId, { rootId, maxDepth = 4 } = {}) {
  const { ledger } = await readLedger(projectId);
  let workflow = null;
  try {
    workflow = await readWorkflowFile(await resolveProjectRoot(projectId), projectId);
  } catch (error) {
    if (error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
  }
  const stageEvidence = workflowStageEvidenceIds(workflow);
  const nodes = ledger.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    verificationStatus: entry.verificationStatus,
    version: evidenceVersion(entry),
    source: sourceForEvidence(entry),
    affectedStageIds: [...(stageEvidence.get(entry.id) || [])],
    affectedClaimIds: []
  }));
  const matrix = checkClaimEvidence(ledger, claimRows(ledger, workflow));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const row of matrix.rows) for (const id of row.evidenceIds) nodeMap.get(id)?.affectedClaimIds.push(row.id);
  let edges = ledger.relations.map((relation) => ({ ...relation }));
  if (rootId) {
    const seen = new Set([rootId]);
    const queue = [{ id: rootId, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.depth >= Math.max(0, Number(maxDepth) || 4)) continue;
      for (const edge of edges.filter((item) => item.fromId === current.id || item.toId === current.id)) {
        const nextId = edge.fromId === current.id ? edge.toId : edge.fromId;
        if (!seen.has(nextId)) { seen.add(nextId); queue.push({ id: nextId, depth: current.depth + 1 }); }
      }
    }
    edges = edges.filter((edge) => seen.has(edge.fromId) && seen.has(edge.toId));
    return { version: ledger.version, rootId, nodes: nodes.filter((node) => seen.has(node.id)), edges, generatedAt: now() };
  }
  return { version: ledger.version, nodes, edges, generatedAt: now() };
}

export async function getEvidenceImpact(projectId, evidenceId) {
  const graph = await getEvidenceGraph(projectId, { rootId: evidenceId });
  const node = graph.nodes.find((item) => item.id === evidenceId);
  if (!node) throw new EvidenceLedgerError(404, 'EVIDENCE_NOT_FOUND', 'Evidence record not found.', { evidenceId });
  return { evidenceId, version: node.version, affectedStageIds: node.affectedStageIds, affectedClaimIds: node.affectedClaimIds, graph };
}

export { CONFIRMED_EVIDENCE_STATUSES };
