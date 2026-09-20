import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty.regex(/^[A-Za-z0-9._:-]+$/, 'id contains unsupported characters');
const confidence = z.number().min(0).max(1);
const stage = (name) => z.literal(name);

const evidenceSchema = z.object({
  id,
  kind: z.enum(['paper', 'dataset', 'experiment', 'artifact', 'human-note']),
  referenceId: nonEmpty,
  summary: nonEmpty,
  location: z.string().trim().min(1).nullable().optional()
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

const paperScreeningSchema = z.object({
  stage: stage('paper_screening'),
  policyId: nonEmpty.nullable().optional(),
  decisions: z.array(z.object({
    paperId: nonEmpty,
    decision: z.enum(['accept', 'reject', 'needs-review']),
    reasons: z.array(nonEmpty).min(1),
    qualityScore: z.number().min(0).max(100).nullable().optional(),
    confidence: confidence.nullable().optional()
  }).strict()),
  missingMetadata: z.array(z.object({
    paperId: nonEmpty,
    fields: z.array(nonEmpty).min(1),
    action: z.enum(['verify', 'reject', 'request-source'])
  }).strict()).default([]),
  summary: nonEmpty
}).strict();

const reproductionPlanSchema = z.object({
  stage: stage('reproduction_plan'),
  paperId: nonEmpty,
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

export const RESEARCH_STAGE_SCHEMAS = Object.freeze({
  search_strategy: searchStrategySchema,
  paper_screening: paperScreeningSchema,
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
  selection: 'paper_screening',
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

// Kept as a plain object so the Harness prompt can include a stable, readable
// contract without depending on zod internals or an additional converter.
export const RESEARCH_STAGE_CONTRACTS = Object.freeze({
  search_strategy: {
    required: ['stage=search_strategy', 'researchQuestion', 'humanDirection', 'queries[]', 'sources[]', 'rationale']
  },
  paper_screening: {
    required: ['stage=paper_screening', 'decisions[]', 'summary'],
    decision: 'accept|reject|needs-review'
  },
  reproduction_plan: {
    required: ['stage=reproduction_plan', 'paperId', 'objective', 'metrics[]', 'expectedOutputs[]', 'humanApprovalRequired=true']
  },
  innovation_ideas: {
    required: ['stage=innovation_ideas', 'humanDirection', 'ideas[]']
  },
  method_proposals: {
    required: ['stage=method_proposals', 'selectedIdeaId', 'proposals[]', 'humanDecisionRequired=true']
  },
  experiment_plan: {
    required: ['stage=experiment_plan', 'methodId', 'datasetIds[]', 'metrics[]', 'successCriteria[]', 'humanApprovalRequired=true']
  },
  experiment_results: {
    required: ['stage=experiment_results', 'runId', 'status', 'metrics']
  },
  writing_brief: {
    required: ['stage=writing_brief', 'title', 'claims[]', 'outline[]']
  }
});
