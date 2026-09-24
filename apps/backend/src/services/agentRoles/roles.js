/**
 * The agent role registry.
 *
 * Before this, every AI entrypoint defined its role implicitly: a prompt string
 * here, a request field there, and the same "LaTeX writing assistant" persona in
 * three places with three different authority levels. A role makes the purpose,
 * the authority, and the forbidden actions explicit and checkable.
 *
 * Two rules the tests enforce:
 * - `allowedCapabilities` may only narrow `HARNESS_CAPABILITIES`. A role can
 *   never grant something the Project Constraint vocabulary does not contain.
 * - The enforcement Modules (Harness Runtime, Experiment Runner, Quality Gate,
 *   Evidence Ledger) are deliberately NOT roles. They enforce; they do not have
 *   an AI authority level, and modelling them as roles would blur that line.
 *
 * `authority` values:
 *   suggest-only       returns text or structured advice; changes nothing
 *   propose-patch      may propose file changes for human confirmation
 *   execute            may perform a gated action after the human gate passes
 *   interpret-results  may read completed results and explain them, never alter them
 */
export const ROLE_AUTHORITIES = Object.freeze(['suggest-only', 'propose-patch', 'execute', 'interpret-results']);

export const ENFORCEMENT_MODULES = Object.freeze([
  { id: 'harness-runtime', module: 'services/harnessRuntime/index.js', enforces: 'Run lifecycle, isolation, capability checks, Patch collection' },
  { id: 'experiment-runner', module: 'services/experimentRunner/index.js', enforces: 'Approval-gated execution, Manifest, Artifacts' },
  { id: 'quality-gate', module: 'services/researchResearch/qualityGate.js', enforces: 'Deterministic paper eligibility' },
  { id: 'evidence-ledger', module: 'services/evidenceLedger/index.js', enforces: 'Evidence provenance and claim support' }
]);

export const AGENT_ROLES = Object.freeze([
  {
    id: 'editor-chat-assistant',
    purpose: 'Conversational writing help with no project mutation.',
    stageScope: ['editor'],
    authority: 'suggest-only',
    allowedCapabilities: [],
    allowedSkills: [],
    outputContract: 'free-text',
    handoff: 'The researcher copies whatever they want into the manuscript.',
    forbiddenActions: ['proposing patches', 'reading project files', 'emitting JSON tool output', 'using the network'],
    entrypoints: [{ module: 'routes/agent.js', symbol: 'registerAgentRoutes', note: 'interaction=chat, no tools are passed' }]
  },
  {
    id: 'project-agent',
    purpose: 'Tool-using project editor: polish, compile debugging, citation insertion, arXiv search.',
    stageScope: ['editor'],
    authority: 'propose-patch',
    allowedCapabilities: ['project.read', 'patch.propose'],
    allowedSkills: [],
    outputContract: 'patch',
    handoff: 'A human reviews the Patch and decides on the Harness Run.',
    forbiddenActions: ['writing the original project', 'executing Shell commands', 'approving or advancing a stage', 'selecting papers, ideas, or methods', 'creating Experiment Runs'],
    entrypoints: [{ module: 'services/agentRuntime.js', symbol: 'runAgentRuntime' }]
  },
  {
    id: 'paper-reviewer',
    purpose: 'Read-only critique: peer review, consistency, missing citations, compile-log summary.',
    stageScope: ['writing'],
    authority: 'suggest-only',
    allowedCapabilities: ['project.read'],
    allowedSkills: ['research-writing'],
    outputContract: 'free-text',
    handoff: 'The researcher decides what to change in the writing stage.',
    forbiddenActions: ['proposing patches', 'any write', 'claiming a result is verified'],
    // Same endpoint as the project agent, deliberately narrower authority: this is
    // the case where the prompt claimed a restriction the code did not enforce.
    entrypoints: [{ module: 'routes/agent.js', symbol: 'registerAgentRoutes', note: 'peer-review / consistency tasks' }]
  },
  {
    id: 'research-stage-assistant',
    purpose: 'One structured producer per Research Stage; JSON output only.',
    stageScope: ['direction', 'search', 'selection', 'replication', 'ideation', 'method', 'experiment', 'writing'],
    authority: 'suggest-only',
    allowedCapabilities: ['project.read'],
    allowedSkills: ['literature-search', 'paper-screening', 'paper-card', 'dataset-audit', 'statistics-audit', 'research-writing'],
    outputContract: 'json:research-stage-contract',
    handoff: 'The stage task reaches awaiting_approval; only a human Approval advances it.',
    forbiddenActions: ['proposing patches', 'executing experiments', 'using the network', 'declaring a Paper Candidate or Experiment Result verified', 'granting Approval', 'advancing a stage'],
    entrypoints: [{ module: 'services/researchResearch/harnessAdapter.js', symbol: 'runResearchHarnessStage' }]
  },
  {
    id: 'latex-conversion-engine',
    purpose: 'Convert an uploaded image into LaTeX (equation, table, figure, algorithm, OCR).',
    stageScope: ['editor'],
    authority: 'propose-patch',
    allowedCapabilities: ['project.read', 'patch.propose'],
    allowedSkills: [],
    outputContract: 'free-text',
    handoff: 'The researcher inserts the returned LaTeX; the stored asset stays reviewable.',
    forbiddenActions: ['executing Shell commands', 'using the network'],
    entrypoints: [{ module: 'routes/vision.js', symbol: 'registerVisionRoutes' }]
  },
  {
    id: 'plot-code-generator',
    purpose: 'Turn a LaTeX table into a rendered figure by generating plotting code.',
    stageScope: ['experiment'],
    authority: 'execute',
    allowedCapabilities: ['project.read', 'patch.propose', 'experiment.execute'],
    allowedSkills: ['statistics-audit'],
    outputContract: 'artifact',
    handoff: 'The rendered figure becomes an Artifact that can enter the Evidence chain.',
    forbiddenActions: ['running generated code without experiment.execute', 'writing the original project', 'claiming the figure proves a result'],
    entrypoints: [{ module: 'routes/plot.js', symbol: 'registerPlotRoutes' }]
  },
  {
    id: 'template-migration-agent',
    purpose: 'Plan and perform a source-to-target LaTeX template migration.',
    stageScope: ['editor'],
    authority: 'propose-patch',
    allowedCapabilities: ['project.read', 'patch.propose'],
    allowedSkills: [],
    outputContract: 'patch',
    handoff: 'A human reviews the migrated files; compilation is a separate baseline step.',
    forbiddenActions: ['bypassing Project Constraints', 'writing the source project'],
    entrypoints: [
      { module: 'services/transferAgent/nodes/draftPlan.js', symbol: 'draftPlan' },
      { module: 'services/transferAgent/nodes/applyTransfer.js', symbol: 'applyTransfer' },
      { module: 'services/transferAgent/nodes/fixCompile.js', symbol: 'fixCompile' },
      { module: 'services/transferAgent/nodes/fixLayout.js', symbol: 'fixLayout' },
      { module: 'services/transferAgent/nodes/checkLayout.js', symbol: 'checkLayout' }
    ]
  },
  {
    id: 'experiment-interpreter',
    purpose: 'Interpret a completed Experiment Run against its own Artifacts.',
    stageScope: ['experiment'],
    authority: 'interpret-results',
    allowedCapabilities: ['project.read'],
    allowedSkills: ['statistics-audit'],
    outputContract: 'json:interpretation',
    handoff: 'A human confirms the interpretation before it becomes Evidence.',
    forbiddenActions: ['creating or altering metrics', 'referencing an Artifact from another Run', 'marking Evidence verified', 'creating the next Experiment Run'],
    entrypoints: [{ module: 'services/experimentRunner/index.js', symbol: 'recordExperimentInterpretation' }]
  }
]);
