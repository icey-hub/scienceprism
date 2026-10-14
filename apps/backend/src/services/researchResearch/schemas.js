import { z } from 'zod';
// The evidence vocabulary has one owner: the ledger schema. It used to be
// inlined here as well, so adding a kind or a status in one place silently
// disagreed with the other.
import { EVIDENCE_KINDS, VERIFICATION_STATUSES } from '../evidenceLedger/schema.js';

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty.regex(/^[A-Za-z0-9._:-]+$/, 'id contains unsupported characters');
const confidence = z.number().min(0).max(1);
const stage = (name) => z.literal(name);

const evidenceSchema = z.object({
  id,
  kind: z.enum(EVIDENCE_KINDS),
  referenceId: nonEmpty,
  summary: nonEmpty,
  location: z.string().trim().min(1).nullable().optional(),
  sourceUrl: z.string().trim().min(1).nullable().optional(),
  sourcePath: z.string().trim().min(1).nullable().optional(),
  acquiredAt: z.string().trim().min(1).nullable().optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).optional(),
  version: z.string().trim().min(1).nullable().optional(),
  sha256: z.string().trim().min(1).nullable().optional()
}).strict();

const paperReferenceSchema = z.object({
  paperId: nonEmpty,
  relevance: z.string().trim().min(1),
  evidence: z.array(evidenceSchema).default([])
}).strict();

const searchStrategySchema = z.object({
  stage: stage('search_strategy'),
  researchQuestion: nonEmpty,
  humanDirection: nonEmpty,
  aiAdditions: z.array(nonEmpty).default([]),
  queries: z.array(nonEmpty).min(1),
  sources: z.array(nonEmpty).min(1),
  inclusionCriteria: z.array(nonEmpty).default([]),
  exclusionCriteria: z.array(nonEmpty).default([]),
  rationale: nonEmpty
}).strict();

const reproductionPlanSchema = z.object({
  stage: stage('reproduction_plan'),
  paperId: nonEmpty,
  evaluationProtocol: z.object({ datasetSplit: nonEmpty.max(4000), metricExtraction: nonEmpty.max(4000), referenceLocation: nonEmpty.max(4000) }).strict().optional(),
  objective: nonEmpty,
  prerequisites: z.array(nonEmpty).default([]),
  datasets: z.array(nonEmpty).default([]),
  baselines: z.array(nonEmpty).default([]),
  metrics: z.array(nonEmpty).min(1),
  commands: z.array(nonEmpty).default([]),
  expectedOutputs: z.array(nonEmpty).min(1),
  risks: z.array(nonEmpty).default([]),
  humanApprovalRequired: z.literal(true)
}).strict();

const innovationIdeaSchema = z.object({
  id,
  title: nonEmpty,
  problem: nonEmpty,
  motivation: nonEmpty,
  hypothesis: nonEmpty,
  novelty: nonEmpty,
  relatedPaperIds: z.array(nonEmpty).default([]),
  validationPlan: z.array(nonEmpty).min(1),
  risks: z.array(nonEmpty).default([]),
  confidence: confidence.nullable().optional()
}).strict();

const innovationIdeasSchema = z.object({
  stage: stage('innovation_ideas'),
  humanDirection: nonEmpty,
  ideas: z.array(innovationIdeaSchema).min(1),
  comparison: z.array(z.object({
    ideaId: id,
    strengths: z.array(nonEmpty),
    weaknesses: z.array(nonEmpty),
    differentiator: nonEmpty
  }).strict()).default([]),
  caveats: z.array(nonEmpty).default([])
}).strict();

const methodProposalSchema = z.object({
  id,
  name: nonEmpty,
  ideaId: id,
  description: nonEmpty,
  components: z.array(nonEmpty).min(1),
  assumptions: z.array(nonEmpty).default([]),
  baselines: z.array(nonEmpty).min(1),
  metrics: z.array(nonEmpty).min(1),
  ablations: z.array(nonEmpty).default([]),
  implementationRisks: z.array(nonEmpty).default([])
}).strict();

const methodProposalsSchema = z.object({
  stage: stage('method_proposals'),
  selectedIdeaId: id,
  proposals: z.array(methodProposalSchema).min(1),
  recommendation: id.nullable().optional(),
  humanDecisionRequired: z.literal(true)
}).strict();

const experimentPlanSchema = z.object({
  stage: stage('experiment_plan'),
  methodId: id,
  datasetIds: z.array(nonEmpty).min(1),
  baselineIds: z.array(nonEmpty).default([]),
  metrics: z.array(z.object({
    name: nonEmpty,
    direction: z.enum(['maximize', 'minimize', 'target']),
    target: z.number().nullable().optional()
  }).strict()).min(1),
  ablations: z.array(z.object({
    id,
    description: nonEmpty,
    changedComponent: nonEmpty
  }).strict()).default([]),
  repetitions: z.number().int().min(1).max(100).default(1),
  seeds: z.array(z.number().int()).default([]),
  computeBudget: nonEmpty.nullable().optional(),
  successCriteria: z.array(nonEmpty).min(1),
  humanApprovalRequired: z.literal(true)
}).strict();

const experimentResultSchema = z.object({
  stage: stage('experiment_results'),
  runId: id,
  status: z.enum(['planned', 'running', 'completed', 'failed', 'cancelled']),
  metrics: z.record(z.string(), z.number().finite()).default({}),
  comparisons: z.array(z.object({
    baselineId: nonEmpty,
    metric: nonEmpty,
    delta: z.number(),
    interpretation: nonEmpty
  }).strict()).default([]),
  artifacts: z.array(z.object({
    id,
    kind: z.enum(['log', 'table', 'figure', 'checkpoint', 'environment', 'other']),
    path: nonEmpty
  }).strict()).default([]),
  observations: z.array(nonEmpty).default([]),
  limitations: z.array(nonEmpty).default([])
}).strict();

const writingBriefSchema = z.object({
  stage: stage('writing_brief'),
  title: nonEmpty,
  claims: z.array(z.object({
    id,
    text: nonEmpty,
    evidenceIds: z.array(nonEmpty).min(1),
    confidence: confidence
  }).strict()).min(1),
  outline: z.array(nonEmpty).min(1),
  citationPaperIds: z.array(nonEmpty).default([]),
  limitations: z.array(nonEmpty).default([]),
  unsupportedClaims: z.array(nonEmpty).default([])
}).strict();

const hypothesisPlanSchema = z.object({
  stage: stage('hypothesis_plan'), ideaId: id.max(200),
  hypothesis: z.object(Object.fromEntries(['problem', 'prediction', 'priorWork', 'conditions', 'falsificationCondition'].map(key => [key, z.string().max(4000)]))).strict(),
  evaluation: z.object({
    researchType: z.enum(['empirical', 'computational', 'theoretical']), dataset: z.string().max(500), datasetVersion: z.string().max(500), seed: z.string().max(100), split: z.string().max(4000),
    baselines: z.array(z.string().max(500)).max(30),
    metrics: z.array(z.object({ name: z.string().max(200), direction: z.enum(['increase', 'decrease', 'target']), threshold: z.number().finite().min(-1e100).max(1e100).nullable() }).strict()).max(30),
    repetitions: z.number().int().positive().max(1000).nullable(), ablations: z.array(z.string().max(500)).max(30),
    budget: z.object({ maxRuns: z.number().int().positive().max(10000).nullable(), maxSeconds: z.number().finite().positive().max(86400).nullable() }).strict()
  }).strict()
}).strict();

export const RESEARCH_STAGE_SCHEMAS = Object.freeze({
  hypothesis_plan: hypothesisPlanSchema,
  replication_analysis: z.object({ stage: stage('replication_analysis'), paperId: nonEmpty,
    rows: z.array(z.object({ metricName: nonEmpty.max(200), reportedValue: z.number().finite().nullable(),
      unit: z.string().max(100), referenceLocation: z.string().max(1000), reportedText: z.string().max(4000),
      causeHypothesis: z.string().max(4000), nextStep: z.string().max(4000),
      gapType: z.enum(['none', 'data-coverage', 'missing-control', 'generalization', 'missing-report', 'replication-failed']),
      tolerance: z.number().finite().nonnegative().nullable()
    }).strict()).min(1).max(50)
  }).strict(),
  environment_proposal:z.object({stage:stage('environment_proposal'),
    blockers:z.array(z.object({kind:z.enum(['entrypoint','dependency','runtime']),detail:nonEmpty}).strict()).max(20),
    deferred:z.array(z.object({kind:z.enum(['dataset','paper','protocol','evidence']),detail:nonEmpty}).strict()).max(20),
    reason:z.string().min(1).max(2000),packages:z.array(z.object({path:z.string().min(1).max(500),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(30)}).strict(),
  dataset_discovery: z.object({stage:stage('dataset_discovery'),missing:z.array(nonEmpty).max(20),candidates:z.array(z.object({
    paperId:nonEmpty,url:z.string().url().max(4096),filename:z.string().min(1).max(240),license:z.string().min(1).max(300).optional(),
    split:z.enum(['train','validation','test','unknown']).optional(),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    evidenceQuote:z.string().min(1).max(2000)
  }).strict()).max(5)}).strict(),
  paper_selection: z.object({ stage: stage('paper_selection'), paperIds: z.array(nonEmpty).min(1).max(5), rationale: nonEmpty }).strict(),
  execution_proposal: z.object({
    stage: stage('execution_proposal'), missing: z.array(nonEmpty),
    plan: z.object({
      dataset: nonEmpty, datasetVersion: nonEmpty, protocol: nonEmpty,
      execution: z.object({ adapter: z.enum(['node', 'python']), entrypoint: nonEmpty, args: z.array(z.string()).max(30), environmentId: z.string().regex(/^environment-[a-f0-9-]{36}$/).optional(), codePreparationId: z.string().regex(/^code-preparation-[a-f0-9]{64}$/).optional() }).strict(),
      seed: z.number().int(), successCriteria: z.array(nonEmpty).min(1),
      artifacts: z.array(z.object({ path: nonEmpty, kind: z.enum(['metric', 'output', 'chart', 'table']) }).strict()).max(20)
    }).strict().nullable()
  }).strict(),
  search_strategy: searchStrategySchema,
  reproduction_plan: reproductionPlanSchema,
  innovation_ideas: innovationIdeasSchema,
  method_proposals: methodProposalsSchema,
  experiment_plan: experimentPlanSchema,
  experiment_results: experimentResultSchema,
  writing_brief: writingBriefSchema
});

export const RESEARCH_STAGES = Object.freeze(Object.keys(RESEARCH_STAGE_SCHEMAS));

// Workflow persistence uses shorter names; keep the AI contract names stable
// while allowing routes to pass their existing stage identifiers directly.
export const RESEARCH_STAGE_ALIASES = Object.freeze({
  direction: 'search_strategy',
  search: 'search_strategy',
  replication: 'reproduction_plan',
  ideation: 'innovation_ideas',
  method: 'method_proposals',
  experiment: 'experiment_plan',
  writing: 'writing_brief'
});

export function normalizeResearchStage(stageName) {
  return RESEARCH_STAGE_ALIASES[stageName] || stageName;
}

export function getResearchStageSchema(stageName) {
  return RESEARCH_STAGE_SCHEMAS[normalizeResearchStage(stageName)] || null;
}

function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message
  }));
}

/** Validate already parsed AI output without throwing. */
export function validateResearchStageOutput(stageName, value) {
  const normalizedStage = normalizeResearchStage(stageName);
  const schema = getResearchStageSchema(normalizedStage);
  if (!schema) {
    return { ok: false, data: null, errors: [{ path: 'stage', code: 'unknown_stage', message: `Unknown research stage: ${stageName}` }] };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data, errors: [] }
    : { ok: false, data: null, errors: formatZodIssues(result.error) };
}

function stripJsonFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

/** Parse a Harness final response and validate it against the stage contract. */
export function parseResearchStageOutput(stageName, value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
  } catch (error) {
    return {
      ok: false,
      data: null,
      errors: [{ path: '', code: 'invalid_json', message: error instanceof Error ? error.message : String(error) }]
    };
  }
  return validateResearchStageOutput(stageName, parsed);
}

export const validateStageOutput = validateResearchStageOutput;

/**
 * Derives a readable, typed description of a stage contract from its zod schema.
 *
 * The previous hand-written `{ required: [...] }` summary listed field names
 * only. A real model then produced `queries: [{...}]` instead of `string[]` and
 * added unknown keys, which `.strict()` rejects -- so the stage failed for
 * reasons the prompt never mentioned. Deriving the description from the schema
 * keeps the prompt honest without introducing a second source of truth.
 *
 * This walks a small, fixed set of zod type tags and degrades to 'unknown'
 * rather than throwing, so a future schema change cannot break the prompt.
 */
function unwrapZodSchema(schema) {
  const modifiers = [];
  let current = schema;
  for (;;) {
    const typeName = current?._def?.typeName;
    if (typeName === 'ZodOptional') { modifiers.push('optional'); current = current._def.innerType; continue; }
    if (typeName === 'ZodNullable') { modifiers.push('nullable'); current = current._def.innerType; continue; }
    if (typeName === 'ZodDefault') { modifiers.push('has default'); current = current._def.innerType; continue; }
    return { schema: current, modifiers };
  }
}

function zodShapeOf(schema) {
  const shape = schema?._def?.shape;
  if (typeof shape === 'function') return shape();
  return shape && typeof shape === 'object' ? shape : null;
}

/** Renders one zod schema as a short type phrase for the Harness prompt. */
export function describeZodType(schema) {
  const { schema: base, modifiers } = unwrapZodSchema(schema);
  const definition = base?._def || {};
  let text;
  switch (definition.typeName) {
    case 'ZodString': {
      // Surfacing the pattern matters: `id` is a string with a character
      // pattern, and a model that returns a human-readable name fails validation.
      const pattern = (definition.checks || []).find((check) => check.kind === 'regex');
      text = pattern ? `string matching ${String(pattern.regex)}` : 'string';
      break;
    }
    case 'ZodNumber': text = 'number'; break;
    case 'ZodBoolean': text = 'boolean'; break;
    case 'ZodLiteral': text = JSON.stringify(definition.value); break;
    case 'ZodEnum': text = definition.values.map((value) => JSON.stringify(value)).join(' | '); break;
    case 'ZodRecord': text = `object map of ${describeZodType(definition.valueType)}`; break;
    case 'ZodArray': {
      const limits = [];
      if (typeof definition.minLength?.value === 'number') limits.push(`min ${definition.minLength.value}`);
      if (typeof definition.maxLength?.value === 'number') limits.push(`max ${definition.maxLength.value}`);
      text = `array of ${describeZodType(definition.type)}${limits.length ? ` (${limits.join(', ')})` : ''}`;
      break;
    }
    case 'ZodObject': {
      const shape = zodShapeOf(base);
      text = shape
        ? `object { ${Object.entries(shape).map(([key, value]) => `${key}: ${describeZodType(value)}`).join('; ')} }`
        : 'object';
      break;
    }
    default: text = 'unknown';
  }
  return modifiers.length ? `${text} (${modifiers.join(', ')})` : text;
}

function isRequiredZodField(schema) {
  const typeName = schema?._def?.typeName;
  return typeName !== 'ZodOptional' && typeName !== 'ZodDefault';
}

/** Typed `field: type` lines for one stage, derived from its zod schema. */
export function describeResearchStageFields(stageName) {
  const shape = zodShapeOf(getResearchStageSchema(stageName));
  if (!shape) return [];
  return Object.entries(shape).map(([key, value]) => `${key}: ${describeZodType(value)}`);
}

/** Required keys for one stage, derived from its zod schema. */
export function requiredResearchStageKeys(stageName) {
  const shape = zodShapeOf(getResearchStageSchema(stageName));
  if (!shape) return [];
  return Object.entries(shape).filter(([, value]) => isRequiredZodField(value)).map(([key]) => key);
}

/**
 * Semantic guidance a zod schema cannot express: what a field's values must
 * *mean*, not just their type. Kept beside the derivation so the prompt and the
 * schema stay one edit apart.
 */
const RESEARCH_STAGE_CONTRACT_NOTES = Object.freeze({
  hypothesis_plan: Object.freeze([
    'Use exactly input.ideaId. Propose a falsifiable hypothesis and evaluation draft, not a completed experiment or a claim of novelty. Respect the selected candidate and previous human plan.',
    'Use only input.relatedWork candidates for literature facts. A failed or partial search does not establish originality; leave unsupported facts empty. Replication comparison causeHypothesis remains unverified.',
    'dataset and datasetVersion must be an id and exact sha256 pair from input.availableDatasets; otherwise use empty strings. Never invent a dataset, paper, reported value, execution result, or permission.',
    'Specify prediction, conditions, falsificationCondition, split, baselines, metric directions and numeric thresholds, seed, repetitions and ablations when justified. Unknown fields may be empty strings, empty arrays or null. Budgets are proposals only; theoretical plans are not directly executable by the current Runner.'
  ]),
  replication_analysis: Object.freeze([
    'Use exactly input.paper.id. Compare only the supplied Run and actual archived metrics. Never output actualValue, difference or match status: the application computes these.',
    'reportedValue requires a source excerpt in reportedText and its page/table in referenceLocation. If the paper does not report the metric or the source is unavailable, use null and missing-report; this is not author failure.',
    'Use tolerance=null unless the supplied evaluation protocol explicitly defines a numeric tolerance. causeHypothesis is always an unverified explanation, not a scientific conclusion. Distinguish missing reports, data coverage, missing controls, untested generalization and execution failure.'
  ]),
  environment_proposal:Object.freeze(['Propose only wheel paths and exact SHA256 values from input.availableWheels. packages=[] means standard library only, not permission to download or install arbitrary packages. blockers contains only actual absent Python entrypoint, dependency wheel or runtime requirements that prevent preparing this environment. A missing scientific dataset, paper, protocol or Evidence belongs in deferred and MUST NOT block preparation of otherwise valid Python code. deferred remains unverified for later reproduction/material checks. reason explains the fixed lock. The application owns preparation, authorization and verification; never claim that an environment or experiment ran successfully.']),
  dataset_discovery: Object.freeze([
    'Use paperId from input.papers. Cite a data availability statement or an exact source provided in input as evidenceQuote. Only return supported public file URLs; never invent a link, license, checksum, or successful download. Unknown or inaccessible sources belong in missing. This is a suggestion only; the application owns acquisition and permissions.'
  ]),
  search_strategy: Object.freeze([
    'sources must contain ids from input.availableSources (registered Source Adapter ids such as "arxiv"), never venue names or descriptions.'
  ]),
  reproduction_plan: Object.freeze([
    'paperId must be a paper id taken from the stage input. Preserve an explicitly requested paperId.',
    'evaluationProtocol is optional and contains datasetSplit, metricExtraction and referenceLocation. Use only supplied protocol and paper evidence; preserve input.evaluationProtocol when present. Omit the whole object when any field is unknown; never invent paper pages, splits or metric extraction rules. The application preserves the original execution protocol and success criteria.'
  ]),
  innovation_ideas: Object.freeze([
    'ideas[].relatedPaperIds must contain only paper ids taken from the stage input.',
    'ideas[].id is a new identifier you choose; it must match the id character pattern and contain no spaces.'
  ]),
  method_proposals: Object.freeze([
    'proposals[].ideaId must be the approved idea id taken from the stage input.',
    'recommendation must be exactly one of the proposals[].id values you produced (same id pattern, no spaces), or null.',
    'proposals[].id is a new identifier you choose; it must match the id character pattern and contain no spaces.'
  ]),
  experiment_plan: Object.freeze([
    'methodId must be the approved method id taken from the stage input.',
    'baselineIds must contain only ids present in the stage input.'
  ]),
  experiment_results: Object.freeze([
    'runId must be an existing Experiment Run id from the stage input.'
  ]),
  writing_brief: Object.freeze([
    'claims[].evidenceIds must contain only Evidence ids that already exist in this project; never invent an Evidence id.',
    'claims[].id is a new identifier you choose; it must match the id character pattern and contain no spaces.',
    'citationPaperIds must contain only paper ids taken from the stage input.',
    'unsupportedClaims must name every claim you could not fully support, including that claim id; an unsupported claim that is not declared here fails validation.'
  ])
});

/**
 * Prompt-facing contract per stage. Derived, never hand-maintained: `fields`
 * carries the types the model must match, `required` lists the non-optional
 * keys, `rules` states the strictness the validators actually apply, and
 * `notes` carries per-stage semantics the schema cannot express.
 */
export const RESEARCH_STAGE_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.keys(RESEARCH_STAGE_SCHEMAS).map((stageName) => [
    stageName,
    Object.freeze({
      stage: stageName,
      required: Object.freeze(requiredResearchStageKeys(stageName)),
      fields: Object.freeze(describeResearchStageFields(stageName)),
      notes: Object.freeze(RESEARCH_STAGE_CONTRACT_NOTES[stageName] || []),
      rules: Object.freeze([
        'Return exactly these keys and no others; any additional key fails validation.',
        'Match each type literally: "array of string" is a JSON array of plain strings, never an array of objects.'
      ])
    })
  ])
));
