# 01 · CCF-A / SCI 一区论文绘图风格指南

> **本文件的写法约定**：每条规则后面跟一个证据标记。
> - 📐 = 出版方官方规范（见 [`02-venue-specs.md`](02-venue-specs.md)）
> - 📊 = 从本仓库 [`gallery/`](gallery/) 里真实论文插图的**量化统计**（`node pic/check/analyze-gallery.mjs` 生成 [`research/gallery-style-stats.md`](research/gallery-style-stats.md)）
> - 👁 = 对真实插图**逐张目视复核**得到的观察（样本见下）
> - 📚 = 公开文献/方法论文

**目视复核样本**（64 篇 291 张图中的 6 张，覆盖不同图型）：

| 图型 | 样本 |
| --- | --- |
| 交互系统 teaser 条 | [`gallery/uist-2026-mutable-table-transformations/fig01.png`](gallery/uist-2026-mutable-table-transformations/fig01.png) |
| 系统数据流架构图 | [`gallery/vldb-2026-ai-query-compilation/fig03.png`](gallery/vldb-2026-ai-query-compilation/fig03.png) |
| 双面板散点对比 | [`gallery/ccs-2026-hydra-malware-drift/fig10.png`](gallery/ccs-2026-hydra-malware-drift/fig10.png) |
| 小倍数网格（24 面板） | [`gallery/icml-2026-bayesian-bandit-eval/fig16.png`](gallery/icml-2026-bayesian-bandit-eval/fig16.png) |
| 定性对比矩阵 | [`gallery/siggraph-2026-gaussian-light-transport/fig08.png`](gallery/siggraph-2026-gaussian-light-transport/fig08.png) |
| 双栏 teaser（物理/模型对照） | [`gallery/mobicom-2026-radiosight-mmwave-xr/fig01.png`](gallery/mobicom-2026-radiosight-mmwave-xr/fig01.png) |

---

## 第一部分 · 先想清楚，再动手

### 规则 1：一张图只回答一个科学问题

图不是插画。先写下「这张图要让读者相信什么」，再选图型；写不出这句话就不该画这张图。

**反例**：把准确率、延迟、内存、消融全塞进一张四面板图 —— 读者无法从任何单面板得出结论。

📚 Rougier, Droettboom & Bourne (2014) *Ten Simple Rules for Better Figures*, PLOS Comput Biol — Rule 1「Know Your Audience」、Rule 2「Identify Your Message」。

### 规则 2：不要相信默认值

默认设置「对任何图都够用，对任何图都不是最好」。库的默认字号、线宽、边距都是为通用场景调的。

📚 同上 — Rule 5「Do not trust the defaults」。
📊 实测：本仓库 291 张图中，**matplotlib 默认三色**（`#1f77b4` 6064 次、`#ff7f0e` 4667 次、`#2ca02c` 2404 次）合计 13135 次——说明「直接用库默认配色」是普遍现象，**而顶级论文的差距在于配色语义化与双编码，不在于花哨**。

### 规则 3：图注不是可选项，且不能只靠图注

图上放不下、又影响结论的信息（样本量、误差定义、显著性标记、单位）必须写进图注或图中；**不要指望读者用尺子量柱高**。

📚 同上 — Rule 4「Captions Are Not Optional」。
📐 PLOS：图注写在正文里，**不得**写进图文件，也不得在图内放作者名/标题/图号。

---

## 第二部分 · 图型选择（决定成败）

### 规则 4：用最简单的能表达该信息的图型

| 要表达 | 用 | 不要用 |
| --- | --- | --- |
| 类别间数值比较 | 条形图（从 0 起） | 饼图、3D 柱、雷达图 |
| 随时间/参数变化趋势 | 折线图 + 置信带 | 双 Y 轴（除非确实必要且标注清楚） |
| 分布 | 小提琴/箱线/ECDF + 散点 | 只画均值柱 |
| 两变量关系 | 散点 + 拟合 + 密度 | 只用相关系数文字 |
| 多配置 × 多数据集 | **小倍数网格**（shared axes） | 一张塞 20 条线的折线图 |
| 定性效果对比 | 图片矩阵（行=场景，列=方法） | 文字描述 |

📚 同上 — Rule 7「Do not mislead the reader」：饼图与 3D 图会系统性误导数量感知。

### 规则 5：多面板要有一致的「视觉语法」

👁 观察 UIST teaser（[`fig01.png`](gallery/uist-2026-mutable-table-transformations/fig01.png)）：四个面板里 **Audience 永远是蓝色、Critics 永远是橙色**；编号徽章 ①②③④ 固定在每个面板左下角；面板之间用浅灰细线分隔。

**结论**：同一实体在整篇论文的所有图中应保持同一颜色 / 同一标记形状。这是审稿人判断「作者是否严谨」的隐性信号。

### 规则 6：面板编号与标题，二选一，不要都上

- **同质小倍数**（如 24 个数据集面板）→ 每个面板给**标题**，不编号。
  👁 见 ICML 小倍数图（[`fig16.png`](gallery/icml-2026-bayesian-bandit-eval/fig16.png)）：每个面板顶部是数据集名 `Anatomy (S)`，没有 (a)(b)(c)。
- **异质面板**（方法图 + 结果图 + 消融图）→ 给 **(a)(b)(c)** 编号，标题写进图注。

---

## 第三部分 · 版式与尺寸

### 规则 7：按目标 venue 的栏宽设计，不要事后缩放

| venue | 单栏 | 双栏 |
| --- | --- | --- |
| IEEE | 88.9 mm (3.5 in) | 182 mm (7.16 in) |
| Nature | 88 mm | 180 mm |
| PLOS | 宽 6.68–19.05 cm（正文栏内 ≤13.2 cm） | — |

📐 见 [`02-venue-specs.md`](02-venue-specs.md)。

**为什么**：IEEE 明说它能把图**缩小**，但**几乎无法放大**而不损失质量 —— 所以宁可画大。📐

### 规则 8：宽高比由内容决定，但常见区间是 2:1 ~ 3.2:1

📊 实测 105 张位图的宽度中位数 **1927 px**。
👁 观察到的实际比例：teaser 条 3.1–3.2:1（MobiCom、UIST）、双面板对比 2.2:1（CCS）、定性矩阵 ≈1:1（SIGGRAPH）、小倍数全页图 ≈0.78:1（ICML）。

**结论**：没有「正确比例」，但**横向条状 teaser** 与**方形/纵向结果图**是两种最主流的形态，不要把它们混在同一张图里。

### 规则 9：单图文件大小要控制

| venue | 上限 |
| --- | --- |
| Nature | 50 MB / 图 |
| PLOS | 10 MB / 图 |

📐 超大图通常是「位图分辨率虚高」或「矢量里塞了位图」造成的，先查这两项。

---

## 第四部分 · 配色

### 规则 10：颜色必须承载语义，不是装饰

👁 观察 VLDB 架构图（[`fig03.png`](gallery/vldb-2026-ai-query-compilation/fig03.png)）：整张图**只有两种强调色**——浅蓝代表 SQL 侧路径，浅粉代表 AI-Ops 侧路径；下方两个圆柱体（Template Registry / AI Ops Registry）用各自生产者的颜色。其余全部是白底黑框。

📚 Rougier et al. — Rule 6：若要强调某元素，就只给它颜色，其余保持灰/黑；并自问「这个图为什么是蓝的而不是黑的？」，答不上来就用黑色。

### 规则 11：**永远不要只靠颜色区分元素**（硬规则）

👁 观察 CCS 散点图（[`fig10.png`](gallery/ccs-2026-hydra-malware-drift/fig10.png)）：用**颜色**区分方法（蓝=Plankton，橙=GinMaster），同时用**形状**区分状态（圆=predrift，三角=postdrift）。这是颜色 + 形状的双重编码。

📐 SIGCHI《Guide to an Accessible Submission》：仅用颜色区分元素的图表，对色觉障碍读者与黑白打印都不可用，**必须同时用形状与纹理**。CHI 明确要求所有投稿遵循该指南。

**落地做法**：给每条线/每个系列分配 `(颜色, 标记形状, 线型)` 三元组，保证任意两个系列至少有两个维度不同。

### 规则 12：分类色、连续色、发散色，三类不能混用

| 数据类型 | 色图类型 | 推荐 |
| --- | --- | --- |
| 分类（无序类别） | 定性 | Okabe–Ito 8 色、ColorBrewer Set1/Paired |
| 连续（低→高） | 顺序、**感知均匀** | viridis / plasma / inferno / magma / cividis、Crameri batlow |
| 以中值为中心偏离 | 发散 | ColorBrewer RdBu / PuOr（注意中点用中性色） |

📚 Rougier et al. — Rule 6；matplotlib 官方文档明确「**感知均匀**色图对多数应用是最佳选择」，并指出 `jet` 的 L\* 值剧烈波动，**不适合**表达需要被感知比较的数据。
📚 Crameri, F. (2018) *Scientific colour maps*, Zenodo, DOI `10.5281/zenodo.1243862` —— 感知均匀、色盲可读、黑白打印仍可区分。
📚 Okabe, M. & Ito, K. *Color Universal Design (CUD)* —— 色盲友好调色板的原始出处，两位作者本人即为强红色盲。

**禁止**：`jet` / `rainbow` / `hsv` 作为连续数据的默认色图。

📊 实测印证：真实论文里出现的顺序色来自 **ColorBrewer**（`#f7fbff`→`#08519c` Blues、`#006d2c` Greens、`#54278f` Purples、`#ae017e`/`#730220` RdPu），**没有**出现 jet 系色图的滥用。

### 规则 13：配色要克制

📊 实测每篇论文矢量图的**不同颜色数**分布：5、7、13、15、22、23、32、39、39、40、42 —— 主流区间是 **5–42**，中位数落在 20 上下。颜色数超过 ~50 基本意味着你把连续色图当分类色用了。

📚 Tufte 的「chartjunk」概念：不带来新信息的装饰应当删除。📚 Rougier et al. — Rule 8。

### 规则 14：给黑白打印留活路

投稿 PDF 常被黑白打印审阅。**判断方法**：把图转灰度后，系列之间是否仍可区分？若不能，回到规则 11 加形状/线型。

📐 SIGCHI 明确把「黑白打印」列为必须支持场景；Crameri 的色图也以此为设计目标。

---

## 第五部分 · 排版（字体与线宽）

### 规则 15：字号有硬上下限，且随 venue 变化

| venue | 图内字号 |
| --- | --- |
| Nature | **最小 5 pt，最大 7 pt** |
| PLOS | **8–12 pt** |
| IEEE | 全尺寸显示约 **9–10 pt** |

📐 见 [`02-venue-specs.md`](02-venue-specs.md)。
📊 实测（LaTeXML 渲染的矢量图 `font-size` 原值）：**7.35 pt、9.8 pt、11.5 pt、9.25 pt、8 pt、10 pt、8.5 pt** —— 与上表区间吻合。

**实践建议**：投稿 PDF 里实际渲染 **≥7 pt** 最稳；低于 5 pt 在任何 venue 都会被要求返工。

### 规则 16：字体族随 venue 文化变化

| 场景 | 惯例 |
| --- | --- |
| Nature / PLOS / IEEE 期刊 | **无衬线**：Helvetica / Arial |
| CHI / UIST 等 HCI | 图中常用**无衬线**，与正文风格一致 |
| NeurIPS / ICML / ACL 等 LaTeX 会议 | 常沿用 **LaTeX 衬线（Computer Modern）**，图内文字与正文同族 |

📐 IEEE 白名单：Helvetica、Times New Roman、Arial、Cambria、Symbol。Nature：优选 Helvetica 或 Arial。PLOS：仅 Arial / Times / Symbol。
👁 目视印证：UIST teaser 与 MobiCom teaser 用无衬线；ICML 小倍数图面板标题明显是 LaTeX 衬线。

**唯一铁律**：同一篇论文里所有图使用**同一套字体**，并与正文风格协调。📐 IEEE 明确要求「所有图与表的字体、字号必须一致」。

### 规则 17：线宽要能扛住缩放

📊 实测描边宽度分布（出现次数降序）：**1、0.8、0.6、1.18、2、0.95、0.35、0.5、1.5、1.4**。

**结论**：主流区间是 **0.4 – 1.5**，坐标轴与主数据线常用 **1.0**，辅助线/网格用 **0.35–0.6**，强调边框用 **1.5–2**。

**反例**：默认 0.5 pt 的网格线在缩到单栏后会消失；默认 3 pt 的边框会显得笨重。

### 规则 18：不要图内标题

👁 观察：UIST / SIGGRAPH / MobiCom 的图**内部没有图题**（"Figure 1: ..." 是图注，在正文里）。ICML 小倍数图里出现的 `Anatomy (S)` 是**面板标题**（数据集名），不是图题。

📐 PLOS 明确规定图内不得放图号/标题/作者名。
**例外**：面板级标题（`Before Training` / `After Training`，见 CCS [`fig10.png`](gallery/ccs-2026-hydra-malware-drift/fig10.png)）是允许且推荐的。

---

## 第六部分 · 标注与可读性

### 规则 19：注释直接画在图上，而不是塞进图注

👁 观察：
- VLDB 架构图（[`fig03.png`](gallery/vldb-2026-ai-query-compilation/fig03.png)）：把「Extract SQL constructs to identify SQL type…」这类解释**直接放在对应流程上方**，而不是写进图注。
- MobiCom teaser（[`fig01.png`](gallery/mobicom-2026-radiosight-mmwave-xr/fig01.png)）：用青色虚线箭头标注 `Control`、白色虚线标注射线路径、加一个青色描边的 `XR Glass` 实物插图 inset。

**结论**：箭头、虚线、色框、inset 是顶级论文的常规语言。用**线型**（实线/虚线/点线）与**箭头方向**再叠加一层语义，而不只是颜色。

### 规则 20：共享坐标轴只标一次

👁 观察 ICML 小倍数图（[`fig16.png`](gallery/icml-2026-bayesian-bandit-eval/fig16.png)）：24 个面板**共用一个** x 轴标签（底部居中「Percentage of Exhaustive Evaluation Cost」）和**一个** y 轴标签（左侧跨全图「Simple regret」），每个面板只保留刻度值。

**结论**：小倍数图必须共享轴标签，否则图注信息被重复 24 次，版面被吃光。

### 规则 21：一个图例，放在不遮挡数据的位置

👁 观察 ICML 图：9 个方法的图例**只出现一次**，置于整图底部，排成 3 列；实线=主曲线，虚线=mean stop。
👁 观察 CCS 图：图例置于右面板右上角空白区。

**禁止**：图例压住数据点、每个子图各放一个图例。

📚 Rougier et al. — Rule 8 反例图（左）明确批评「图例框压住图形」。

### 规则 22：每个面板都要有可读的刻度范围，且不截断误导

📚 Rougier et al. — Rule 7：y 轴从 0 到 100 与从 80 到 100 会让同一组数据看起来截然不同；柱状图尤其危险。

**做法**：条形图从 0 起；折线图可截断但必须标清刻度；不要靠「不标 y 轴」来掩盖截断。

---

## 第七部分 · 复现性与合规

### 规则 23：图必须可由代码或矢量源重建

- 数据图 → 脚本生成（脚本入库，随机种子固定）。
- 示意图/架构图 → **手写 SVG / TikZ / draw.io 导出矢量**，不依赖截图。
- **禁止**用 AI 生图模型画带标签的科学图：会拼错标签，且不可复现。

📐 Nature 要求所有文字与覆盖元素（线、轴、框、箭头、比例尺）保持**可编辑矢量**；不推荐用 Photoshop 做图（栅格化会打平矢量）。

### 规则 24：导出格式按图的内容类型分开选

| 图的内容 | 导出 |
| --- | --- |
| 线稿、图表、示意图、公式 | **矢量**：PDF / EPS / SVG / AI |
| 照片、渲染图、显微图、复杂插画 | **位图 ≥300 dpi**：TIFF / PNG |
| 混合 | 位图置于矢量布局程序中，矢量元素**覆盖其上**，保持可编辑 |

📐 Nature：不接受把 BMP/GIF/GIMP/JPG/PNG/Tex/TIFF 用作矢量图；建议用 AI/EPS/PDF。
📐 IEEE：矢量 PS/EPS/PDF；彩色/灰度位图 >300 dpi，黑白线稿 >600 dpi。
📐 PLOS：TIFF 或 EPS，300–600 dpi，LZW 压缩，无图层无 alpha。

### 规则 25：字体必须嵌入或转曲

📐 IEEE：EPS/PS/PDF 必须嵌入字体或转曲，否则他机打开会缺字/变形。
📐 PLOS：EPS 需嵌入字体或转曲（Illustrator `Shift+Cmd+O`，Inkscape `Shift+Ctrl+C`）。
📐 Nature：所有文字保持可编辑矢量。

### 规则 26：无障碍是硬门槛，不是加分项

📐 SIGCHI / CHI（CCF-A）：必须提供**图的文字描述**（≠图注，不复述图注）；表格用真表格；公式用标记公式；LaTeX 用 `\Description{...}`。CHI 会把「被审稿人标记为不可访问」的论文**重新分配审稿人**。

### 规则 27：不要不当处理图像数据

📐 PLOS：不得引入/增强/移动/删除图中特征；亮度对比调整必须全图一致且不得掩盖背景；不同凝胶/曝光不得拼接（拼接必须加分隔线并说明）；分辨率提升只有在**缩小尺寸**时才允许。

---

## 第八部分 · 提交前检查表

- [ ] 图内字号在目标 venue 区间内（Nature 5–7 pt / PLOS 8–12 pt / IEEE ~9–10 pt），且**全篇统一**
- [ ] 全篇图使用同一套字体
- [ ] 单栏图宽 88–89 mm，双栏 180–182 mm（或按目标 venue）
- [ ] 线稿/示意图是矢量；照片 ≥300 dpi；黑白线稿 ≥600 dpi
- [ ] 字体已嵌入或转曲
- [ ] 连续数据用感知均匀色图，**未使用 jet/rainbow**
- [ ] 分类数据用定性色板，且**颜色 + 形状/线型**双重编码
- [ ] 灰度化后仍能区分所有系列
- [ ] 每张图只有一个图例，且不遮挡数据
- [ ] 小倍数图共享坐标轴标签
- [ ] 图内无图题/图号/作者名
- [ ] 图注在正文里，且说明了样本量、误差定义、单位
- [ ] 提供了每张图的文字描述（ACM/SIGCHI 系强制）
- [ ] 条形图从 0 起；无 3D 图、无饼图比较数量
- [ ] 文件大小在限制内（Nature 50 MB / PLOS 10 MB）
- [ ] 每张图都有可重建的脚本或矢量源文件

---

## 附：三条最容易踩的坑

1. **默认色图**：`plt.imshow(..., cmap='jet')` —— 顶级论文里基本绝迹。
2. **只靠颜色**：色盲审稿人 + 黑白打印 = 你的 5 条曲线变成 5 条灰线。必须加形状/线型。
3. **图内字号**：屏幕上看得清 ≠ 印到单栏后看得清。按最终栏宽 100% 打印出来再看一次。
