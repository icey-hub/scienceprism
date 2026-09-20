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

The workflow lives inside the same project and editor shell. Every stage has its own URL and records state and audit events in `.openprism/research-workflow.json` (the `OPENPRISM_*` prefix is retained for runtime compatibility).

1. **Direction** — enter the research question, scope, constraints, and acceptance criteria.
2. **Search** — expand the human-defined direction into traceable paper queries and results.
3. **Selection** — apply server-side quality gates, such as CCF venue requirements, then let the researcher choose papers.
4. **Replication** — optionally record and assess a reproduction plan for selected papers.
5. **Ideation** — ask DeepSeek Harness for several evidence-linked innovation candidates; the researcher decides which direction to keep.
6. **Method** — compare AI-assisted method proposals, then approve the final human-owned method.
7. **Experiment** — audit datasets, define commands and evaluation criteria, and record the approved experiment plan.
8. **Writing** — hand verified evidence, decisions, and results into the existing LaTeX writing workspace.

Navigation does not grant approval. The backend enforces stage order, quality gates, human confirmation, and audit logging. The first experiment release records an approved plan and does not execute arbitrary shell commands.

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

Select **DeepSeek Harness** as the Agent Runtime in Workspace Settings. SciencePrism auto-detects the standard local SDK path, or you can point to another checkout:

```text
OPENPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
```

Optional runtime settings include `OPENPRISM_HARNESS_PROFILE`, `OPENPRISM_HARNESS_PROVIDER`, `OPENPRISM_HARNESS_MAX_TOKENS`, and `OPENPRISM_HARNESS_TIMEOUT_MS`. If Harness cannot start, the existing LangChain runtime is used unless `OPENPRISM_HARNESS_FALLBACK=false` is set.

Each Harness request runs against a temporary project copy. Text changes return as pending diffs and affect the original project only after the user applies them.

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
export OPENPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

The catalog is a metadata adapter. It cannot override failed year, peer-review, code, or human-approval checks. See [docs/research-workflow.md](docs/research-workflow.md) for the full policy and API behavior.

## Project documentation

- [Research workflow](docs/research-workflow.md)
- [Research Skills](docs/research-skills.md)
- [DeepSeek Harness integration](docs/deepseek-harness.md)

## Privacy and security

SciencePrism is designed for local-first use. Keep API keys, PATs, passwords, certificates, and private datasets outside Git. Use `.env` files only on your machine, verify `.gitignore` before committing, and rotate any credential that has been exposed.

<div align="center">
  <sub>Built for researchers who want AI assistance without giving up authorship.</sub>
</div>
