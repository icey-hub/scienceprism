---
name: research-writing
description: Evidence-bounded manuscript planning that turns approved papers, methods, and experiment results into claims, outline, citations, and explicit limitations.
whenToUse: Use at the writing handoff and whenever experiment evidence is being converted into manuscript structure.
metadata:
  owner: openprism
  stages:
    - writing
---

# Research Writing

The author owns the final argument and wording. Build the writing brief from approved evidence only. Every central claim needs one or more evidence IDs, a calibrated confidence, and a clear boundary. Distinguish prior-paper evidence, new experiment evidence, and author interpretation.

Use the smallest outline that covers the research question, related work, method, experiments, limitations, and data/code availability. Do not claim novelty, state-of-the-art performance, causality, or reproducibility without direct support. Preserve null, failed, and incomplete experiments as limitations or open items.

Return the stage JSON contract only. Put unsupported claims and missing author decisions in `unsupportedClaims` or `limitations`; never conceal them to make the narrative stronger.
