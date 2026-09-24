---
name: figure-table-plan
description: Plan the figures and tables a manuscript needs, using the project's zero-install diagram route and a visual QA step, before any figure is drawn.
whenToUse: Use at the writing stage when a manuscript needs figures or tables, or when an existing figure must be regenerated.
metadata:
  owner: scienceprism
  stages:
    - writing
---

# Figure And Table Plan

Plan the evidence architecture first; draw second.

## Procedure

1. For each figure, state the single Result-level question it answers and the Evidence that backs it.
2. Give each panel a distinct inferential role; do not repeat the same metric across panels.
3. Choose the medium:
   - Data plots and comparison charts.
   - Diagrams, flowcharts, and **complex vector illustration** (for example a cell structure figure): hand-authored SVG is the project's zero-install route. Generate with `node scripts/build-diagrams.mjs`.
   - Never use an AI image model for a labelled scientific figure: it misspells labels and is not reproducible.
4. Every figure must declare its source Evidence IDs so it can enter the Evidence chain as an Artifact.
5. Render, then **look at the rasterised output**. A figure is not verified because its source contains a text node — CJK glyphs can be missing while the markup looks correct.

## Boundaries

- Do not draw a figure whose underlying data is unverified; mark it as a plan instead.
- Do not invent axis values, sample sizes, or significance markers.
