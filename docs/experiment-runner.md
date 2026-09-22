# Controlled Experiment Runner

The Experiment Runner is the backend-owned Module for turning an approved
Experiment Plan into a reproducible Experiment Run. An Experiment Plan is
still a reviewable description; it never becomes a result by itself.

## Lifecycle

1. Save an Experiment Plan in the `experiment` Research Stage.
2. Approve the Plan through the Research Workflow.
3. Create an Experiment Run with a structured Manifest.
4. Approve the Run as a separate human decision.
5. Start it only when the Project Constraints grant `experiment.execute`.
6. Verify the recorded code snapshot, execute inside a temporary project copy,
   and archive the declared Artifacts.
7. Review the persisted metrics and use source-bound interpretation or a
   comparison of completed Runs.

The Run status and phase make these permissions visible:

| Phase | Authority | Meaning |
| --- | --- | --- |
| `plan` | researcher | Manifest has been created and awaits approval. |
| `approval` | researcher | The Run was approved or rejected. |
| `execution` | Runner plus Project Constraint | The approved Run is isolated and executing. |
| `archive` | Runner | Logs, metrics, Artifacts, and the environment snapshot are persisted. |
| `interpret` | researcher or source-bound Harness task | Interpretation can reference only this Run's persisted Artifacts. |

## Manifest

Each Run stores `.scienceprism/experiment-runs.json` metadata and a durable
directory at `.scienceprism/experiment-runs/<run-id>/`. The Manifest records:

- code version and a SHA-256 snapshot of the selected project files;
- dataset identity, dataset version, and an optional Evidence ID;
- Node version, platform, architecture, package-lock hash, and Runner version;
- a structured Adapter command and arguments, parameters, seed, resources, and
  success criteria;
- declared output paths and their Artifact kinds: log, metric, chart, table,
  checkpoint, environment, or output.

The built-in production Adapter runs a project-relative `.js`, `.mjs`, or
`.cjs` entrypoint through `process.execPath` with `shell: false`. On macOS the
Node process is launched through `/usr/bin/sandbox-exec`: network access is
denied, host filesystem reads are limited to the copied workspace, the Node
runtime, and required macOS runtime files, and writes are limited to the copied
workspace. The child receives a small non-secret environment with workspace-
local `HOME` and `TMPDIR`. Platforms without a supported OS sandbox fail closed
with `EXPERIMENT_SANDBOX_UNAVAILABLE`; the process is never started without
isolation. The Fake Adapter is test-only.

Immediately before execution, the Runner rehashes the selected code paths in
the source Project and compares them with the Manifest. A mismatch fails with
`EXPERIMENT_CODE_CHANGED` before the Adapter starts. This prevents an approved
Run from silently executing code that changed after approval.

Grant execution explicitly in `.scienceprism/project-constraints.json`:

```json
{
  "capabilities": ["project.read", "patch.propose", "experiment.execute"],
  "maxConcurrent": 1,
  "experimentTimeoutMs": 600000
}
```

## HTTP Interface

The Experiment Run routes are under
`/api/projects/:id/experiment-runs`:

- `GET` and `POST` the Run collection;
- `GET /:runId` and `GET /comparisons?runIds=a,b`;
- `POST /:runId/decision` with `approve` or `reject`;
- `POST /:runId/start`, `/cancel`, and `/retry`;
- `POST /:runId/interpret` for a summary whose Artifact references are
  validated against the completed Run.

Retrying a failed Run builds a fresh Manifest and code snapshot from the current
Project, creates a new Run record, and returns it to the approval phase. It does
not clone stale snapshot hashes from the failed Run. Cancellation is supported
before and during execution.

## Evidence

Completed Runs and their Artifacts are written to the Evidence Ledger. Run
Evidence remains `pending` until a researcher verifies it; failed Runs are
recorded as `unverified`. The Runner never marks a result as verified and
never writes metric values from an interpretation. This preserves the
distinction between a measured result and an explanation of that result.
