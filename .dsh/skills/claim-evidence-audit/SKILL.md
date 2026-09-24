---
name: claim-evidence-audit
description: Audit every manuscript claim against the project Evidence Ledger, flagging unsupported, stale, or over-stated claims before a human confirms them.
whenToUse: Use at the writing stage once a draft brief exists, when claims must be checked against evidence rather than merely planned.
metadata:
  owner: scienceprism
  stages:
    - writing
---

# Claim Evidence Audit

Audit claims; never approve them. The researcher owns the final claim.

## Procedure

1. List every claim in the draft together with its `evidenceIds`.
2. Resolve each Evidence entry and record its kind, verification status, and version.
3. Classify every claim:
   - `supported` — at least one verified Evidence entry actually states it.
   - `needs-verification` — Evidence exists but is pending, unverified, or its version changed.
   - `unsupported` — no Evidence, or the Evidence does not state the claim.
4. Move anything unsupported into `unsupportedClaims` with the reason, and keep it visible.
5. Report the claim-evidence table and the count per class.

## Boundaries

- Never mark Evidence verified; that is a human decision.
- Never drop an unsupported claim silently — report it.
- Never restate a claim more strongly than its Evidence supports.
