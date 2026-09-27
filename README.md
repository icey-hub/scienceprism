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

In the editor's **Plotting** sidebar, GPT Image 2 can create PNG diagrams from a text prompt, save them in the current project's `assets/images/`, and insert a LaTeX figure. It uses the editor's model endpoint and key by default; you can configure the backend separately with `SCIENCEPRISM_IMAGE_ENDPOINT` and `SCIENCEPRISM_IMAGE_API_KEY`. The endpoint can be an OpenAI-compatible base URL such as `https://example.com/v1`; the backend calls `/v1/images/generations` with model `gpt-image-2`. Generated illustrations are raster images; use reproducible plotting for quantitative research figures.

## Workflow

The research stages are Direction, Search, Selection, optional Replication, Ideation, Method, Experiment, and Writing. The implemented paper source is arXiv. You review search results and AI suggestions. An experiment plan and an experiment run are separate; a run needs its own approval and project execution capability.

The Direction page lists twelve built-in research Skills, including CCF-A idea review, manuscript storyline, paper review, and figure style. Bind them to compatible stages there. The default Legacy agent can read enabled Skill instructions; see [Research Skills](docs/research-skills.md) and the [generated catalog snapshot](aidoc/research-skill-catalog.md).

Writing defaults to a single Agent. On the Writing stage, choose “两个子 Agent 审查后生成” under the review mode selector and run the writing handoff to start two serial read-only reviews followed by a coordinator Run. The page shows each Run's ID, status, review text, errors, and provider-reported token usage. Review opinions are advisory and may be wrong; the final brief still passes the evidence checks and requires human approval. Each Run may make several model requests. A failed child can be inspected and retried from the same stage. In [one real-model comparison](docs/agent-governance/real-writing-delegation-validation.md), this mode used 161,818 tokens versus 25,401 for the single-Agent path; cost varies with the project context.

Main project views:

- Project overview: `/project/:projectId` for stage progress, tasks, and next steps.
- Research stages: `/editor/:projectId/research/:stage` for stage decisions.
- Manuscript editor: `/editor/:projectId` for LaTeX editing, compilation, and PDF preview.
- Library, tasks, evidence, and settings: available from project navigation.

See [Research Workflow](docs/research-workflow.md), [Harness Runtime](docs/harness-runtime.md), [Experiment Runner](docs/experiment-runner.md), and [Evidence Ledger](docs/evidence-ledger.md) for the detailed contracts.

Editor Chat can turn a durable instruction into a pending project constraint. You can correct a misunderstood proposal before reviewing its regenerated code and test draft, then accept or reject it; an accepted rule can later be disabled. The first supported checks forbid a literal phrase in assistant replies or Harness Patch content, or a project-relative path in Harness Patch application. See [Chat-origin constraints](docs/constraint-proposals.md) for the exact scope and limits.

Project Settings can toggle the two built-in optional rules: C-10 project run budgets and C-16 project feature flag overrides. Core rules remain active. Disabling C-10 retains absolute resource ceilings; disabling C-16 still respects deployment-level feature flags.

## Data and commands

Projects are stored in the repository's gitignored `data/` directory by default. Set `SCIENCEPRISM_DATA_DIR` before startup to choose another directory. Each project's workflow, evidence, and run records live under its `.scienceprism/` directory. The repository's `aidoc/` holds committed example research output, separate from personal project data.

The repository also includes an English exploratory study of explainable graph anomaly detection, run through SciencePrism's controlled Experiment Runner. The manuscript includes the related-work context, exact training and model-selection protocol, and appendices listing split-level validation records and every selected explanation-pilot node. See the [editable manuscript](aidoc/028127fc-3b3a-4b4b-93ec-02beb626d776/main.tex), [portable run artifacts](docs/research/run-artifacts/), [result plotting source](docs/research/plot-gadbench-results.py), and [GADBench data preparation script](scripts/prepare-gadbench-reddit.py). Rebuild the result figure with `python3 docs/research/plot-gadbench-results.py docs/research/run-artifacts/results/results.json docs/research/figure2-gadbench-results` (requires Matplotlib and NumPy). The study is limited to one attributed graph and a small explanation pilot; it does not establish general performance or explanation validity.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start frontend and backend |
| `npm test` | Run backend tests |
| `npm run typecheck` | Check frontend TypeScript |
| `npm run build` | Build the frontend |
| `npm run quality` | Run tests, type checking, build, and diagram layout checks |

The full quality gate needs Chrome. Set `SCIENCEPRISM_CHROME` to the browser executable if it is not installed at the default macOS path.

For more context, see the [domain overview](CONTEXT.md), [project constraints](docs/project-constraints.md), and [architecture implementation record](docs/architecture-roadmap.md). Development history and iteration notes are in the [governance record](docs/agent-governance/README.md).
