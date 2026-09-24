import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-phase-ten-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { assertFeatureEnabled, getFeatureFlags, getProjectFeatureFlags } = await import('../src/services/featureFlags.js');
const { getProjectObservability, normalizeTokenUsage } = await import('../src/services/observability/index.js');
const { registerObservabilityRoutes } = await import('../src/routes/observability.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
const { buildContextPack, contextManifest } = await import('../src/services/harnessRuntime/contextPackager.js');
const { assertCapability, assertNetworkHost, assertProjectPath, isPathAllowed, resolveCapabilityPolicy, HARNESS_CAPABILITIES, DEFAULT_PROJECT_CAPABILITIES } = await import('../src/services/harnessRuntime/capabilities.js');
const { evaluatePaperCandidate } = await import('../src/services/researchResearch/qualityGate.js');
const { parseResearchStageOutput, RESEARCH_STAGE_CONTRACTS, RESEARCH_STAGE_SCHEMAS, RESEARCH_STAGES, requiredResearchStageKeys, describeResearchStageFields } = await import('../src/services/researchResearch/schemas.js');
const { buildResearchHarnessPrompt, createResearchHarnessRunner } = await import('../src/services/researchResearch/harnessAdapter.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { toFrontendWorkflow } = await import('../src/services/researchWorkflow/projection.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/index.js');
const { migrateStoredWorkflow } = await import('../src/services/researchWorkflow/migrations.js');
const { upsertEvidence } = await import('../src/services/evidenceLedger/index.js');
const {
  COLLAB_STORAGE_KEY,
  migrateCollabName,
  migrateSettingsRecord,
  SETTINGS_STORAGE_KEY
} = await import('../../frontend/src/app/editor/settingsMigration.js');

async function createProject(projectId) {
  const root = path.join(dataDir, projectId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  return root;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    has(key) { return values.has(key); }
  };
}

test('quality gate and stage schema reject unsafe or incomplete structured output', () => {
  const rejected = evaluatePaperCandidate(
    { id: 'paper-1', title: 'Paper', authors: ['A'], abstract: 'Abstract', year: 2020, venue: 'Workshop', venueLevel: 'workshop', peerReviewed: false, hasCode: false, url: 'https://example.test/paper' },
    { requiredVenueLevels: ['A'], peerReviewedOnly: true, requireCode: true }
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.decision, 'reject');
  assert.ok(rejected.checks.some((check) => check.status === 'fail'));

  const invalid = parseResearchStageOutput('writing', JSON.stringify({ stage: 'writing_brief', title: 'Draft', claims: [], outline: [] }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length > 0);
});

test('workflow schema 2 and legacy .openprism storage migrate without dropping data', async () => {
  const projectId = 'phase10-legacy-workflow';
  const root = await createProject(projectId);
  const legacy = createWorkflowDocument(projectId, { data: { topic: 'legacy question' } });
  legacy.schemaVersion = 2;
  delete legacy.commandReceipts;
  await mkdir(path.join(root, '.openprism'), { recursive: true });
  await writeFile(path.join(root, '.openprism', 'research-workflow.json'), JSON.stringify(legacy));

  const loaded = await getResearchWorkflow(projectId);
  assert.equal(loaded.schemaVersion, 3);
  assert.equal(loaded.stages[0].data.topic, 'legacy question');
  assert.deepEqual(loaded.commandReceipts, {});
  assert.ok((await readFile(path.join(root, '.scienceprism', 'research-workflow.json'), 'utf8')).includes('"schemaVersion": 3'));

  const migrated = migrateStoredWorkflow(legacy, projectId);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.workflow.schemaVersion, 3);
});

test('Fake Harness capability, path safety, and context packaging stay fail closed', async () => {
  const projectId = 'phase10-harness-safety';
  const root = await createProject(projectId);
  await mkdir(path.join(root, 'sections'), { recursive: true });
  await writeFile(path.join(root, 'sections', 'intro.md'), 'A bounded context.');
  const policy = resolveCapabilityPolicy({ configured: ['project.read'] });
  assert.equal(isPathAllowed('sections/intro.md', policy), true);
  assert.equal(isPathAllowed('../outside.txt', policy), false);
  assert.equal(isPathAllowed('.env', policy), false);
  assert.throws(() => assertCapability(policy, 'experiment.execute'), (error) => error.code === 'CAPABILITY_DENIED');
  assert.throws(() => assertProjectPath('../outside.txt', policy), (error) => error.code === 'PATH_DENIED');

  const pack = await buildContextPack({
    projectId,
    projectRoot: root,
    request: { stage: 'direction', activePath: 'sections/intro.md', prompt: 'Use this file.' },
    policy,
    constraints: { contextTokenBudget: 80 }
  });
  assert.equal(pack.files[0].path, 'sections/intro.md');
  assert.equal(pack.contextHash.length, 64);
  assert.equal(contextManifest(pack).contextHash, pack.contextHash);
  assert.equal(contextManifest(pack).files[0].path, 'sections/intro.md');
});

test('feature flags can be opened or disabled by environment and project constraints', async () => {
  assert.equal(getFeatureFlags({ env: { SCIENCEPRISM_FEATURE_EXPERIMENT_EXECUTION: 'false' } }).experimentExecution, false);
  assert.equal(getFeatureFlags({ env: { SCIENCEPRISM_FEATURE_ADVANCED_HARNESS: '0' } }).advancedHarness, false);
  assert.throws(() => assertFeatureEnabled('experimentExecution', { env: { SCIENCEPRISM_FEATURE_EXPERIMENT_EXECUTION: 'off' } }), (error) => error.code === 'FEATURE_FLAG_DISABLED');

  const projectId = 'phase10-feature-flags';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({ featureFlags: { experimentExecution: false, advancedHarness: true } }));
  const flags = await getProjectFeatureFlags(projectId);
  assert.deepEqual(flags, { experimentExecution: false, advancedHarness: true });
});

test('browser storage migration promotes legacy settings and collaboration name', () => {
  const defaults = { llmModel: 'default', compileEngine: 'pdflatex' };
  const storage = memoryStorage({
    'openprism-settings-v1': JSON.stringify({ llmModel: 'legacy-model' }),
    'openprism-collab-name': 'Legacy Researcher'
  });
  const settings = migrateSettingsRecord(storage, defaults);
  assert.equal(settings.migrated, true);
  assert.equal(settings.settings.llmModel, 'legacy-model');
  assert.equal(storage.has(SETTINGS_STORAGE_KEY), true);
  assert.equal(migrateCollabName(storage), 'Legacy Researcher');
  assert.equal(storage.getItem(COLLAB_STORAGE_KEY), 'Legacy Researcher');
});

test('observability computes duration, tokens, failures, decisions, and missing evidence', async () => {
  const projectId = 'phase10-observability';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'harness-runs.json'), JSON.stringify({
    schemaVersion: 1,
    projectId,
    runs: [
      {
        id: 'run-completed', projectId, stage: 'writing', task: 'brief', adapter: 'fake', status: 'completed',
        startedAt: '2026-09-21T00:00:00.000Z', finishedAt: '2026-09-21T00:00:02.000Z', updatedAt: '2026-09-21T00:00:02.000Z',
        tokenUsage: { promptTokens: 12, completionTokens: 8 }, events: [{ type: 'turn/end' }], contextHash: 'abc', contextManifest: { files: [] },
        humanDecision: { status: 'rejected' }, error: null
      },
      {
        id: 'run-failed', projectId, stage: 'search', task: 'search', adapter: 'fake', status: 'failed',
        startedAt: '2026-09-21T00:01:00.000Z', finishedAt: '2026-09-21T00:01:03.000Z', updatedAt: '2026-09-21T00:01:03.000Z',
        tokenUsage: { inputTokens: 2, outputTokens: 3 }, events: [], contextHash: 'def', contextManifest: { files: [] },
        humanDecision: { status: 'accepted' }, error: { code: 'FAKE_FAILURE' }
      }
    ]
  }));
  await upsertEvidence(projectId, { id: 'claim-unsupported', kind: 'paper-claim', summary: 'Needs a source.', verificationStatus: 'pending', metadata: { evidenceIds: ['missing-source'] } });

  assert.deepEqual(normalizeTokenUsage({ promptTokens: 12, completionTokens: 8 }), { input: 12, output: 8, total: 20 });
  const result = await getProjectObservability(projectId);
  assert.equal(result.harness.tokens.total, 25);
  assert.equal(result.harness.failureRate, 0.5);
  assert.equal(result.harness.averageDurationMs, 2500);
  assert.equal(result.harness.humanRejectionRate, 0.5);
  assert.equal(result.evidence.missingEvidenceRate, 1);
  assert.equal(result.recentRuns[0].runId, 'run-failed');
  assert.equal(result.recentRuns[1].contextHash, 'abc');
});

test('observability and feature flag HTTP contracts expose stable envelopes', async () => {
  const projectId = 'phase10-http-contract';
  await createProject(projectId);
  const app = Fastify();
  registerObservabilityRoutes(app);
  const flags = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/feature-flags` });
  assert.equal(flags.statusCode, 200);
  assert.deepEqual(Object.keys(flags.json().featureFlags).sort(), ['advancedHarness', 'experimentExecution']);
  const metrics = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/observability?limit=1` });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.json().ok, true);
  assert.equal(metrics.json().observability.recentRuns.length, 0);
  await app.close();
});

test('workflow API contract returns the backend projection consumed by the frontend adapter', async () => {
  const projectId = 'phase10-workflow-contract';
  await createProject(projectId);
  const app = Fastify();
  registerResearchWorkflowRoutes(app);
  const initialized = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research-workflow`, payload: { data: { researchQuestion: 'Question' } } });
  assert.equal(initialized.statusCode, 201);
  const workflow = initialized.json().workflow;
  assert.equal(workflow.currentStage, 'direction');
  assert.equal(workflow.stages.find((stage) => stage.id === 'direction').state, 'active');
  const queried = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/research-workflow` });
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.json().workflow.version, workflow.version);
  await app.close();
});

test('workflow projection preserves the structured Experiment Plan contract', () => {
  const workflow = createWorkflowDocument('phase10-experiment-projection');
  const stage = workflow.stages.find((item) => item.id === 'experiment');
  stage.data = {
    dataset: 'dataset-1',
    datasetVersion: 'snapshot-2026-09-21',
    protocol: 'Evaluate the approved method.',
    command: 'node run.mjs',
    execution: { adapter: 'node', entrypoint: 'run.mjs', args: ['--once'] },
    parameters: { repetitions: 3 },
    seed: 7,
    successCriteria: ['accuracy >= 0.9'],
    artifacts: [{ path: 'results/metrics.json', kind: 'metric' }],
    status: 'planned',
    metrics: ['accuracy']
  };

  const projected = toFrontendWorkflow(workflow).experiment;

  assert.deepEqual(projected, stage.data);
});

test('the grantable capability vocabulary holds only enforceable capabilities', () => {
  // Locked on purpose: adding or removing a capability changes the security
  // surface, so it must be a deliberate edit of this assertion rather than a
  // silent drift in the vocabulary.
  assert.deepEqual([...HARNESS_CAPABILITIES].sort(), [
    'experiment.execute',
    'patch.propose',
    'project.read',
    'research.search'
  ]);
  assert.ok(!HARNESS_CAPABILITIES.includes('project.write'), 'project.write is grantable but never asserted anywhere');

  for (const capability of DEFAULT_PROJECT_CAPABILITIES) {
    assert.ok(HARNESS_CAPABILITIES.includes(capability), `default capability is missing from the vocabulary: ${capability}`);
  }

  // A stored grant for a capability outside the vocabulary is dropped rather
  // than silently honoured, so removing a capability cannot widen access.
  const policy = resolveCapabilityPolicy({ configured: ['project.read', 'project.write'] });
  assert.deepEqual(policy.configured, ['project.read']);
});

test('stage contracts are derived from their zod schema and cannot drift', () => {
  for (const stage of Object.keys(RESEARCH_STAGE_SCHEMAS)) {
    const schema = RESEARCH_STAGE_SCHEMAS[stage];
    const shape = schema._def.shape();
    const schemaKeys = Object.keys(shape).sort();

    const derivedFields = describeResearchStageFields(stage);
    const fieldKeys = derivedFields.map((line) => line.slice(0, line.indexOf(':'))).sort();
    assert.deepEqual(fieldKeys, schemaKeys, `${stage}: derived fields must cover every schema key`);

    assert.deepEqual(
      [...requiredResearchStageKeys(stage)].sort(),
      Object.entries(shape).filter(([, value]) => !['ZodOptional', 'ZodDefault'].includes(value._def.typeName)).map(([key]) => key).sort(),
      `${stage}: required keys must match the schema`
    );

    // The prompt-facing contract must stay in sync with the derivation.
    assert.deepEqual([...RESEARCH_STAGE_CONTRACTS[stage].fields], derivedFields);
    assert.deepEqual([...RESEARCH_STAGE_CONTRACTS[stage].required], requiredResearchStageKeys(stage));
  }
});

test('stage contract fields carry types, and the prompt states strictness', () => {
  const searchFields = describeResearchStageFields('search_strategy');
  assert.ok(searchFields.includes('queries: array of string (min 1)'), `unexpected queries field: ${searchFields.join(' | ')}`);
  assert.ok(searchFields.includes('sources: array of string (min 1)'), `unexpected sources field: ${searchFields.join(' | ')}`);
  assert.ok(searchFields.some((line) => line.startsWith('stage: ')), 'the stage discriminator must be described');

  const prompt = buildResearchHarnessPrompt({ stage: 'search', input: { researchQuestion: 'q' } });
  assert.match(prompt, /array of string/, 'the prompt must state element types');
  assert.match(prompt, /any additional key fails validation/, 'the prompt must state that unknown keys are rejected');
  assert.doesNotMatch(
    prompt,
    /Provide analysis and structured suggestions only/,
    'a rule the role now enforces structurally must not be restated as prompt text'
  );

  // Regression for the real-model failure this contract was written for: an
  // array of objects plus one unknown key is exactly what the model returned.
  const rejected = parseResearchStageOutput('search_strategy', {
    stage: 'search_strategy',
    researchQuestion: 'How can retrieval stay grounded?',
    humanDirection: 'long-context retrieval',
    aiAdditions: [],
    queries: [{ text: 'grounded retrieval' }],
    sources: [{ name: 'arxiv' }],
    rationale: 'Seeded from the direction.',
    deduplicationPlan: 'not part of the contract'
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.code === 'invalid_type'));
  assert.ok(rejected.errors.some((error) => error.code === 'unrecognized_keys'));
});

test('project constraint defaults have a single source of truth', async () => {
  const { PROJECT_CONSTRAINT_DEFAULTS } = await import('../src/config/projectConstraintDefaults.js');

  assert.deepEqual(PROJECT_CONSTRAINT_DEFAULTS.capabilities, DEFAULT_PROJECT_CAPABILITIES);
  assert.equal(PROJECT_CONSTRAINT_DEFAULTS.maxTokens, 49152);
  assert.equal(PROJECT_CONSTRAINT_DEFAULTS.timeoutMs, 10 * 60 * 1000);
  assert.equal(PROJECT_CONSTRAINT_DEFAULTS.maxConcurrent, 1);
  assert.equal(PROJECT_CONSTRAINT_DEFAULTS.retryLimit, 1);
  assert.equal(PROJECT_CONSTRAINT_DEFAULTS.contextTokenBudget, 12000);
  assert.deepEqual(Object.keys(PROJECT_CONSTRAINT_DEFAULTS).sort(), [
    'allowedPaths', 'capabilities', 'contextTokenBudget', 'fallback',
    'maxConcurrent', 'maxTokens', 'networkAllowlist', 'retryLimit', 'timeoutMs'
  ]);

  // Re-duplication guard. The values above used to be restated in four modules,
  // so the convergence only holds if a later edit cannot quietly add a fifth.
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const entries = await readdir(srcRoot, { recursive: true, withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    const relative = path.relative(srcRoot, absolute);
    if (relative === path.join('config', 'projectConstraintDefaults.js')) continue;
    const text = await readFile(absolute, 'utf8');
    if (/\b49152\b/.test(text)) offenders.push(`${relative}: restates maxTokens`);
    if (/\bDEFAULT_TIMEOUT_MS\b|\bDEFAULT_MAX_TOKENS\b|\bDEFAULT_MAX_CONCURRENT\b|\bDEFAULT_RETRY_LIMIT\b/.test(text)) {
      offenders.push(`${relative}: declares a local constraint default`);
    }
  }
  assert.deepEqual(offenders, [], 'constraint default limits must live only in config/projectConstraintDefaults.js');
});

test('the research stage contract vocabulary is locked', () => {
  assert.deepEqual([...RESEARCH_STAGES].sort(), [
    'experiment_plan',
    'experiment_results',
    'innovation_ideas',
    'method_proposals',
    'reproduction_plan',
    'search_strategy',
    'writing_brief'
  ]);

  // paper_screening was removed as a reduce beat: no code path ever ran it,
  // because paper selection is decided by the deterministic quality gate. It
  // was a full zod contract, prompt, and skill binding that nothing could reach.
  assert.ok(!RESEARCH_STAGES.includes('paper_screening'), 'a stage contract nothing runs must not come back');
  assert.equal(RESEARCH_STAGE_CONTRACTS.paper_screening, undefined);
});

test('the research stage runs under the research-stage-assistant role', async () => {
  let captured = null;
  const run = createResearchHarnessRunner({
    runHarness: async (request) => {
      captured = request;
      return { ok: false, reply: '', runId: null };
    }
  });

  await run({ stage: 'search_strategy', input: { researchQuestion: 'How can retrieval stay grounded?' } });

  assert.equal(captured.role, 'research-stage-assistant');
  assert.deepEqual(captured.capabilities, ['project.read'], 'the stage must not be able to propose a Patch');
});

test('the network allowlist fails closed, matching what the model is told', () => {
  const allowed = { granted: ['research.search'], networkAllowlist: ['export.arxiv.org'] };

  assert.equal(assertNetworkHost(allowed, 'https://export.arxiv.org/api/query?search_query=all:x'), 'export.arxiv.org');
  assert.throws(
    () => assertNetworkHost(allowed, 'https://example.com/collect'),
    (error) => error.code === 'NETWORK_DENIED'
  );
  assert.throws(
    () => assertNetworkHost({ granted: ['research.search'], networkAllowlist: [] }, 'https://export.arxiv.org/'),
    (error) => error.code === 'NETWORK_DENIED',
    'an empty allowlist must deny every host, which is what capabilityPrompt states'
  );
  assert.throws(
    () => assertNetworkHost({ granted: [], networkAllowlist: ['export.arxiv.org'] }, 'https://export.arxiv.org/'),
    (error) => error.code === 'CAPABILITY_DENIED'
  );
  assert.throws(
    () => assertNetworkHost(allowed, 'not-a-url'),
    (error) => error.code === 'NETWORK_DENIED'
  );
});
