<div align="center">

<img src="static/logo-rotating.gif" alt="SciencePrism logo" width="180"/>

# SciencePrism

### Human-led, AI-assisted research from question to paper

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-icey--hub%2Fscienceprism-181717?logo=github)](https://github.com/icey-hub/scienceprism)
[![Issues](https://img.shields.io/github/issues/icey-hub/scienceprism)](https://github.com/icey-hub/scienceprism/issues)

[中文](README_ZH.md) | [English](README.md)

</div>

SciencePrism is a local-first research workspace for turning a researcher’s own question into traceable evidence, reproducible experiments, and a manuscript. The researcher controls the direction, paper selection, innovation choices, methods, and final claims; AI supplies search expansion, structured analysis, and drafting support.

## Research workflow

The workflow lives inside the same project and editor shell. Every stage has its own URL and records state and audit events in `.scienceprism/research-workflow.json`. Runtime settings use the `SCIENCEPRISM_*` prefix; `OPENPRISM_*` remains supported as a legacy fallback.

1. **Direction** — enter the research question, scope, constraints, and acceptance criteria.
2. **Search** — expand the human-defined direction into traceable paper queries and results.
3. **Selection** — apply server-side quality gates, such as CCF venue requirements, then let the researcher choose papers.
4. **Replication** — optionally record and assess a reproduction plan for selected papers.
5. **Ideation** — ask DeepSeek Harness for several evidence-linked innovation candidates; the researcher decides which direction to keep.
6. **Method** — compare AI-assisted method proposals, then approve the final human-owned method.
7. **Experiment** — audit datasets, define commands and evaluation criteria, and record the approved experiment plan.
8. **Writing** — hand verified evidence, decisions, and results into the existing LaTeX writing workspace.

Navigation does not grant approval. The backend enforces stage order, quality gates, human confirmation, and audit logging. The first experiment release records an approved plan and does not execute arbitrary shell commands.

### Workflow core (Phase 2)

The backend is the single source of truth for research workflow state. The workflow core is split into a state machine, stage contracts, approval commands, audit events, migrations, file persistence, and frontend projections. The frontend consumes these projections and does not infer stage status locally.

Available workflow commands include initialization, stage updates, approval, rejection, optional replication skipping, recovery, and reset. Query projections are available for the current workflow, individual stage details, pending approvals, and the audit timeline:

- `GET /api/projects/:id/research-workflow`
- `GET /api/projects/:id/research-workflow/stages/:stageId`
- `GET /api/projects/:id/research-workflow/pending-approvals`
- `GET /api/projects/:id/research-workflow/audit`

Mutating requests may include `expectedVersion` for optimistic concurrency and `idempotencyKey` for safe retries. Existing `.openprism` workflow files and schema versions 1/2 migrate to the schema 3 project-local format without deleting the legacy source.

### Unified Harness Runtime (Phase 3)

The backend now provides one Harness Runtime for research-stage AI assistance. A Run can use the DeepSeek SDK Adapter, the legacy LangChain Adapter, or a deterministic Fake Adapter for tests. The Runtime owns the temporary workspace, environment injection, events, proposed Patches, output validation, limits, cancellation, pause/resume, retries, replay, and human decisions.

Run records are persisted in `.scienceprism/harness-runs.json`. The HTTP interface supports listing and creating Runs, querying one Run, and controlling its lifecycle:

- `GET /api/projects/:id/harness-runs`
- `GET /api/projects/:id/harness-runs/:runId`
- `POST /api/projects/:id/harness-runs`
- `POST /api/projects/:id/harness-runs/:runId/start`
- `POST /api/projects/:id/harness-runs/:runId/pause`
- `POST /api/projects/:id/harness-runs/:runId/resume`
- `POST /api/projects/:id/harness-runs/:runId/cancel`
- `POST /api/projects/:id/harness-runs/:runId/replay`
- `POST /api/projects/:id/harness-runs/:runId/decision`

The default capabilities are only `project.read` and `patch.propose`. Additional capabilities, allowed paths, network access, token budgets, timeouts, concurrency, and retries must be granted through `.scienceprism/project-constraints.json`. Runs always use a temporary project copy; proposed Patches are never applied to the original project automatically. See [docs/harness-runtime.md](docs/harness-runtime.md) and [docs/project-constraints.md](docs/project-constraints.md).

### Constrained Context Packaging (Phase 4)

Before a Run starts, the backend builds a deterministic Context Pack for the current task. It includes the active file, user selection, relevant project files, Project Constraint projection, confirmed Evidence summaries, recent human decisions, applicable Skills, the stage output contract, and human instructions. Sensitive files, `.dsh/skills` files, and paths outside `allowedPaths` are excluded.

The packer ranks files by task relevance, keeps the active file highest priority, and enforces `contextTokenBudget` by truncating content and removing lower-priority files. Each Run stores the exact `contextPack`, its `contextHash`, and a smaller `contextManifest` with file hashes, included sizes, Evidence IDs, decision IDs, Skills, warnings, and the stage contract. This makes the model-visible context inspectable after the temporary workspace is removed.

Set the budget and file scope in the project constraint file:

```json
{
  "capabilities": ["project.read", "patch.propose"],
  "allowedPaths": ["main.tex", "sections"],
  "contextTokenBudget": 12000
}
```

Stale file or workflow versions, conflicting Evidence versions, and missing Evidence are recorded as explicit warnings. They do not approve output or replace human review. See [docs/harness-runtime.md](docs/harness-runtime.md) and [docs/adr/0007-context-packaging.md](docs/adr/0007-context-packaging.md).

### Evidence Ledger and Provenance (Phase 5)

Evidence is stored as a project-owned ledger at `.scienceprism/evidence-ledger.json`. The Ledger provides one interface for papers, datasets, code, environments, methods, experiment plans and runs, results, logs, figures, tables, human notes, artifacts, and Paper Claims. Legacy `.scienceprism/evidence.json` and `.openprism/evidence*.json` files are migrated when they are read.

Each record keeps its source URL or path, acquisition time, summary, verification status, version, and optional SHA-256 hash. Records can be connected with typed relationships such as `supports`, `uses`, `produces`, `derived-from`, and `contradicts`. The graph reports which Research Stages and Paper Claims are affected when an Evidence record changes.

The Evidence Ledger HTTP interface includes:

- `GET /api/projects/:id/evidence`
- `GET /api/projects/:id/evidence/graph`
- `GET /api/projects/:id/evidence/impact/:evidenceId`
- `GET /api/projects/:id/evidence/claims/matrix`
- `POST /api/projects/:id/evidence`
- `POST /api/projects/:id/evidence/relations`

Research Harness output is checked against confirmed Evidence after the stage schema is validated. Missing, unverified, or stale references are returned as explicit validation errors; they cannot become verified facts or approve a workflow stage. The Writing stage displays the Claim-Evidence Matrix with supported, unsupported, and needs-verification claims.

See [docs/evidence-ledger.md](docs/evidence-ledger.md) and [docs/adr/0008-evidence-ledger-and-provenance.md](docs/adr/0008-evidence-ledger-and-provenance.md) for the record contract and design decisions.

### Research Stage Vertical Slice (Phase 6)

Phase 6 connects the first end-to-end research path:

`Direction -> Search -> Selection -> Evidence confirmation -> Writing Brief -> LaTeX editor`

Paper discovery now runs through a `researchSources` Source Adapter seam. The arXiv adapter is implemented today; OpenAlex, Semantic Scholar, and Crossref can be added behind the same interface. Search candidates are normalized, deduplicated, merged into paper entities, checked for metadata quality, and ranked by source priority. The server-side quality gate and human selection decision remain required.

Every research stage uses the same Stage Task lifecycle: input context, Harness task, structured output, automatic validation, human decision, and audit record. Failed or unvalidated tasks cannot approve a stage, while retrying a task leaves confirmed upstream results unchanged. The same record carries screening explanations, innovation comparisons, method candidates, experiment plans, and writing handoff state.

Human-confirmed papers are written to the Evidence Ledger. Writing Brief Paper Claims retain their `evidenceIds`, and the generated `research/writing-brief.md` opens in the editor as an editable handoff without overwriting the main `.tex` manuscript. Experiment execution remains a separate controlled phase; the current workflow records plans and does not execute arbitrary shell commands.

See [docs/research-stage-contracts.md](docs/research-stage-contracts.md) and [docs/architecture-roadmap.md](docs/architecture-roadmap.md) for the stage contracts and implementation record.

## Why SciencePrism

- **Human control**: AI cannot approve a paper, select an innovation, authorize an experiment, or fabricate a result.
- **Quality gates**: unknown metadata is marked `needs-review`; the selection API accepts only papers that pass the configured policy and receive a human `accept` decision.
- **Evidence chain**: paper cards, dataset audits, statistics checks, experiment plans, and writing handoff stay attached to the project.
- **Project Skills**: upload a project-specific `SKILL.md` from the first workflow page and bind it to compatible stages.
- **DeepSeek Harness**: run research-stage assistance in an isolated workspace with the bundled research skills.

## Writing workspace

The research flow complements, rather than replaces, the original academic writing workspace:

- LaTeX editor with AI chat, agent diffs, tools, and autocomplete.
- TexLive, Tectonic, or automatic fallback compilation with PDF preview and diagnostics.
- ACL, CVPR, NeurIPS, and ICML templates plus template transfer support.
- BibTeX/file-tree project management, paper search, web search, charts, and formula recognition.
- AI review reports, consistency checks, missing-citation checks, and compile summaries.
- Optional Yjs/WebSocket real-time collaboration.

## Quick start

### Requirements

- Node.js 18 or newer
- npm 9 or newer
- A LaTeX engine (TexLive or Tectonic) for PDF compilation

### Install and run

```bash
git clone https://github.com/icey-hub/scienceprism.git
cd scienceprism
npm install
npm run dev
```

The frontend and backend start together. For separate processes:

```bash
npm run dev:backend
npm run dev:frontend
```

Create a production frontend build with:

```bash
npm run build
```

### Configure an LLM

Configure the model and OpenAI-compatible endpoint in Workspace Settings. Environment variables are optional; use placeholders in local configuration and never commit secrets:

```text
DEEPSEEK_API_KEY=<your-key>
DEEPSEEK_BASE_URL=<optional-endpoint>
```

The key is read from the workspace setting first, then from `DEEPSEEK_API_KEY` for Harness runs.

## DeepSeek Harness

Select **DeepSeek Harness** as the Agent Runtime in Workspace Settings. The unified Harness Runtime uses the standard local SDK path automatically, or you can point to another checkout:

```text
SCIENCEPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
```

Optional runtime settings include `SCIENCEPRISM_HARNESS_PROFILE`, `SCIENCEPRISM_HARNESS_PROVIDER`, `SCIENCEPRISM_HARNESS_MAX_TOKENS`, and `SCIENCEPRISM_HARNESS_TIMEOUT_MS`. If Harness cannot start, the existing LangChain runtime is used unless `SCIENCEPRISM_HARNESS_FALLBACK=false` is set.

Each Harness Run runs against a temporary project copy. Text changes return as pending diffs and affect the original project only after the user applies them. Run state, events, validation results, errors, human decisions, and the exact model-visible context remain available through the Harness Run API.

## Project Skills

Bundled research skills live under `.dsh/skills`:

| Skill | Stages | Purpose |
| --- | --- | --- |
| `literature-search` | Direction, Search | Expand a human question into traceable queries. |
| `paper-screening` | Selection | Explain quality evidence without bypassing gates. |
| `paper-card` | Replication, Ideation, Method | Connect claims, methods, experiments, and limits. |
| `dataset-audit` | Experiment, Writing | Check provenance, access, licensing, and reproducibility. |
| `statistics-audit` | Experiment, Writing | Check units, replication, uncertainty, and comparisons. |
| `research-writing` | Writing | Build evidence-bounded outlines, claims, and citations. |

To add a project Skill, open `/editor/:projectId/research/direction`, choose **添加 Skill**, and upload a directory containing one or more `SKILL.md` files. The upload stores only the selected Skill files under `.dsh/skills`; Skill instructions cannot bypass server-side gates or approvals.

## CCF quality policy

To provide an official venue catalog, set a JSON object mapping venue names to levels:

```bash
export SCIENCEPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

The catalog is a metadata adapter. It cannot override failed year, peer-review, code, or human-approval checks. See [docs/research-workflow.md](docs/research-workflow.md) for the full policy and API behavior.

## Project documentation

- [Domain context](CONTEXT.md)
- [Project constraints](docs/project-constraints.md)
- [Research stage contracts](docs/research-stage-contracts.md)
- [Research workflow contract and migration](docs/research-workflow-contract.md)
- [Architecture decisions](docs/adr/)
- [Research workflow](docs/research-workflow.md)
- [Research Skills](docs/research-skills.md)
- [Harness Runtime](docs/harness-runtime.md)
- [Evidence Ledger](docs/evidence-ledger.md)
- [Architecture roadmap](docs/architecture-roadmap.md)
- [DeepSeek Harness integration](docs/deepseek-harness.md)

## Privacy and security

SciencePrism is designed for local-first use. Keep API keys, PATs, passwords, certificates, and private datasets outside Git. Use `.env` files only on your machine, verify `.gitignore` before committing, and rotate any credential that has been exposed.

<div align="center">
  <sub>Built for researchers who want AI assistance without giving up authorship.</sub>
</div>
