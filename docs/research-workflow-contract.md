# Research Workflow Contract

This document records the state invariants and migration rules that the existing workflow implementation must preserve while the workflow core is deepened in later phases.

## State Invariants

1. A stored workflow has schema version `3`, one `projectId`, a valid workflow status, a command receipt map, and exactly these ordered stages: `direction`, `search`, `selection`, `replication`, `ideation`, `method`, `experiment`, `writing`.
2. `currentStage` always names one of those stages. The current stage is the only stage that can be patched or approved.
3. A stage status is one of `pending`, `in_progress`, `awaiting_approval`, `approved`, `rejected`, or `skipped`.
4. A stage can be approved only when its readiness requirement is satisfied. `stageContracts.js` checks the stage-specific data shape and required fields before approval.
5. Approval advances to the next stage and marks it `in_progress`; approving the last stage sets workflow status to `completed`.
6. Rejection marks the current stage `rejected` and the workflow `blocked`. A later patch to that stage clears the rejection and returns the workflow to `in_progress`.
7. Only `replication` may be skipped, and a non-empty human note is required. Skipping advances to the next stage and records an audit event.
8. Every successful mutation appends an audit event and increments `version`. The workflow file is written atomically through a temporary file and rename.
9. AI output, a Project Skill, or frontend navigation cannot set an approval decision. Approval is an explicit backend command with an actor and optional note.
10. A completed workflow cannot be patched, approved, or have Skill bindings changed without an explicit reset operation.
11. A failed Harness Run cannot mutate the original Project. A file modification is a proposed Patch until the user applies it.
12. Experiment stage data with `status: planned` is not an Experiment Run and cannot be represented as an experiment result.

## Transition Table

| From | Command | To | Required condition |
| --- | --- | --- | --- |
| new | initialize | `direction: in_progress` | Project exists; no workflow file exists |
| `in_progress` or `awaiting_approval` | update | same stage | Current-stage gate; object data |
| `rejected` | update | `in_progress` | Current stage receives a new patch |
| current stage | approve | next stage `in_progress` | Stage readiness is satisfied |
| current stage | approve last stage | workflow `completed` | Stage readiness is satisfied |
| current stage | reject | current stage `rejected`, workflow `blocked` | Optional human note |
| replication | skip | next stage `in_progress` | Non-empty human skip reason |
| any existing workflow | reset | `direction: in_progress` | Explicit reset command; prior audit retained |

## Migration Strategy

### Existing Storage

The project-local canonical file is `.scienceprism/research-workflow.json`. On first access, the reader checks that file first and then `.openprism/research-workflow.json` as a legacy source. A legacy file is read, validated, and written to the canonical path; the legacy file is not deleted. This makes the migration recoverable and makes subsequent reads deterministic.

### Schema Version 1 To 2

The current migration changes `schemaVersion` from `1` to `2` by normalizing stored Skill bindings, then from `2` to `3` by adding command receipts. Each step appends `workflow.migrated` with `actor: system` and preserves the existing stage data, audit entries, workflow ID, project ID, and creation time. The migration is applied before stored-workflow validation and is persisted atomically.

### Future Versions

- Migrations are forward-only and must be explicit functions keyed by source version.
- A migration must preserve unknown stage data unless it can prove a field is obsolete; lossy conversion requires an audit event and a documented manual recovery path.
- Unsupported versions fail with `409 WORKFLOW_VERSION_UNSUPPORTED`; malformed JSON fails with `500 WORKFLOW_CORRUPT`.
- Legacy path migration and schema migration must remain separate steps so storage moves can be tested independently from data-shape changes.
- A future migration that changes human-owned fields must include a fixture, a rollback/export path, and an audit event before it is enabled.
- Mutating commands may provide `expectedVersion`; a mismatch fails with `409 VERSION_CONFLICT` and includes the actual version. Requests may provide `idempotencyKey`; the persisted receipt replays an identical command without adding a second audit event.

### Data Compatibility Rules

The current workflow keeps stage data as an object and reads compatibility aliases such as `innovationPoints`, `methodPlan`, and `experimentResults`. New Modules must consume the canonical contract names and keep alias conversion at the storage adapter Seam. The frontend must consume the backend projection rather than reconstructing stage meaning from aliases.
