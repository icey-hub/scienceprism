# Evidence Ledger

The Evidence Ledger is the project-local provenance record for the research
workflow. It is available through `/api/projects/:id/evidence` and is stored
at `.scienceprism/evidence-ledger.json`.

## Record shape

Records use a stable `id`, a `kind`, a summary, provenance, verification state,
and a version or hash when one is available. Supported kinds include:

- `research-question`, `paper`, `dataset`, `code`, `environment`, `method`
- `experiment-plan`, `experiment-run`, `result`, `log`, `figure`, `table`
- `human-note`, `paper-claim`, and `artifact`

`source.url` and `source.path` preserve the original source location.
`verificationStatus` is one of `unverified`, `pending`,
`partially-verified`, `verified`, `human-confirmed`, `approved`, `rejected`,
or `superseded`.

## Relations and impact

Relations connect records with types such as `answers`, `supports`, `uses`,
`produces`, `derived-from`, `reports`, and `contradicts`. The graph endpoint
returns the related records plus the Research Stages and Paper Claims affected
by each record. A claim can retain `evidenceVersions`; the matrix marks it
`needs-verification` when an Evidence record changes version or hash.

## Claim checks

`GET /api/projects/:id/evidence/claims/matrix` returns the claim-level matrix.
The writing stage displays its supported, unsupported, and needs-verification
rows. A Harness `writing_brief` is accepted only when every returned Paper
Claim resolves to confirmed Evidence; otherwise the output contains explicit
validation errors and cannot be treated as a verified writing result.
