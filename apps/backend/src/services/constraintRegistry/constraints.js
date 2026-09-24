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
    module: "Project Root Module",
    failure: "Unknown Project returns `404 PROJECT_NOT_FOUND`; an invalid Project id is rejected before any path is built.",
    validationLocation: "`apps/backend/src/services/projectService.js:getProjectRoot` (project.json must exist); `apps/backend/src/services/researchWorkflow/errors.js:assertProjectId`",
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
    module: "Research Workflow Module",
    failure: "Returns `409 STAGE_GATE` with current and requested stage IDs.",
    validationLocation: "`apps/backend/src/services/researchWorkflow/stateMachine.js:currentStage`",
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
    module: "Research Workflow Module",
    failure: "Returns `409 STAGE_NOT_READY` and names missing requirements. Stage-specific data shape checks run before approval.",
    validationLocation: "`apps/backend/src/services/researchWorkflow/stageContracts.js:getStageReadiness` and `stateMachine.js:applyApprovalDecision`",
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
    module: "Research Workflow Module + Research Harness Adapter",
    failure: "AI output is returned as data or a proposed Patch. An approval decision must identify its actor — `400 ACTOR_REQUIRED` when none is supplied (there is **no** `'human'` default) and `400 INVALID_ACTOR` when the kind is not `human`/`ai`/`system`; a refused decision changes nothing. Invalid stage changes fail with a `4xx` workflow error.",
    validationLocation: "`apps/backend/src/routes/researchWorkflow.js:requireActor` (approve / reject / skip / recover / reset); `select-papers` quality gate; `run-experiment` plan-only route; `apps/backend/src/services/researchResearch/harnessAdapter.js`",
    tier: 'core',
    scope: ['workflow', 'harness'],
    enforcement: { module: 'routes/researchWorkflow.js', symbol: 'requireActor' },
    testRef: { file: 'researchWorkflow.test.js', name: 'an approval decision must identify its actor' },
    provenance: { source: 'adr', ref: 'ADR-0002' },
    drift: null
  },
  {
    id: 'C-05',
    statement: 'Structured Harness output must validate against the named stage contract before it is treated as usable output.',
    module: "Research Stage Contract Module",
    failure: "`validation.ok=false`, `output=null`, and the run is not considered successful. A reply that breaks the contract gets **one repair attempt** with the validation errors quoted back (`attempts` records both); a transport failure is not retried here, and the retry is awaited rather than issued in parallel.",
    validationLocation: "`apps/backend/src/services/researchResearch/schemas.js:parseResearchStageOutput`; `harnessAdapter.js:runResearchHarnessStage`",
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
    module: "Paper Quality Gate Module",
    failure: "Returns `409 QUALITY_GATE` with blocked paper IDs; unverified candidates remain `needs-review`.",
    validationLocation: "`apps/backend/src/services/researchResearch/qualityGate.js:applyQualityGate`; `routes/researchWorkflow.js:select-papers`",
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
    module: "Harness Runtime Module",
    failure: "Files outside non-empty `allowedPaths` are not copied into the workspace. Invalid scopes copy no project files. A failed run does not mutate the original Project. Applying Patches requires a human-accepted Run (`409 PATCH_APPLICATION_REQUIRES_ACCEPTANCE`), re-checks each path against the current policy (`403 PATH_DENIED`), and refuses to apply the same Patch twice (`409 NO_PATCHES_TO_APPLY`).",
    validationLocation: "`apps/backend/src/services/harnessRuntime/index.js:copyWorkspace`, `collectPatches`, temporary workspace cleanup, and `applyHarnessRunPatches` (exposed as `POST /api/projects/:id/harness-runs/:runId/apply`)",
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
    module: "Experiment Plan Module + Experiment Runner Module",
    failure: "Incomplete plans return `400 EXPERIMENT_INCOMPLETE`; free-form commands cannot execute; missing approval or capability returns a `4xx` error; a disabled flag returns `403 FEATURE_FLAG_DISABLED`.",
    validationLocation: "`apps/backend/src/services/researchWorkflow/application.js:run-experiment` records a plan; `apps/backend/src/services/experimentRunner/` requires a structured Node Adapter, a human Run approval, and `experiment.execute`; `apps/backend/src/services/featureFlags.js` can disable the capability outright.",
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
    module: "Harness Run Module + Context Packager",
    failure: "Fail-closed with `403 CAPABILITY_DENIED` / `PATH_DENIED` / `NETWORK_DENIED` and no unauthorized Patch; excluded files are absent from both the Context Pack and temporary workspace. Network is fail-closed twice over: `research.search` must be granted **and** the host must appear in `networkAllowlist` — an empty allowlist denies every host, which is what `capabilityPrompt` tells the model.",
    validationLocation: "`apps/backend/src/services/harnessRuntime/capabilities.js:assertCapability`, `isPathAllowed`, `isSensitivePath`, `assertNetworkHost`; `apps/backend/src/services/harnessRuntime/contextPackager.js`; `.scienceprism/project-constraints.json`; Runtime tool-event checks",
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
    module: "Harness Runtime Module",
    failure: "Exceeding the timeout aborts the Run (`504 HARNESS_TIMEOUT`); `maxTokens` caps each provider call on both adapters; a failed Run returns `ok=false` and never mutates the original Project.",
    validationLocation: "`apps/backend/src/services/harnessRuntime/index.js:buildLimits` computes the limits and passes them to **every** adapter; `deepseekAdapter.js` forwards `maxTokens` to the SDK and `agentService.js:buildToolAgentModel` applies it to the legacy tool-agent model.",
    tier: 'standard',
    scope: ['harness', 'limits'],
    enforcement: { module: 'services/agentService.js', symbol: 'buildToolAgentModel' },
    testRef: { file: 'harnessRuntime.test.js', name: 'the Run token budget is applied by the legacy tool-agent model' },
    provenance: { source: 'adr', ref: 'ADR-0006' },
    drift: null
  },
  {
    id: 'C-11',
    statement: 'Unknown metadata, unsupported results, and missing evidence must remain explicitly uncertain.',
    module: "Paper Quality Gate + Evidence Ledger Modules",
    failure: "A claim the evidence matrix cannot support is accepted **only when the writing brief names that claim id in `unsupportedClaims`**; an undeclared one fails with `UNSUPPORTED_CLAIM` / `EVIDENCE_REQUIRES_VERIFICATION`, and naming a different claim id does not count. Output never becomes verified fact.",
    validationLocation: "`apps/backend/src/services/evidenceLedger/index.js:validateStageEvidence` (the declared-uncertainty channel); `needs-review`, `missingMetadata`, `caveats`, `limitations`, and confidence fields in `schemas.js` remain optional hints.",
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
    module: "Evidence Ledger Module + Research Harness Adapter",
    failure: "Missing, unverified, and stale Evidence references return claim-level validation errors and remain human-reviewable; the workflow still requires explicit human approval.",
    validationLocation: "`apps/backend/src/services/evidenceLedger/`; `validateStageEvidence`; `writing_brief` requires `claims[].evidenceIds`.",
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
    module: "Research Workflow Module",
    failure: "Persistence errors fail the request; stale `expectedVersion` returns `409 VERSION_CONFLICT`; repeated `idempotencyKey` requests replay without a duplicate event.",
    validationLocation: "`audit.js:appendAudit`, `commands.js:mutateWorkflow`, and atomic `repository.js:writeWorkflowFile`.",
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
    module: "Experiment Runner Module",
    failure: "Run creation fails when dataset version, protocol, or structured execution is missing; the Manifest preserves the computed code snapshot.",
    validationLocation: "`apps/backend/src/services/experimentRunner/manifest.js`; `.scienceprism/experiment-runs/<run-id>/manifest.json`",
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
    module: "Experiment Runner + Evidence Ledger Modules",
    failure: "Completed output is recorded as pending Evidence; failed output is unverified; an interpretation cannot reference an Artifact from another Run.",
    validationLocation: "`apps/backend/src/services/experimentRunner/index.js`; `.scienceprism/evidence-ledger.json`",
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
    module: "Feature Flag Module + Experiment Runner + Harness Runtime",
    failure: "Returns `403 FEATURE_FLAG_DISABLED`; global environment flags can disable a capability for every Project, while Project Constraints may disable it further.",
    validationLocation: "`apps/backend/src/services/featureFlags.js`; `.scienceprism/project-constraints.json`; `SCIENCEPRISM_FEATURE_*` environment variables",
    tier: 'standard',
    scope: ['experiment', 'harness', 'rollout'],
    enforcement: { module: 'services/featureFlags.js', symbol: 'assertFeatureEnabled' },
    testRef: { file: 'phase10.test.js', name: 'feature flags can be opened or disabled by environment and project constraints' },
    provenance: { source: 'ai-subjective', ref: 'Feature flags appear in no ADR and are not mentioned in CONTEXT.md.' },
    drift: null
  },
  {
    id: 'C-17',
    statement: 'Documents the research tool produces land under the repository aidoc/ directory, never inside the agent-governance docs.',
    module: "Document Landing Module + Research Workflow Driver",
    failure: "The driver fails loudly when the produced document is aimed outside `aidoc/`. The landing directory is pinned in code, not inherited from the gitignored `.env`, so a fresh clone still writes tool output where the requirement says.",
    validationLocation: "`apps/backend/src/services/researchWorkflow/documentLanding.js:resolveDocumentLandingDir`, `assertDocumentLandingPath`; `scripts/produce-research-document.mjs` pins the landing directory.",
    tier: 'core',
    scope: ['workflow', 'document'],
    enforcement: { module: 'services/researchWorkflow/documentLanding.js', symbol: 'assertDocumentLandingPath' },
    testRef: { file: 'documentLanding.test.js', name: 'a produced document must land under aidoc/' },
    provenance: { source: 'context', ref: 'The user requirement R-15 and U-21: deliverables must be documents the tool actually produced, written to aidoc/, not agent-authored governance notes.' },
    drift: null
  }
]);

/** Constraints that have no test yet. Locked so the gap cannot grow silently. */
export const UNTESTED_CONSTRAINTS = Object.freeze([]);

/** Constraints whose documentation disagrees with the code. */
export const DRIFTED_CONSTRAINTS = Object.freeze(
  CONSTRAINT_REGISTRY.filter((constraint) => constraint.drift !== null).map((constraint) => constraint.id)
);
