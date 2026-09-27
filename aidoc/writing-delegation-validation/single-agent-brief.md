# Explainable General Graph Anomaly Detection: Detection Performance and Local Prediction Fidelity

<!-- scienceprism-writing-brief: generatedAt=2026-09-27T06:56:48.399Z -->

## Outline
- Introduction: motivate supervised node anomaly detection in attributed graphs and distinguish detection performance from explanation quality.
- Related work: summarize GADBench as evidence for broad GNN/non-GNN comparison and GNNExplainer as a model-agnostic local explanation approach.
- Research questions and scope: compare a two-layer GCN with a node-feature-only logistic-regression baseline on the planned GADBench Reddit evaluation; assess local edge explanations through deletion and controlled insertion perturbations.
- Experimental protocol: use fixed official splits, training-only feature standardization, validation-based model selection, matched tuning budgets, predefined random seeds, and held-out test evaluation.
- Detection evaluation: report AUPRC as the primary metric and AUROC as a complementary metric, with split-level results and uncertainty rather than a single pooled claim.
- Explanation evaluation: define the node sampling rule before inspecting results; cover true-positive, false-positive, true-negative, and false-negative predictions; record explanation masks, selected edges, optimization failures, and computational cost.
- Fidelity analysis: compare explanation-selected edges with random and other controlled edge selections using paired deletion and, where implemented, insertion perturbations; treat score changes as model-fidelity measures only.
- Results presentation: report per-split detection metrics, per-node perturbation effects, subgroup distributions, explanation sparsity, stability, and sensitivity to perturbation and normalization choices.
- Discussion: interpret any association or dissociation between detection performance and model-prediction fidelity without equating fidelity with causal or mechanistic truth.
- Reproducibility and limitations: document dataset provenance, hash, license, graph semantics, label definition, preprocessing, split construction, software environment, and all unresolved metadata before making reproducibility claims.
- Conclusion: answer only the empirically supported portion of the research question and explicitly state that one graph and absent edge-level explanation ground truth limit generalization.

## Claims And Evidence
- GADBench is a benchmark for supervised anomalous-node detection in static graphs that compares 29 models across ten real-world graph anomaly-detection datasets; its reported findings motivate comparing GNNs with non-GNN baselines rather than assuming GNN superiority.
  - Claim ID: `gadbench-benchmark-context`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`
  - Confidence: 0.95
- GNNExplainer is presented as a model-agnostic method for explaining GNN predictions by identifying compact subgraphs and relevant node features, with explanation learning formulated through an optimization objective involving mutual information between predictions and candidate graph structures.
  - Claim ID: `gnnexplainer-method`
  - Evidence IDs: `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.95
- The proposed study can be framed as two linked but distinct questions: how a two-layer GCN compares with a feature-only baseline for node anomaly detection, and how faithfully a local edge explanation tracks the GCN's own predictions under controlled perturbations.
  - Claim ID: `two-part-research-question`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`, `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.82

## Limitations
- No confirmed experimental result currently supports a claim that the GCN outperforms the feature baseline in AUPRC, AUROC, or any other detection metric.
- No confirmed experimental result currently supports a claim that the generated explanations outperform random or other control edges in perturbation fidelity.
- The experiment-run record is pending at the run level, so recorded metric summaries must not be presented as verified final findings.
- The available evidence does not establish edge-level explanation ground truth; perturbation effects measure sensitivity of the model prediction, not whether selected edges represent the real anomaly mechanism.
- The planned study uses one Reddit graph and one primary GNN architecture, so findings cannot be generalized to general attributed graphs, other anomaly types, or other GNN families.
- The precise dataset provenance, license, graph semantics, label semantics, preprocessing details, split-generation procedure, and stable access route require explicit audit before reproducibility or cross-study comparability claims.
- Deleting edges can change degree normalization, isolate nodes, or create out-of-distribution graphs, so prediction decreases may reflect structural damage rather than explanation fidelity.
- Insertion-based results depend on the predefined background graph and should not be assumed to be symmetric with deletion-based results.
- Nodes in a single graph share neighborhoods and edges; ordinary independent-sample uncertainty estimates may be too optimistic.
- Explanation optimization may be sensitive to initialization, candidate-subgraph construction, optimization budget, and random seed.
- Performance comparisons can be confounded if model tuning budgets, preprocessing, class-imbalance treatment, or computational environments are not aligned.
- The proposed joint performance-fidelity framing is a candidate study design; its novelty has not been established by a complete literature review.

## Unverified Claims
- prospective-gcn-detection-superiority: It is not verified that the two-layer GCN will outperform the feature-only baseline on AUPRC or AUROC.
- prospective-explanation-superiority: It is not verified that GNNExplainer-selected edges will cause larger prediction changes than random, low-weight, or degree-matched control edges.
- prospective-generalization: It is not verified that findings from the planned Reddit experiment will generalize to general attributed graphs or other datasets.
- verified-final-experimental-results: No final experimental result should be claimed while the experiment-run evidence remains pending.
- verified-dataset-reproducibility: Reproducibility and cross-study comparability of the Reddit dataset remain unverified until the required provenance and metadata audit is complete.
- explanation-ground-truth-validity: Perturbation fidelity cannot be claimed to validate the true causal or semantic mechanism of an anomaly because edge-level explanation ground truth is absent.
- established-novelty: The joint detection-performance and local-fidelity framing cannot be claimed as novel or first without a complete literature review.
