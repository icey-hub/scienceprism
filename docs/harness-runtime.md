# Harness Runtime

The Harness Runtime is the backend-owned execution Module for AI assistance.
Its public Interface is exposed by `apps/backend/src/services/harnessRuntime`:

- create, start, pause, resume, cancel, query, replay, and record a human decision;
- select the DeepSeek SDK Adapter, LangChain Agent Adapter, or Fake Adapter;
- persist Run metadata in `.scienceprism/harness-runs.json`;
- execute inside a temporary Project copy and return proposed Patches;
- record events, context hash, model, Skill names, output validation, limits, Context Pack, and errors.

DeepSeek can delegate coding proposals to an internal Codex CLI worker. Parent and
child share this ledger, policy and model slot; Codex is not a public Adapter
selection. See [configuration and current tool limits](deepseek-harness.md).

## Capability policy

Without a project constraint file, the Runtime grants only:

```json
{
  "capabilities": ["project.read", "patch.propose"]
}
```

To grant additional capabilities, create
`.scienceprism/project-constraints.json` in the Project. The backend intersects
requested capabilities with this list; a request cannot add a capability that
the Project Constraints did not grant.

```json
{
  "capabilities": ["project.read", "patch.propose", "research.search"],
  "allowedPaths": ["main.tex", "sections"],
  "networkAllowlist": ["export.arxiv.org"],
  "timeoutMs": 600000,
  "maxTokens": 49152,
  "contextTokenBudget": 12000,
  "maxConcurrent": 1,
  "retryLimit": 1
}
```

`experiment.execute` is intentionally absent from the default set, and there is
no direct-write capability at all: a Patch is only a proposal and this Runtime
never applies it. Writes are expressed as `patch.propose` plus the owning Patch
application command and its saved human/automatic policy, so the grantable vocabulary holds only capabilities the
Runtime can enforce.

The verified DSH profile exposes bounded project reads, text proposals, Codex
delegation, paper search and fixed approved experiment execution. Its search broker uses the shared paper-search
history and source adapters, with current role/capability/network checks before
each request and persistence. Search results retain partial failures and imported
ranking provenance; they are not automatically confirmed evidence. The experiment
broker uses the existing ExperimentRunner with an exact saved manifest, existing
approval, current file scope, parent cancellation and durable process stopping
proof. Arbitrary commands, model-supplied approvals and unbound MCP remain denied.

## HTTP Interface

`/api/projects/:id/harness-runs` supports listing and creating Runs. The
`/:runId` resource supports `start`, `pause`, `resume`, `cancel`, `replay`, and
`decision` commands. A client can create a Run without starting it, then start
it with provider credentials supplied in the start request; credentials are
never written to the Run file.

Internal `codex-worker` Runs cannot be started, replayed, accepted or applied on
their own. Their parent owns those commands and the combined proposal. Session
IDs, fixed Skill sources and actual read events remain in full history. An
unconfirmed process stop retains a persistent model-slot marker, so a service
restart cannot silently allow overlapping execution.

Within one Codex worker connection, repeated dynamic tool requests with the same
call ID and parameters share one execution and its bounded result, including
sanitized failures. Changing the thread, turn, tool or arguments under that ID is
rejected. Retransmissions do not add another tool execution or proposal to the
graph. Cross-process result reconciliation uses the retained-work recovery
interface below; it does not replay an interrupted worker. The connection retains at most 128 tool identities
and 8 pending responses. Pending input writes are limited to 4 MiB; a stalled
connection that exceeds this limit fails and is closed by the owning worker.

DeepSeek Runs now retain their private working copy, immutable baseline, selected
Skill manifest and child-process checkpoints outside the original project. Codex
stores its controls, saved thread/turn identity and bounded tool receipts there;
completed results are saved before handoff to the parent's copy. Each project
operation records a prepared receipt before execution. Completed receipts must
match the current policy and actual file evidence to replay; an uncertain prepared
operation is never automatically reissued. Parent handoff uses the same receipt
boundary and keeps conflicting worker results for reconciliation.

The retained Run has one process owner. A live or unconfirmed earlier process
blocks recovery, and a checkpoint failure cannot mask an unconfirmed stop.
`POST /api/projects/:id/harness-runs/:runId/recover` reconciles stopped work without
starting a model task. Missing completed results are read from the exact saved
Codex turn. Completed handoffs are verified as a before/after chain; a later
verified child edit does not cause an earlier proposal to execute again. Unknown
prepared operations, broken chains, changed original files or changed policy
remain conflicts. The parent stays paused with its recovered proposal.

`resume` reconciles retained work first if necessary, then starts an explicit DSH
continuation session using the fixed Skill view and saved child results. It
keeps the original workspace attempt and accounts for previously reported
parent/worker usage. An identical completed worker task returns its saved result
without spawning another worker. It does not revive an interrupted Codex turn or
automatically retry ambiguous operations. Retained files are not deleted
automatically; operators must account for their disk usage.

## Context Pack

Each Run is created with a deterministic Context Pack by
`apps/backend/src/services/harnessRuntime/contextPackager.js`. The pack contains
only the current task context that passed the backend policy: stage, active file,
selection, Project Constraint projection, prioritized file excerpts, confirmed
Evidence summaries, recent human decisions, applicable Skills, the stage output
contract, and explicit uncertainty warnings.

`contextTokenBudget` can be set in `.scienceprism/project-constraints.json` or on
the request. The packer estimates UTF-8 bytes at four bytes per token, truncates
content, and removes low-priority files when necessary. Sensitive paths and paths
outside `allowedPaths` are never included. The active file is retained as the
highest-priority file entry, even when its content must be truncated.

The Run stores both the exact `contextPack` used by the Adapter and a smaller
`contextManifest` containing the file hashes, included byte/token counts, Evidence
IDs, decision IDs, Skill names, contract, warnings, and `contextHash`. This makes
“what did the model see?” answerable after the temporary workspace is removed.

The packer emits explicit warnings for stale file/context/workflow versions,
conflicting Evidence versions, missing required or confirmed Evidence, invalid
Evidence Ledger data, and absent file-read capability. These are review signals;
they do not approve or reject workflow data.
