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
export function buildResearchHarnessPrompt({ stage, input, humanInstructions, context, skills = [], repair } = {}) {
  const normalizedStage = normalizeResearchStage(stage);
  if (!RESEARCH_STAGES.includes(normalizedStage)) {
    throw new Error(`Unknown research stage: ${stage}`);
  }
  const contract = RESEARCH_STAGE_CONTRACTS[normalizedStage];
  const contractFields = Array.isArray(contract?.fields) ? contract.fields : [];
  const contractRules = Array.isArray(contract?.rules) ? contract.rules : [];
  const contractNotes = Array.isArray(contract?.notes) ? contract.notes : [];
  return [
    'You are an assistant in a human-led research workflow.',
    'The human owns the research direction, paper selection, innovation choice, method approval, and final claims.',
    // "Provide analysis and structured suggestions only" used to sit here as
    // prompt text. It is now enforced by the role: the research stage runs as
    // `research-stage-assistant`, whose only capability is project.read, so the
    // Run structurally cannot propose a Patch.
    'Never claim that an unverified metadata field or experiment result is verified.',
    'Return JSON only. Do not use Markdown fences, comments, or prose outside the JSON object.',
    'Every Paper Claim must cite existing confirmed Evidence by evidenceIds. If support is missing, add the item to unsupportedClaims and keep the claim explicitly unverified; never present speculation as a verified result.',
    `Research stage: ${normalizedStage}`,
    `Required output fields (name: type) for ${normalizedStage}:`,
    contractFields.length ? contractFields.map((line) => `- ${line}`).join('\n') : '- (no contract available)',
    'Output contract rules:',
    contractRules.length ? contractRules.map((rule) => `- ${rule}`).join('\n') : '- Return only the fields listed above.',
    contractNotes.length ? `Field semantics:\n${contractNotes.map((note) => `- ${note}`).join('\n')}` : '',
    `Stage-specific project skills:\n${researchSkillPrompt(normalizedStage, skills)}`,
    context ? `Known workflow context:\n${safeJson(context)}` : '',
    input ? `Stage input:\n${safeJson(input)}` : '',
    humanInstructions ? `Human instructions:\n${asText(humanInstructions)}` : '',
    // C-05: a reply that failed the contract gets one repair attempt, with the
    // validation errors quoted back. Without this the model never learns why the
    // output was rejected.
    repair ? `Your previous reply was rejected:\n${asText(repair)}` : '',
    'If evidence is missing, represent the uncertainty explicitly and add it to risks, caveats, limitations, or missingMetadata as appropriate.'
  ].filter(Boolean).join('\n\n');
}

/**
 * A validation failure is worth one repair attempt; a transport failure is not
 * retried here, because that is the Run limit's job.
 */
export const MAX_VALIDATION_ATTEMPTS = 2;

/** Quotes the validation errors back so the model can correct exactly them. */
export function validationRepairInstructions(validation) {
  const errors = (Array.isArray(validation?.errors) ? validation.errors : []).slice(0, 10);
  return [
    'Fix exactly these problems and reply with the corrected JSON object only.',
    ...(errors.length
      ? errors.map((error) => `- ${error?.path ? `${error.path}: ` : ''}${error?.message || 'invalid value'}`)
      : ['- The reply was not a valid JSON object for this stage.']),
    'Do not add commentary. Do not invent Evidence ids that do not exist in this project.'
  ].join('\n');
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
  const baseRequest = {
    projectId,
    stage: normalizedStage,
    activePath,
    task: `research:${normalizedStage}`,
    role: 'research-stage-assistant',
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
  };

  const attempt = async (repair) => {
    const harnessResult = await runHarness({
      ...baseRequest,
      prompt: buildResearchHarnessPrompt({ stage: normalizedStage, input, humanInstructions, context, skills: activeSkills, repair })
    });
    const parsedValidation = parseResearchStageOutput(normalizedStage, harnessResult?.reply || '');
    const evidenceValidation = projectId && parsedValidation.ok
      ? await validateStageEvidence(projectId, normalizedStage, parsedValidation.data)
      : { ok: true, errors: [], warnings: [] };
    const validation = evidenceValidation.ok
      ? { ...parsedValidation, evidence: evidenceValidation }
      : { ...parsedValidation, ok: false, data: null, errors: [...parsedValidation.errors, ...evidenceValidation.errors], evidence: evidenceValidation };
    if (harnessResult?.runId) await recordHarnessRunValidation(projectId, harnessResult.runId, validation);
    return { harnessResult, validation };
  };

  // C-05: a reply that breaks the contract gets one repair attempt, with the
  // validation errors quoted back, so the model learns why it was rejected.
  // Only validation failures are retried — a transport failure is the Run
  // limit's business. Calls stay strictly serial (U-20): the retry is awaited
  // and never issued alongside the first attempt.
  const attempts = [];
  let { harnessResult, validation } = await attempt(null);
  attempts.push({ attempt: 1, ok: validation.ok, runId: harnessResult?.runId ?? null, errorCodes: (validation.errors || []).map((error) => error?.code) });

  if (!validation.ok && harnessResult?.ok && attempts.length < MAX_VALIDATION_ATTEMPTS) {
    ({ harnessResult, validation } = await attempt(validationRepairInstructions(validation)));
    attempts.push({ attempt: 2, ok: validation.ok, runId: harnessResult?.runId ?? null, errorCodes: (validation.errors || []).map((error) => error?.code) });
  }

  return {
    ...harnessResult,
    ok: Boolean(harnessResult?.ok && validation.ok),
    stage,
    output: validation.ok ? validation.data : null,
    validation: { ...validation, attempts },
    attempts
  };
}

export const runResearchStage = runResearchHarnessStage;

/** Dependency-injection helper for routes/services that keep a configured runner. */
export function createResearchHarnessRunner({ runHarness = runHarnessRequest } = {}) {
  return (params) => runResearchHarnessStage({ ...params, runHarness });
}
