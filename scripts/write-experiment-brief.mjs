#!/usr/bin/env node
/**
 * Writes the paper for the evidence-gate experiment, using the project's own
 * writing stage.
 *
 * The experiment is already in the Evidence Ledger as an `experiment-run`
 * entry, so the writing stage can cite it the same way it cites papers. The
 * instructions below are the only hand-authored part: what the document is
 * about. Everything after that — the prompt, the contract, the validation, the
 * repair retry, the artifact — is the product's.
 *
 * Usage: SCIENCEPRISM_DATA_DIR=<repo>/aidoc node scripts/write-experiment-brief.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/script-helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await loadDotEnv(REPO_ROOT);
process.env.SCIENCEPRISM_DATA_DIR = process.env.SCIENCEPRISM_DATA_DIR || path.join(REPO_ROOT, 'aidoc');

const projectId = process.argv[2] || 'aidoc-research-document';
const adapter = process.env.SCIENCEPRISM_ADAPTER || 'deepseek';

const { runUiAction } = await import('../apps/backend/src/services/researchWorkflow/application.js');
const { getResearchWorkflow } = await import('../apps/backend/src/services/researchWorkflow/index.js');
const { getEvidenceLedger } = await import('../apps/backend/src/services/evidenceLedger/index.js');

const ledger = await getEvidenceLedger(projectId);
const experiment = ledger.entries.find((entry) => entry.kind === 'experiment-run');
const paperIds = ledger.entries.filter((entry) => entry.kind === 'paper').map((entry) => entry.id);
const citableIds = [...new Set([experiment?.id, ...paperIds].filter(Boolean))];

console.log(`citable Evidence: ${citableIds.join(', ') || '(none)'}`);

const instructions = [
  'Write the writing brief for an empirical study of evidence grounding, not for the original retrieval-augmented-generation question.',
  'The study is an ablation with four arms and eight generations per arm, recorded as the experiment-run Evidence entry.',
  'Its findings are: with Evidence in the stage input, claim-evidence coverage was 1.00 in every arm and no id was fabricated, so citation cost the model nothing.',
  'The instruction to cite Evidence raised declared uncertainty about tenfold, while schema enforcement added almost nothing and never triggered a repair.',
  'With no Evidence in the input, every cited id was fabricated, enforcement rejected seven of eight generations, and the repair retry never repaired one.',
  'State the conclusion that prompt instruction changes declared honesty while code enforcement is what stops a fabricated citation from being accepted, and that the retry cannot repair a model that has nothing to cite.',
  'Every claim MUST cite only these existing Evidence ids in evidenceIds:',
  citableIds.join(', ') || '(none available)',
  'Do not invent Evidence ids. Record anything unsupported in unsupportedClaims.',
  'Note explicitly that the sample is eight generations per arm on a single research question, that the effect is therefore a pilot rather than an estimate, and that the no-evidence arm is the only one in which fabrication was possible.'
].join(' ');

console.log('running the writing stage with the real model (serial)');
const workflow = await runUiAction(projectId, { action: 'handoff-writing', adapter, humanInstructions: instructions }, 'human');

const stage = workflow?.stages?.find((item) => item.id === 'writing');
const task = stage?.task || stage?.data || {};
console.log('\n=== writing stage ===');
console.log(`status      : ${stage?.status}`);
console.log(`briefPath   : ${task.briefPath || '(none)'}`);
console.log(`claims      : ${(task.claims || []).length}`);
console.log(`unsupported : ${(task.unsupportedClaims || []).length}`);
console.log(`limitations : ${(task.limitations || []).length}`);
console.log(`validation  : ${task.validation?.ok === undefined ? '(n/a)' : task.validation.ok}`);
if (task.validation?.errors?.length) {
  for (const error of task.validation.errors.slice(0, 5)) console.log(`  - ${error.code || ''} ${error.message || ''}`);
}

const current = await getResearchWorkflow(projectId);
console.log(`workflow    : stage=${current.currentStage} version=${current.version}`);
