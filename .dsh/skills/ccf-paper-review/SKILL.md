---
name: ccf-paper-review
description: Review a CCF-A writing brief or manuscript as a skeptical program committee member, tracing every major claim to evidence and prioritizing fixable scientific weaknesses.
metadata:
  owner: scienceprism
  stages:
    - writing
---

# CCF-A Paper Review

Use this when the writing stage prepares a brief or when manuscript text is available. Review the scientific argument before polishing sentences.

1. Identify the paper's central claim, evaluated setting, and evidence currently available. Quote only short passages from supplied text where necessary to locate a problem.
2. Test validity: baseline fairness, leakage, split independence, metrics, ablations, uncertainty, failed runs, and reproducibility. Check each only when relevant to the actual method.
3. Test positioning: compare the claimed novelty against selected, confirmed sources. Missing literature means **needs verification**, not an invented competitor.
4. Separate major issues that could change the conclusion from presentation issues. For every issue, state the exact claim at risk, the supporting or missing evidence ID, and one feasible next action.
5. Recheck whether the title, abstract, figures, and conclusion overstate a pilot result or generalize beyond the tested data.

Return the writing stage's JSON contract. Place unverified reviewer concerns in limitations or unsupported claims; do not call the paper accepted, rejected, or submission-ready. Human review and approval remain separate.
