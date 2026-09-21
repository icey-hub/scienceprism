---
status: accepted
---

# Evidence Ledger Is the Provenance Seam

Research evidence is stored in the project-local
`.scienceprism/evidence-ledger.json` document. The Evidence Ledger Module is
the only Module responsible for normalising Evidence records, provenance,
version snapshots, relationships, and claim support checks. Older
`.scienceprism/evidence.json` and `.openprism/evidence*.json` files are read
and migrated on first access.

An Evidence record identifies its kind, summary, original URL or path,
acquisition time, verification status, version or SHA-256 hash, and optional
metadata. A Paper Claim is not treated as supported merely because it has an
ID: every `evidenceIds` reference must resolve to a confirmed Evidence record,
and a claim whose recorded Evidence version no longer matches is marked
`needs-verification`.

The Harness receives only confirmed Evidence summaries and confirmed
relationships in its Context Pack. Writing-stage output is checked against
the Ledger after schema validation. Missing, unverified, or stale references
are returned as explicit validation errors and remain human-reviewable; the
Harness cannot promote them to verified facts or approve a workflow stage.

The Ledger document has a monotonic document version and uses atomic local
writes plus an in-process project lock. The lock is intentionally local to
the current backend process; cross-process locking remains a later hardening
task.
