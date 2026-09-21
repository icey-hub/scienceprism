---
status: accepted
---

# Package Constrained Context Before Harness Execution

The Harness Runtime creates a deterministic Context Pack before a Run starts.
The packer selects stage-relevant files, the current file, user selection,
confirmed Evidence, recent human decisions, applicable Skills, the stage
contract, Project Constraint projection, and human instructions. It applies
sensitive-path filtering, allowed-path checks, file priority, and a token
budget. The Run stores the exact pack and a smaller manifest with hashes so a
later inspection can answer what the model received.

Stale file or workflow versions, conflicting Evidence versions, and missing
Evidence are represented as explicit warnings in the pack. Warnings do not
grant authority to the Harness and do not replace human approval. The pack is
created before execution and reused for retry, pause/resume, and fallback so
those controls cannot silently change the model's input.
