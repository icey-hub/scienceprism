# DeepSeek Harness and Codex CLI

DeepSeek Harness owns the research task. When configured, it can delegate a bounded
coding proposal to a Codex CLI worker and inspect the returned result. Both use the
existing project Run ledger; Codex is not a second engine selector.

## Configure the backend

Select `DeepSeek Harness` in Workspace Settings. Install the SDK and its matching
runtime dependencies in a location you manage, then configure either the installed
`@deepseek-ai/dsh-sdk-client` package or an explicit entry path:

```sh
SCIENCEPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
SCIENCEPRISM_CODEX_EXECUTABLE=/absolute/path/to/codex
SCIENCEPRISM_LLM_ENDPOINT=https://your-provider.example/v1
SCIENCEPRISM_LLM_MODEL=your-model
SCIENCEPRISM_LLM_API_KEY=your-provider-key
SCIENCEPRISM_HARNESS_FALLBACK=false
```

Keep credentials out of Git. The backend does not automatically load a root `.env`.
Request-level model settings take precedence over backend LLM settings. The same
explicit provider is passed to the worker through its private process environment;
SciencePrism does not read the user's Codex login or plugins.

The verified combination requires DSH SDK/runtime/tools/minimal/pi-ai **0.2.0-rc.2**
and Codex CLI **0.162.0-alpha.17.2**. Other versions fail with a configuration error.
There is no automatic lookup of a particular user's Desktop or app installation.
The runtime status endpoint uses the same SDK package/version verifier as execution;
an existing file alone does not mark the SDK configured. This check does not verify
model credentials or provider availability.
The DSH profile is `sdk-minimal`, with provider route `scienceprism-configured`.
Leave `SCIENCEPRISM_HARNESS_PROFILE` and `SCIENCEPRISM_HARNESS_PROVIDER` unset, or
use those exact values; a custom `SCIENCEPRISM_HARNESS_DSH_BIN` is unsupported.

The provider must support streaming Chat Completions for DSH and Responses for
Codex. HTTPS is required except for loopback providers. Without a configured Codex
executable, DSH can still read and propose changes through its project tools.

## Execution and review

The product tools are `project_read_file`, `project_propose_patch`,
`research_delegate_codex`, `research_search_papers`, and `research_run_experiment`. A coding child inherits its parent task's current role,
allowed paths, selected Skill versions, cancellation and remaining budget. The
model cannot supply a new provider, working directory, role, command or permission.
Each actual read and proposal rechecks current policy. Child proposals merge into
the parent's temporary copy using file hashes. The original project changes only
through the existing Patch application command and its configured approval policy.

Task details link the parent and child and retain Codex thread/turn IDs. Inspect
and apply the combined proposal from the parent. Child Runs cannot be started,
replayed or applied independently. Reconciled retained work can continue through
an explicit DSH handoff session; completed worker results are reused. An interrupted
Codex turn is not restarted automatically. See the recovery interface below.

The current worker supports text reads and coding proposals. Native shell, test
commands, experiment execution, arbitrary MCP tools, browser access and plugin
scripts are not exposed to the worker. The parent can execute an existing,
approved Experiment Run through its fixed-plan domain tool below.

`research_search_papers` calls the same search command as the paper search page.
It accepts `query`, fixed `sources` (`arxiv`/`openalex`), `pageSize`, `offset`,
`filters`, and `ranking`; it cannot choose a project, URL, credential or provider.
The owning Run must explicitly request `research.search`, the project must grant
it, and the role must permit it (`literature-agent` does; writing roles do not).
The project network allowlist must name `export.arxiv.org` for arXiv or
`api.openalex.org` for OpenAlex. Each actual upstream request, including queued
and paginated requests, and the search-history write recheck current policy.

The result includes the saved `searchSessionId`, bounded candidate previews,
publication metadata, imported venue ranks and partial source failures. Task
execution details link to the same paper search session with its original filters.
This does not collect papers, download attachments or confirm scientific evidence.
Identical call IDs share one execution within the live profile; persistent
cross-session research-step reuse is a separate coordinator concern.

`research_run_experiment` accepts only `runId` and `expectedManifestSha256`
(available in the saved run's `manifestSummary`). It uses the existing isolated
ExperimentRunner; the model cannot provide commands, paths, create/approve plans
or automatically retry failed work. `experiment-operator` permits this tool when
the parent and project explicitly grant `experiment.execute`. Existing human or
automatic-policy approval still applies. Automatic approval updates the manifest
hash; reload the saved manifest after authorization.

The experiment is bound to its parent, policy and exact manifest under the runner
lock. Current policy and file scope are checked before the actual process launch.
Only permitted original files enter the private working copy. Parent cancellation
waits for process exit and archival. Actual PID and stopping confirmation remain
in the experiment ledger; a restarted server refuses execution/retry when the
previous process is live or its stopping status is uncertain. A completed result
can be read again by the same parent without another process launch. Native shell
and arbitrary MCP remain disabled. Task execution links to actual logs, metrics,
artifacts and pending evidence; exit code zero does not confirm a scientific claim.

## Skills and budgets

Use the project's Skills page to discover candidates, select a fixed version,
install, bind to a stage, inspect updates, roll back or uninstall. Project-managed
`.agents/skills` takes precedence over compatibility `.dsh/skills` and built-ins.
Only selected Markdown documents are projected for a Run; scripts are not run.
Installation history, stage binding and an actual model read are distinct records.
DSH and its worker use the same frozen document hashes and source commits.

The parent holds one model slot while waiting for its child. Token use includes
both runtimes; the worker receives a smaller allocation. Usage-triggered stops
prevent further work after an observed overrun, but a completed provider response
can exceed the remaining allocation before usage arrives. These limits are not an
exact billing cap. Timeouts and cancellation wait for process shutdown before
removing temporary files. If shutdown cannot be confirmed, the workspace and a
persistent retained-slot marker are kept and further project Runs are blocked.
An operator must verify process termination before clearing that marker; restarting
the server alone is insufficient.

Legacy fallback is allowed only before delegated work and when policy permits it.
It is disabled after cancellation, a policy failure or an unconfirmed process stop.
See [Harness Runtime](harness-runtime.md) for the shared HTTP interface.
