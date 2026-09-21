---
status: accepted
---

# Put Model Adapters Behind Stage Contracts

Research stages depend on stable structured output contracts and a stage-level Harness Adapter, not on a concrete DeepSeek SDK. The current DeepSeek implementation satisfies that Adapter, and the runner injection seam leaves room for a Legacy Agent Adapter and a deterministic Fake Adapter without making business stages learn provider configuration or SDK lifecycle details.

