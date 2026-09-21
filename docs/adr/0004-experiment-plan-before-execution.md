---
status: accepted
---

# Record Experiment Plans Before Execution

The first experiment release records and approves an Experiment Plan but does not execute arbitrary Shell commands. An Experiment Run, capability policy, resource limits, cancellation, and Artifact capture are separate concerns for a later Module; this prevents a generated command from being mistaken for a verified result and keeps execution authorization explicit.

