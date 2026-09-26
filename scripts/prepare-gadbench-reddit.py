#!/usr/bin/env python3
"""Convert GADBench's official DGL Reddit graph to a compact Node-readable file.

This is data import, not a model run. Keep the original file and its SHA-256 so
SciencePrism's controlled Experiment Runner can trace the dataset it consumes.
"""
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
os.environ.setdefault("DGLBACKEND", "pytorch")
os.environ.setdefault("DGLDEFAULTDIR", str(repo_root / ".cache" / "dgl"))

from dgl.data.utils import load_graphs  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prepare-gadbench-reddit.py SOURCE_DGL OUTPUT_JSON_GZ")
    source, output = map(Path, sys.argv[1:])
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    graph = load_graphs(str(source))[0][0]
    src, dst = graph.edges(order="eid")
    labels = graph.ndata["label"].int().tolist()
    features = graph.ndata["feature"].float().tolist()
    payload = {
        "source": "https://github.com/squareRoot3/GADBench/tree/master/datasets",
        "sourceSha256": digest,
        "nodes": graph.num_nodes(),
        "edges": [src.tolist(), dst.tolist()],
        "features": features,
        "labels": labels,
        "splits": [
            {
                "train": graph.ndata["train_masks"][:, trial].bool().tolist(),
                "validation": graph.ndata["val_masks"][:, trial].bool().tolist(),
                "test": graph.ndata["test_masks"][:, trial].bool().tolist(),
            }
            for trial in range(3)
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as target:
            target.write(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode())
    print(json.dumps({"nodes": payload["nodes"], "edges": len(payload["edges"][0]),
                      "anomalies": sum(labels), "sha256": digest, "output": str(output)}))


if __name__ == "__main__":
    main()
