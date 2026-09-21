---
status: accepted
---

# Isolate Harness Runs In A Temporary Project Copy

Every Harness Run executes in a temporary copy of the Project and returns file changes as proposed Patches; the original Project is changed only by an explicit user action. This preserves human control, makes failed runs recoverable, and gives the Harness Runtime a clear Seam for future capability restrictions, at the cost of copying workspace data for each run.

