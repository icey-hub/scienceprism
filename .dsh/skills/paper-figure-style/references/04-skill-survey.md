# 04 · 高星 skill 调研结论（含许可证合规核验）

> **调研方式**：本机 `web_search` 引擎不可用（modsearch 返回 403），全部数据通过 `curl` 直连 `api.github.com` 实测取得。
> **两条独立证据线**：
> 1. **Lead 实测**：16 组查询 → 144 个仓库的星数/许可证/推送时间 → 对 22 个相关仓库做 `git/trees?recursive=1` 深核验。脚本：[`research/github-skill-survey.mjs`](research/github-skill-survey.mjs)、[`research/skill-tree-probe.mjs`](research/skill-tree-probe.mjs)。
> 2. **子 agent 实测**：26 组查询 → 25 个仓库的文件树核验 + **逐仓库 LICENSE 原文探针**。笔记：[`research/skills-survey-raw.md`](research/skills-survey-raw.md)（601 行）。
>
> 两条线结论一致；**许可证结论以子 agent 的 LICENSE 原文探针为准**（更深）。

---

## 0. 最重要的结论（负面结论，但它是真的）

> **「高星」与「论文绘图」在当前 GitHub skill 生态里是负相关的。**
>
> - 显式点名 CCF-A 的 skill：`zhangjiazhe/ccfa-cns-paper-skills` **2★**、`nothingmay/Paper-Outline` **1★**。
> - 显式点名 NeurIPS/ICML/ICLR 的 `VILA-Lab/FigMirror`：**518★，且无 LICENSE 文件**。
> - `matplotlib + publication + style` 这组搜索的**最高星结果仅 69★**（`Galaxy-Dawn/pubfig`）。
> - 官方 `anthropics/skills`（177917★）实测 20 个 SKILL.md，**0 个**涉及论文写作/期刊投稿/科研绘图，且许可证为 **Proprietary**。

**所以用户「尽量找高星」这个目标，在「论文绘图风格」这个维度上不可达。** 正确做法是：**用高星 skill 的可借鉴机制 + 风格资源（SciencePlots 等）+ 本仓库实测证据，自研一个可商用的 skill。**

---

## 1. ⚠️ 许可证雷区（本轮调研最有价值的发现）

**高星 ≠ 能用。** 以下仓库星数很高，但**法律上不能直接吸收进本项目**：

| 仓库 | 星数 | 实测许可证 | 判定 |
| --- | --- | --- | --- |
| `anthropics/skills` | 177917 | **Proprietary**（其 `pdf/SKILL.md` frontmatter 明写） | ❌ 不可吸收 |
| `Imbad0202/academic-research-skills` | 49371 | **CC BY-NC 4.0**（LICENSE 原文探针） | ❌ 禁商用 |
| `ChenLiu-1996/figures4papers` | 7059 | **CC BY-NC 4.0**（LICENSE 原文探针） | ❌ 禁商用 |
| `Trae1ounG/paper-plot-skills` | 834 | **无 LICENSE 文件**（raw 探针非 200） | ❌ 无授权 |
| `VILA-Lab/FigMirror` | 518 | **无 LICENSE 文件** | ❌ 无授权 |
| `chingswy/Skill-Research-Figure` | 173 | **无 LICENSE 文件** | ❌ 无授权 |
| `c-narcissus/paper-framework-figure-studio-pro` | 2174 | **无 LICENSE 文件** | ❌ 无授权 |

> ⚠️ **对本仓库的直接影响**：Lead 在早期草稿中曾把 `ChenLiu-1996/figures4papers`（★7059）列为「采纳来源」。
> 子 agent 的 LICENSE 原文探针证明它是 **CC BY-NC 4.0（禁商用）**，因此**已从自研 skill 的采纳来源中移除**，仅作为「写作范式观察」记录，不复制其内容。
> 这正是「先核验许可证，再决定吸收」的价值。

**可安全商用的高星来源**（MIT / Apache-2.0 / BSD）：

| 仓库 | 星数 | 许可证 |
| --- | --- | --- |
| `K-Dense-AI/scientific-agent-skills` | 46482 | MIT |
| `Master-cai/Research-Paper-Writing-Skills` | 7084 | MIT |
| `Haojae/scipilot-figure-skill` | 2469 | MIT（有 LICENSE 文件） |
| `LigphiDonk/academic-figure-generator` | 2448 | MIT |
| `Orchestra-Research/AI-Research-SKILLs` | 13006 | MIT |
| `wanshuiyin/Auto-claude-code-research-in-sleep` | 16597 | MIT |
| `zLanqing/codex-claude-academic-skills` | 4262 | MIT |
| `Azhi-ss/academic-figure-skills` | 125 | MIT |
| `garrettj403/SciencePlots` | 9250 | MIT |
| `axismaps/colorbrewer` | 1102 | Apache-2.0 |
| `colour-science/colour` | 2654 | BSD-3-Clause |

---

## 2. Top 5 推荐（可商用）

| # | 仓库 | 星数 | 许可证 | 为什么 |
| --- | --- | --- | --- | --- |
| 1 | `K-Dense-AI/scientific-agent-skills` | 46482 | MIT | 星数最高的**真 skill 库**（166 个 SKILL.md 实测）；`scientific-visualization` + `matplotlib` 直击出版级数据图；但**只做 data figures**，不含示意图/架构图 |
| 2 | `Master-cai/Research-Paper-Writing-Skills` | 7084 | MIT | 专为 ML/CV/NLP 论文（最接近 CS 场景）；覆盖 figures/tables 打磨与 claim-evidence 对齐；**但不含绘图风格规范** |
| 3 | **`Haojae/scipilot-figure-skill`** | 2469 | MIT | 高星绘图 skill 里**最贴期刊投稿**：Nature/Science/IEEE/Elsevier/PNAS + 中文核心；含「可视化顾问」图型推荐、色盲安全、**灰度预览**、**中文混排（宋体正文 + Times New Roman 数字）与负号方框修复**、**渲染后视觉自检闭环**。自述**不做示意图/流程图/架构图** |
| 4 | `LigphiDonk/academic-figure-generator` | 2448 | MIT | 论文配图生成 skill（2 个 SKILL.md 实测） |
| 5 | `Azhi-ss/academic-figure-skills` | 125 | MIT | 星数低，但**唯一 frontmatter 带 `stages:` 的 5-skill 绘图流水线**，与本仓库 `.dsh/skills/` 加载约定同构，格式可直接复用 |

**次选（机制优秀）**：`TAO-QKV/Icarus-Figures`（48★, MIT，四轴质量门 + 图契约）、`heyu-233/engineering-figure-agent`（305★, MIT，image/plot/mixed 三分模式）、`wanshuiyin/.../figure-spec`（MIT，**确定性 JSON→SVG**）、`Orchestra-Research/.../academic-plotting`（MIT，图表选型矩阵）。

---

## 3. 风格资源（**明确标注：不是 skill**）

以下均为绘图风格/色板/教程资源，**无 `SKILL.md`，不可被 skill 加载器加载**；只能作为风格资料包的内容来源或自研 skill 的引用依据。

| 资源 | 星数 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `matplotlib/matplotlib` | 23259 | 未识别 | 官方库；感知均匀色图 `viridis` 等 |
| `rougier/scientific-visualization-book` | 11569 | 未识别（**是书，不是 skill**） | 科学可视化专著，含「如何不骗人地画图」原则 |
| `garrettj403/SciencePlots` | 9250 | **MIT** | matplotlib 期刊样式表（Nature/Science/IEEE/APS），`plt.style.use(['science','ieee'])` |
| `rougier/matplotlib-cheatsheet` | 2909 | BSD-2-Clause | matplotlib 速查表 |
| `colour-science/colour` | 2654 | BSD-3-Clause | 色差、**色盲模拟**、色彩空间转换（做色盲安全校验） |
| `axismaps/colorbrewer` | 1102 | Apache-2.0 | ColorBrewer 配色原始实现 |
| `Paul Tol 配色` | — | — | 搜索返回 **0 条**，未找到权威仓库；**标注为未核验**，建议直接引用作者官方页面 |

---

## 4. 现有高星 skill 的缺口清单（= 自研 skill 的输入）

1. **无 CCF-A 会议版式硬参数**：无人给出 ACM `acmart` / IEEEtran / NeurIPS `.sty` 的图宽（单栏/双栏）、字号（≥7pt）、线宽等硬参数。
2. **无「示意图/方法总览图」的高星整合**：高星库全部只做数据图或写作；做示意图的都是低星或无许可证。
3. **无「可编辑矢量输出」的统一验收门**：仅 `TAO-QKV/Icarus-Figures`（48★）提出四轴质量门；其余要么只出 PNG，要么无验收。
4. **无中文期刊规范**：仅 `Haojae/scipilot-figure-skill`（2469★）提到中文混排与负号方框修复——**这是最值得吸收的单点**。
5. **无「参考图 → 风格迁移 → 自检闭环」的高星实现**：`VILA-Lab/FigMirror`（518★）机制完整但**无许可证**。
6. **无本机可执行的渲染链**：`chingswy` 依赖 `pdflatex`+Blender，`pengjunchi0` 依赖 Windows Visio，多数依赖 matplotlib——**本机无 matplotlib/seaborn，只有 `tectonic`**，这些 skill 均不能原样跑通。
7. **许可证雷区普遍**：见 §1。
8. **缺 `stages:` frontmatter 约定**：本仓库 `.dsh/skills/` 加载器只认带 `stages:` 的 skill；25 个核验仓库中只有 `Azhi-ss/academic-figure-skills` 符合。

---

## 5. 决策：自研 `paper-figure-style`

| 自研 skill 的组成部分 | 融合来源（含许可证） |
| --- | --- |
| 目标 venue 硬规格（列宽/DPI/字号/格式） | 📐 IEEE / Nature / PLOS / SIGCHI **官方指南**（[`02-venue-specs.md`](02-venue-specs.md)） |
| 图表选型优先级矩阵 | `Orchestra-Research/AI-Research-SKILLs`（★13006, **MIT**）的 `academic-plotting` |
| 架构图用确定性矢量、**不用 AI 生图** | `wanshuiyin/.../figure-spec`（★16597, **MIT**）+ 本仓库既有约束 |
| 「可视化顾问」式先剖析数据再推荐图型 | `Haojae/scipilot-figure-skill`（★2469, **MIT**） |
| 渲染后视觉自检闭环 | `Haojae/scipilot-figure-skill`（★2469, **MIT**） |
| 色盲安全 + 灰度预览 | `Haojae/scipilot-figure-skill` + SIGCHI 无障碍指南 |
| 期刊样式表（matplotlib 路线） | `garrettj403/SciencePlots`（★9250, **MIT**） |
| 色盲模拟校验 | `colour-science/colour`（★2654, **BSD-3**） |
| 配色 / 字号 / 线宽的量化默认值 | **本仓库对 291 张真实论文插图的实测**（[`03-palette-and-typography.md`](03-palette-and-typography.md)） |
| 双编码（颜色 + 形状） | SIGCHI 无障碍指南 + CCS 真实插图目视复核 |
| 画完自动校验 | 本仓库自研门禁 [`check/check-figure-style.mjs`](check/check-figure-style.mjs) |

**自研产物**：[`skills/paper-figure-style/SKILL.md`](skills/paper-figure-style/SKILL.md)

**明确不采纳**：`ChenLiu-1996/figures4papers`（CC BY-NC 禁商用）、`Imbad0202/academic-research-skills`（NC）、`anthropics/skills`（Proprietary）、`academic-plotting` 的「用 Gemini 生图做架构图」子流程（不可复现 + 会拼错标签，与本仓库约束冲突）。

---

## 6. 未解疑点与风险

| 项 | 说明 |
| --- | --- |
| 星数可信度 | 本机 `api.github.com` 返回值显著高于 GitHub 常规量级（如 `anthropics/skills` 177917★）。**不排除本机网络环境返回合成/镜像数据**。因此本表只可用于**同一次快照内的相对排序**，不可对外引用绝对星数 |
| 限速遗留 | core 60/h 在最后 3 个聚合列表仓库（`ComposioHQ/awesome-claude-skills` 等）耗尽，其完整文件树未核验；已用 raw 探针确认根目录无 `SKILL.md` |
| 40 余个仓库未核验 | 星数来自搜索实测，但「是否真含 SKILL.md」未经核实（如 `alirezarezvani/claude-skills` 26393★、`wshobson/agents` 39921★） |
| `NOASSERTION` ≠ 无许可证 | 有 LICENSE 但 GitHub 无法识别 SPDX，**需人工读原文**才能商用 |
| Paul Tol 配色 | 搜索返回 0 条，**未核验**；本仓库不转录其色值，避免抄错 |
