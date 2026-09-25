# 05 · 原论文复刻流程（Replication Workflow）

> **为什么要有这一步**：自绘框图最容易「看起来像 PPT，不像论文」。
> 复刻真实论文插图，是把风格从「我以为」校准到「审稿人见过的样子」的最快路径。
> 本文件把这套流程固化成可重复的 6 步，并记录了实际踩过的坑。

---

## 0. 什么时候用

| 场景 | 用不用复刻 |
| --- | --- |
| 第一次给某 venue 画图，不确定版式 | ✅ 先复刻该 venue 一张图 |
| 要画框图/架构图/流程图 | ✅ 优先复刻同类型框图 |
| 已有明确规范、只是画数据图 | ⚠️ 可选，直接照 [`01-figure-style-guide.md`](01-figure-style-guide.md) |
| 只是改个颜色/字号 | ❌ 不用 |

**复刻 ≠ 抄袭**：复刻的是**版式、配色体系、标记约定、几何比例**；数据一律用合成值，标签在生成器里写清来源与「数据为合成」。原图必须来自可再分发许可（本仓库只用 CC-BY / CC-BY-SA）。

---

## 1. 六步流程

### 第 0 步：选图 + 三查（不合格就换图）

**查质量**：只选 CCF-A 会议 / CCF-A 期刊 / SCI 一区 / Nature 系。venue 证据在 `gallery/<dir>/credits.json` 里。

**查许可证**：必须是 CC-BY / CC-BY-SA / CC0。arXiv 默认「非独占许可」的论文**不能**进 gallery，也就不能作为复刻对象。

**查能不能渲染**（最容易漏的一步）：

```bash
node pic/check/render-figure.mjs <原图.svg> /tmp/probe.png --dpr 1
```

- 退出码非 0 → 换图。真实案例：`oopsla-2026-mgql-gql-semantics/fig02.svg` 是 **XML 非法**的（LaTeXML 输出里有个未转义的 `&`），浏览器只会渲染出错误页。全库扫描：**166 个 SVG 里 1 个是坏的**。
- 还要看**内容有没有越界**。真实案例：`oopsla-2026-mgql-gql-semantics/fig01.svg` 的部分内容在 viewBox 之外（y 为负），顶部元素被裁掉 —— 这种图不适合当范例。

### 第 1 步：提取几何与配色（不要目测）

```bash
node pic/check/extract-figure.mjs <原图.svg> --min-area 200 --top 60
```

输出三块信息：

| 输出 | 用途 |
| --- | --- |
| 画布 viewBox + **固有渲染尺寸** | 决定渲染尺寸（见第 2 步的坑） |
| 元素计数 + 调色板（fill/stroke 频次） | 直接得到原图配色体系 |
| 形状外接矩形表（fill / stroke / x / y / w / h） | 直接得到块的位置与尺寸 |

**它做了什么**：论文 SVG（dvisvgm / draw.io 导出）通常**没有 `<rect>`、没有 `<text>`**，全是带 `transform="matrix(...)"` 的 `<path>`。工具解析 path 的 `d` + transform，算出每个形状的外接矩形。

**验证过的准确度**（用浏览器 `getBoundingClientRect()` 做交叉校验）：

| 元素 | 浏览器实测 | extract-figure.mjs |
| --- | --- | --- |
| 面板框 | 205 × 122 | 204.7 × 122.4 |
| 梯形 Encoder | 41 × 78 | 40.8 × 79.9 |
| 卡片堆叠 | 54 × 54 | 54.4 × 54.4 |
| 肘线连接 | 32 × 95 | 32.5 × 95.2 |

误差 < 2%，足够定位块。

### 第 2 步：渲染原图 + **目视读出标签**

原图文字已转路径，**标签只能靠看图读**：

```bash
node pic/check/render-figure.mjs <原图.svg> pic/research/tmp/<tag>-orig.png --dpr 1.4
```

然后用 `read_image` 工具看图，逐条抄下：面板标题、行/列标签、图例条目、坐标轴范围与刻度、注释文字。

> ⚠️ **本仓库踩过的坑**：第一次复刻 SIGMOD Figure 4 时，我按 viewBox 尺寸（2007.9）渲染，只截到了左上角，误判成「2 行 × 5 列、5 个系列」。
> 真实情况是 **3 行 × 8 列 = 24 面板、7 个系列 + ★Pre-filter**。
> **根因**：SVG 的固有尺寸写成 `width="2007.9182pt"`，浏览器按 **1pt = 4/3 px** 渲染（= 2677 px）。按 viewBox 数值渲染就会只看到一部分。
> **规避**：`render-figure.mjs` 现在自动按 pt→px 换算，不要手写尺寸。

### 第 3 步：写确定性生成器

产出 `pic/check/make-replica-<tag>.mjs`，要求：

| 要求 | 理由 |
| --- | --- |
| 用**原图坐标系**做基准，`const S = 画布宽 / 原图宽` 统一缩放 | 几何值可以直接对着第 1 步的输出抄，可追溯 |
| 输出用 `<rect>` / `<polygon>` / `<path>` / `<text>` 重建 | 复刻产物必须**可编辑**，不能是路径转储 |
| **确定性**：固定种子 PRNG，不用 `Math.random()` | 同脚本同输出，可复现、可 diff |
| 顶部注释写清：论文标题、venue、arXiv ID、许可证、原始图 URL、提取方式 | 出处可追溯 |
| 合成数据要标注「数据为合成」 | 诚实；原图数值确实不可还原 |
| 字号 ≥7pt、线宽 0.35–2.0、非中性色 ≤8 | 见第 4 步 |

**画布缩放的经验公式**：原图文字相对尺寸 ≈ 原图字号 / 原图宽度。要满足 ≥7pt，通常把画布放大到原图的 **2–3 倍**。
例：原图 653 宽 → 放大到 1400（×2.14）；原图 473 宽 → 放大到 1419（×3）。

### 第 4 步：过风格门禁

```bash
node pic/check/check-figure-style.mjs pic/styleboard/replica-<tag>.svg
```

退出码必须为 0。不通过就改到达标 —— **不要为了过门禁而放宽门禁**。

### 第 5 步：渲染复刻图 + **逐项对比 + 至少修一轮**

```bash
node pic/check/render-figure.mjs pic/styleboard/replica-<tag>.svg pic/research/tmp/<tag>-rep.png --dpr 2
```

`read_image` 看图，和原图逐项对比。**必须真的找出差异并修**。实际修过的例子：

| 图 | 目视发现的问题 | 修法 |
| --- | --- | --- |
| CCS Hydra 框图 | Android 图标比例错，画得像张桌子 | 重做：圆顶头 + 双眼 + 双天线 + 圆角身体 + 双臂 + 双腿 |
| CCS Hydra 框图 | Encoder 梯形收得太尖（0.30） | 收到 0.20，对齐原图上边≈下边×0.6 |
| CCS Hydra 框图 | (c) 子标题压在肘线上 | 移到上下两组内容之间的空带（y 101–152）+ 白色底衬 |
| CCS Hydra 框图 | 底衬把肘线箭头盖住了 | 底衬收窄到 x=398 |
| ICML fig01 | (b) 右轴标题与 (c) y 轴标题挤在一起 | (b) 收窄 13 单位、(c) 右移 4 单位 |
| SIGMOD fig04 | 第一次整体版式就判错了（见第 2 步的坑） | 按 clipPath 实测网格重做 |

### 第 6 步：归档

- `pic/styleboard/replica-<tag>.svg` —— 可编辑矢量图
- `pic/styleboard/replica-<tag>-preview.png` —— 渲染预览（视觉验证证据）
- `pic/check/make-replica-<tag>.mjs` —— 生成器
- 在 [`README.md`](README.md) 的复刻表里登记一行

---

## 2. 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| [`check/extract-figure.mjs`](check/extract-figure.mjs) | 提取画布/调色板/形状外接矩形 | `--min-area` `--top` `--json` |
| [`check/render-figure.mjs`](check/render-figure.mjs) | SVG→PNG，自动 pt→px、预检 XML 合法性 | `--dpr` `--max-width` |
| [`check/check-figure-style.mjs`](check/check-figure-style.mjs) | 风格门禁：XML 合法性 / 字号 / 线宽 / 配色数 / 禁用色图 / 内嵌位图 / 字体回退 / 图内图题 / **元素重叠遮挡** | `--json` |
| `read_image`（agent 工具） | **看图**读标签、做目视对比 | — |

> `render-figure.mjs` 依赖 `~/.dsh/skills/browser-inspection/scripts/browser.mjs`（独立私有 Chromium）。
> 本机 `qlmanage` 渲染 SVG 会因沙箱报 `Operation not permitted`，Chrome headless 会挂死 —— 只有这条路可用。

---

## 3. 踩过的坑（按被坑顺序）

1. **按 viewBox 尺寸渲染 → 只看到一部分**。固有尺寸若是 `pt`，必须 ×4/3 换算成 px。
2. **SVG 可能 XML 非法**。渲染出来是错误页，不是图。复刻前必须 `render-figure.mjs` 探一次。
3. **`<defs>` 里的字体字形路径会污染几何提取**。dvisvgm 把字形轮廓作为 `<path id="font_*">` 放进 `<defs>`，坐标常在画布外（y 为负）。`extract-figure.mjs` 现在先剥掉 `<defs>`。
4. **文字转路径 → 没有 `<text>`**。`elementCounts.text === 0` 时，工具会打印警告：标签必须靠渲染图读。
5. **原图本身可能是错的**。例：CCS Hydra 的 (c) 子标题压着连接线。复刻时**修掉**并在生成器里注明，不要照抄错误。
6. **原图可能有违反规范的用法**。例：ICML fig01 的 (b) 用了**双 Y 轴**（本仓库 [`01-figure-style-guide.md`](01-figure-style-guide.md) 规则 4 不建议）。复刻时保留以忠实原图，但生成器里留 `USE_DUAL_AXIS` 开关，置 `false` 即改用堆叠子图。
7. **别把 `--width`/`--height` 空值传给渲染器**，会得到非等比视口，图被拉伸（踩过，导致像素估算全错）。
8. **别用 bash 变量在 `node -e` 里做条件**（`$(...)` 展开会吃掉 `$`）。要算尺寸就写在脚本里 —— 这正是 `render-figure.mjs` 存在的理由。
9. **不要把一行文字拆成多个 `<text>` 再手工推进 x**。SVG 会吞掉前导/尾随空格，字距也会错乱。踩过：SQL 查询被渲染成 `SELECTFROM`、`WHERE2.0`。→ 整行用一个 `<text>`；确需多色时才用 `<tspan>`（`<tspan>` 不会丢空格）。
10. **元素重叠只能靠门禁查，眼睛一定会漏**。一眼扫过去觉得「还行」，实际已经叠在一起。本仓库的门禁已加入重叠检测：
    - 文字 × 文字（重叠 > 较小文字面积 30%）
    - 文字 × 直线（直线穿过文字盒内缩后的核心区）
    - 文字越界（包围盒超出画布）

    踩过：ICML 图的样本量注释被 α=1.0 的竖直网格线穿过；CCS 图的 (c) 子标题压着连接线；VLDB 图的长标签越出右边界。
    → **改完必须重跑门禁**，不要凭「看起来没问题」收工。
    局限：文字已转成路径的 SVG（论文原始图）门禁看不见，只能靠渲染后目视。
11. **线条 × 图形也会重叠，而且眼睛几乎看不出来**。门禁规则 8.4 会查「线从外部扎进实心图形」。判定要同时满足三个条件才不会误报：① 线画在图形**之后**（在上层）；② **两端不全在图形内**（两端都在里面 = 图形自身内容，如卡片里的节点连线）；③ 穿透深度 **> 图形较短边的 25%**（只是从大容器边缘擦过不算）。
    踩过：CCS 图的「disassemble」箭头尾端扎进了 Android 的右臂（11 单位深）——放大才看得见。
12. **XML 非法会让整张图渲染成错误页，而源文件看起来"有内容"**。门禁已加规则 0 查未转义的 `&`。
    注意坑中坑：**XML 注释内部不解析实体引用，裸 `&` 是合法的** —— 预检必须先剥注释再查，否则会把正常文件判成非法（我踩过这个误报）。
13. **并行 agent 会覆盖你的文件**。本次一个子 agent 在失败前把我已经写好的 `make-replica-vldb-fig02.mjs` 与对应 SVG **整个覆盖**了。
    → 派发子 agent 时必须给**互斥的写范围**；事后用「生成器 md5 ↔ 产物 md5」校验一致性，确认交付物确实来自当前生成器。
14. **图形 × 图形也会重合，判据是「小」不是「比例」**。两个箭头画在同一坐标（96% 重合）肉眼只看到「箭头有点糊」。
    但按重合比例判会误伤两种正常画法：**卡片堆叠**（故意错位，~60%）与**容器包住表格**（正常嵌套，100%）。两者尺寸都大（≈116 / ≈220 单位），而重复绘制的箭头只有 ≈16–21 单位 —— 所以按**尺寸**卡，不按比例卡。
    踩过：VLDB 流程图的红/黑箭头重合；styleboard 里三条曲线的首个标记堆在一起（起点 y 只差 5 单位）。

---

## 4. 复刻验收清单

- [ ] 原图 venue 属 CCF-A / SCI 一区 / Nature 系，且许可证为 CC-BY / CC-BY-SA
- [ ] 原图能正常渲染（非错误页、内容未越界）
- [ ] 几何来自 `extract-figure.mjs` 实测，不是目测
- [ ] 生成器确定性（连跑两次输出一致）
- [ ] **生成器输出与提交的 SVG 一致**（`md5` 校验，防止被并行 agent 或手工改动污染）
- [ ] 复刻产物是**可编辑** SVG（`<rect>`/`<polygon>`/`<text>`），不是路径转储
- [ ] 通过 `check-figure-style.mjs`（退出码 0），其中**必须包含**：
  - [ ] XML 合法性（否则渲染成错误页）
  - [ ] 无文字重叠 / 文字压线 / **线条扎进图形** / 图形被完全遮挡 / 文字越界
- [ ] 渲染后**目视对比过**，且至少修过一轮，差异已记录
- [ ] 生成器顶部注明论文标题 / venue / arXiv ID / 许可证 / 原始图 URL / 「数据为合成」
- [ ] 预览 PNG 与 README 登记齐全

---

## 5. 已完成的复刻

| # | 原图 | venue / 等级 | 类型 | 原图规模 | 复刻产物 | 体积 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CCS 2026《HYDRA》Fig. 4 | CCS · CCF-A | **框架框图**（4 子模块 + 流水线 + 卡片堆叠 + 梯形/圆角块） | 653×276 pt，433 path（无 rect/text） | [`replica-ccs-hydra-architecture.svg`](styleboard/replica-ccs-hydra-architecture.svg) | 13.2 KB |
| 2 | SIGMOD 2026《LFANNS》Fig. 4 | SIGMOD · CCF-A | **数据小倍数**（3 行 × 8 列 = 24 面板，7 系列 + ★） | 2007.9×631.7 pt，8741 path | [`replica-sigmod-qps-recall.svg`](styleboard/replica-sigmod-qps-recall.svg) | 435 KB |
| 3 | ICML 2026《Topographic Training》Fig. 1 | ICML · CCF-A | **三面板混合**（示意图 + 双轴折线 + 散点误差棒） | 473×182 pt，487 path | [`replica-icml-fig01.svg`](styleboard/replica-icml-fig01.svg) | 21 KB |
| 4 | VLDB 2026《Distribution-Aware DDB Testing》Fig. 2 | VLDB · CCF-A | **彩色行表格插图**（4 子图 + SQL 注释 + 跨分片箭头） | 425×242 pt，695 path | [`replica-vldb-fig02.svg`](styleboard/replica-vldb-fig02.svg) | 18 KB |
| 5 | VLDB 2026《Distribution-Aware DDB Testing》Fig. 7 | VLDB · CCF-A | **五面板流程图**（AST 树 + 特征路径 + 归一化 + 标注 + 匹配，含矢量 ✓/✗） | 345.5×259.6 pt | [`replica-vldb-fig07.svg`](styleboard/replica-vldb-fig07.svg) | 24 KB |

> 五张图都跑过 `check-figure-style.mjs`（退出码 0，**含元素重叠检测**）、做过渲染后目视对比、且生成器经确定性验证（连跑两次 md5 一致）。
> 覆盖了四种差异很大的图型：**框图 / 数据小倍数 / 混合面板 / 表格插图** —— 这正是复刻要「多复刻几篇」的原因：单一图型校准不了通用风格。

---

## 6. 复刻之后：从「像」到「是」

复刻的产出不是图，是**可迁移的规则**。每复刻一张，回到 [`01-figure-style-guide.md`](01-figure-style-guide.md) 检查：

1. 这张图里有没有**规范里没写**的手法？→ 补进规范。
2. 这张图有没有**违反规范**的地方？→ 记进「反例」并说明为什么顶级论文也会这么干。
3. 这张图的**几何比例**（面板宽高比、边距、字号层级）能不能变成默认值？→ 补进 [`03-palette-and-typography.md`](03-palette-and-typography.md)。

例：复刻 SIGMOD fig04 后补进的规则 —— **「小倍数图共享轴标签只标一次」「y 刻度只标最左列」「`Recall@10` 只在最底行」**。
