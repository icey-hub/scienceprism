---
status: accepted
---

# Execute Approved Experiment Plans Through A Structured Runner

An Experiment Plan remains a human-approved description and is converted into
a separately identified Experiment Run. The Run requires a second explicit
human decision and the project capability `experiment.execute`. The Runner
copies the Project into a temporary workspace, records a Manifest with code,
dataset, environment, parameters, seed, resources, and success criteria, and
archives logs and declared Artifacts back into project-local storage.

The production Adapter accepts only a project-relative Node entrypoint and
executes it with `shell: false`; a free-form command is retained as a plan
note and cannot be executed. Cancellation aborts the isolated process, retry
creates a new approval-gated Run, and comparison reads only metrics persisted
by completed Runs. Results are written to the Evidence Ledger as pending or
unverified Evidence; an interpretation must reference Artifacts from the same
Run and cannot create or alter measured metrics.

This extends ADR-0004: the plan-before-execution rule remains, while the
controlled Experiment Runner now provides the later execution Module.
