---
name: paper-screening
description: Evidence-aware paper screening that explains quality checks while leaving hard eligibility decisions to OpenPrism's server-side gate and the researcher.
whenToUse: Use during paper selection when candidate metadata must be compared against an explicit quality policy.
metadata:
  owner: openprism
  stages:
    - selection
---

# Paper Screening

Treat the configured policy as a hard constraint. The server-side quality gate is authoritative for CCF level, venue, publication type, year, peer review, and public code. Do not upgrade an unknown field to pass and do not override a rejected candidate in prose.

For every candidate, distinguish:

- verified pass evidence;
- verified failure evidence;
- unknown metadata that requires human or source verification.

Explain decisions with short, field-level reasons. A `needs-review` result must name the missing fields and a concrete verification action. The human still selects papers; AI only prepares a structured screening explanation.

Return the stage JSON contract only. Never claim that selection, novelty, or venue status is final unless the input contains the supporting metadata.
