#!/usr/bin/env python3
"""Render the GADBench Reddit exploratory results as editable vector figures."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


COLORS = {"gcn": "#247A78", "feature_logistic": "#D17A43"}
LABEL_COLORS = {0: "#5575A5", 1: "#C56D54"}


def style_axis(ax, title, letter):
    ax.set_title(title, loc="left", fontsize=13, fontweight="bold", color="#203247", pad=12)
    ax.text(-0.09, 1.08, letter, transform=ax.transAxes, fontsize=14, fontweight="bold",
            color="#FFFFFF", ha="center", va="center",
            bbox={"boxstyle": "circle,pad=0.32", "fc": "#203247", "ec": "none"})
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#9EADBB")
    ax.tick_params(colors="#526478", labelsize=9, length=3)
    ax.grid(axis="y", color="#DCE4EA", linewidth=0.7, zorder=0)


def performance_panel(ax, trials, metric, title, letter, ylim):
    x = np.arange(len(trials))
    for method in ("gcn", "feature_logistic"):
        values = [trial[method][metric] for trial in trials]
        ax.plot(x, values, color=COLORS[method], marker="o", markersize=6,
                markeredgecolor="white", markeredgewidth=0.8, linewidth=1.9,
                label="Two-layer GCN" if method == "gcn" else "Feature-only logistic",
                zorder=3)
        for index, (xi, yi) in enumerate(zip(x, values)):
            other = trials[index]["feature_logistic" if method == "gcn" else "gcn"][metric]
            near_other = abs(yi - other) < 0.014
            if near_other:
                offset = (0, 14 if yi > other else -20)
            else:
                offset = (0, 8 if method == "gcn" else -14)
            ax.annotate(f"{yi:.3f}", (xi, yi), xytext=offset,
                        textcoords="offset points", ha="center", fontsize=8,
                        color=COLORS[method])
    style_axis(ax, title, letter)
    ax.set_xticks(x, [f"Trial {trial['trial']}" for trial in trials])
    ax.set_ylim(*ylim)
    ax.set_ylabel(metric.upper(), fontsize=9, color="#526478")


def plot(data, output_stem):
    trials = data["trials"]
    successful = [item for item in data["explanations"] if item["status"] == "ok"]
    skipped = len(data["explanations"]) - len(successful)
    if not trials or not successful:
        raise ValueError("results.json must contain trial metrics and successful explanations")

    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.labelcolor": "#526478",
        "savefig.facecolor": "white",
        "figure.facecolor": "white",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
    })
    fig, axes = plt.subplots(2, 2, figsize=(13.4, 8.5), constrained_layout=True)
    fig.suptitle("Detection performance and local perturbation pilot",
                 fontsize=18, fontweight="bold", color="#203247", x=0.04, ha="left")
    fig.text(0.04, 0.947,
             "GADBench Reddit · three official masks · trial 0 explanation sample",
             fontsize=10, color="#65778A")

    performance_panel(axes[0, 0], trials, "auprc", "Detection under class imbalance", "A", (0.045, 0.082))
    performance_panel(axes[0, 1], trials, "auroc", "Pairwise ranking performance", "B", (0.62, 0.72))
    handles, labels = axes[0, 0].get_legend_handles_labels()
    axes[0, 1].legend(handles, labels, loc="lower right", frameon=True, framealpha=0.95,
                      facecolor="white", edgecolor="#DCE4EA", fontsize=8)

    ordered = sorted(successful, key=lambda row: row["paired_difference"])
    values = np.array([row["paired_difference"] for row in ordered])
    y = np.arange(len(ordered))
    colors = [LABEL_COLORS[int(row["true_label"])] for row in ordered]
    axes[1, 0].axvline(0, color="#66788A", linewidth=1, linestyle=(0, (3, 3)), zorder=1)
    axes[1, 0].hlines(y, 0, values, color="#A8B5C1", linewidth=1.2, zorder=2)
    axes[1, 0].scatter(values, y, c=colors, s=44, edgecolor="white", linewidth=0.8, zorder=3)
    style_axis(axes[1, 0], "All successful explanation perturbations", "C")
    axes[1, 0].grid(axis="x", color="#DCE4EA", linewidth=0.7, zorder=0)
    axes[1, 0].grid(axis="y", visible=False)
    axes[1, 0].set_yticks(y, [f"Node {row['node']}" for row in ordered])
    axes[1, 0].set_xlabel("Top-mask minus random deletion logit drop")
    axes[1, 0].set_xlim(min(-0.08, float(values.min()) - 0.02), float(values.max()) + 0.16)
    axes[1, 0].set_ylim(-0.6, len(ordered) - 0.3)
    for yi, value in zip(y, values):
        if value > 0.5:
            axes[1, 0].annotate(f"+{value:.3f}", (value, yi), xytext=(7, 0),
                                textcoords="offset points", va="center", fontsize=8,
                                color="#8F4936")
    axes[1, 0].text(0.02, 0.96, f"n = {len(successful)}; {skipped} skipped (>3,000 local nodes)",
                    transform=axes[1, 0].transAxes, ha="left", va="top", fontsize=8,
                    color="#65778A")

    small = [row for row in ordered if abs(row["paired_difference"]) < 0.05]
    small_values = np.array([row["paired_difference"] for row in small])
    small_y = np.arange(len(small))
    small_colors = [LABEL_COLORS[int(row["true_label"])] for row in small]
    axes[1, 1].axvline(0, color="#66788A", linewidth=1, linestyle=(0, (3, 3)), zorder=1)
    axes[1, 1].hlines(small_y, 0, small_values, color="#A8B5C1", linewidth=1.2, zorder=2)
    axes[1, 1].scatter(small_values, small_y, c=small_colors, s=44,
                       edgecolor="white", linewidth=0.8, zorder=3)
    style_axis(axes[1, 1], "Near-zero effects (expanded scale)", "D")
    axes[1, 1].grid(axis="x", color="#DCE4EA", linewidth=0.7, zorder=0)
    axes[1, 1].grid(axis="y", visible=False)
    axes[1, 1].set_yticks(small_y, [f"Node {row['node']}" for row in small])
    axes[1, 1].set_xlabel("Same paired difference; x-axis expanded")
    axes[1, 1].set_xlim(-0.018, 0.018)
    axes[1, 1].set_ylim(-0.6, len(small) - 0.25)
    axes[1, 1].text(0.02, 0.96, f"{len(small)} of {len(successful)} points; 3 large effects retained in C",
                    transform=axes[1, 1].transAxes, ha="left", va="top", fontsize=8,
                    color="#65778A")

    from matplotlib.lines import Line2D
    label_legend = [
        Line2D([0], [0], marker="o", color="none", markerfacecolor=LABEL_COLORS[1],
               markeredgecolor="white", label="Anomaly label", markersize=7),
        Line2D([0], [0], marker="o", color="none", markerfacecolor=LABEL_COLORS[0],
               markeredgecolor="white", label="Normal label", markersize=7),
    ]
    axes[1, 1].legend(handles=label_legend, loc="lower right", frameon=True,
                      facecolor="white", edgecolor="#DCE4EA", fontsize=8)

    fig.text(0.04, -0.01,
             "C/D show predicted-class logit changes after deleting top-k mask edges versus 20 equal-size random deletions; "
             "positive favors the mask. This is model perturbation, not explanation ground truth.",
             fontsize=8, color="#65778A", wrap=True)
    stem = Path(output_stem)
    stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(stem.with_suffix(".pdf"), bbox_inches="tight")
    fig.savefig(stem.with_suffix(".svg"), bbox_inches="tight")
    fig.savefig(stem.with_suffix(".png"), dpi=180, bbox_inches="tight")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results_json", type=Path)
    parser.add_argument("output_stem", type=Path)
    args = parser.parse_args()
    plot(json.loads(args.results_json.read_text(encoding="utf-8")), args.output_stem)


if __name__ == "__main__":
    main()
