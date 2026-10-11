---
status: accepted
---

# User-configured research confirmation

The user requested one overall switch, per-stage switches, and a continuous literature → reproduction → limitation-analysis workflow. This extends ADR-0002 and ADR-0004: repeated human confirmation is the default, while an explicit project policy can authorize the coordinator to continue automatically.

The project-local automation policy is versioned and only human commands can change it. Stage overrides, experiment execution and manuscript Patch application can independently retain manual confirmation. Saving policy does not start work; starting a chain creates a persistent session. The coordinator rechecks policy before decisions and execution, records `system` identity, policy version and session, and never manufactures a human decision.

Model roles remain bounded structured producers. Specialists plan search, screen quality-accepted papers, plan reproduction, analyze limitations, design methods and prepare writing. They cannot edit authorization or execute commands directly. The original controlled Experiment Runner checks project capability, rollout flags, structured commands, current plan and code snapshot before dispatch. Missing materials, model contract failures and stale versions stop continuation. Completed steps survive refresh; interrupted work requires explicit continuation and unresolved dispatch is not silently repeated.

Automatic selection creates pending paper Evidence. Experimental outputs and model interpretations retain their original uncertainty; automatic stage approval is workflow authorization and does not establish scientific validity. Patch application uses the original version-checked transaction and applies only new conversation proposals when enabled.
