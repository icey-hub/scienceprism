import { z } from 'zod';

export const EVIDENCE_KINDS = Object.freeze([
  'research-question',
  'paper',
  'dataset',
  'code',
  'environment',
  'method',
  'experiment',
  'experiment-plan',
  'experiment-run',
  'result',
  'log',
  'figure',
  'table',
  'human-note',
  'paper-claim',
  'artifact'
]);

export const VERIFICATION_STATUSES = Object.freeze([
  'unverified',
  'pending',
  'partially-verified',
  'verified',
  'human-confirmed',
  'approved',
  'rejected',
  'superseded'
]);

export const RELATION_TYPES = Object.freeze([
  'answers',
  'supports',
  'references',
  'uses',
  'depends-on',
  'produces',
  'derived-from',
  'reports',
  'contains',
  'contradicts'
]);

const id = z.string().trim().min(1).regex(/^[A-Za-z0-9._:-]+$/, 'id contains unsupported characters');
const nullableText = z.string().trim().min(1).nullable().optional();

const sourceSchema = z.object({
  url: nullableText,
  path: nullableText,
  provider: nullableText,
  locator: nullableText
}).passthrough().default({});

export const evidenceRecordSchema = z.object({
  id,
  kind: z.enum(EVIDENCE_KINDS),
  title: z.string().trim().optional().default(''),
  summary: z.string().trim().optional().default(''),
  source: sourceSchema,
  sourceUrl: nullableText,
  sourcePath: nullableText,
  acquiredAt: nullableText,
  verifiedAt: nullableText,
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('unverified'),
  version: nullableText,
  sha256: z.string().trim().min(1).nullable().optional(),
  location: nullableText,
  tags: z.array(z.string().trim().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  evidenceVersions: z.record(z.string(), z.string()).default({}),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1)
}).strict();

export const evidenceRelationSchema = z.object({
  id,
  type: z.enum(RELATION_TYPES),
  fromId: id,
  toId: id,
  evidenceIds: z.array(id).default([]),
  note: z.string().trim().optional().default(''),
  actor: z.string().trim().optional().default('system'),
  createdAt: z.string().trim().min(1)
}).strict();

export const evidenceLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().trim().min(1),
  version: z.number().int().min(1),
  entries: z.array(evidenceRecordSchema),
  relations: z.array(evidenceRelationSchema),
  updatedAt: z.string().trim().min(1)
}).strict();

export const CONFIRMED_EVIDENCE_STATUSES = new Set(['verified', 'human-confirmed', 'approved']);

export function isConfirmedEvidence(value) {
  return Boolean(value?.confirmed === true || CONFIRMED_EVIDENCE_STATUSES.has(value?.verificationStatus));
}

export function evidenceVersion(value) {
  return value?.version || value?.sha256 || value?.updatedAt || null;
}

export function sourceForEvidence(value) {
  const source = value?.source && typeof value.source === 'object' ? value.source : {};
  const legacySource = typeof value?.source === 'string' ? value.source : null;
  const legacyUrl = legacySource && /^https?:\/\//i.test(legacySource) ? legacySource : null;
  return {
    url: value?.sourceUrl || source.url || legacyUrl || null,
    path: value?.sourcePath || source.path || (legacySource && !legacyUrl ? legacySource : null),
    provider: source.provider || value?.provider || null,
    locator: value?.location || source.locator || null
  };
}

export function normalizeEvidenceRecord(value, { now = new Date().toISOString(), existing } = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const previous = existing && typeof existing === 'object' ? existing : {};
  const merged = { ...previous, ...input };
  const source = sourceForEvidence({ ...merged, source: input.source || previous.source });
  const knownFields = new Set(['id', 'kind', 'title', 'summary', 'source', 'sourceUrl', 'sourcePath', 'acquiredAt', 'verifiedAt', 'verificationStatus', 'version', 'sha256', 'location', 'tags', 'metadata', 'evidenceVersions', 'createdAt', 'updatedAt']);
  const migratedMetadata = Object.fromEntries(Object.entries(merged).filter(([key]) => !knownFields.has(key)));
  const normalizedKind = EVIDENCE_KINDS.includes(merged.kind) ? merged.kind : 'human-note';
  const normalized = {
    id: String(merged.id || '').trim(),
    kind: normalizedKind,
    title: String(merged.title ?? '').trim(),
    summary: String(merged.summary ?? '').trim(),
    source,
    sourceUrl: source.url,
    sourcePath: source.path,
    acquiredAt: merged.acquiredAt ?? now,
    verifiedAt: merged.verifiedAt ?? null,
    verificationStatus: merged.verificationStatus || merged.status || 'unverified',
    version: merged.version ?? null,
    sha256: merged.sha256 ?? null,
    location: merged.location ?? source.locator ?? null,
    tags: [...new Set([...(Array.isArray(previous.tags) ? previous.tags : []), ...(Array.isArray(input.tags) ? input.tags : [])].map(String).map((item) => item.trim()).filter(Boolean))],
    metadata: { ...(previous.metadata || {}), ...(input.metadata || {}), ...migratedMetadata },
    evidenceVersions: { ...(previous.evidenceVersions || {}), ...(input.evidenceVersions || {}) },
    createdAt: previous.createdAt || input.createdAt || now,
    updatedAt: now
  };
  if (normalized.verificationStatus === 'verified' || normalized.verificationStatus === 'human-confirmed' || normalized.verificationStatus === 'approved') {
    normalized.verifiedAt = normalized.verifiedAt || now;
  }
  return evidenceRecordSchema.parse(normalized);
}

export function normalizeEvidenceRelation(value, { now = new Date().toISOString() } = {}) {
  return evidenceRelationSchema.parse({
    id: String(value?.id || `relation-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: value?.type || value?.relation,
    fromId: String(value?.fromId || value?.sourceId || value?.source || ''),
    toId: String(value?.toId || value?.targetId || value?.target || ''),
    evidenceIds: Array.isArray(value?.evidenceIds) ? value.evidenceIds.map(String) : [],
    note: value?.note || '',
    actor: value?.actor || 'system',
    createdAt: value?.createdAt || now
  });
}
