# Research Workflow

OpenPrism now includes a human-led research workflow inside the same project as
the writing editor. The workflow is available at
`/editor/:projectId/research/:stage`; the old `/research/:projectId` path
redirects to the direction stage.
It persists state and audit events in `.openprism/research-workflow.json` inside each project.

## Stages

1. Direction: human-owned research question and scope.
2. Search: arXiv discovery with deterministic metadata quality checks.
3. Selection: server-side quality gate followed by human selection.
4. Replication: optional reproduction decision; skipping requires an audit note.
5. Ideation: structured innovation suggestions through DeepSeek Harness when configured.
6. Method: structured method proposals and human approval.
7. Experiment: human-approved dataset and command plan. The first release records the plan and does not execute arbitrary shell commands.
8. Writing: evidence handoff to the existing editor.

Each stage is a separate URL and interface inside the existing editor shell.
The OpenPrism top bar, project file sidebar, project settings, language controls,
and writing entry point stay mounted while the research view replaces the
editor/preview area. The writing stage returns to `/editor/:projectId` after the
evidence handoff. Navigation does not grant approval: the server still checks
the current stage and records every approval in the project audit log.

### Stage 1 Skills

The Direction page is also the project Skill manager. Use **添加 Skill** to
upload a Skill directory whose root contains `SKILL.md` files, then enable the
Skill for compatible workflow stages. The binding is stored in
`.openprism/research-workflow.json` and applies only to this project. A blank
binding explicitly disables the default Skill for that stage.

## Quality policy

Hard filters run in `apps/backend/src/services/researchResearch/qualityGate.js`.
Unknown metadata defaults to `needs-review`, and the selection endpoint only accepts papers with an `accept` decision.

To provide an official venue catalog, set `OPENPRISM_CCF_VENUE_CATALOG_JSON` to a JSON object mapping venue names to levels, for example:

```sh
export OPENPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

The catalog is only a metadata adapter; it cannot override failed year, peer-review, or code checks.

## Local development

The frontend proxy accepts `OPENPRISM_BACKEND_URL`, which makes it possible to run the backend on a second port:

```sh
PORT=8799 OPENPRISM_TUNNEL=false npm --workspace apps/backend run dev
OPENPRISM_BACKEND_URL=http://127.0.0.1:8799 npm --workspace apps/frontend run dev -- --host 127.0.0.1 --port 5174
```

The DeepSeek Harness adapter reuses the existing `runDeepSeekHarness` integration. Set `OPENPRISM_HARNESS_SDK` or install the SDK where the existing runtime can discover it before running AI-assisted stages.

Stage-specific Harness skills are documented in [research-skills.md](./research-skills.md). The bundled skills are copied into the isolated run workspace and cannot bypass the server-side quality gate or human approvals.
