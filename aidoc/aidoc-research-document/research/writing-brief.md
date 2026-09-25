# Prompt Instruction Versus Code Enforcement for Evidence-Grounded Citation: A Four-Arm Pilot Ablation

<!-- scienceprism-writing-brief: generatedAt=2026-09-25T04:43:15.758Z -->

## Outline
- Abstract: frame the brief as a pilot ablation on evidence grounding rather than the original retrieval-augmented-generation question, and state that all empirical claims are unverified pending a confirmed experiment-run Evidence entry.
- Introduction: motivate prompt-level citation instruction versus code-level enforcement as two ways to suppress fabricated citations.
- Related work: summarize the three human-confirmed background papers (interventional benchmark criteria; modular attributor aggregation; attribute-conditioned representations) and state that none directly addresses retrieval-augmented-generation provenance.
- Method: describe the four-arm ablation with eight generations per arm on a single research question, the Evidence-present and no-Evidence conditions, the citation instruction, schema enforcement, and the repair retry.
- Results: report the pilot findings, namely coverage 1.00 and no fabricated ids with Evidence present, roughly tenfold higher declared uncertainty under the citation instruction, minimal schema-enforcement effect with no repair trigger, and, without Evidence, all-fabricated ids, seven-of-eight enforcement rejections, and zero repairs.
- Analysis: state the conclusion that prompt instruction changes declared honesty while code enforcement blocks a fabricated citation from being accepted, and that the retry cannot repair a model with nothing to cite.
- Limitations: state the eight-generations-per-arm single-question pilot scope, the fact that only the no-evidence arm could fabricate, and the pending/unverified experiment-run Evidence entry.
- Availability and next steps: list the human inputs required before any claim can be promoted to verified, including a confirmed experiment-run Evidence entry, dataset and code provenance, and the statistical design.

## Claims And Evidence
- Unverified study design: the empirical study is a four-arm ablation with eight generations per arm on a single research question, in which arms vary whether Evidence is present in the stage input and how strongly citation is required. Its paired, intervention-style logic is only analogically motivated by the human-confirmed review abstract (paper-50abf243f9f4e962403b), which reports that stronger benchmarks incorporate interventional or counterfactual reasoning; the actual four-arm design is not recorded in any confirmed Evidence entry, and transposing that rationale from causal-reasoning benchmarks to claim-level provenance is an unvalidated analogy.
  - Claim ID: `claim.ablation-design`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.4
- Unverified pilot finding: with Evidence present in the stage input, claim-evidence coverage was 1.00 in every arm and no cited id was fabricated, indicating that adding the citation requirement imposed no measurable citation cost in that condition. The experiment-run Evidence entry that would confirm this is pending/unverified and was therefore not used as claim evidence, so this remains an unverified single-question pilot observation.
  - Claim ID: `claim.coverage-with-evidence`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.25
- Unverified pilot finding: instructing the model to cite Evidence raised declared uncertainty roughly tenfold relative to the condition without that instruction. This is a single-question pilot observation, and the experiment-run Evidence entry that would confirm it is pending/unverified and was not used as claim evidence.
  - Claim ID: `claim.instruction-raises-declared-uncertainty`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.25
- Unverified pilot finding: schema enforcement added almost nothing beyond the prompt instruction and never triggered a repair in the Evidence-present arms. The experiment-run Evidence entry that would confirm it is pending/unverified and was not used as claim evidence, so this is not a confirmed result.
  - Claim ID: `claim.schema-enforcement-minimal`
  - Evidence IDs: `paper-bcc49f7513ed61be3a1f`
  - Confidence: 0.25
- Unverified pilot finding: with no Evidence in the stage input, every cited id was fabricated, enforcement rejected seven of eight generations, and the repair retry never repaired one. The no-evidence arm is the only arm in which fabrication was possible by construction, so this rate is not comparable across arms; the experiment-run Evidence entry that would confirm it is pending/unverified and was not used as claim evidence.
  - Claim ID: `claim.no-evidence-fabrication`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.25
- Unverified pilot finding: the repair retry could not repair a model that had nothing to cite, repairing zero of the rejected no-evidence generations. The experiment-run Evidence entry that would confirm it is pending/unverified and was not used as claim evidence.
  - Claim ID: `claim.retry-repaired-none`
  - Evidence IDs: `paper-b2b2f01594862b01e12f`
  - Confidence: 0.25
- Unverified conclusion: prompt instruction changes declared honesty, whereas code enforcement is what stops a fabricated citation from being accepted, and the retry cannot repair a model that has nothing to cite. This interpretation rests on an eight-generations-per-arm, single-question pilot and is not backed by any confirmed Evidence entry, so it must not be reported as a verified result.
  - Claim ID: `claim.instruction-vs-enforcement`
  - Evidence IDs: `paper-bcc49f7513ed61be3a1f`
  - Confidence: 0.2
- The human-confirmed abstract of the causality-benchmark review states that many existing benchmarks for large language model causal inference and reasoning can likely be solved through retrieval of domain knowledge, which the review says questions whether those benchmarks achieve their intended purpose.
  - Claim ID: `claim.review-retrieval-shortcut`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.9
- The human-confirmed abstract of the same review reports that recent benchmarks move toward a more thorough definition of causal reasoning by incorporating interventional or counterfactual reasoning and that it derives criteria a useful benchmark should satisfy; the abstract does not enumerate those criteria, so any operational checklist derived from them is an extrapolation.
  - Claim ID: `claim.review-interventional-criteria`
  - Evidence IDs: `paper-50abf243f9f4e962403b`
  - Confidence: 0.85
- The human-confirmed abstract of the cyber threat attribution paper proposes a modular architecture that can combine concrete attributors via opinion pools, including a Pairing Aggregator that sequentially applies logarithmic and linear opinion pools, and reports experimental validation suggesting the modular approach does not decrease performance and can improve precision and recall; this is background by analogy only and does not address retrieval-augmented-generation provenance.
  - Claim ID: `claim.attribution-aggregation-background`
  - Evidence IDs: `paper-bcc49f7513ed61be3a1f`
  - Confidence: 0.85
- The human-confirmed abstract of the distributed attribute representation paper proposes a third-order multiplicative model in which word context and attribute vectors interact to predict the next word, and reports tasks including sentiment classification, cross-lingual document classification, and blog authorship attribution; this is background by analogy only and does not address retrieval-augmented-generation provenance.
  - Claim ID: `claim.attribute-representation-background`
  - Evidence IDs: `paper-b2b2f01594862b01e12f`
  - Confidence: 0.85
- None of the three human-confirmed paper abstracts supplied in this project directly addresses retrieval-augmented-generation provenance or claim-to-source traceability, so they can serve only as background and cannot substantiate the empirical findings of this study.
  - Claim ID: `claim.no-rag-provenance-paper`
  - Evidence IDs: `paper-50abf243f9f4e962403b`, `paper-bcc49f7513ed61be3a1f`, `paper-b2b2f01594862b01e12f`
  - Confidence: 0.8

## Limitations
- The sample is eight generations per arm on a single research question, so the observed effects are a pilot signal rather than a population estimate; no uncertainty interval, variance summary, or significance test is available.
- Only the no-evidence arm could fabricate citations by construction, so fabrication rates are not comparable across arms and the seven-of-eight rejection figure applies only to that arm.
- The experiment-run Evidence entry evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50 is recorded in the stage input ledger with verificationStatus pending and does not resolve as confirmed Evidence in this project, so no empirical claim in this brief cites it or is treated as verified.
- No retrieval-augmented-generation paper is present in the confirmed Evidence set; the three human-confirmed paper entries concern causal-reasoning benchmarks, cyber threat attribution, and distributed attribute representations, so they are background only and do not directly support evidence-grounding mechanisms.
- Paper 2407.08029v1 is a preprint whose venue, venueLevel, peerReviewed, citationCount, and hasCode fields are unset, and its benchmark criteria are described only at abstract level, so any derived checklist is partly extrapolated.
- The experiment is recorded as planned with a human-approved plan only; no structured Experiment Run has been executed and no unsupported-claim-rate result exists.
- No dataset identity, size, version, license, code artifact, environment specification, or deterministic seed was supplied, so reproducibility cannot be assessed or claimed.
- Ground-truth supported-by-cited-span labels and annotator agreement are unavailable, and the enforcement and repair behavior is observed on a single model and prompt scaffold, so generalization is unestablished.

## Unverified Claims
- claim.ablation-design: the four-arm, eight-generations-per-arm design and its interventional logic are only analogically motivated by paper-50abf243f9f4e962403b and are not recorded in any confirmed Evidence entry.
- claim.coverage-with-evidence: no confirmed experiment-run Evidence entry is present, so the 1.00 coverage and zero-fabrication result is unverified.
- claim.instruction-raises-declared-uncertainty: the roughly tenfold rise in declared uncertainty is an unverified single-question pilot observation with no confirmed Evidence entry.
- claim.schema-enforcement-minimal: the assertion that schema enforcement added almost nothing and never triggered a repair is unverified with no confirmed Evidence entry.
- claim.no-evidence-fabrication: the all-fabricated ids, seven-of-eight rejections, and zero repairs without Evidence are unverified with no confirmed Evidence entry.
- claim.retry-repaired-none: the retry repairing zero of the rejected generations is unverified with no confirmed Evidence entry.
- claim.instruction-vs-enforcement: the conclusion distinguishing prompt instruction from code enforcement is an unverified interpretation of the pilot and is not a confirmed result.
- The experiment-run Evidence entry evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50 is pending/unverified and does not resolve as confirmed Evidence, so it was not cited in any claim and no claim may be reported as verified on its basis.
