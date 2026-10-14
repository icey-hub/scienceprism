"""Application-owned table renderer: fixed charts from archived numeric cells."""
import hashlib
import json
import math
import platform
import re
import sys
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

source = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
style = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
table = source["parsedTable"]
series, labels = table["series"], table["rowLabels"]
font_paths = ["/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
              "/System/Library/Fonts/STHeiti Light.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
font_path = next((value for value in font_paths if Path(value).is_file()), None)
all_text = [style["title"], style["xLabel"], style["yLabel"], source["unit"] or ""] + labels + table["headers"]
if not font_path and any(re.search(r"[\u3400-\u9fff]", value) for value in all_text):
    raise RuntimeError("A CJK font is required to render the supplied Chinese labels.")
font = {"family": "DejaVu Sans"}
if font_path:
    font_manager.fontManager.addfont(font_path)
    font = {"family": font_manager.FontProperties(fname=font_path).get_name(), "path": font_path,
            "sha256": hashlib.sha256(Path(font_path).read_bytes()).hexdigest()}
plt.rcParams.update({"font.family": font["family"], "font.size": 9, "axes.labelsize": 9,
                     "axes.titlesize": 10, "svg.fonttype": "none", "pdf.fonttype": 42,
                     "ps.fonttype": 42, "text.usetex": False, "text.parse_math": False,
                     "axes.unicode_minus": False, "axes.spines.top": False, "axes.spines.right": False})
palettes = {"blue-orange": ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9"],
            "purple-green": ["#8E5EA2", "#009E73", "#D55E00", "#0072B2", "#CC79A7", "#E69F00"],
            "grayscale": ["#222222", "#666666", "#999999", "#BBBBBB", "#444444", "#888888"]}
colors = palettes[style["palette"]]

def wrapped(value, width=26, limit=None):
    if limit and len(value) > limit:
        value = value[:limit - 1] + "…"
    if re.search(r"[\u3400-\u9fff]", value):
        width = max(10, width // 2)
    return "\n".join(textwrap.wrap(value, width=width, break_long_words=True, break_on_hyphens=False))

tick_step = max(1, math.ceil(len(labels) / 16))
tick_indices = sorted(set(range(0, len(labels), tick_step)) | {len(labels) - 1})
shown_labels = [wrapped(labels[index], 22, 44) for index in tick_indices]
panels = len(series) if source["layout"] == "panels" else 1
columns = min(3, panels)
rows = math.ceil(panels / columns)
fig, axes = plt.subplots(rows, columns, figsize=(max(6.8, columns * 3.6), rows * 3.4 + 0.9), squeeze=False, layout="constrained")
if style["title"]:
    fig.suptitle(wrapped(style["title"], columns * 34 + 14), fontsize=12)
chart_type = source["chartType"]
if chart_type == "heatmap":
    ax = axes[0][0]
    matrix = [[item["values"][index] for item in series] for index in range(len(labels))]
    cmap = {"blue-orange": "viridis", "purple-green": "PiYG", "grayscale": "Greys"}[style["palette"]]
    mesh = ax.pcolormesh(matrix, cmap=cmap, shading="flat", rasterized=False)
    ax.invert_yaxis()
    ax.set_xticks([index + 0.5 for index in range(len(series))], [wrapped(item["name"], 22, 44) for item in series])
    ax.set_yticks([index + 0.5 for index in tick_indices], shown_labels)
    if len(series) > 4:
        plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
    ax.set_xlabel(wrapped(style["xLabel"], 42))
    ax.set_ylabel(wrapped(table["headers"][0], 32, 64))
    colorbar = fig.colorbar(mesh, ax=ax, label=wrapped(style["yLabel"] or source["unit"] or "Value", 40))
    colorbar.solids.set_rasterized(False)
else:
    for panel, ax in enumerate(axes.flat):
        if panel >= panels:
            ax.set_visible(False)
            continue
        selected = [series[panel]] if panels > 1 else series
        for index, item in enumerate(selected):
            color = colors[(panel if panels > 1 else index) % len(colors)]
            if chart_type == "bar":
                width = 0.8 / len(selected)
                positions = [row - 0.4 + width * (index + 0.5) for row in range(len(labels))]
                ax.bar(positions, item["values"], width=width, color=color, hatch="//" if index >= len(colors) else None,
                       label=wrapped(item["name"], 30, 60), zorder=3)
            else:
                ax.plot(range(len(labels)), item["values"], marker="o", markersize=3, linewidth=1.2,
                        color=color, linestyle="--" if index >= len(colors) else "-",
                        label=wrapped(item["name"], 30, 60), zorder=3)
        ax.set_xticks(tick_indices, shown_labels)
        if len(tick_indices) > 5:
            plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
        ax.set_xlabel(wrapped(style["xLabel"], 36))
        ax.set_ylabel(wrapped(style["yLabel"] or source["unit"] or "Value", 40))
        ax.grid(axis="y", color="#E4E8E6", linewidth=0.5)
        ax.set_axisbelow(True)
        if panels > 1:
            ax.set_title(f"{chr(65 + panel)}  {wrapped(series[panel]['name'], 28, 84)}", loc="left", pad=10)
        elif len(selected) > 1:
            ax.legend(frameon=False, fontsize=8, ncols=min(3, len(selected)))
sample_note = "n not reported" if source["sampleSize"] is None else f"n = {source['sampleSize']} (user supplied)"
fig.supxlabel(f"{len(labels)} source rows | {sample_note} | no error bars\nAll values retained; full labels and exact values in source JSON", fontsize=7, color="#555555")
for extension in ("svg", "pdf", "png"):
    fig.savefig(f"figure.{extension}", dpi=600 if extension == "png" else 300,
                metadata={"Title": style["title"]}, facecolor="white", bbox_inches="tight", pad_inches=0.12)
plt.close(fig)
Path("runtime.json").write_text(json.dumps({"pythonVersion": platform.python_version(),
                                           "matplotlibVersion": matplotlib.__version__, "font": font}), encoding="utf-8")
