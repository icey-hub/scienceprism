# Writing Brief: Evidence Provenance and Unsupported-Claim Suppression in Retrieval-Augmented Generation

<!-- scienceprism-writing-brief: generatedAt=2026-09-24T07:33:55.653Z -->

## Outline
- Abstract: state the research question on traceable, source-verifiable claims in retrieval-augmented generation and frame the contribution as a benchmark-design proposal, not a demonstrated result.
- Introduction: motivate evidence provenance and unsupported-claim suppression, and state explicitly that no RAG-specific paper was supplied and that the argument rests on an analogy from causal-reasoning benchmark criteria.
- Related work: summarize the review's claim that domain-knowledge retrieval can solve many causality benchmarks and its interventional/counterfactual criteria, plus the cyber threat attribution modular opinion-pool architecture and the distributed attribute representation model as analogical prior work.
- Method: describe the Paired Intervention Provenance Suite (PIPS), including the paired-item schema, the delete/contradict/distractor interventions, the meaning-preserving placebo arm, the scoring harness, and the human annotation protocol for 'supported-by-cited-span' labels.
- Planned experiments: present the approved experiment plan (evidence-gated retrieval versus plain retrieval on unsupported-claim rate, configs/evidence_gate.yaml, status planned) strictly as a plan with no results.
- Metrics and analysis plan: list the pre-registered intervention-sensitivity, claim-flip, citation-redirection, placebo-adjusted sensitivity, and discriminative-gain metrics and state that directions and effect sizes are unconfirmed guesses.
- Limitations and open items: cover absent RAG-specific evidence, unenumerated review criteria, unvalidated analogy, missing dataset and code metadata, annotation-cost and label-contestability risks, and the unexecuted experiment.
- Data and code availability: report that no benchmark items, dataset snapshot, license, seed, environment, or code artifact was supplied and mark all such facts as AUTHOR_INPUT_NEEDED.
- Conclusion: restate the proposal status and list the human decisions required before any claim of effectiveness, novelty, or reproducibility can be made.

## Claims And Evidence
- The human-confirmed abstract of the causality-benchmark review states that many existing benchmarks for large language model causal inference and reasoning can likely be solved through retrieval of domain knowledge, which the review says questions whether those benchmarks achieve their intended purpose.
  - Claim ID: `claim.review-retrieval-shortcut`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.9
- The same review reports that recent benchmarks move toward a more thorough definition of causal reasoning by incorporating interventional or counterfactual reasoning, and that it derives a set of criteria a useful benchmark should satisfy; the abstract does not enumerate those criteria, so any operational checklist derived from them is an extrapolation.
  - Claim ID: `claim.review-interventional-criteria`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.85
- The approved Paired Intervention Provenance Suite (PIPS) frames its design rationale as an analogy from the review's interventional/counterfactual benchmark criteria to claim-level provenance; the analogy is an author-level proposal and no supplied material demonstrates that this transfer holds.
  - Claim ID: `claim.pips-analogy-is-proposal`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.4
- The human-confirmed abstract of the cyber threat attribution paper proposes a modular architecture that can combine concrete attributors via opinion pools, including a Pairing Aggregator that sequentially applies logarithmic and linear opinion pools, and reports experimental validation suggesting the modular approach does not decrease performance and can enhance precision and recall relative to monolithic alternatives.
  - Claim ID: `claim.threat-attribution-modular-pools`
  - Evidence IDs: `paper-bcc49f7513ed61be3a1f`
  - Confidence: 0.85
- The human-confirmed abstract of the distributed attribute representation paper proposes a third-order multiplicative model in which word context and attribute vectors interact to predict the next word, and reports experimental tasks including sentiment classification, cross-lingual document classification, and blog authorship attribution.
  - Claim ID: `claim.attribute-representation-model`
  - Evidence IDs: `paper-b2b2f01594862b01e12f`
  - Confidence: 0.85
- The attribution-aggregation and attribute-representation papers are relevant to the direction only by analogy (attributor aggregation and attribute-conditioned representations); neither abstract addresses retrieval-augmented generation provenance, so their bearing on claim-to-source traceability is unverified.
  - Claim ID: `claim.related-work-relevance-unverified`
  - Evidence IDs: `paper-bcc49f7513ed61be3a1f`, `paper-b2b2f01594862b01e12f`
  - Confidence: 0.5

## Limitations
- No retrieval-augmented generation paper was supplied; the three available papers concern causal-reasoning benchmarks, cyber threat attribution, and distributed attribute representations, so no direct evidence supports RAG claim-provenance mechanisms.
- The core analogy from interventional/counterfactual causal-reasoning criteria to claim-level provenance benchmarking is an unvalidated author proposal and may not transfer.
- The review's derived benchmark criteria are described only at abstract level and are not enumerated in the supplied evidence, so any operational checklist is extrapolation.
- The experiment is status planned with a human-approved plan only; no run has been executed and no unsupported-claim-rate result exists.
- The experiment plan requires conversion to a structured Experiment Run, explicit approval, and execution under the experiment.execute capability, which is not granted in this context.
- The evaluation dataset is described only as a 'held-out evaluation set of evidence-attribution questions'; its identity, size, snapshot or version, source path, license, split policy, and access restrictions are AUTHOR_INPUT_NEEDED.
- No code artifact, environment specification, dependency lockfile, deterministic seed, or preprocessing artifact was supplied, so reproducibility cannot be assessed or claimed.
- Ground-truth 'supported-by-cited-span' labels are expected to be contestable and annotator disagreement could dominate the intervention-sensitivity signal.
- The intervention may perturb the prompt in ways unrelated to evidence content, risking false evidence-sensitivity; the placebo arm is intended to address this but is itself untested.
- All supplied paper metadata is incomplete: venue, venueLevel, peerReviewed, citationCount, hasCode, doi, and metadataUpdatedAt are null, and all three records are arXiv preprints with a single source record, so peer-review status and citation impact are unverified.
- Effect direction and size for every pre-registered metric are guesses that may not be confirmed by experiments.
- No statistical design facts are available, including unit of analysis, number of items, repetitions or seeds, uncertainty summary, test or model, multiple-comparison handling, and exclusion or missing-data rules; these are AUTHOR_INPUT_NEEDED.

## Unverified Claims
- Unverified: that PIPS intervention-sensitivity scores discriminate evidence-grounded attribution from parametric-memory citation; no experiment has been run.
- Unverified: that evidence-gated retrieval reduces unsupported-claim rate relative to plain retrieval; this is a planned comparison with no results.
- Unverified: that a corpus of RAG items with verifiable claim-to-span support can be assembled at acceptable annotation cost.
- Unverified: that claim and citation changes under evidence intervention are observable and stable enough to score.
- Unverified: that the review's interventional/counterfactual criteria transfer from causal-reasoning benchmarks to provenance benchmarks.
- Unverified: any claim of novelty, state-of-the-art performance, causality, or reproducibility for the proposed method.
- Unverified: that the cyber threat attribution modular opinion-pool architecture or the distributed attribute representation model provides direct support for RAG provenance; their use here is analogical only.
- Unverified: peer-review status, venue, citation counts, code availability, and DOI for any supplied paper, all of which are null in the supplied metadata.
