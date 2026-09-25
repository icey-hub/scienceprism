# SciencePrism

<img src="static/logo-rotating.gif" alt="SciencePrism logo" width="180">

A local research and LaTeX workspace for individual use. Keep a research question, paper search and selection, evidence, experiment plans, and a manuscript in one project. AI can suggest and draft; you make stage decisions, authorize experiment runs, and apply file changes.

[中文](README_ZH.md)

## Quick start

This repository has been verified with Node.js 26; it does not declare compatibility with older versions. Install dependencies and start the frontend and backend:

~~~bash
npm ci
npm run dev
~~~

Open http://localhost:5173. The frontend development server uses port 5173 and the backend API uses port 8787. Open Projects, create a project with an optional template, and enter a research question. The project overview links to the research workflow and editor. PDF compilation requires a local LaTeX engine such as Tectonic or TeX Live.

To run the processes separately:

~~~bash
npm run dev:backend
npm run dev:frontend
~~~

## Model configuration

You can create projects, manage files, and edit a manuscript without configuring a model. For AI features, enter an OpenAI-compatible endpoint, model, and API key in the editor's Workspace Settings. These settings are stored in this browser's localStorage.

You can also set server environment variables before starting the backend. They are fallback values when a request does not provide the corresponding setting:

~~~bash
export SCIENCEPRISM_LLM_ENDPOINT=https://example.com/v1
export SCIENCEPRISM_LLM_MODEL=your-model
export SCIENCEPRISM_LLM_API_KEY=your-key
npm run dev
~~~

The backend's `npm run dev` does not automatically load the repository's `.env` file. If you use one, load it in your shell first, and keep credentials out of Git. The editor's Agent Tools mode defaults to Legacy LangChain. DeepSeek Harness is optional and needs a separate SDK setup; see [DeepSeek Harness](docs/deepseek-harness.md).

## Workflow

The research stages are Direction, Search, Selection, optional Replication, Ideation, Method, Experiment, and Writing. The implemented paper source is arXiv. You review search results and AI suggestions. An experiment plan and an experiment run are separate; a run needs its own approval and project execution capability.

Main project views:

- Project overview: `/project/:projectId` for stage progress, tasks, and next steps.
- Research stages: `/editor/:projectId/research/:stage` for stage decisions.
- Manuscript editor: `/editor/:projectId` for LaTeX editing, compilation, and PDF preview.
- Library, tasks, evidence, and settings: available from project navigation.

See [Research Workflow](docs/research-workflow.md), [Harness Runtime](docs/harness-runtime.md), [Experiment Runner](docs/experiment-runner.md), and [Evidence Ledger](docs/evidence-ledger.md) for the detailed contracts.

## Data and commands

Projects are stored in the repository's gitignored `data/` directory by default. Set `SCIENCEPRISM_DATA_DIR` before startup to choose another directory. Each project's workflow, evidence, and run records live under its `.scienceprism/` directory. The repository's `aidoc/` holds committed example research output, separate from personal project data.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start frontend and backend |
| `npm test` | Run backend tests |
| `npm run typecheck` | Check frontend TypeScript |
| `npm run build` | Build the frontend |
| `npm run quality` | Run tests, type checking, build, and diagram layout checks |

The full quality gate needs Chrome. Set `SCIENCEPRISM_CHROME` to the browser executable if it is not installed at the default macOS path.

For more context, see the [domain overview](CONTEXT.md), [project constraints](docs/project-constraints.md), and [architecture implementation record](docs/architecture-roadmap.md). Development history and iteration notes are in the [governance record](docs/agent-governance/README.md).
