#!/usr/bin/env node
/**
 * Experiment: where does evidence grounding actually come from?
 *
 * Research question
 * -----------------
 * A pipeline can ask a model to cite evidence (prompt), or refuse output that
 * does not (code). This project does both, and since iteration 044 it also feeds
 * a rejection back for one repair attempt. The question is which of those three
 * mechanisms actually changes what comes out, and which only changes what is
 * accepted.
 *
 * Design
 * ------
 * Three arms, same model, same research question, same Evidence Ledger, eight
 * independent generations each:
 *
 *   A no-gate     the evidence instruction is removed from the prompt and
 *                 nothing is enforced
 *   B prompt-only the instruction is present, nothing is enforced
 *   C enforced    the instruction is present AND the project validates the
 *                 output, rejecting undeclared unsupported claims and offering
 *                 one repair attempt (the shipped behaviour)
 *
 * A and B differ by the prompt; B and C differ by enforcement plus feedback. So
 * B-vs-A measures what asking buys, and C-vs-B measures what refusing and
 * retrying buys on top of asking.
 *
 * Measurement uses the product's own validator (parseResearchStageOutput and
 * validateStageEvidence), so the instrument is the thing under study rather than
 * a reimplementation of it.
 *
 * U-20: calls are strictly serial. The gateway is shared with the DSH session,
 * so this never issues two requests at once.
 *
 * Usage: SCIENCEPRISM_DATA_DIR=<repo>/aidoc node scripts/experiment-evidence-gate.mjs [reps]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
process.env.SCIENCEPRISM_DATA_DIR = process.env.SCIENCEPRISM_DATA_DIR || path.join(REPO_ROOT, 'aidoc');

const REPS = Number(process.argv[2]) || 8;
const PROJECT_ID = 'aidoc-research-document';

const { callOpenAICompatible } = await import('../apps/backend/src/services/llmService.js');
const { getEvidenceLedger } = await import('../apps/backend/src/services/evidenceLedger/index.js');
const { validateStageEvidence } = await import('../apps/backend/src/services/evidenceLedger/index.js');
const { parseResearchStageOutput } = await import('../apps/backend/src/services/researchResearch/schemas.js');
const { buildResearchHarnessPrompt } = await import('../apps/backend/src/services/researchResearch/harnessAdapter.js');
const { runResearchHarnessStage } = await import('../apps/backend/src/services/researchResearch/harnessAdapter.js');

const RESEARCH_QUESTION = 'Does requiring every claim to cite retrieved evidence reduce unsupported assertions in a generated research brief?';
const OUT = path.join(REPO_ROOT, 'aidoc', 'experiment-evidence-gate.json');

const ledger = await getEvidenceLedger(PROJECT_ID);
const confirmed = ledger.entries.filter((entry) => entry.kind === 'paper' && entry.verificationStatus === 'human-confirmed');
const knownEvidenceIds = new Set(ledger.entries.map((entry) => entry.id));
console.log(`evidence ledger: ${ledger.entries.length} entries, ${confirmed.length} human-confirmed papers`);
console.log(`arms: A no-gate | B prompt-only | C enforced   (${REPS} generations each, strictly serial)`);

// Arm D removes the evidence list from the input entirely. Arms A-C all show a
// claim-evidence coverage of 1.0 because the ids are sitting in the context, so
// citation costs the model nothing. Only when there is nothing to cite can the
// gate's value show: either the model fabricates ids, or it declares the claims
// unsupported, and enforcement decides which of those survives.
const INPUT = {
  researchQuestion: RESEARCH_QUESTION,
  availableEvidence: confirmed.map((entry) => ({ id: entry.id, summary: String(entry.summary || '').slice(0, 400) }))
};

/** Arm C uses the shipped prompt; arms A and B use it with the evidence rule removed for A. */
const EVIDENCE_RULE = /^Every Paper Claim must cite existing confirmed Evidence.*$/m;

function promptFor(arm) {
  const full = buildResearchHarnessPrompt({
    stage: 'writing_brief',
    input: INPUT,
    humanInstructions: 'Write the writing brief for the research question. Cite only Evidence ids that exist in the ledger.'
  });
  return arm === 'no-gate' ? full.replace(EVIDENCE_RULE, 'Return a writing brief as JSON.').replace(/\n{3,}/g, '\n\n') : full;
}

function measure(reply) {
  const parsed = parseResearchStageOutput('writing_brief', reply || '');
  const claims = Array.isArray(parsed?.data?.claims) ? parsed.data.claims : [];
  const allIds = claims.flatMap((claim) => (Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : []).map(String));
  return {
    jsonValid: Boolean(parsed?.ok),
    claimsTotal: claims.length,
    claimsWithEvidence: claims.filter((claim) => Array.isArray(claim?.evidenceIds) && claim.evidenceIds.length > 0).length,
    evidenceRefs: allIds.length,
    fabricatedIds: allIds.filter((id) => !knownEvidenceIds.has(id)),
    declaredUnsupported: Array.isArray(parsed?.data?.unsupportedClaims) ? parsed.data.unsupportedClaims.length : 0,
    limitations: Array.isArray(parsed?.data?.limitations) ? parsed.data.limitations.length : 0
  };
}

async function generate(prompt) {
  const completion = await callOpenAICompatible({
    messages: [
      { role: 'system', content: 'You are an assistant in a human-led research workflow. Return JSON only.' },
      { role: 'user', content: prompt }
    ]
  });
  return completion?.ok ? String(completion.content || '') : '';
}

const NO_EVIDENCE_INPUT = { researchQuestion: RESEARCH_QUESTION };

const rows = [];
for (const arm of ['no-gate', 'prompt-only', 'enforced', 'enforced-no-evidence']) {
  for (let rep = 1; rep <= REPS; rep += 1) {
    const started = Date.now();
    let reply = '';
    let accepted = null;
    let attempts = null;

    if (arm === 'enforced' || arm === 'enforced-no-evidence') {
      // The shipped path: validation plus one repair attempt, measured by the product.
      const result = await runResearchHarnessStage({
        stage: 'writing_brief',
        projectId: PROJECT_ID,
        input: arm === 'enforced-no-evidence' ? NO_EVIDENCE_INPUT : INPUT,
        humanInstructions: 'Write the writing brief for the research question.',
        runHarness: async ({ prompt }) => ({ ok: true, reply: await generate(prompt), runId: null })
      });
      reply = result.reply || '';
      accepted = Boolean(result.ok);
      attempts = (result.attempts || []).length;
    } else {
      reply = await generate(promptFor(arm === 'enforced-no-evidence' ? 'enforced' : arm));
      const parsed = parseResearchStageOutput('writing_brief', reply);
      const evidence = parsed.ok ? await validateStageEvidence(PROJECT_ID, 'writing_brief', parsed.data) : { ok: false };
      accepted = Boolean(parsed.ok && evidence.ok);
      attempts = 1;
    }

    const metrics = measure(reply);
    rows.push({ arm, rep, accepted, attempts, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), ...metrics });
    const line = `  ${arm.padEnd(12)} ${String(rep).padStart(2)}/${REPS}  json=${metrics.jsonValid ? 'y' : 'n'}  claims=${metrics.claimsTotal}  withEvidence=${metrics.claimsWithEvidence}  fabricated=${metrics.fabricatedIds.length}  accepted=${accepted}`;
    console.log(line);
  }
}

const summary = {};
for (const arm of ['no-gate', 'prompt-only', 'enforced', 'enforced-no-evidence']) {
  const armRows = rows.filter((row) => row.arm === arm);
  const mean = (key) => Number((armRows.reduce((sum, row) => sum + row[key], 0) / armRows.length).toFixed(2));
  const claimTotal = armRows.reduce((sum, row) => sum + row.claimsTotal, 0);
  const withEvidence = armRows.reduce((sum, row) => sum + row.claimsWithEvidence, 0);
  const refs = armRows.reduce((sum, row) => sum + row.evidenceRefs, 0);
  const fabricated = armRows.reduce((sum, row) => sum + row.fabricatedIds.length, 0);
  summary[arm] = {
    generations: armRows.length,
    jsonValidRate: Number((armRows.filter((row) => row.jsonValid).length / armRows.length).toFixed(2)),
    acceptedRate: Number((armRows.filter((row) => row.accepted).length / armRows.length).toFixed(2)),
    meanClaims: mean('claimsTotal'),
    claimEvidenceCoverage: claimTotal ? Number((withEvidence / claimTotal).toFixed(2)) : 0,
    evidenceRefsPerGeneration: Number((refs / armRows.length).toFixed(2)),
    fabricatedIdsTotal: fabricated,
    fabricationRate: refs ? Number((fabricated / refs).toFixed(3)) : 0,
    meanDeclaredUnsupported: mean('declaredUnsupported'),
    meanLimitations: mean('limitations'),
    meanSeconds: mean('seconds')
  };
}

await fs.writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), model: process.env.SCIENCEPRISM_LLM_MODEL, reps: REPS, researchQuestion: RESEARCH_QUESTION, summary, rows }, null, 2)}\n`, 'utf8');

console.log('\n=== summary ===');
console.log('arm          jsonOK  accepted  claims  evidenceCoverage  refs/gen  fabricated  declared');
for (const arm of ['no-gate', 'prompt-only', 'enforced', 'enforced-no-evidence']) {
  const s = summary[arm];
  console.log(`${arm.padEnd(12)} ${String(s.jsonValidRate).padEnd(7)} ${String(s.acceptedRate).padEnd(9)} ${String(s.meanClaims).padEnd(7)} ${String(s.claimEvidenceCoverage).padEnd(17)} ${String(s.evidenceRefsPerGeneration).padEnd(9)} ${String(s.fabricatedIdsTotal).padEnd(11)} ${s.meanDeclaredUnsupported}`);
}
console.log(`\nraw rows: ${path.relative(REPO_ROOT, OUT)}`);
