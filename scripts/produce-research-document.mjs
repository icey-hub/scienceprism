#!/usr/bin/env node
/**
 * Drives SciencePrism's own research workflow to produce a real document.
 *
 * This is not a test double: it calls the project's service layer
 * (researchWorkflow commands + application.runUiAction) with the configured
 * real model adapter, so the document it leaves behind is genuine tool output.
 *
 * Usage:
 *   node scripts/produce-research-document.mjs [projectId] ["research question"] ["scope"]
 *
 * Output lands in the repository's aidoc/ directory (R-15), including
 * research/writing-brief.md. The landing directory is pinned below rather than
 * inherited from .env, which is gitignored, so a fresh clone still writes tool
 * output where the requirement says. Override with SCIENCEPRISM_AIDOC_DIR.
 *
 * Calls are strictly serial: the configured gateway is shared with the DSH
 * session (U-20), so this script never issues concurrent model requests.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This project has no dotenv dependency, and config/constants.js reads the
// environment at import time, so .env must be applied before any import below.
async function loadDotEnv() {
  let text = '';
  try {
    text = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
await loadDotEnv();

// R-15: pin the document landing directory instead of inheriting it from the
// gitignored .env. config/constants.js reads the environment at import time, so
// this must happen before the imports below.
const { assertDocumentLandingPath, resolveDocumentLandingDir } = await import('../apps/backend/src/services/researchWorkflow/documentLanding.js');
const LANDING_DIR = resolveDocumentLandingDir(REPO_ROOT, { override: process.env.SCIENCEPRISM_AIDOC_DIR });
process.env.SCIENCEPRISM_DATA_DIR = LANDING_DIR;

const projectId = process.argv[2] || 'aidoc-research-document';
const researchQuestion = process.argv[3] || 'How can retrieval-augmented generation keep every generated claim traceable to a verifiable source?';
const scope = process.argv[4] || 'Evidence provenance and unsupported-claim suppression in retrieval-augmented generation.';
const searchQuery = process.env.SCIENCEPRISM_SEARCH_QUERY || 'retrieval augmented generation attribution provenance';
const adapter = process.env.SCIENCEPRISM_ADAPTER || 'deepseek';

const { DATA_DIR } = await import('../apps/backend/src/config/constants.js');
const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow } = await import('../apps/backend/src/services/researchWorkflow/commands.js');
const { runUiAction } = await import('../apps/backend/src/services/researchWorkflow/application.js');
const { getResearchWorkflow } = await import('../apps/backend/src/services/researchWorkflow/index.js');
const { getEvidenceLedger } = await import('../apps/backend/src/services/evidenceLedger/index.js');

const projectRoot = path.join(DATA_DIR, projectId);

function log(step, detail) {
  console.log(`[${new Date().toISOString()}] ${step}${detail ? ` — ${detail}` : ''}`);
}

function stageData(workflow, stageId) {
  return workflow.stages.find((stage) => stage.id === stageId)?.data || {};
}

function assertTaskOk(workflow, stageId, label) {
  const data = stageData(workflow, stageId);
  const task = data.task;
  if (!task) throw new Error(`${label}: no stage task was recorded.`);
  if (task.status === 'failed') {
    throw new Error(`${label}: stage task failed — ${JSON.stringify(task.error || task.validation || {})}`);
  }
  if (task.validation && task.validation.ok === false) {
    throw new Error(`${label}: output failed validation — ${JSON.stringify(task.validation.errors || [])}`);
  }
  log(`  ${label}`, `task.status=${task.status} harness=${task.harness?.ok === true ? 'ok' : String(task.harness?.ok)}`);
  return data;
}

async function approve(stageId, note) {
  const workflow = await getResearchWorkflow(projectId);
  return approveResearchWorkflow(projectId, {
    stageId,
    expectedVersion: workflow.version,
    idempotencyKey: `${stageId}-${workflow.version}`,
    note
  });
}

async function main() {
  await fs.mkdir(projectRoot, { recursive: true });
  const metaPath = path.join(projectRoot, 'project.json');
  try {
    await fs.access(metaPath);
  } catch {
    await fs.writeFile(metaPath, `${JSON.stringify({ id: projectId, name: 'aidoc research document', createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  log('start', `projectId=${projectId} adapter=${adapter}`);
  log('  dataDir', DATA_DIR);
  log('  model', `${process.env.SCIENCEPRISM_LLM_MODEL} @ ${process.env.SCIENCEPRISM_LLM_ENDPOINT}`);

  let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion } });
  workflow = await updateResearchWorkflow(projectId, {
    stageId: 'direction',
    data: { researchQuestion, scope, acceptanceCriteria: ['Every claim cites a source-backed Evidence entry.'] },
    expectedVersion: workflow.version,
    idempotencyKey: 'direction-update'
  });
  log('direction', 'human-owned direction recorded');
  workflow = await approve('direction', 'human approved the research direction');

  log('search', 'running the search stage with the real model (1/4 model calls)');
  workflow = await runUiAction(projectId, {
    action: 'search',
    query: searchQuery,
    direction: { question: researchQuestion, scope },
    adapter,
    policy: { venueLevel: 'Any', publicationType: 'Any', peerReviewed: false, requireCode: false }
  }, 'human');
  const search = assertTaskOk(workflow, 'search', 'search');
  const papers = search.papers || [];
  const accepted = (search.evaluations || []).filter((item) => item.decision === 'accept');
  log('  search', `papers=${papers.length} acceptedByQualityGate=${accepted.length} sources=${JSON.stringify(search.sources || [])}`);
  if (Array.isArray(search.sourceFailures) && search.sourceFailures.length) {
    log('  sourceFailures', JSON.stringify(search.sourceFailures.map((failure) => `${failure.source}:${failure.code}`)));
  }
  if (!accepted.length) throw new Error('The server-side quality gate accepted no paper, so the pipeline cannot continue.');
  workflow = await approve('search', 'human approved the search result');

  const paperIds = accepted.slice(0, 3).map((item) => String(item.id));
  log('selection', `selecting ${paperIds.length} quality-gated paper(s)`);
  workflow = await runUiAction(projectId, { action: 'select-papers', paperIds }, 'human');
  workflow = await approve('selection', 'human selected the papers');
  if (workflow.currentStage === 'replication') {
    workflow = await approveResearchWorkflow(projectId, {
      stageId: 'replication',
      decision: 'skip',
      expectedVersion: workflow.version,
      idempotencyKey: `replication-skip-${workflow.version}`,
      note: 'No replication run in this pipeline invocation.'
    });
    log('  replication', 'skipped (human decision)');
  }

  log('ideation', 'generating ideas with the real model (2/4 model calls)');
  workflow = await runUiAction(projectId, { action: 'generate-ideas', adapter, paperIds }, 'human');
  const ideas = assertTaskOk(workflow, 'ideation', 'ideation');
  const ideaId = ideas.ideas?.[0]?.id;
  if (!ideaId) throw new Error('The ideation stage produced no idea.');
  workflow = await approve('ideation', 'human approved one idea');

  log('method', 'generating method proposals with the real model (3/4 model calls)');
  workflow = await runUiAction(projectId, { action: 'generate-method', adapter, ideaIds: [ideaId] }, 'human');
  assertTaskOk(workflow, 'method', 'method');
  workflow = await approve('method', 'human approved the method');

  log('experiment', 'recording the experiment plan (no execution)');
  workflow = await runUiAction(projectId, {
    action: 'run-experiment',
    experiment: {
      dataset: 'held-out evaluation set of evidence-attribution questions',
      command: 'node run_experiment.mjs --config configs/evidence_gate.yaml',
      protocol: 'Compare evidence-gated retrieval against plain retrieval on unsupported-claim rate.',
      metrics: ['unsupported-claim rate'],
      status: 'planned'
    }
  }, 'human');
  workflow = await approve('experiment', 'human approved the experiment plan');

  const ledger = await getEvidenceLedger(projectId);
  const paperEvidenceIds = ledger.entries.filter((entry) => entry.kind === 'paper').map((entry) => entry.id);
  log('writing', `handing off to writing with ${paperEvidenceIds.length} paper Evidence id(s) (4/4 model calls)`);
  workflow = await runUiAction(projectId, {
    action: 'handoff-writing',
    adapter,
    humanInstructions: [
      'Write the writing brief for the approved direction.',
      'Every claim MUST cite only these existing Evidence ids in evidenceIds:',
      paperEvidenceIds.join(', ') || '(none available)',
      'Do not invent Evidence ids. Record anything unsupported in unsupportedClaims.'
    ].join(' ')
  }, 'human');
  const writing = assertTaskOk(workflow, 'writing', 'writing');

  const briefPath = writing.briefPath || 'research/writing-brief.md';
  const absoluteBrief = path.join(projectRoot, briefPath);
  // R-15: fail loudly rather than silently leaving the document somewhere the
  // requirement does not allow.
  const landingRelativePath = assertDocumentLandingPath(absoluteBrief, LANDING_DIR);
  const brief = await fs.readFile(absoluteBrief, 'utf8');
  log('done', `writing brief written: ${absoluteBrief} (${brief.length} chars)`);

  console.log('\n=== produced by the tool ===');
  console.log(`landing dir  : ${LANDING_DIR}`);
  console.log(`document     : ${landingRelativePath}`);
  console.log(`claims       : ${(writing.claims || []).length}`);
  console.log(`outline      : ${(writing.outline || []).join(' / ')}`);
  console.log(`limitations  : ${(writing.limitations || []).join(' | ')}`);
}

await main();
