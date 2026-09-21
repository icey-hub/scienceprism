# SciencePrism Context

SciencePrism is a local-first research workspace. A researcher owns the question, decisions, experiment authorization, and final paper claims; AI provides bounded suggestions, analysis, and draft material that must remain traceable and reviewable.

This file is the canonical domain vocabulary for the research workflow. The architecture vocabulary used alongside it is **Module**, **Interface**, **Depth**, **Seam**, **Adapter**, **Leverage**, and **Locality**.

## Project And Workflow

**Project**:
A local workspace that owns the manuscript files, research workflow, project constraints, evidence references, and audit history.

**Research Workflow**:
The ordered, backend-owned record that tracks the eight research stages, their data, status, version, and audit events.

**Research Stage**:
One human-reviewable step in the workflow: direction, search, selection, replication, ideation, method, experiment, or writing.

**Approval**:
An explicit human decision that advances the current stage; navigation, an AI response, or a saved draft is not an approval.

**Project Constraint**:
A rule limiting what a Harness Run may read, write, execute, access over the network, consume in tokens, or run for time.

**Project Skill**:
Project-local instructions supplied to a compatible Harness Run; a Skill has no authority to approve workflow data or bypass a Project Constraint.

## Research Objects

**Research Direction**:
The human-owned research question, scope, constraints, and acceptance criteria that define what later stages are allowed to investigate.

**Paper Candidate**:
A paper record returned by a source and considered for selection; its metadata is not verified merely because it was retrieved.

**Evidence**:
A traceable source-backed record that supports an analysis, decision, experiment, or Paper Claim and carries its provenance and verification state.

**Evidence Ledger**:
The project-owned record of Evidence entries and relationships. It preserves source URL or path, acquisition time, summary, verification status, version or hash, and the impact of Evidence changes on Research Stages and Paper Claims.

**Method**:
The human-approved approach, assumptions, baselines, metrics, and implementation choices used to answer the Research Direction.

**Experiment Plan**:
The approved description of datasets, commands, metrics, repetitions, budget, and success criteria for a possible Experiment Run.

**Experiment Run**:
A separately identified execution of an Experiment Plan with a status, metrics, logs, and produced Artifacts; an Experiment Plan is not an Experiment Run.

**Artifact**:
A durable output such as a log, table, figure, checkpoint, or environment record that can be attached to an Evidence chain.

**Paper Claim**:
A manuscript assertion that must link to one or more Evidence records and explicitly retain uncertainty when support is incomplete.

**Claim-Evidence Matrix**:
The query projection that classifies each Paper Claim as supported, unsupported, or needing verification by resolving its Evidence IDs and comparing recorded Evidence versions.

**Harness Run**:
An auditable execution of AI assistance for a Project and Research Stage, including its model, Skill set, context, tool events, validated output, and proposed Patch.

## Canonical Names And Relationships

- A **Project** owns one **Research Workflow** and may contain many **Evidence** records and **Artifacts**.
- A **Research Workflow** contains exactly eight ordered **Research Stages**.
- A **Research Direction** produces the scoped input for search; it does not select a Paper Candidate.
- A **Paper Candidate** can support **Evidence** only after its source, retrieval time, metadata state, and relevant location are recorded.
- A confirmed **Paper Candidate**, **Method**, **Experiment Plan**, or **Artifact** may be referenced by a **Paper Claim**; a suggestion alone is not evidence.
- An **Experiment Plan** may produce zero or more **Experiment Runs**. A run may produce zero or more **Artifacts**.
- A **Harness Run** can propose data or a Patch, but only **Approval** or an explicit Patch application action can change the human-owned record.

The canonical backend stage IDs are `direction`, `search`, `selection`, `replication`, `ideation`, `method`, `experiment`, and `writing`. The frontend label `innovation` is an alias for the backend stage `ideation`; it is not a second stage.

## Example Dialogue

> **Dev:** “The Harness returned an experiment plan with a command. Can we mark the experiment as completed?”
>
> **Researcher:** “No. It is an **Experiment Plan** until I approve it and a controlled **Experiment Run** produces verified **Artifacts**. The Harness may suggest the plan, but it cannot create the result or grant **Approval**.”

## Flagged Ambiguities

- `innovation` in frontend routes and labels means the backend `ideation` stage. New code should use `ideation` as the canonical ID.
- The current `experiment` stage stores a plan and uses `status: planned`; it does not yet provide a real **Experiment Run** Module.
- “Paper” is ambiguous between a retrieved **Paper Candidate** and a selected, source-backed record. New contracts should name the lifecycle explicitly.
- `stage.data` is the current persistence envelope, not a domain object. Stage-specific contracts define the meaning of the fields stored inside it.
- Existing code uses `aiSearchStrategy`, `harness`, and `innovationPoints` as storage aliases. These remain migration-compatible aliases until the workflow core is split into a deeper Module.
