"""Fixed app-owned paired-seed renderer. It accepts data/style JSON, never code."""
import hashlib
import json
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
font_paths = ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/STHeiti Light.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
font_path = next((item for item in font_paths if Path(item).is_file()), None)
text_values = [style["title"], style["xLabel"], style["yLabel"], source["candidate"]["label"], source["comparison"]["label"]]
if not font_path and any(re.search(r"[\u3400-\u9fff]", value) for value in text_values):
    raise RuntimeError("A trusted CJK font is required for Chinese labels; no placeholder glyphs are exported.")
font_family = "DejaVu Sans"
font_metadata = {"family": font_family}
if font_path:
    font_manager.fontManager.addfont(font_path)
    font_family = font_manager.FontProperties(fname=font_path).get_name()
    font_metadata = {"family": font_family, "path": font_path, "sha256": hashlib.sha256(Path(font_path).read_bytes()).hexdigest()}
plt.rcParams.update({"font.family": font_family, "font.size": 9, "axes.labelsize": 10,
                     "axes.titlesize": 11, "pdf.fonttype": 42, "ps.fonttype": 42,
                     "svg.fonttype": "none", "text.usetex": False, "axes.unicode_minus": False,
                     "axes.spines.top": False, "axes.spines.right": False})
palettes = {"blue-orange": ("#0072B2", "#D55E00"),
            "purple-green": ("#8E5EA2", "#009E73"),
            "grayscale": ("#333333", "#999999")}
left_color, right_color = palettes[style["palette"]]
def wrapped(value, ascii_width, cjk_width):
    width = cjk_width if re.search(r"[\u3400-\u9fff]", value) else ascii_width
    return "\n".join(textwrap.wrap(value, width=width, break_long_words=True, break_on_hyphens=False))

title = wrapped(style["title"], 42, 24)
labels = [wrapped(source["comparison"]["label"], 24, 14), wrapped(source["candidate"]["label"], 24, 14)]
x_label = wrapped(style["xLabel"], 42, 24)
y_label = wrapped(style["yLabel"], 40, 22)
label_lines = max(value.count("\n") + 1 for value in labels)
title_lines = title.count("\n") + 1
x_lines = x_label.count("\n") + 1
height = 4.2 + max(0, label_lines - 2) * 0.15 + max(0, title_lines - 1) * 0.18 + max(0, x_lines - 1) * 0.15
fig, ax = plt.subplots(figsize=(4.8, height))
rows = source["rows"]
n = len(rows)
# A fixed symmetric offset identifies every seed without omitting paired points.
for index, row in enumerate(rows):
    offset = (index - (n - 1) / 2) * min(0.025, 0.28 / max(n, 1))
    left, right = row["comparisonValue"], row["candidateValue"]
    ax.plot([offset, 1 + offset], [left, right], color="#B5B5B5", linewidth=0.8, alpha=0.8, zorder=1)
    ax.scatter([offset], [left], s=26, color=left_color, zorder=3)
    ax.scatter([1 + offset], [right], s=26, color=right_color, zorder=3)
ax.set_xticks([0, 1], labels)
for label in ax.get_xticklabels():
    label.set_wrap(True)
    label.set_fontsize(8)
ax.set_xlim(-0.3, 1.3)
ax.set_title(title, pad=12)
ax.set_xlabel(x_label)
ax.set_ylabel(y_label)
ax.grid(axis="y", color="#E5E5E5", linewidth=0.5)
ax.set_axisbelow(True)
if source["metric"]["direction"] == "target":
    ax.axhline(source["metric"]["threshold"], color="#666666", linestyle="--", linewidth=0.8)
    ax.text(0.02, 0.98, "Dashed line: frozen absolute target", transform=ax.transAxes,
            va="top", fontsize=7, color="#555555")
threshold_note = ("absolute target = " if source["metric"]["direction"] == "target" else "mean improvement threshold = ") + str(source["metric"]["threshold"])
fig.text(0.13, 0.04 / height, f"n = {n} paired seeds | all preset seeds | no error bars\n{threshold_note}; no significance claim", fontsize=7, va="bottom", color="#555555")
fig.subplots_adjust(left=0.19, right=0.96, top=1 - (0.4 + title_lines * 0.16) / height, bottom=(0.65 + label_lines * 0.13 + x_lines * 0.15) / height)
for extension in ("svg", "pdf", "png"):
    metadata = {"Title": style["title"]} if extension != "png" else {"Title": style["title"], "Software": "OpenPrism fixed paired renderer"}
    fig.savefig(f"figure.{extension}", dpi=600 if extension == "png" else 300,
                metadata=metadata, facecolor="white", bbox_inches="tight", pad_inches=0.12)
plt.close(fig)
Path("runtime.json").write_text(json.dumps({"pythonVersion": platform.python_version(),
                                           "matplotlibVersion": matplotlib.__version__, "font": font_metadata}), encoding="utf-8")
