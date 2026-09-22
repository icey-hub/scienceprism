---
status: accepted
---

# Record Experiment Plans Before Execution

The experiment workflow records and approves an Experiment Plan before any execution. It does not execute arbitrary Shell commands. The controlled Experiment Runner in ADR-0009 provides the later Experiment Run Module with a separate approval, capability policy, resource limits, cancellation, and Artifact capture; this prevents a generated command from being mistaken for a verified result and keeps execution authorization explicit.
