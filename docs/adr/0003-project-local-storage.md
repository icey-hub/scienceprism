---
status: accepted
---

# Store Research State Inside The Project

Research workflow state and audit history are stored in the project-local `.scienceprism/research-workflow.json` file, with `.openprism/research-workflow.json` supported as a one-time legacy source. Atomic writes and a non-destructive legacy migration keep project data portable and recoverable without introducing a separate database for the first workflow release.

