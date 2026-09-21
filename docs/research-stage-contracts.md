# Research Stage Contracts

This is the Phase 1 contract map for the research workflow. It describes the intended Interface of each Research Stage while recording the current storage and validation seams. “Human-owned” means the researcher must decide or confirm the value; “AI-suggested” means the Harness may propose it but cannot commit the decision.

The AI output names map to `apps/backend/src/services/researchResearch/schemas.js`. The workflow storage names map to `apps/backend/src/services/researchWorkflow/index.js` and may temporarily use the aliases documented in `CONTEXT.md`.

## Input, Output, Evidence, And Approval

| Stage | Input | Output | Evidence relationship | Approval and rejection |
| --- | --- | --- | --- | --- |
| Direction (`direction`) | Project identity; human question, scope, constraints, and acceptance criteria. | A normalized Research Direction and handoff context for search. Current UI stores `question`, `keywords`, `scope`, and `notes`. | Human notes and Project Constraints are the initial provenance; no external Paper Candidate is required. | Approve only when the question and scope are sufficiently specific for search. Reject when the scope is empty, contradictory, or relies on an unmarked assumption. Current readiness checks only whether one direction alias is present. |
| Search (`search`) | Approved Research Direction, source selection, query seed, and quality policy. | Search strategy (`queries`, `sources`, criteria, rationale), raw Paper Candidates, evaluated candidates, and quality summary. | Each candidate must retain source, query context, retrieval time, and available metadata; missing metadata is explicit. | Approve when queries are in scope and candidate metadata is inspectable. Reject when results are untraceable, out of scope, or the source response cannot be interpreted. |
| Selection (`selection`) | Search candidates, quality evaluations, and the active selection policy. | Human-selected Paper Candidate IDs and snapshots in `selectedPapers`; quality decisions remain attached to each candidate. | The selected record points to its source and quality checks; an `accept` decision is required. | Approve only after the server quality gate accepts every selected ID and the researcher confirms the set. Reject `needs-review`, failed, or unsupported candidates. |
| Replication (`replication`) | Selected papers plus their code, dataset, environment, and method metadata. | A reproduction plan with prerequisites, datasets, baselines, metrics, commands, expected outputs, and risks, or an explicit skip record. | Code and dataset URLs/paths, paper sections, and human notes provide provenance. | Approve a complete plan, or skip only with a human note. Reject plans that cannot state metrics, prerequisites, or expected outputs. The only skippable stage is replication. |
| Ideation (`ideation`, UI alias `innovation`) | Approved selected papers, Research Direction, and their Evidence. | Structured innovation candidates with problem, hypothesis, novelty, related paper IDs, validation plans, comparison, and caveats. | Every candidate should cite related Paper Candidates/Evidence and mark unsupported novelty as uncertain. | AI may generate candidates; the human selects one or more IDs. Reject candidates without a research gap, evidence relationship, or testable validation plan. |
| Method (`method`) | Human-selected innovation candidates, confirmed Evidence, Project Constraints, and available baselines. | Method proposals and the human-approved Method with components, assumptions, baselines, metrics, ablations, and implementation risks. | Proposals reference selected ideas and their supporting papers; assumptions and missing evidence remain visible. | Approve only the human-selected method with comparable baselines and metrics. Reject proposals that hide assumptions, lack a baseline, or claim unsupported performance. |
| Experiment (`experiment`) | Approved Method, dataset provenance/version, environment, compute budget, and success criteria. | An Experiment Plan; later, a separate Experiment Run and its results/Artifacts. Current route stores `planned` and does not execute a command. | Dataset source/version, environment, command, metric definition, and plan hash are required; results need Run IDs and Artifacts. | Approve the plan and explicit execution authorization separately. Reject missing provenance, unsafe/unbounded commands, missing success criteria, or attempts to present a plan as a result. |
| Writing (`writing`) | Confirmed papers, selected ideas, approved Method, approved Experiment Plan/Run, and Evidence. | Writing Brief with outline, Paper Claims, claim-level `evidenceIds`, citations, limitations, and unsupported-claim list; then a handoff to the editor. | Every confirmed Paper Claim links to Evidence; unsupported claims stay in `unsupportedClaims` with confidence/limitations. | Approve handoff only when evidence links and uncertainty labels are present. Reject unsupported claims, missing citations, or a result that has no Experiment Run/Artifact source. |

## Ownership Matrix

| Stage | Human-owned fields | AI-suggested fields |
| --- | --- | --- |
| Direction | `researchQuestion`, `scope`, `constraints`, `acceptanceCriteria`, final keywords | Query expansion, terminology expansion, possible inclusion/exclusion criteria |
| Search | Source choice, query seed, inclusion/exclusion policy, final interpretation of results | `queries`, `sources`, rationale, summaries, missing metadata notices |
| Selection | Selected IDs, accept/reject decision, reason for the final set | Quality explanation, score, metadata completeness, `needs-review` recommendation |
| Replication | Replicate/skip decision, approved plan, acceptable risk and resource limits | Prerequisites, baselines, metrics, commands, expected outputs, risks |
| Ideation | Chosen innovation candidate and research direction | Candidate ideas, comparisons, hypotheses, novelty analysis, validation plans |
| Method | Final Method, assumptions accepted, baselines, metrics, ablations | Method proposals and recommendation |
| Experiment | Dataset authorization, command authorization, budget, success criteria, result interpretation | Dataset audit suggestions, protocol, metrics, ablations, risk checks |
| Writing | Final Paper Claims, manuscript text, citation acceptance, limitations | Brief, outline, claim/evidence draft, citation suggestions, consistency warnings |

## Current Schema Names

| Workflow stage | Harness contract | Current persisted aliases |
| --- | --- | --- |
| `direction` | `search_strategy` | `topic`, `researchQuestion`, `question`, `seedKeywords`, `keywords` |
| `search` | `search_strategy` | `queries`, `papers`, `evaluations`, `results`, `qualitySummary` |
| `selection` | `paper_screening` | `selectedPaperIds`, `selectedPapers`, `policy` |
| `replication` | `reproduction_plan` | `replication`, `replicationPlan` |
| `ideation` | `innovation_ideas` | `ideas`, `innovationPoints`, `candidates` |
| `method` | `method_proposals` | `method`, `methodPlan`, `plan` |
| `experiment` | `experiment_plan` / future `experiment_results` | `experiment`, `experiments`, `runs`, `results` |
| `writing` | `writing_brief` | `writing`, `outline`, `draft`, `manuscript` |

## Contract Rules

1. A Harness output is usable only after the named Zod schema and, for Writing, the Evidence Ledger claim check validate it.
2. A stage output is not an Approval; the workflow mutation and audit event are separate records.
3. A Paper Claim without an Evidence ID is a pending or unsupported claim, never verified prose.
4. A proposed command is part of an Experiment Plan and cannot be executed by the current research route.
5. Any future field added to a stage must be classified as human-owned, AI-suggested, system-derived, or evidence reference before it is persisted.

## Phase 5 Runtime Checks

The Evidence Ledger Module stores source URL/path, acquisition time, summary,
verification status, version, and SHA-256 fields for each record. The writing
contract's `claims[].evidenceIds` are checked against confirmed Ledger entries;
the check also compares optional `evidenceVersions` snapshots and reports
stale Evidence. `GET /api/projects/:id/evidence/claims/matrix` exposes the same
check to the writing workbench, while `GET /api/projects/:id/evidence/graph`
exposes the question-to-claim provenance graph.
