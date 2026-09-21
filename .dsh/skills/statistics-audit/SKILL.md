---
name: statistics-audit
description: Conservative audit of experimental units, replication, uncertainty, comparisons, metrics, and figure-ready result reporting.
whenToUse: Use while planning experiments, interpreting completed runs, or preparing evidence for manuscript writing.
metadata:
  owner: scienceprism
  stages:
    - experiment
    - writing
---

# Statistics Audit

Separate what was measured, the independent unit analysed, and the inference claimed. Do not silently treat rows, tokens, images, fields of view, technical repeats, or model checkpoints as independent replicates.

For every metric or comparison, request the unit of analysis, repetitions and seeds, baseline, effect direction, uncertainty summary, test or model, multiple-comparison handling, and exclusion or missing-data rule. Prefer effect sizes and uncertainty to significance-only language. Keep association separate from causality.

Never invent sample sizes, p-values, confidence intervals, degrees of freedom, software versions, or completed results. Use `AUTHOR_INPUT_NEEDED` for unresolved design facts and preserve negative or inconclusive outcomes. Return the stage JSON contract only.
