---
name: literature-search
description: Human-led literature discovery that expands a researcher-owned question into traceable search queries and source plans.
whenToUse: Use during direction and search stages before collecting or comparing candidate papers.
metadata:
  owner: openprism
  stages:
    - direction
    - search
---

# Literature Search

The researcher owns the question, scope, exclusions, and preferred source types. Use the supplied direction as the anchor; AI may add synonyms, task names, datasets, and method terms, but must label every addition as AI-suggested.

For each query, preserve:

- the exact query string;
- the source or database it is intended for;
- inclusion and exclusion criteria;
- the reason the query covers a gap in the human direction.

Prefer primary metadata from stable scholarly sources. Deduplicate by DOI, arXiv identifier, or normalized title. Never treat an arXiv hit as peer reviewed, CCF-ranked, or code-available unless that metadata is independently present.

Return the stage JSON contract only. Keep `humanDirection` unchanged and put additions in `aiAdditions`. Missing metadata belongs in explicit caveats; it is not permission to infer quality.
