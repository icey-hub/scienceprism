# Harness Runtime

The Harness Runtime is the backend-owned execution Module for AI assistance.
Its public Interface is exposed by `apps/backend/src/services/harnessRuntime`:

- create, start, pause, resume, cancel, query, replay, and record a human decision;
- select the DeepSeek SDK Adapter, LangChain Agent Adapter, or Fake Adapter;
- persist Run metadata in `.scienceprism/harness-runs.json`;
- execute inside a temporary Project copy and return proposed Patches;
- record events, context hash, model, Skill names, output validation, limits, Context Pack, and errors.

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

`project.write` and `experiment.execute` are intentionally absent from the
default set. A Patch is only a proposal; this Runtime does not apply it.

## HTTP Interface

`/api/projects/:id/harness-runs` supports listing and creating Runs. The
`/:runId` resource supports `start`, `pause`, `resume`, `cancel`, `replay`, and
`decision` commands. A client can create a Run without starting it, then start
it with provider credentials supplied in the start request; credentials are
never written to the Run file.

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
