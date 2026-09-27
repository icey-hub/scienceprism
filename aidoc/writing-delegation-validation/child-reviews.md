# Multi-agent review opinions

These are unverified model opinions. They are not human approval or confirmed Evidence.

## claim-evidence-audit

Run ID: `aa61c124-4636-4e41-843e-45cc0ebda997`

## Claim–evidence audit

1. **Experimental results are presented as established despite pending run evidence.**
   The manuscript states “We used” and reports GCN/logistic-regression AUPRC and AUROC values, but the corresponding run Evidence ID `experiment-run-experiment-run-bca97a65-c447-4e18-87d0-e267623c78ec` remains **pending**. The verified metric artifact `experiment-artifact-experiment-run-bca97a65-c447-4e18-87d0-e267623c78ec-4985edf3febdd92d` supports that a metric file exists, not that the results are confirmed. This applies to the reported means, standard deviations, and model comparison.

2. **The explanation-pilot claims are also not confirmed.**
   Statements about “9 of 12” explained nodes, the median difference of `0.0025`, mean `0.4585`, the three values near `1.377`, and the anomaly-case mean `−0.0015` are not supported by a confirmed claim-level Evidence ID. They correspond most closely to pending claim `claim-80af5e13497f57c10ca7` and the pending experiment run. They should be labeled recorded/pending results rather than established findings.

3. **The manuscript overstates the evidentiary status of the dataset audit.**
   The GADBench paper Evidence ID `paper-93a5912257e52e4b7e27` supports the benchmark’s broad scope and reported competitiveness of tree ensembles, but it does not, in the available evidence, confirm the exact Reddit node count, edge count, anomaly count, file hashes, mask construction, or source-file layers reported in Methods. The code checks the hash, and the output artifact records it, but the run remains pending; these details therefore lack confirmed source/data Evidence IDs.

4. **Several cited literature claims have no corresponding project Evidence ID.**
   `paper-e354e924c2fcf2b75f3d` supports the GNNExplainer description. `paper-93a5912257e52e4b7e27` supports the GADBench claims. However, the manuscript also cites DOMINANT, the original GCN paper, PGExplainer, GraphFramEx, and other evaluation studies. Their references are not present in the readable `references.bib`, and no matching confirmed project Evidence IDs are shown. Claims attributed to those works are therefore unsupported in the current project evidence.

5. **The paper’s “auditable” and reproducibility language exceeds confirmed evidence.**
   The manuscript claims that it “records source-data hashes” and reports an auditable controlled evaluation. The readable script does contain hash checking and protocol details, and verified artifact IDs exist, but the experiment-run Evidence ID is pending and the data source/metadata are not independently confirmed in the evidence ledger. The stronger wording should be qualified.

6. **Planned methods must not be conflated with executed controls.**
   The approved method planned deletion and addition tests, low-weight controls, degree-matched controls, stability analyses, sensitivity analyses, and four prediction strata. The readable executed script implements only the split-0 stratified mask deletion pilot with 20 random deletion controls and fixed normalization. It does not show addition tests, low-weight or degree-matched controls, repeated explanation stability, or the proposed sensitivity analyses. Any manuscript language implying those controls were run would be mismatched with the executed protocol.

7. **The paper appropriately states that no explanation ground truth exists, but this limitation is not evidence for a positive fidelity claim.**
   Pending claim `claim-80af5e13497f57c10ca7` and the experiment output describe logit perturbation only. A larger mask-induced logit drop would support model sensitivity under this perturbation protocol, not semantic correctness, causal validity, or fidelity to the real anomaly mechanism. The manuscript generally acknowledges this distinction; it should be retained wherever “explanation fidelity” is used.

8. **The GADBench motivation is supported, but the broader generalization is not.**
   `paper-93a5912257e52e4b7e27` supports the motivation for comparing GCNs with non-GNN baselines. It does not support conclusions about explainable general graph anomaly detection beyond this single Reddit graph, transductive setup, two models, and small explanation sample. Any general claim should remain explicitly framed as an unverified review opinion or exploratory implication.

## method-consistency-review

Run ID: `5773f1fb-5ec8-4c59-ba04-02eded01e92c`

# Method–Conclusion Consistency Review

## Concrete findings

1. **The executed explanation protocol is narrower than the proposed method.**
   The proposed method includes deletion and addition perturbations, low-weight and degree-matched controls, stability analysis, confidence intervals/permutation tests, and sensitivity analyses. The executable script implements only top-mask deletion versus 20 random deletions; it does not implement addition perturbations, low-weight controls, degree-matched controls, or explanation-seed replication (`experiments/reddit_gcn_explain.py`; planned method `method:joint-profile-controlled-perturbation`). Conclusions should therefore be limited to a single deletion-based model-sensitivity pilot.

2. **The explanation pilot does not support a general explanation-fidelity conclusion.**
   Only up to 12 split-0 test nodes are sampled, with 9 successful explanations recorded in the evidence summary (`claim-80af5e13497f57c10ca7`; artifact `experiment-artifact-...-49c2acab87b11616`). The sample is label-stratified rather than prevalence-representative, and the code records no population-level estimator or uncertainty interval. Any statement that GNN explanations are reliable, generally faithful, or useful for graph anomaly detection would exceed this protocol.

3. **The reported perturbation quantity measures predicted-class logit sensitivity, not anomaly-explanation fidelity.**
   The script optimizes the mask to preserve the model’s current predicted class and then measures the decrease in that same class logit after deletion. This does not test explanation sufficiency, semantic correctness, causal relevance, or agreement with an edge-level anomaly mechanism. The absence of explanation ground truth is acknowledged in the project (`claim-80af5e13497f57c10ca7`; `claim-72f44280083ff74369cb`), so conclusions must use “model sensitivity” or “deletion effect,” not “correct explanation.”

4. **The local explanation target is not clearly identical to the full-graph prediction target.**
   In `explain_one`, the reference class and original logit are computed on the extracted local graph, whereas detection scores are computed with the full graph. Thus the explanation pilot may explain the GCN’s prediction on a two-hop induced subgraph rather than the prediction produced in the reported transductive detection evaluation. The paper should state this distinction explicitly or demonstrate equivalence; otherwise “explains the model’s test prediction” is potentially overstated.

5. **Fixed original degree normalization creates a known intervention confound.**
   The code removes edge values while retaining normalization weights computed from the unperturbed graph. Consequently, the deletion intervention is not the same as recomputing a normalized adjacency after edge removal. The paper acknowledges this limitation, but a conclusion that selected edges are intrinsically important would be inconsistent with the unresolved normalization and distribution-shift effects (`claim-80af5e13497f57c10ca7`; `experiment-artifact-...-49c2acab87b11616`).

6. **The GCN comparison supports only a descriptive within-graph comparison.**
   The recorded means are GCN AUPRC 0.0620 versus logistic-regression AUPRC 0.0605, and GCN AUROC 0.6695 versus 0.6594 (`claim-c8373e78362f165bfd0b`; metric artifact `experiment-artifact-...-4985edf3febdd92d`). The three trials reuse one graph and are not independent datasets. Therefore these values do not establish that GCNs outperform feature baselines, much less that they perform better on “general” attributed graphs.

7. **The baseline set is insufficient for a claim about graph anomaly detectors generally.**
   The method rationale cites GADBench’s tree-ensemble results (`claim-4b705f70a39ced66b74f`), but the executed comparison includes only a two-layer GCN and feature-only logistic regression. The paper correctly describes this as a narrow comparison; any conclusion about GNNs versus the broader GADBench model family would not be supported.

8. **The planned and executed GCN selection protocols differ.**
   The approved method plan describes validation selection over hidden dimension, regularization, learning rate, imbalance handling, and early stopping. The script fixes hidden width, learning rate, weight decay, and class weighting, selecting only the training checkpoint by validation AUPRC. This is not necessarily invalid, but the manuscript should describe the executed fixed-hyperparameter protocol rather than implying the broader planned tuning protocol was run.

9. **Artifact provenance is internally unresolved in the project snapshot.**
   The ledger marks the output and metric files as verified, but the experiment-run evidence itself remains `pending`, and direct inspection of the readable `metrics.json`, `results.json`, and `stdout.log` returned empty content. Accordingly, the numerical claims should be presented as recorded artifact claims, not as independently re-verified results (`claim-c8373e78362f165bfd0b`; `claim-80af5e13497f57c10ca7`; run evidence `experiment-run-experiment-run-bca97a65-c447-4e18-87d0-e267623c78ec`).

10. **The data-processing wording should distinguish source preservation from model input transformation.**
    The manuscript says that source graph construction was not altered, while the executable code explicitly symmetrizes directed edges, binarizes them, and adds self-loops before GCN propagation. The source file may be preserved, but the operational graph used by the model is transformed. Claims about directed-edge semantics or direct reproduction of the source graph should be qualified.

## Supported conclusion boundary

The strongest conclusion supported by the described protocol is:

> On one GADBench Reddit graph, under three correlated official masks, the tested two-layer GCN and feature-only logistic regression showed similar descriptive detection metrics. In a small split-0 pilot, deleting mask-ranked edges sometimes changed the GCN’s local predicted-class logit more than random deletions, but the result was heterogeneous and does not establish explanation fidelity, semantic anomaly causes, causal relevance, or generalization beyond this graph and perturbation protocol.

This review does not approve the stage or verify the reported numerical results.
