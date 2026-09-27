# Explainable General Graph Anomaly Detection: Detection Performance and Local Model Sensitivity

<!-- scienceprism-writing-brief: generatedAt=2026-09-27T06:59:17.211Z -->

## Review Run Provenance
- Coordinator Run: `5969e5b2-d862-4f3d-8e2d-58c835e20bfb`
- 论断与证据审查: `aa61c124-4636-4e41-843e-45cc0ebda997` (review opinion, not verified Evidence)
- 方法与结论审查: `5773f1fb-5ec8-4c59-ba04-02eded01e92c` (review opinion, not verified Evidence)

## Outline
- Introduction: distinguish node-level anomaly-detection performance from the fidelity and validity of local explanations.
- Related work: summarize supervised graph anomaly detection using GADBench and position the study as a bounded comparison rather than a claim about graph anomaly detectors generally.
- Explanation framework: describe GNNExplainer-style local edge masks and define perturbation-based model sensitivity separately from explanation ground truth or causal validity.
- Research questions: compare a two-layer GCN with a feature-only baseline on the selected GADBench Reddit graph, and assess whether selected local edges affect the fitted model's predicted-class score more than matched random deletions.
- Methods to report: specify the dataset version, provenance, masks, preprocessing, model-selection protocol, transductive setting, explanation-node sampling, perturbation budget, normalization choice, and random seeds once independently confirmed.
- Results section plan: report only confirmed run outcomes; if the experiment remains pending, label all metric and explanation outputs as recorded but unconfirmed and do not state a model winner.
- Interpretation: frame any deletion contrast as model sensitivity under the tested intervention, not as proof of faithful anomaly-mechanism recovery.
- Limitations and reproducibility: address the single-graph design, shared-graph split dependence, limited baseline set, absence of edge-level explanation labels, possible distribution shift from edge deletion, fixed normalization, local-subgraph target mismatch, and incomplete dataset metadata verification.
- Conclusion: answer only the bounded empirical questions supported by confirmed evidence and explicitly avoid generalization to explainable graph anomaly detection as a whole.

## Claims And Evidence
- GADBench provides a supervised static-graph anomaly-detection benchmark spanning 29 models and ten real-world datasets, and reports that tree ensembles with simple neighborhood aggregation can outperform recent GNN-based approaches in its benchmark setting.
  - Claim ID: `gadbench-benchmark-scope`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`
  - Confidence: 0.98
- The GADBench findings support comparing a GCN with non-GNN baselines without presupposing that message passing improves anomaly-detection performance.
  - Claim ID: `comparison-without-presupposed-winner`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`
  - Confidence: 0.94
- GNNExplainer is presented as a model-agnostic approach for explaining individual GNN predictions by identifying compact subgraph structures and relevant node features through an optimization formulation.
  - Claim ID: `gnnexplainer-purpose`
  - Evidence IDs: `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.98
- An explanation mask derived from GNNExplainer concerns the fitted model's prediction; the available confirmed evidence does not establish that such a mask identifies the real-world mechanism of a graph anomaly.
  - Claim ID: `prediction-versus-mechanism`
  - Evidence IDs: `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.9

## Limitations
- The controlled experiment run is pending, so reported AUPRC, AUROC, explanation counts, logit changes, means, standard deviations, and model comparisons must not be presented as verified findings.
- The verified metric and output artifacts establish that result files exist, but they do not independently confirm the pending run's scientific results.
- The executed explanation protocol is narrower than the approved method: it covers a small split-0 deletion pilot with random controls and does not establish results for addition tests, low-weight controls, degree-matched controls, repeated explanation stability, or the proposed sensitivity analyses.
- The explanation sample is small, label-stratified, and not prevalence-representative; it cannot support a population-level estimate of explanation quality.
- The perturbation quantity is predicted-class logit sensitivity under edge deletion, not explanation fidelity, semantic correctness, causal relevance, or agreement with an edge-level anomaly mechanism.
- No confirmed project evidence establishes edge-level explanation ground truth.
- The local explanation target may differ from the full-graph transductive prediction target because the explanation procedure evaluates an extracted local graph.
- Fixed original degree normalization during deletion introduces an intervention confound; results may depend on normalization and distribution-shift effects.
- The GCN-versus-logistic-regression comparison is descriptive and restricted to one graph reused across three official masks; it cannot establish superiority on general attributed graphs.
- The baseline set is insufficient for claims about graph anomaly detectors generally and does not reproduce the full GADBench comparison.
- The available confirmed evidence does not independently verify the exact Reddit node count, edge count, anomaly count, source-file layers, mask construction, licensing, or all preprocessing details stated in the manuscript.
- The confirmed paper evidence supports the scope and broad findings of GADBench and the purpose of GNNExplainer, but not the manuscript's additional citations to DOMINANT, the original GCN paper, PGExplainer, GraphFramEx, or other evaluation studies.
- Any use of the terms faithful, reliable, causal, auditable, reproducible, or general should be qualified to the confirmed evidence and the specific tested protocol.

## Unverified Claims
- claim-experiment-metrics: Any claim that the GCN or logistic-regression baseline achieved particular AUPRC or AUROC values, means, standard deviations, or superiority is not fully supported because the associated experiment run remains pending.
- claim-explanation-results: Any claim that a stated number of nodes yielded explanations or that mask-ranked deletions produced particular median, mean, subgroup, or anomaly-case logit differences is not fully supported because the associated experiment run remains pending.
- claim-general-explanation-fidelity: No claim that the local edge masks are faithful, reliable, causally valid, semantically correct, or useful for general graph anomaly detection is supported by the confirmed evidence.
- claim-dataset-metadata: The exact Reddit graph statistics, file hashes, mask construction, labels, preprocessing, licensing, and source-file provenance are not independently confirmed by the available project Evidence Ledger.
- claim-broad-model-superiority: No claim that GCNs outperform feature baselines, tree ensembles, or graph anomaly detectors generally is supported by the available confirmed evidence.
- claim-complete-method-execution: No claim that addition perturbations, low-weight controls, degree-matched controls, stability analyses, confidence intervals, permutation tests, or the full approved sensitivity-analysis plan was executed is supported by the available evidence.
