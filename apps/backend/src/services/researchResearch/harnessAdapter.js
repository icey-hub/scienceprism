import { recordHarnessRunValidation, runHarnessRequest } from '../harnessRuntime/index.js';
import {
  getResearchStageSchema,
  normalizeResearchStage,
  parseResearchStageOutput,
  RESEARCH_STAGE_CONTRACTS,
  RESEARCH_STAGES
} from './schemas.js';
import { getResearchStageSkills, researchSkillPrompt } from './researchSkills.js';
import { validateStageEvidence } from '../evidenceLedger/index.js';

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

/** Build the deterministic instruction envelope for one research stage. */
export function buildResearchHarnessPrompt({ stage, input, humanInstructions, context, skills = [] } = {}) {
  const normalizedStage = normalizeResearchStage(stage);
  if (!RESEARCH_STAGES.includes(normalizedStage)) {
    throw new Error(`Unknown research stage: ${stage}`);
  }
  const contract = RESEARCH_STAGE_CONTRACTS[normalizedStage];
  return [
    'You are an assistant in a human-led research workflow.',
    'The human owns the research direction, paper selection, innovation choice, method approval, and final claims.',
    'Provide analysis and structured suggestions only. Never claim that an unverified metadata field or experiment result is verified.',
    'Return JSON only. Do not use Markdown fences, comments, or prose outside the JSON object.',
    'Every Paper Claim must cite existing confirmed Evidence by evidenceIds. If support is missing, add the item to unsupportedClaims and keep the claim explicitly unverified; never present speculation as a verified result.',
    `Research stage: ${normalizedStage}`,
    `Required output contract:\n${safeJson(contract)}`,
    `Stage-specific project skills:\n${researchSkillPrompt(normalizedStage, skills)}`,
    context ? `Known workflow context:\n${safeJson(context)}` : '',
    input ? `Stage input:\n${safeJson(input)}` : '',
    humanInstructions ? `Human instructions:\n${asText(humanInstructions)}` : '',
    'If evidence is missing, represent the uncertainty explicitly and add it to risks, caveats, limitations, or missingMetadata as appropriate.'
  ].filter(Boolean).join('\n\n');
}

/**
 * Stage adapter over the Harness Runtime. The stage owns its output contract;
 * the Runtime owns provider selection, lifecycle, isolation, and audit data.
 */
export async function runResearchHarnessStage({
  stage,
  projectId,
  input,
  humanInstructions,
  context,
  activePath,
  selection,
  compileLog,
  llmConfig,
  adapter,
  fakeResponse,
  fakeError,
  runHarness = runHarnessRequest
} = {}) {
  const normalizedStage = normalizeResearchStage(stage);
  if (!RESEARCH_STAGES.includes(normalizedStage)) {
    return {
      ok: false,
      stage,
      output: null,
      validation: {
        ok: false,
        errors: [{ path: 'stage', code: 'unknown_stage', message: `Unknown research stage: ${stage}` }]
      },
      reply: `Unknown research stage: ${stage}`
    };
  }
  if (!getResearchStageSchema(normalizedStage)) {
    return {
      ok: false,
      stage,
      output: null,
      validation: { ok: false, errors: [{ path: 'stage', code: 'missing_schema', message: `No schema for stage: ${stage}` }] },
      reply: `No schema for stage: ${stage}`
    };
  }

  const activeSkills = projectId ? await getResearchStageSkills(projectId, normalizedStage) : [];
  const harnessResult = await runHarness({
    projectId,
    stage: normalizedStage,
    activePath,
    task: `research:${normalizedStage}`,
    prompt: buildResearchHarnessPrompt({ stage: normalizedStage, input, humanInstructions, context, skills: activeSkills }),
    humanInstructions,
    input,
    context,
    stageContract: RESEARCH_STAGE_CONTRACTS[normalizeResearchStage(normalizedStage)],
    selection,
    compileLog,
    llmConfig,
    adapter,
    fakeResponse,
    fakeError,
    researchSkills: activeSkills.map((skill) => skill.name),
    researchSkillMetadata: activeSkills.map(({ name, description, stages }) => ({ name, description, stages })),
    capabilities: ['project.read']
  });
  const parsedValidation = parseResearchStageOutput(normalizedStage, harnessResult?.reply || '');
  const evidenceValidation = projectId && parsedValidation.ok
    ? await validateStageEvidence(projectId, normalizedStage, parsedValidation.data)
    : { ok: true, errors: [], warnings: [] };
  const validation = evidenceValidation.ok
    ? { ...parsedValidation, evidence: evidenceValidation }
    : { ...parsedValidation, ok: false, data: null, errors: [...parsedValidation.errors, ...evidenceValidation.errors], evidence: evidenceValidation };
  if (harnessResult?.runId) await recordHarnessRunValidation(projectId, harnessResult.runId, validation);
  return {
    ...harnessResult,
    ok: Boolean(harnessResult?.ok && validation.ok),
    stage,
    output: validation.ok ? validation.data : null,
    validation
  };
}

export const runResearchStage = runResearchHarnessStage;

/** Dependency-injection helper for routes/services that keep a configured runner. */
export function createResearchHarnessRunner({ runHarness = runHarnessRequest } = {}) {
  return (params) => runResearchHarnessStage({ ...params, runHarness });
}
