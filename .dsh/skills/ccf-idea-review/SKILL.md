---
name: ccf-idea-review
description: Review a CCF-A research idea for a precise question, credible novelty, falsifiable contribution, feasible evidence, and the strongest likely rejection reason before human selection.
metadata:
  owner: scienceprism
  stages:
    - ideation
---

# CCF-A Idea Review

Use this during idea generation. The researcher selects the idea; your job is to make each option testable and comparable.

1. State the research question in one sentence, including the target setting and failure mode.
2. Separate the proposed mechanism from its hoped-for outcome. Identify the closest confirmed prior work and the exact difference that would need verification.
3. Name the smallest decisive experiment for the central claim: baseline, dataset or benchmark, metric, unit of analysis, and a result that would refute the idea.
4. For each candidate, give its strongest plausible reviewer objection and a concrete way to investigate it. An unverified novelty or feasibility claim stays explicitly provisional.
5. Rank ideas only against the user's stated constraints. If the evidence is insufficient, say which comparison cannot be made yet.

Return the ideation stage's JSON contract. Put unresolved evidence, risks, and author decisions in its matching fields. Do not select or approve an idea on the researcher's behalf.
