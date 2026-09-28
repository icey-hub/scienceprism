# Research Workflow

SciencePrism now includes a human-led research workflow inside the same project as
the writing editor. The workflow is available at
`/editor/:projectId/research/:stage`; the old `/research/:projectId` path
redirects to the direction stage.
It persists schema version 3 state, command receipts, and audit events in `.scienceprism/research-workflow.json` inside each project. Existing `.openprism` workflow files and schema versions 1/2 are migrated on first access.

The Phase 1 domain and architecture contracts are documented in
[CONTEXT.md](../CONTEXT.md), [project constraints](./project-constraints.md),
[stage contracts](./research-stage-contracts.md), and the
[workflow migration contract](./research-workflow-contract.md). Architectural
decisions are recorded in [docs/adr](./adr/).

## Stages

1. Direction: human-owned research question and scope.
2. Search: arXiv discovery with deterministic metadata quality checks.
3. Selection: server-side quality gate followed by human selection.
4. Replication: optional reproduction decision; skipping requires an audit note.
5. Ideation: structured innovation suggestions through DeepSeek Harness when configured.
6. Method: structured method proposals and human approval.
7. Experiment: human-approved dataset and structured execution plan. The workflow route records the plan; a separate controlled Experiment Run requires its own human approval and the project `experiment.execute` capability. Arbitrary shell commands are never executed.
8. Writing: evidence handoff to the existing editor. The default single-Agent path remains available. An optional multi-Agent mode runs two serial read-only `paper-reviewer` child Runs (claim/evidence and method/conclusion), then one `research-stage-assistant` coordinator Run. Child opinions remain advisory; the coordinator output passes the writing schema and Evidence Ledger checks before human approval.

Each stage is a separate URL and interface inside the existing editor shell.
The SciencePrism top bar, project file sidebar, project settings, language controls,
and writing entry point stay mounted while the research view replaces the
editor/preview area. The writing stage returns to `/editor/:projectId` after the
evidence handoff. Navigation does not grant approval: the server still checks
the current stage and records every approval in the project audit log. In the multi-Agent writing mode, the page stays on the writing stage after handoff so the researcher can inspect the child Run IDs, statuses, opinions, errors, and provider-reported token usage before opening the Brief. Runs are linked by `parentRunId`; the Brief records their provenance. A failed child stops the sequence, and retry reuses successful child output from the same delegation. This mode uses three serial Runs when all steps succeed; a tool-using Run may make several model requests. Token usage is shown only when the provider reports it. Review opinions are unverified and can contain factual mistakes.

A [single-project real-model comparison](agent-governance/real-writing-delegation-validation.md) used 25,401 tokens and 33.904 seconds for the default path versus 161,818 tokens and 128.372 seconds for delegation. These are observations from one writing handoff, not general cost or latency estimates. Restart a development backend after code changes so the UI and backend use the same implementation.

The backend also exposes stage details, pending approvals, and the audit timeline as query projections. Mutations accept `expectedVersion` for optimistic concurrency and `idempotencyKey` for safe retries.

### Human suggestions during research

The seven research stages from Direction through Experiment each show an **人工建议** form at the top of the stage. Enter your own ideas, corrections, priorities, or questions for the AI, then click **保存建议**. Each stage holds up to 2,000 characters; deleting the text and saving clears that stage's suggestions. Suggestions can be recorded before a stage starts or after its approval. They are stored separately from stage results in the workflow's `humanInstructions` map, with version checks, idempotent writes, and human audit events. Existing projects need no migration.

AI actions receive saved suggestions from their current stage and earlier stages. The UI saves the current draft before running an AI action, saving a stage form, or approving the current stage. Suggestions do not automatically revise existing results, pass the quality gate, approve a stage, or change executable experiment parameters. Updating a suggestion preserves existing stage outputs and approval records. The existing Writing page keeps its own inputs; its AI handoff also receives the saved research suggestions.

### Stage 1 Skills

The Direction page is also the project Skill manager. Use **添加 Skill** to
upload a Skill directory whose root contains `SKILL.md` files, then enable the
Skill for compatible workflow stages. The binding is stored in
`.scienceprism/research-workflow.json` and applies only to this project. A blank
binding explicitly disables the default Skill for that stage.

## Quality policy

Hard filters run in `apps/backend/src/services/researchResearch/qualityGate.js`.
Unknown metadata defaults to `needs-review`, and the selection endpoint only accepts papers with an `accept` decision.

To provide an official venue catalog, set `SCIENCEPRISM_CCF_VENUE_CATALOG_JSON` to a JSON object mapping venue names to levels, for example:

```sh
export SCIENCEPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

The catalog is only a metadata adapter; it cannot override failed year, peer-review, or code checks.

## Local development

The frontend proxy accepts `SCIENCEPRISM_BACKEND_URL`, which makes it possible to run the backend on a second port:

```sh
PORT=8799 SCIENCEPRISM_TUNNEL=false npm --workspace apps/backend run dev
SCIENCEPRISM_BACKEND_URL=http://127.0.0.1:8799 npm --workspace apps/frontend run dev -- --host 127.0.0.1 --port 5174
```

Research stages call the Harness Runtime. In the editor, Workspace Settings defaults to the Legacy LangChain runtime and sends that choice as `llmConfig.runtime`; selecting DeepSeek Harness requires a discoverable SDK or `SCIENCEPRISM_HARNESS_SDK`. A direct Harness API request that omits both `adapter` and `llmConfig.runtime` defaults to the DeepSeek Adapter. Deterministic tests may use `fake`. Each Run is queryable under `/api/projects/:id/harness-runs`.

Stage-specific Harness skills are documented in [research-skills.md](./research-skills.md). The bundled skills are copied into the isolated run workspace and cannot bypass the server-side quality gate or human approvals.
