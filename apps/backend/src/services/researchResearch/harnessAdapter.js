import { runDeepSeekHarness } from '../deepseekHarnessService.js';
import {
  getResearchStageSchema,
  normalizeResearchStage,
  parseResearchStageOutput,
  RESEARCH_STAGE_CONTRACTS,
  RESEARCH_STAGES
} from './schemas.js';
import { getResearchStageSkills, researchSkillPrompt } from './researchSkills.js';

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
 * Thin adapter over the existing DeepSeek Harness service.
 * It adds stage-level JSON validation but does not create another SDK client,
 * alter Harness configuration, or silently apply AI decisions.
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
  runHarness = runDeepSeekHarness
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
    activePath,
    task: `research:${normalizedStage}`,
    prompt: buildResearchHarnessPrompt({ stage: normalizedStage, input, humanInstructions, context, skills: activeSkills }),
    selection,
    compileLog,
    llmConfig,
    researchSkills: activeSkills.map((skill) => skill.name)
  });
  const validation = parseResearchStageOutput(normalizedStage, harnessResult?.reply || '');
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
export function createResearchHarnessRunner({ runHarness = runDeepSeekHarness } = {}) {
  return (params) => runResearchHarnessStage({ ...params, runHarness });
}
