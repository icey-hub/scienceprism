/**
 * The project constraint registry.
 *
 * Each entry is one constraint that today lives only as a row in
 * `docs/project-constraints.md` plus scattered code. The registry makes the
 * catalogue machine-readable so it can be projected, tested, and eventually
 * toggled, without changing any behaviour yet: nothing calls `enforcement`
 * here, and every reference points at a seam that already exists.
 *
 * Field meaning:
 * - `tier`       core = a product invariant that must not be user-disableable;
 *                standard = a normal quality constraint, toggleable, on by default;
 *                experimental = speculative, toggleable, off by default.
 * - `enforcement` the module and exported symbol that actually enforces it.
 * - `testRef`    the test that proves it, or null when no test exists yet.
 * - `provenance` which human decision it follows from, or `ai-subjective`.
 * - `drift`      set when the documentation claims something the code does not do.
 */
export const CONSTRAINT_TIERS = Object.freeze(['core', 'standard', 'experimental']);

export const CONSTRAINT_REGISTRY = Object.freeze([
  {
    id: 'C-01',
    statement: 'Every workflow operation is scoped to an existing Project and its project-local storage.',
    tier: 'core',
    scope: ['workflow', 'storage'],
    enforcement: { module: 'services/projectService.js', symbol: 'getProjectRoot' },
    testRef: { file: 'researchWorkflow.test.js', name: 'an unknown Project is rejected instead of resolving to a shared root' },
    provenance: { source: 'adr', ref: 'ADR-0003' },
    drift: null
  },
  {
    id: 'C-02',
    statement: 'Only the current Research Stage can be changed or approved.',
    tier: 'core',
    scope: ['workflow'],
    enforcement: { module: 'services/researchWorkflow/stateMachine.js', symbol: 'applyStageUpdate' },
    testRef: { file: 'researchWorkflow.test.js', name: 'state machine records versioned approval, rejection, and recovery transitions' },
    provenance: { source: 'adr', ref: 'ADR-0002' },
    drift: null
  },
  {
    id: 'C-03',
    statement: 'A stage cannot be approved without data satisfying its readiness requirement.',
    tier: 'core',
    scope: ['workflow'],
    enforcement: { module: 'services/researchWorkflow/stageContracts.js', symbol: 'getStageReadiness' },
    testRef: { file: 'researchWorkflow.test.js', name: 'state machine records versioned approval, rejection, and recovery transitions' },
    provenance: { source: 'adr', ref: 'ADR-0002' },
    drift: null
  },
  {
    id: 'C-04',
    statement: 'AI output cannot approve a stage, select a paper, choose an innovation, authorize an experiment, or submit a final claim.',
    tier: 'core',
    scope: ['workflow', 'harness'],
    enforcement: { module: 'services/researchWorkflow/commands.js', symbol: 'approveResearchWorkflow' },
    testRef: { file: 'researchStageSlice.test.js', name: 'direction to writing Brief vertical slice keeps approvals, Evidence, and editor artifact' },
    provenance: { source: 'adr', ref: 'ADR-0002' },
    drift: 'The human-approval path is structural only: the actor is caller-supplied (body.actor || header || collabAuth?.sub || "human"), so nothing distinguishes an AI caller from a human.'
  },
  {
    id: 'C-05',
    statement: 'Structured Harness output must validate against the named stage contract before it is treated as usable output.',
    tier: 'core',
    scope: ['harness', 'contract'],
    enforcement: { module: 'services/researchResearch/schemas.js', symbol: 'parseResearchStageOutput' },
    testRef: { file: 'phase10.test.js', name: 'quality gate and stage schema reject unsafe or incomplete structured output' },
    provenance: { source: 'adr', ref: 'ADR-0005' },
    drift: null
  },
  {
    id: 'C-06',
    statement: 'A Paper Candidate is selectable only when the server-side quality gate returns accept.',
    tier: 'core',
    scope: ['workflow', 'quality'],
    enforcement: { module: 'services/researchResearch/qualityGate.js', symbol: 'applyQualityGate' },
    testRef: { file: 'phase10.test.js', name: 'quality gate and stage schema reject unsafe or incomplete structured output' },
    provenance: { source: 'adr', ref: 'ADR-0002' },
    drift: null
  },
  {
    id: 'C-07',
    statement: 'Harness work runs in a temporary, physically filtered project copy; original files change only through an explicit Patch application.',
    tier: 'core',
    scope: ['harness', 'isolation'],
    enforcement: { module: 'services/harnessRuntime/index.js', symbol: 'applyHarnessRunPatches' },
    testRef: { file: 'harnessRuntime.test.js', name: 'an accepted Run applies its Patches to the project exactly once' },
    provenance: { source: 'adr', ref: 'ADR-0001' },
    drift: null
  },
  {
    id: 'C-08',
    statement: 'Shell and experiment execution require an explicit capability and a human Run approval.',
    tier: 'core',
    scope: ['experiment', 'capability'],
    enforcement: { module: 'services/researchWorkflow/application.js', symbol: 'runUiAction' },
    testRef: { file: 'experimentRunner.test.js', name: 'Experiment Run requires approval and an explicit execution capability' },
    provenance: { source: 'adr', ref: 'ADR-0004' },
    drift: null
  },
  {
    id: 'C-09',
    statement: 'File scope, sensitive-file filtering, network access, and tool capabilities are denied unless granted and enforceable.',
    tier: 'core',
    scope: ['harness', 'capability'],
    enforcement: { module: 'services/harnessRuntime/capabilities.js', symbol: 'assertNetworkHost' },
    testRef: { file: 'phase10.test.js', name: 'the network allowlist fails closed, matching what the model is told' },
    provenance: { source: 'adr', ref: 'ADR-0006' },
    drift: null
  },
  {
    id: 'C-10',
    statement: 'Each Harness Run is bounded by a timeout and a token budget.',
    tier: 'standard',
    scope: ['harness', 'limits'],
    enforcement: { module: 'services/harnessRuntime/index.js', symbol: 'createHarnessRun' },
    testRef: { file: 'harnessRuntime.test.js', name: 'Harness Run limits fall back to the shared constraint defaults' },
    provenance: { source: 'adr', ref: 'ADR-0006' },
    drift: 'The token budget is passed only to the DeepSeek SDK; the legacy adapter never receives limits and nothing enforces a cumulative budget.'
  },
  {
    id: 'C-11',
    statement: 'Unknown metadata, unsupported results, and missing evidence must remain explicitly uncertain.',
    tier: 'core',
    scope: ['contract', 'evidence'],
    enforcement: { module: 'services/evidenceLedger/index.js', symbol: 'validateStageEvidence' },
    testRef: { file: 'evidenceLedger.test.js', name: 'an unsupported claim is accepted once declared, and only then' },
    provenance: { source: 'adr', ref: 'ADR-0008 and the roadmap invariant that unverified metadata, results, and claims must be marked explicitly uncertain. The caveats/limitations/missingMetadata field set was AI-added and stays an optional hint.' },
    drift: null
  },
  {
    id: 'C-12',
    statement: 'Every Paper Claim must link to Evidence before it can be treated as a confirmed writing output.',
    tier: 'core',
    scope: ['evidence', 'writing'],
    enforcement: { module: 'services/evidenceLedger/index.js', symbol: 'validateStageEvidence' },
    testRef: { file: 'evidenceLedger.test.js', name: 'research Harness rejects a writing output that cites no confirmed Evidence' },
    provenance: { source: 'adr', ref: 'ADR-0008' },
    drift: null
  },
  {
    id: 'C-13',
    statement: 'Every successful workflow mutation is versioned and auditable.',
    tier: 'core',
    scope: ['workflow', 'audit'],
    enforcement: { module: 'services/researchWorkflow/audit.js', symbol: 'appendAudit' },
    testRef: { file: 'researchWorkflow.test.js', name: 'commands enforce optimistic version checks and replay idempotent writes' },
    provenance: { source: 'adr', ref: 'ADR-0003' },
    drift: null
  },
  {
    id: 'C-14',
    statement: 'Every Experiment Run must be reproducible to code, dataset, environment, parameters, seed, resources, and success criteria.',
    tier: 'core',
    scope: ['experiment', 'reproducibility'],
    enforcement: { module: 'services/experimentRunner/manifest.js', symbol: 'buildExperimentManifest' },
    testRef: { file: 'experimentRunner.test.js', name: 'approved Node Experiment Run archives reproducible artifacts and Evidence' },
    provenance: { source: 'adr', ref: 'ADR-0009' },
    drift: null
  },
  {
    id: 'C-15',
    statement: 'Experiment results, Artifacts, and interpretations remain traceable and uncertain until human verification.',
    tier: 'core',
    scope: ['experiment', 'evidence'],
    enforcement: { module: 'services/experimentRunner/index.js', symbol: 'recordExperimentInterpretation' },
    testRef: { file: 'experimentRunner.test.js', name: 'running Experiments can be cancelled, retried, and interpreted only from their Artifacts' },
    provenance: { source: 'adr', ref: 'ADR-0009' },
    drift: null
  },
  {
    id: 'C-16',
    statement: 'Experiment execution and advanced Harness adapters are rollout-controlled and cannot run when their Feature Flag is disabled.',
    tier: 'standard',
    scope: ['experiment', 'harness', 'rollout'],
    enforcement: { module: 'services/featureFlags.js', symbol: 'assertFeatureEnabled' },
    testRef: { file: 'phase10.test.js', name: 'feature flags can be opened or disabled by environment and project constraints' },
    provenance: { source: 'ai-subjective', ref: 'Feature flags appear in no ADR and are not mentioned in CONTEXT.md.' },
    drift: null
  }
]);

/** Constraints that have no test yet. Locked so the gap cannot grow silently. */
export const UNTESTED_CONSTRAINTS = Object.freeze([]);

/** Constraints whose documentation disagrees with the code. */
export const DRIFTED_CONSTRAINTS = Object.freeze(
  CONSTRAINT_REGISTRY.filter((constraint) => constraint.drift !== null).map((constraint) => constraint.id)
);
