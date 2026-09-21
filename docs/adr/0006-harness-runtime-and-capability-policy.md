---
status: accepted
---

# Make Harness Runs Durable And Fail Closed

The Harness Runtime owns the lifecycle of every Harness Run, including its
temporary project copy, Adapter selection, limits, events, proposed Patches,
failure state, retry, pause, resume, cancellation, replay, and human decision.
Run metadata is stored in the project-local `.scienceprism/harness-runs.json`;
the original Project is never the execution workspace.

DeepSeek, LangChain, and Fake implementations satisfy the same Adapter
Interface. Project Constraints are interpreted by the backend and grant only
the listed capabilities. The default grant is `project.read` and
`patch.propose`; direct writes, network search, Shell/experiment execution,
and sensitive paths are denied unless explicitly granted. AI output and
Patches remain pending until a human decision is recorded.
