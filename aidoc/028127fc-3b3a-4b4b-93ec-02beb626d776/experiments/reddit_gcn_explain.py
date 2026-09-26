"""SciencePrism controlled run: GCN detection and local edge-mask explanations.

The input JSON comes from the official GADBench Reddit DGL file. All model
fitting, evaluation, and explanation happens inside the approved Experiment Run.
"""
import gzip
import json
import os
import random
import time
from pathlib import Path

import numpy as np
import scipy.sparse as sp
import torch
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.preprocessing import StandardScaler


torch.set_num_threads(2)
ROOT = Path.cwd()
INPUT = json.loads(Path(os.environ["SCIENCEPRISM_EXPERIMENT_INPUT"]).read_text())
DATA = ROOT / "datasets/reddit-trials-0-2.json.gz"
OUT = ROOT / "results"
OUT.mkdir(exist_ok=True)
EXPECTED_SHA = "575caca42abdb659cda700174854f7c1542d0cb7f79f676612d4a8385142a0fa"


def performance(y, p):
    return {"auprc": float(average_precision_score(y, p)), "auroc": float(roc_auc_score(y, p))}


def adjacency(src, dst, n):
    # Undirected, binary edges; the original directed edge count is preserved in provenance.
    raw = sp.coo_matrix((np.ones(len(src), np.float32), (src, dst)), shape=(n, n)).tocsr()
    raw = raw.maximum(raw.T)
    raw.data[:] = 1.0
    raw.setdiag(1.0)
    raw.eliminate_zeros()
    degrees = np.asarray(raw.sum(axis=1)).ravel().astype(np.float32)
    norm = sp.diags(1.0 / np.sqrt(degrees)) @ raw @ sp.diags(1.0 / np.sqrt(degrees))
    return raw.tocsr(), norm.tocsr(), degrees


def sparse_tensor(matrix):
    coo = matrix.tocoo()
    indices = torch.from_numpy(np.stack([coo.row, coo.col]).astype(np.int64))
    return torch.sparse_coo_tensor(indices, torch.from_numpy(coo.data.astype(np.float32)), coo.shape).coalesce()


class GCN(torch.nn.Module):
    def __init__(self, inputs, hidden=32):
        super().__init__()
        self.first = torch.nn.Linear(inputs, hidden, bias=False)
        self.second = torch.nn.Linear(hidden, 2, bias=True)

    def forward(self, x, graph):
        h = torch.relu(self.first(torch.sparse.mm(graph, x)))
        return self.second(torch.sparse.mm(graph, h))


def train_gcn(x, labels, split, graph, seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    model = GCN(x.shape[1])
    optimizer = torch.optim.Adam(model.parameters(), lr=0.01, weight_decay=5e-4)
    train = torch.from_numpy(split["train"])
    validation = split["validation"]
    y = torch.from_numpy(labels.astype(np.int64))
    positives = max(1, int(labels[split["train"]].sum()))
    negatives = int(split["train"].sum()) - positives
    weights = torch.tensor([1.0, negatives / positives], dtype=torch.float32)
    best, best_epoch, best_ap, patience = None, 0, -1.0, 0
    history = []
    started = time.monotonic()
    for epoch in range(1, 61):
        model.train()
        optimizer.zero_grad()
        logits = model(x, graph)
        loss = torch.nn.functional.cross_entropy(logits[train], y[train], weight=weights)
        loss.backward()
        optimizer.step()
        model.eval()
        with torch.no_grad():
            scores = torch.softmax(model(x, graph), dim=1)[:, 1].numpy()
        ap = float(average_precision_score(labels[validation], scores[validation]))
        history.append({"epoch": epoch, "training_loss": float(loss.detach()), "validation_auprc": ap})
        if ap > best_ap + 1e-5:
            best_ap, best_epoch = ap, epoch
            best = {key: value.detach().clone() for key, value in model.state_dict().items()}
            patience = 0
        else:
            patience += 1
        if patience >= 10:
            break
    model.load_state_dict(best)
    model.eval()
    with torch.no_grad():
        scores = torch.softmax(model(x, graph), dim=1)[:, 1].numpy()
    return model, scores, {"best_epoch": best_epoch, "validation_auprc": best_ap,
                           "seconds": round(time.monotonic() - started, 3), "history": history}


def baseline(features, labels, split, graph):
    """Feature-only logistic baseline, with C selected exclusively on validation."""
    train, validation = split["train"], split["validation"]
    scaler = StandardScaler().fit(features[train])
    x = scaler.transform(features)
    choices = []
    for c in (0.1, 1.0, 10.0):
        model = LogisticRegression(C=c, class_weight="balanced", max_iter=500, random_state=17)
        model.fit(x[train], labels[train])
        scores = model.predict_proba(x)[:, 1]
        choices.append((float(average_precision_score(labels[validation], scores[validation])), c, scores))
    ap, c, scores = max(choices, key=lambda item: item[0])
    return scores, {"C": c, "validation_auprc": ap}


def local_graph(node, raw, degrees):
    first = raw.indices[raw.indptr[node]:raw.indptr[node + 1]]
    second = np.unique(np.concatenate([raw.indices[raw.indptr[v]:raw.indptr[v + 1]] for v in first]))
    nodes = np.unique(np.concatenate([np.array([node]), first, second]))
    local = raw[nodes][:, nodes].tocoo()
    index = {int(global_id): local_id for local_id, global_id in enumerate(nodes)}
    first_local = set(index[int(v)] for v in first)
    # Every undirected pair has one trainable parameter shared by both arcs.
    pair_to_id = {}
    mapping = []
    active = []
    for row, col in zip(local.row, local.col):
        pair = (min(int(row), int(col)), max(int(row), int(col)))
        is_candidate = row != col and (row in first_local or col in first_local)
        if is_candidate and pair not in pair_to_id:
            pair_to_id[pair] = len(pair_to_id)
        mapping.append(pair_to_id.get(pair, 0) if is_candidate else 0)
        active.append(is_candidate)
    index_tensor = torch.from_numpy(np.stack([local.row, local.col]).astype(np.int64))
    weights = torch.from_numpy((1 / np.sqrt(degrees[nodes[local.row]] * degrees[nodes[local.col]])).astype(np.float32))
    return nodes, index[int(node)], index_tensor, weights, torch.tensor(mapping), torch.tensor(active), pair_to_id


def graph_from_mask(indices, weights, ids, active, mask, n):
    values = weights * torch.where(active, mask[ids], torch.ones_like(weights))
    return torch.sparse_coo_tensor(indices, values, (n, n)).coalesce()


def explain_one(node, model, x, raw, degrees, seed):
    nodes, target, indices, weights, ids, active, pairs = local_graph(node, raw, degrees)
    if len(pairs) < 3 or len(nodes) > 3000 or len(pairs) > 20000:
        return {"node": node, "status": "skipped", "candidate_edges": len(pairs), "local_nodes": len(nodes)}
    local_x = x[nodes]
    full = graph_from_mask(indices, weights, ids, active, torch.ones(len(pairs)), len(nodes))
    with torch.no_grad():
        reference = model(local_x, full)[target]
        predicted = int(reference.argmax())
        original_logit = float(reference[predicted])
    torch.manual_seed(seed)
    mask_logits = torch.nn.Parameter(torch.zeros(len(pairs)))
    optimizer = torch.optim.Adam([mask_logits], lr=0.15)
    for _ in range(35):
        optimizer.zero_grad()
        probability = torch.sigmoid(mask_logits)
        masked = graph_from_mask(indices, weights, ids, active, probability, len(nodes))
        logits = model(local_x, masked)[target]
        entropy = -(probability * torch.log(probability + 1e-8) + (1 - probability) * torch.log(1 - probability + 1e-8)).mean()
        loss = -torch.log_softmax(logits, dim=0)[predicted] + 0.05 * probability.mean() + 0.01 * entropy
        loss.backward()
        optimizer.step()
    ranking = torch.argsort(mask_logits.detach(), descending=True).numpy()
    k = min(10, max(1, round(len(pairs) * 0.1)))

    def drop(selected):
        mask = torch.ones(len(pairs))
        mask[selected] = 0.0
        with torch.no_grad():
            changed = model(local_x, graph_from_mask(indices, weights, ids, active, mask, len(nodes)))[target]
        return original_logit - float(changed[predicted])

    explained = drop(ranking[:k])
    rng = np.random.default_rng(seed)
    controls = [drop(rng.choice(len(pairs), k, replace=False)) for _ in range(20)]
    return {"node": node, "status": "ok", "predicted_class": predicted,
            "candidate_edges": len(pairs), "local_nodes": len(nodes), "removed_edges": k,
            "top_mask_logit_drop": explained, "random_logit_drop_mean": float(np.mean(controls)),
            "random_logit_drop_sd": float(np.std(controls, ddof=1)),
            "paired_difference": explained - float(np.mean(controls))}


def main():
    with gzip.open(DATA, "rt") as handle:
        payload = json.load(handle)
    if payload["sourceSha256"] != EXPECTED_SHA:
        raise ValueError("GADBench Reddit source hash does not match the audited dataset")
    features = np.asarray(payload["features"], dtype=np.float32)
    labels = np.asarray(payload["labels"], dtype=np.int64)
    raw, norm, degrees = adjacency(np.asarray(payload["edges"][0]), np.asarray(payload["edges"][1]), len(labels))
    graph = sparse_tensor(norm)
    results = []
    explanations = []
    for trial, source_split in enumerate(payload["splits"]):
        split = {key: np.asarray(value, dtype=bool) for key, value in source_split.items()}
        if any(np.any(split[a] & split[b]) for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))):
            raise ValueError("split masks overlap")
        scaler = StandardScaler().fit(features[split["train"]])
        x = torch.from_numpy(scaler.transform(features).astype(np.float32))
        model, gcn_scores, training = train_gcn(x, labels, split, graph, 17 + trial)
        base_scores, base_meta = baseline(features, labels, split, graph)
        test = split["test"]
        result = {"trial": trial, "test_nodes": int(test.sum()), "test_anomalies": int(labels[test].sum()),
                  "gcn": performance(labels[test], gcn_scores[test]),
                  "feature_logistic": performance(labels[test], base_scores[test]),
                  "gcn_training": training, "logistic_selection": base_meta}
        results.append(result)
        print(json.dumps({"trial": trial, "gcn": result["gcn"], "feature_logistic": result["feature_logistic"]}), flush=True)
        if trial == 0:
            # Fixed stratified pilot sample; selection uses labels only for sampling, never explanation optimization.
            rng = np.random.default_rng(2026)
            for label in (1, 0):
                candidates = np.flatnonzero(test & (labels == label))
                for node in rng.choice(candidates, min(6, len(candidates)), replace=False):
                    row = explain_one(int(node), model, x, raw, degrees, 1000 + int(node))
                    row["true_label"] = label
                    explanations.append(row)
                    print(json.dumps({"explained_node": int(node), "status": row["status"]}), flush=True)
    good = [row for row in explanations if row["status"] == "ok"]
    metrics = []
    for name in ("auprc", "auroc"):
        for method in ("gcn", "feature_logistic"):
            values = [row[method][name] for row in results]
            metrics.append({"name": f"{method}_{name}_mean", "value": float(np.mean(values)),
                            "uncertainty": float(np.std(values, ddof=1))})
    if good:
        metrics.append({"name": "explainer_paired_logit_drop_mean", "value": float(np.mean([r["paired_difference"] for r in good])),
                        "uncertainty": float(np.std([r["paired_difference"] for r in good], ddof=1)) if len(good) > 1 else None})
        metrics.append({"name": "explained_nodes", "value": len(good)})
    output = {"protocol": "transductive 2-layer GCN; 3 official masks; split-0 stratified local mask pilot",
              "dataset_source_sha256": EXPECTED_SHA, "directed_edges_source": len(payload["edges"][0]),
              "undirected_edges_with_loops": raw.nnz, "nodes": len(labels), "anomalies": int(labels.sum()),
              "trials": results, "explanations": explanations, "limitations": [
                  "one graph and three correlated official splits", "no ground-truth edge explanations",
                  "mask deletion uses fixed full-graph degree normalization", "small stratified explanation pilot"]}
    (OUT / "results.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    (OUT / "metrics.json").write_text(json.dumps({"metrics": metrics}, indent=2) + "\n")


if __name__ == "__main__":
    main()
