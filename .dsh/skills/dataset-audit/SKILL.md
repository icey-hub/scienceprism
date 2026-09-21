---
name: dataset-audit
description: Dataset and code readiness audit for reproducible experiments, including provenance, versions, access routes, licenses, and missing metadata.
whenToUse: Use when turning an approved method into a dataset-backed experiment plan or writing data/code availability notes.
metadata:
  owner: scienceprism
  stages:
    - experiment
    - writing
---

# Dataset Audit

The researcher chooses the dataset and approves access. Inventory every dataset used by the proposed run and record its exact name, version or snapshot, source URL or local path, license, split policy, preprocessing, and access restrictions.

Do not invent accession numbers, licenses, permissions, versions, or availability. Mark missing facts as `AUTHOR_INPUT_NEEDED` or an explicit risk. Distinguish reused public data from newly collected, controlled-access, and unavailable data. Check that the dataset supports the proposed task, baselines, metrics, and reproducibility claim.

The plan must identify deterministic seeds, preprocessing artifacts, environment details, and a safe human-approved command. This skill never authorizes arbitrary shell execution and never converts a dataset recommendation into an experiment result.
