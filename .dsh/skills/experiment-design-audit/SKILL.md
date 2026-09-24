---
name: experiment-design-audit
description: Audit an experiment design for baselines, metrics, ablations, seeds, and success criteria before the plan is approved for execution.
whenToUse: Use at the method stage when a method proposal is about to become an experiment plan.
metadata:
  owner: scienceprism
  stages:
    - method
---

# Experiment Design Audit

A plan is not a result. Audit it before a human approves execution.

## Procedure

1. Check that the design answers the approved method, not a neighbouring question.
2. Require an explicit baseline for every metric, and name what that baseline is.
3. Require the unit of analysis, the number of repetitions, and the seed policy.
4. Require ablations that isolate each claimed component.
5. Require success criteria that could actually fail, plus the direction each metric must move.
6. Record anything missing as an open item rather than filling it in.

## Boundaries

- Never estimate an effect size or a significance level that was not measured.
- Never authorise execution; only a human Run approval plus the `experiment.execute` capability can.
- Never present a planned experiment as a completed one.
