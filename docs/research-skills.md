# Research Skills

## GitHub discovery authentication

Skill discovery and installation read public GitHub repositories. Browser login
does not authenticate the backend's API requests. Choose a backend credential source:

- `SCIENCEPRISM_GITHUB_TOKEN`: a GitHub access token.
- `SCIENCEPRISM_GITHUB_TOKEN_FILE`: an explicit path to a UTF-8 file containing
  only the token. On macOS/Linux the file must be private (`chmod 600`). The
  environment token takes precedence; the file is reread on each API request so
  replacing it does not require a server restart.
- `SCIENCEPRISM_GITHUB_CLI` together with
  `SCIENCEPRISM_GITHUB_CLI_CONFIG_DIR`: absolute paths to the GitHub CLI executable
  and its login configuration directory. The backend reads `gh auth token` into
  memory with a bounded subprocess, without a shell or an exported credential
  file. Ambient `GH_TOKEN`, `GITHUB_TOKEN`, and model keys are not passed to it.
  The explicit token/file settings take precedence over CLI authentication.

Keep the file in a local ignored directory such as `.cache/github-auth/`, outside
project research documents. Do not send the token through a frontend form,
workflow, Skill, or model prompt. The backend sends it only to `api.github.com`
over verified HTTPS. Raw file downloads remain anonymous; an optional explicitly
trusted `SCIENCEPRISM_SKILL_DISCOVERY_PROXY` uses CONNECT with separate proxy
credentials.

For a personal token, select public-repository access without additional write
permissions. For CLI browser login, review GitHub's requested permissions: its
standard OAuth flow requests `repo`, `read:org`, and `gist`, which grant more than
this discovery feature requires. The application still rejects private
repositories. CLI normally stores its credential in the system credential store;
if that store is unavailable it can fall back to a plaintext configuration file.
Check its storage status after logging in. With an already installed CLI, for
example, from the repository root:

```sh
mkdir -p .cache/github-auth/gh
chmod 700 .cache/github-auth .cache/github-auth/gh
export GH_CONFIG_DIR="$PWD/.cache/github-auth/gh"
gh auth login --web --hostname github.com
export SCIENCEPRISM_GITHUB_CLI="/absolute/path/to/gh"
export SCIENCEPRISM_GITHUB_CLI_CONFIG_DIR="$GH_CONFIG_DIR"
```

Start the backend with that environment. Account changes and CLI logout are
observed on the next API request. Use the same `GH_CONFIG_DIR` when managing this
login. Revoke the credential on GitHub when access should end. A separately
configured token file must also be removed if it is no longer needed.

Repository visibility is checked afresh before reading commits or files. Private
repositories are rejected even if the credential can access them. API caches are
partitioned by credential identity. Invalid authentication is reported explicitly
without retrying anonymously; permission failures and rate-limit responses are
reported separately. Authentication failures or throttling stop the current scan.
Secondary throttling is recognized even when GitHub omits retry headers, with a
minimum one-minute wait message. Cached fixed-commit responses reduce repeated requests.

GitHub documents a usual primary REST allowance of 60 requests/hour for anonymous
access and 5,000/hour for authenticated users; secondary limits can still apply.
See [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
and [CLI browser login](https://cli.github.com/manual/gh_auth_login).

## Bundled research skills

SciencePrism bundles twelve research skills under `.dsh/skills`. For the
DeepSeek adapter, enabled skills are copied into the isolated Harness workspace.
For the default Legacy adapter, the agent can read an enabled skill's `SKILL.md`
and its Markdown references through the read-only `read_research_skill` tool.
Skills run only when their bound stage starts a Harness Run.

Only four workflow stages run a Harness Run at present — `search`, `ideation`,
`method` and `writing` — so a skill bound to any other stage could never be
loaded. Bindings for stages without a Harness Run are therefore not declared; see
`HARNESS_EXECUTED_STAGES` in
`apps/backend/src/services/researchResearch/researchSkills.js`, which a test keeps
in step with the invocations in `researchWorkflow/application.js`.

| Skill | Workflow stages | Purpose |
| --- | --- | --- |
| `literature-search` | Search | Expand the human question into traceable queries and sources. |
| `paper-card` | Ideation, Method | Connect paper claims, methods, experiments, and limitations. |
| `dataset-audit` | Method, Writing | Check dataset provenance, access, licensing, and reproducibility. |
| `statistics-audit` | Method, Writing | Check experimental units, replication, uncertainty, and comparisons. |
| `experiment-design-audit` | Method | Audit baselines, metrics, ablations, seeds, and success criteria before approval. |
| `research-writing` | Writing | Build evidence-bounded claims, outline, citations, and limitations. |
| `claim-evidence-audit` | Writing | Classify every claim as supported, needs-verification, or unsupported. |
| `figure-table-plan` | Writing | Plan figures and tables, including the zero-install vector route and visual QA. |
| `paper-figure-style` | Writing | CCF-A / SCI 一区 figure specs, colour-blind-safe palettes, dual encoding, and a style gate. |
| `ccf-idea-review` | Ideation | Test novelty, feasibility, falsifiability, and likely reviewer objections. |
| `ccf-paper-storyline` | Writing | Connect question, mechanism, evidence, and section budget. |
| `ccf-paper-review` | Writing | Identify scientific weaknesses and unsupported claims before polishing. |

The three `ccf-*` skills are SciencePrism adaptations inspired by the
[MIT-licensed CCFA-Skills family](https://github.com/mikubaka88/CCFA-Skills).
They fit the four stages that currently execute research agents; the broader
upstream family includes workflows such as submission and rebuttal that this
product does not run yet. `paper-figure-style` is also enabled by default in
Writing. Existing projects with an explicit Writing binding keep their chosen
list; they can enable the new skills on the Direction page. In the two-reviewer
Writing mode, the claim reviewer loads `claim-evidence-audit` and the method
reviewer loads `ccf-paper-review` when those skills are enabled.

> Three skills were added in iteration 024 (`experiment-design-audit`,
> `claim-evidence-audit`, `figure-table-plan`), and `dataset-audit` /
> `statistics-audit` gained the `method` stage, which actually runs a Harness Run.
>
> `paper-screening` was removed in iteration 022. It was bound only to the
> selection stage, which never runs a Harness Run because paper selection is
> decided by the deterministic server-side quality gate (C-06). It could never be
> loaded, and it duplicated a gate that code already enforces.

## Adding a project-specific skill

DeepSeek Harness discovers a project skill at:

```text
<project-root>/.dsh/skills/<kebab-case-name>/SKILL.md
```

The file must start with YAML frontmatter containing `name`, `description`, and
at least one compatible stage under `metadata.stages` (or a top-level `stages`).
The name must be kebab-case. A project-local skill with the same name takes
precedence over the bundled copy in the temporary workspace, so it can be
customized without changing SciencePrism.

You can add a project Skill from the first workflow page at
`/editor/:projectId/research/direction`. Select the Skill directory in the
**添加 Skill** control, refresh the catalog if needed, and enable it for one or
more compatible stages. SciencePrism only uploads the selected files under
`.dsh/skills`; it does not execute Skill files during upload.

Skills are instructions, not authority. The research workflow still enforces
server-side paper quality checks, stage ordering, audit logging, and human
approval. A skill cannot approve a paper, select an innovation, authorize a
command, or fabricate an experiment result.

The current bundle intentionally does not include the broader scheduled
literature-pipeline skill: recurring searches, notifications, and archival are
outside the interactive workflow and would require a separate scheduler and
consent model.

The `nature-*` skills installed in Codex are useful source material, but they
are Codex skills with their own routers, scripts, and optional MCP servers. Do
not copy `~/.codex/skills` wholesale into this project. Adapt a needed skill to
the Harness `SKILL.md` format and place it in the project `.dsh/skills` root so
the isolated research run can discover it.
