import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { isPathAllowed, isSensitivePath } from './capabilities.js';
import { RESEARCH_STAGE_CONTRACTS, normalizeResearchStage } from '../researchResearch/schemas.js';

export const CONTEXT_PACK_SCHEMA_VERSION = 1;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 12_000;
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_FILE_CANDIDATES = 80;
const IGNORED_CONTEXT_FILES = new Set(['project.json', '.compile']);
const IGNORED_CONTEXT_PREFIXES = ['.dsh/skills/'];
const MAX_EVIDENCE_ITEMS = 80;
const MAX_DECISIONS = 40;
const TEXT_BYTES_PER_TOKEN = 4;
const CONTEXT_FILE_PRIORITY = Object.freeze({
  active: 1_000,
  requested: 900,
  related: 650,
  manuscript: 500,
  metadata: 350,
  other: 100
});
const STAGE_FILE_EXTENSIONS = Object.freeze({
  direction: ['.md', '.txt', '.json'],
  search: ['.md', '.json', '.bib', '.txt'],
  selection: ['.md', '.json', '.bib', '.txt'],
  replication: ['.md', '.json', '.py', '.sh', '.yaml', '.yml', '.txt'],
  ideation: ['.md', '.json', '.bib', '.tex', '.txt'],
  method: ['.md', '.json', '.py', '.tex', '.txt'],
  experiment: ['.json', '.csv', '.md', '.py', '.yaml', '.yml', '.txt'],
  writing: ['.tex', '.bib', '.md', '.json', '.txt']
});
const EVIDENCE_REQUIRED_STAGES = new Set(['replication', 'ideation', 'method', 'experiment', 'writing']);
const CONFIRMED_STATUSES = new Set(['confirmed', 'verified', 'accepted', 'approved', 'human-confirmed', 'human_confirmed']);
const DECISION_TYPES = new Set(['stage.approved', 'stage.rejected', 'stage.skipped', 'workflow.recovered', 'workflow.reset']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.max(0, Math.ceil(Buffer.byteLength(text, 'utf8') / TEXT_BYTES_PER_TOKEN));
}

function normalizeStage(stage) {
  const normalized = String(stage || '').trim();
  const workflowStage = {
    direction: 'direction',
    search: 'search',
    selection: 'selection',
    replication: 'replication',
    ideation: 'ideation',
    innovation: 'ideation',
    method: 'method',
    experiment: 'experiment',
    writing: 'writing',
    search_strategy: 'search',
    paper_screening: 'selection',
    reproduction_plan: 'replication',
    innovation_ideas: 'ideation',
    method_proposals: 'method',
    experiment_plan: 'experiment',
    experiment_results: 'experiment',
    writing_brief: 'writing'
  };
  return workflowStage[normalized] || normalized;
}

function normalizeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '' : normalized;
}

function isContextExcludedPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return true;
  const basename = path.posix.basename(normalized);
  return IGNORED_CONTEXT_FILES.has(basename)
    || IGNORED_CONTEXT_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function boundedText(value, maxBytes) {
  const text = value === undefined || value === null ? '' : String(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let result = text.slice(0, Math.max(0, Math.floor(maxBytes / 2)));
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return { text: result, truncated: true };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function getPriorityPathItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') return { path: item, priority: 800 - index };
    if (!item || typeof item !== 'object') return null;
    return { path: item.path || item.file, priority: Number(item.priority) || 800 - index, expectedHash: item.hash || item.sha256 };
  }).filter((item) => item?.path);
}

function contentHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hasConfirmedStatus(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.confirmed === true || item.verified === true) return true;
  const status = String(item.verificationStatus || item.status || '').trim().toLowerCase();
  return CONFIRMED_STATUSES.has(status);
}

function evidenceSummary(item, source = 'request') {
  if (!item || typeof item !== 'object') return null;
  const id = item.id || item.evidenceId || item.referenceId;
  if (!id) return null;
  const summary = item.summary || item.title || item.description || item.text || '';
  const bounded = boundedText(summary, 2_000);
  const sourceRecord = item.source && typeof item.source === 'object' ? item.source : {};
  const sourceValue = typeof item.source === 'string' ? item.source : null;
  return {
    id: String(id),
    kind: item.kind || item.type || 'unknown',
    summary: bounded.text,
    source: item.sourceUrl || item.sourcePath || sourceRecord.url || sourceRecord.path || sourceValue || item.url || item.path || null,
    sourceUrl: item.sourceUrl || sourceRecord.url || item.url || null,
    sourcePath: item.sourcePath || sourceRecord.path || item.path || null,
    location: item.location || null,
    version: item.version || item.revision || null,
    sha256: item.sha256 || item.hash || null,
    verificationStatus: item.verificationStatus || item.status || (item.confirmed || item.verified ? 'confirmed' : null),
    sourceRecord: source,
    truncated: bounded.truncated
  };
}

function collectConfirmedEvidence({ request, ledger, workflow }) {
  const candidates = [];
  for (const item of request.confirmedEvidence || []) {
    const summary = evidenceSummary({ ...item, confirmed: true }, 'request.confirmedEvidence');
    if (summary) candidates.push(summary);
  }
  for (const item of request.evidence || []) {
    if (hasConfirmedStatus(item)) {
      const summary = evidenceSummary(item, 'request.evidence');
      if (summary) candidates.push(summary);
    }
  }
  for (const item of Array.isArray(ledger) ? ledger : []) {
    if (hasConfirmedStatus(item)) {
      const summary = evidenceSummary(item, 'project.evidenceLedger');
      if (summary) candidates.push(summary);
    }
  }
  for (const stage of workflow?.stages || []) {
    const data = stage?.data || {};
    const stageItems = [...(data.confirmedEvidence || []), ...(data.evidenceRecords || [])];
    for (const item of stageItems) {
      if (hasConfirmedStatus(item)) {
        const summary = evidenceSummary(item, `workflow.${stage.id}`);
        if (summary) candidates.push(summary);
      }
    }
  }
  const unique = new Map();
  for (const item of candidates) {
    const key = `${item.id}:${item.version || item.sha256 || item.source || ''}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].slice(0, MAX_EVIDENCE_ITEMS);
}

function collectRecentDecisions({ request, workflow }) {
  const provided = Array.isArray(request.recentDecisions) ? request.recentDecisions : [];
  const audited = (workflow?.audit || []).filter((event) => DECISION_TYPES.has(event.type));
  return [...provided.map((item) => ({ ...item, source: item.source || 'request.recentDecisions' })), ...audited.map((item) => ({
    id: item.id,
    type: item.type,
    stageId: item.stageId || null,
    actor: item.actor || null,
    at: item.at || null,
    note: item.note || null,
    details: item.details || null,
    source: 'workflow.audit'
  }))].filter((item) => item && typeof item === 'object').slice(-MAX_DECISIONS);
}

function findVersionConflicts(items) {
  const versions = new Map();
  for (const item of items) {
    const identity = item.id;
    const version = item.version || item.sha256 || item.source || 'unknown';
    if (!identity) continue;
    if (!versions.has(identity)) versions.set(identity, new Set());
    versions.get(identity).add(version);
  }
  return [...versions.entries()].filter(([, values]) => values.size > 1).map(([id, values]) => ({ id, versions: [...values] }));
}

async function readJsonIfExists(projectRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(projectRoot, relativePath), 'utf8'));
      return { value, path: relativePath };
    } catch (error) {
      if (error?.code !== 'ENOENT') return { value: null, path: relativePath, error: 'invalid_json' };
    }
  }
  return { value: null, path: null };
}

async function readWorkflow(projectRoot) {
  const result = await readJsonIfExists(projectRoot, [
    path.join('.scienceprism', 'research-workflow.json'),
    path.join('.openprism', 'research-workflow.json')
  ]);
  return result.value && typeof result.value === 'object' ? result.value : null;
}

async function listFiles(root, relative = '') {
  const current = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
    if (isContextExcludedPath(child) || isSensitivePath(child)) continue;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function filePriority(relativePath, { activePath, requested, stage, configuredPriority = [] } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const active = normalizeRelativePath(activePath);
  const requestedItem = requested.find((item) => normalizeRelativePath(item.path) === normalized);
  const configuredItem = configuredPriority.find((item) => normalizeRelativePath(item.path) === normalized);
  if (normalized && active && normalized === active) return { score: CONTEXT_FILE_PRIORITY.active, reason: 'active-file' };
  if (requestedItem) return { score: Math.min(CONTEXT_FILE_PRIORITY.active - 1, CONTEXT_FILE_PRIORITY.requested + requestedItem.priority), reason: 'requested-file' };
  if (configuredItem) return { score: Math.min(CONTEXT_FILE_PRIORITY.active - 1, CONTEXT_FILE_PRIORITY.requested + configuredItem.priority), reason: 'project-priority' };
  const extension = path.posix.extname(normalized || '').toLowerCase();
  const stageExtensions = STAGE_FILE_EXTENSIONS[stage] || [];
  const sameDirectory = active && normalized?.includes('/') && path.posix.dirname(normalized) === path.posix.dirname(active);
  if (sameDirectory && stageExtensions.includes(extension)) return { score: CONTEXT_FILE_PRIORITY.related + 100, reason: 'active-directory' };
  if (stageExtensions.includes(extension)) return { score: CONTEXT_FILE_PRIORITY.related, reason: 'stage-extension' };
  if (['main.tex', 'README.md', 'README_ZH.md'].includes(normalized)) return { score: CONTEXT_FILE_PRIORITY.manuscript, reason: 'project-entry' };
  if (['.json', '.bib'].includes(extension)) return { score: CONTEXT_FILE_PRIORITY.metadata, reason: 'metadata-file' };
  return { score: CONTEXT_FILE_PRIORITY.other, reason: 'project-file' };
}

async function createFileCandidate(projectRoot, relativePath, options) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || isContextExcludedPath(normalized) || isSensitivePath(normalized) || !isPathAllowed(normalized, options.policy, { operation: 'read' })) return null;
  const absolute = path.resolve(projectRoot, normalized);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) return null;
  const content = await fs.readFile(absolute, 'utf8');
  const hash = contentHash(content);
  const priority = filePriority(normalized, options);
  const expectedHash = options.requested.find((item) => normalizeRelativePath(item.path) === normalized)?.expectedHash;
  return {
    path: normalized,
    priority: priority.score,
    reason: priority.reason,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: hash,
    expectedHash: expectedHash || null,
    content
  };
}

function buildWarnings({ request, files, evidence, workflow, ledgerError, policy }) {
  const warnings = [];
  const prompts = [];
  const add = (code, message, details) => {
    warnings.push({ code, message, ...(details === undefined ? {} : { details }) });
    prompts.push(message);
  };

  const deniedPaths = [];
  if (request.activePath && !isPathAllowed(request.activePath, policy, { operation: 'read' })) deniedPaths.push(request.activePath);
  if (deniedPaths.length) add('ACTIVE_PATH_DENIED', 'The active file is outside the Project Constraint file scope and was excluded from context.', { paths: deniedPaths });
  const staleFiles = files.filter((file) => file.expectedHash && file.expectedHash !== file.sha256).map((file) => file.path);
  if (staleFiles.length) add('STALE_CONTEXT', 'Some requested files changed since the caller captured its context; review the current file versions before relying on this Run.', { paths: staleFiles });
  if (request.expectedWorkflowVersion !== undefined && workflow?.version !== undefined && Number(request.expectedWorkflowVersion) !== Number(workflow.version)) {
    add('STALE_WORKFLOW_VERSION', 'The Research Workflow changed since the caller captured context; re-check recent decisions and stage data.', { expected: request.expectedWorkflowVersion, actual: workflow.version });
  }
  const conflicts = findVersionConflicts(evidence);
  if (conflicts.length) add('CONFLICTING_EVIDENCE_VERSIONS', 'Evidence has conflicting versions in the supplied context; do not treat the conflict as resolved.', { conflicts });
  const expectedEvidenceVersions = request.expectedEvidenceVersions && typeof request.expectedEvidenceVersions === 'object'
    ? request.expectedEvidenceVersions
    : {};
  const staleEvidence = evidence.filter((item) => expectedEvidenceVersions[item.id]
    && expectedEvidenceVersions[item.id] !== (item.version || item.sha256)).map((item) => item.id);
  if (staleEvidence.length) add('STALE_EVIDENCE', 'Some confirmed Evidence changed since the caller captured context; re-check the current Evidence version.', { evidenceIds: [...new Set(staleEvidence)] });
  if (ledgerError) add('INVALID_EVIDENCE_LEDGER', 'The project Evidence Ledger could not be parsed, so no ledger evidence was included.', { source: ledgerError });
  const requiredEvidenceIds = normalizeList(request.requiredEvidenceIds);
  const availableIds = new Set(evidence.map((item) => item.id));
  const missingIds = requiredEvidenceIds.filter((id) => !availableIds.has(id));
  if (missingIds.length) add('MISSING_EVIDENCE', 'Required Evidence is missing or not confirmed; keep dependent output explicitly unverified.', { evidenceIds: missingIds });
  const stage = normalizeStage(request.stage);
  if (EVIDENCE_REQUIRED_STAGES.has(stage) && !evidence.length) add('MISSING_CONFIRMED_EVIDENCE', 'No confirmed Evidence is available for this Research Stage; suggestions must retain explicit uncertainty.', { stage });
  if (!policy?.granted?.includes('project.read')) add('PROJECT_READ_DENIED', 'The Project Constraint does not grant project.read, so file context was excluded.');
  if (!files.length && policy?.granted?.includes('project.read')) add('NO_FILE_CONTEXT', 'No eligible project files were included in the context budget.');
  return { warnings, prompts, conflicts };
}

function buildContextWithoutHash({ stage, task, activePath, prompt, humanInstructions, selection, compileLog, files, evidence, evidenceGraph, decisions, skills, stageContract, warnings, prompts, budget, workflowVersion, projectConstraints }) {
  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    stage: stage || null,
    task: task || null,
    activePath: activePath || null,
    instructions: {
      prompt: prompt || '',
      human: humanInstructions || '',
      warnings: prompts,
      skills: clone(skills),
      stageContract: clone(stageContract)
    },
    selection: selection || '',
    compileLog: compileLog || '',
    projectConstraints: clone(projectConstraints),
    files: files.map(({ content, ...manifest }) => ({ ...manifest, content })),
    evidence: clone(evidence),
    evidenceGraph: clone(evidenceGraph),
    decisions: clone(decisions),
    workflowVersion: workflowVersion ?? null,
    budget: {
      maxTokens: budget,
      estimatedTokens: 0,
      truncated: false
    },
    warnings: clone(warnings)
  };
}

function truncateToBudget(pack, budget) {
  let estimatedTokens = estimateTokens(pack);
  let truncated = false;
  if (estimatedTokens <= budget) return { pack, estimatedTokens, truncated };

  const trimOrder = [
    ...pack.files.filter((file) => file.priority < CONTEXT_FILE_PRIORITY.active).sort((a, b) => a.priority - b.priority),
    ...pack.files.filter((file) => file.priority >= CONTEXT_FILE_PRIORITY.active).sort((a, b) => a.priority - b.priority)
  ];
  for (const file of trimOrder) {
    if (estimatedTokens <= budget) break;
    if (!file.content) continue;
    const excess = estimatedTokens - budget;
    const keepTokens = Math.max(0, estimateTokens(file.content) - excess - 8);
    const bounded = boundedText(file.content, keepTokens * TEXT_BYTES_PER_TOKEN);
    file.content = bounded.text;
    file.truncated = bounded.truncated;
    file.includedBytes = Buffer.byteLength(file.content, 'utf8');
    file.includedTokens = estimateTokens(file.content);
    estimatedTokens = estimateTokens(pack);
    truncated = truncated || bounded.truncated;
  }
  while (estimatedTokens > budget && pack.files.length) {
    const removable = [...pack.files]
      .sort((left, right) => left.priority - right.priority || right.path.localeCompare(left.path))
      .find((file) => file.priority < CONTEXT_FILE_PRIORITY.active);
    if (!removable) break;
    pack.files = pack.files.filter((file) => file !== removable);
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  while (estimatedTokens > budget && pack.decisions.length) {
    pack.decisions.shift();
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  if (estimatedTokens > budget && pack.evidence.length) {
    pack.evidence = pack.evidence.map((item) => ({ id: item.id, kind: item.kind, verificationStatus: item.verificationStatus }));
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  if (estimatedTokens > budget && pack.evidenceGraph) {
    pack.evidenceGraph = { relations: pack.evidenceGraph.relations || [] };
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  if (estimatedTokens > budget) {
    pack.instructions.warnings = pack.warnings.map((warning) => warning.code);
    pack.files = pack.files.map(({ expectedHash, bytes, includedBytes, includedTokens, ...file }) => file);
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  if (estimatedTokens > budget) {
    const availableBytes = Math.max(0, Math.floor(budget * TEXT_BYTES_PER_TOKEN / 2));
    const prompt = boundedText(pack.instructions.prompt, availableBytes);
    pack.instructions.prompt = prompt.text;
    pack.instructions.promptTruncated = prompt.truncated;
    pack.instructions.human = boundedText(pack.instructions.human, availableBytes).text;
    pack.selection = boundedText(pack.selection, availableBytes).text;
    pack.compileLog = boundedText(pack.compileLog, availableBytes).text;
    estimatedTokens = estimateTokens(pack);
    truncated = true;
  }
  pack.budget.estimatedTokens = estimatedTokens;
  pack.budget.truncated = truncated;
  return { pack, estimatedTokens, truncated };
}

/** Build the exact, constrained context that a Harness Adapter receives. */
export async function buildContextPack({ projectId, projectRoot: providedRoot, request = {}, policy = {}, constraints = {}, workflow: providedWorkflow } = {}) {
  const projectRoot = providedRoot || await getProjectRoot(projectId);
  const workflow = providedWorkflow || await readWorkflow(projectRoot);
  const ledgerResult = await readJsonIfExists(projectRoot, [
    path.join('.scienceprism', 'evidence-ledger.json'),
    path.join('.scienceprism', 'evidence.json')
  ]);
  const ledger = Array.isArray(ledgerResult.value) ? ledgerResult.value : ledgerResult.value?.entries;
  const ledgerRelations = Array.isArray(ledgerResult.value?.relations)
    ? ledgerResult.value.relations
    : Array.isArray(ledgerResult.value?.relationships) ? ledgerResult.value.relationships : [];
  const evidence = collectConfirmedEvidence({ request, ledger, workflow });
  const confirmedIds = new Set(evidence.map((item) => item.id));
  const evidenceGraph = {
    nodes: evidence.map((item) => ({ id: item.id, kind: item.kind, version: item.version || item.sha256 || null })),
    relations: ledgerRelations.filter((relation) => confirmedIds.has(relation.fromId) && confirmedIds.has(relation.toId)).map((relation) => ({
      id: relation.id,
      type: relation.type,
      fromId: relation.fromId,
      toId: relation.toId,
      evidenceIds: relation.evidenceIds || []
    }))
  };
  const decisions = collectRecentDecisions({ request, workflow });
  const stage = normalizeStage(request.stage);
  const requested = getPriorityPathItems(request.contextFiles || request.files);
  const configuredPriority = getPriorityPathItems(constraints.contextFilePriority || constraints.filePriority);
  const available = await listFiles(projectRoot);
  const candidatePaths = [...new Set([
    ...requested.map((item) => item.path),
    request.activePath,
    ...available
  ].filter(Boolean))]
    .sort((left, right) => {
      const leftPriority = filePriority(left, { activePath: request.activePath, requested, configuredPriority, stage }).score;
      const rightPriority = filePriority(right, { activePath: request.activePath, requested, configuredPriority, stage }).score;
      return rightPriority - leftPriority || left.localeCompare(right);
    })
    .slice(0, MAX_CONTEXT_FILE_CANDIDATES);
  const fileCandidates = (await Promise.all(candidatePaths.map((filePath) => createFileCandidate(projectRoot, filePath, {
    policy,
    requested,
    configuredPriority,
    activePath: request.activePath,
    stage
  })))).filter(Boolean).sort((left, right) => right.priority - left.priority || left.path.localeCompare(right.path));
  const budget = Number(request.contextTokenBudget || constraints.contextTokenBudget || policy.constraints?.contextTokenBudget || DEFAULT_CONTEXT_TOKEN_BUDGET);
  const safeBudget = Number.isFinite(budget) ? Math.max(256, Math.min(200_000, Math.floor(budget))) : DEFAULT_CONTEXT_TOKEN_BUDGET;
  const skillMetadata = Array.isArray(request.researchSkillMetadata) ? request.researchSkillMetadata : [];
  const skills = skillMetadata.length ? skillMetadata : normalizeList(request.researchSkills).map((name) => ({ name, description: '', stages: stage ? [stage] : [] }));
  const stageContract = request.stageContract || RESEARCH_STAGE_CONTRACTS[normalizeResearchStage(request.stage || stage)] || null;
  const contextInputs = {
    ...request,
    stage,
    constraints,
    policy,
    workflowVersion: workflow?.version
  };
  const preliminaryWarnings = buildWarnings({ request: contextInputs, files: fileCandidates, evidence, workflow, ledgerError: ledgerResult.error, policy });
  const projectConstraints = {
    capabilities: policy.granted || [],
    deniedCapabilities: policy.denied || [],
    allowedPaths: policy.allowedPaths || [],
    networkAllowlist: policy.networkAllowlist || [],
    contextTokenBudget: safeBudget,
    maxTokens: policy.constraints?.maxTokens ?? constraints.maxTokens ?? null,
    timeoutMs: policy.constraints?.timeoutMs ?? constraints.timeoutMs ?? null,
    maxConcurrent: policy.constraints?.maxConcurrent ?? constraints.maxConcurrent ?? null,
    retryLimit: policy.constraints?.retryLimit ?? constraints.retryLimit ?? null,
    fallback: policy.constraints?.fallback ?? constraints.fallback !== false
  };
  const pack = buildContextWithoutHash({
    stage,
    task: request.task,
    activePath: normalizeRelativePath(request.activePath) || request.activePath,
    prompt: request.prompt,
    humanInstructions: request.humanInstructions,
    selection: request.selection,
    compileLog: request.compileLog,
    files: fileCandidates,
    evidence,
    evidenceGraph,
    decisions,
    skills,
    stageContract,
    warnings: preliminaryWarnings.warnings,
    prompts: preliminaryWarnings.prompts,
    budget: safeBudget,
    workflowVersion: workflow?.version,
    projectConstraints
  });
  // Reserve space for the final hash and timestamp while keeping the configured
  // budget as the externally visible ceiling.
  const packingBudget = Math.max(128, safeBudget - 64);
  const result = truncateToBudget(pack, packingBudget);
  result.pack.budget.estimatedTokens = estimateTokens(result.pack);
  let contextHash = hashValue({ ...result.pack, generatedAt: undefined, contextHash: undefined });
  const staleHash = request.expectedContextHash && request.expectedContextHash !== contextHash;
  if (staleHash && !result.pack.warnings.some((warning) => warning.code === 'STALE_CONTEXT')) {
    result.pack.warnings.push({ code: 'STALE_CONTEXT', message: 'The supplied context hash does not match the generated context pack; treat this Run as stale.' });
    result.pack.instructions.warnings.push('The supplied context hash does not match the generated context pack; treat this Run as stale.');
  }
  result.pack.budget.estimatedTokens = estimateTokens(result.pack);
  contextHash = hashValue({ ...result.pack, generatedAt: undefined, contextHash: undefined });
  result.pack.contextHash = contextHash;
  result.pack.generatedAt = new Date().toISOString();
  result.pack.budget.estimatedTokens = estimateTokens(result.pack);
  return result.pack;
}

export function contextManifest(contextPack) {
  if (!contextPack) return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    contextHash: null,
    files: [],
    evidenceIds: [],
    decisionIds: [],
    warnings: []
  };
  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    contextHash: contextPack.contextHash || null,
    generatedAt: contextPack.generatedAt || null,
    stage: contextPack.stage || null,
    task: contextPack.task || null,
    activePath: contextPack.activePath || null,
    budget: clone(contextPack.budget || {}),
    files: (contextPack.files || []).map((file) => ({
      path: file.path,
      priority: file.priority,
      reason: file.reason,
      sha256: file.sha256,
      bytes: file.bytes,
      includedBytes: file.includedBytes ?? Buffer.byteLength(file.content || '', 'utf8'),
      includedTokens: file.includedTokens ?? estimateTokens(file.content || ''),
      truncated: Boolean(file.truncated)
    })),
    evidenceIds: (contextPack.evidence || []).map((item) => item.id),
    evidenceGraph: {
      nodeIds: (contextPack.evidenceGraph?.nodes || []).map((node) => node.id),
      relationIds: (contextPack.evidenceGraph?.relations || []).map((relation) => relation.id).filter(Boolean)
    },
    decisionIds: (contextPack.decisions || []).map((item) => item.id).filter(Boolean),
    skills: (contextPack.instructions?.skills || []).map((skill) => skill.name || skill),
    stageContract: clone(contextPack.instructions?.stageContract || null),
    warnings: clone(contextPack.warnings || [])
  };
}

export { estimateTokens, hashValue };
