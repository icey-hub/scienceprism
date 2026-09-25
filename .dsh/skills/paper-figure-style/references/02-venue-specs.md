# 02 · 各 venue 图表硬规格（一手来源）

> 全部数字取自出版方官方作者指南。**未取到一手来源的条目会明确标注为缺口，不编数字。**
> 取用日期与 URL 见 [`references.md`](references.md)。

---

## 0. 先搞清楚：你的目标 venue 归哪个出版方

CCF-A 的计算机 venue 分散在几个出版方，**规格完全不同**，套错模板是最常见的返工原因。

| 你投的 venue | 出版方 | 该看下面哪一节 |
| --- | --- | --- |
| TPAMI / TKDE / TSE / TOSEM / TIFS / TIP / TDSC / TOIS / TMC / JSAC | IEEE | §1 IEEE |
| CVPR / ICCV / NeurIPS / ICML / ICLR / AAAI / ACL / EMNLP | 各自会议模板（多为 LaTeX 双栏） | §5 会议通用 + §4 无障碍 |
| SIGMOD / VLDB / KDD / WWW / SIGIR / MM | ACM（部分 VLDB 走 PVLDB 自有模板） | §4 ACM/SIGCHI |
| CHI / UIST / CSCW / SIGGRAPH | ACM | §4 ACM/SIGCHI |
| CCS / S&P / USENIX Security / NDSS | ACM / IEEE / USENIX | §1 或 §4 |
| OSDI / SOSP / NSDI / ATC | USENIX | §5 |
| POPL / PLDI / OOPSLA / ICSE / FSE / ASE / ISSTA | ACM | §4 ACM/SIGCHI |
| Nature / Science 及其子刊 | Springer Nature / AAAS | §2 Nature |
| PLOS 系列 | PLOS | §3 PLOS |

---

## 1. IEEE（CCF-A 期刊主力）

| 项目 | 规格 |
| --- | --- |
| 矢量格式 | **PS / EPS / PDF**（首选，缩放不失真） |
| 位图分辨率 | 彩色与灰度 **> 300 dpi**；黑白线稿 **> 600 dpi** |
| 单栏宽 | 3.5 in = **88.9 mm** = 21 picas |
| 双栏宽 | 7.16 in = **182 mm** = 43 picas |
| 图形最大尺寸 | 7.16 × 8.8 in（182 × 220 mm） |
| 接受格式 | PS、EPS、PDF、PNG、TIFF（Office 文件仅当原图在该程序中绘制时） |
| **不接受** | VSD、GIF、BMP |
| 字体白名单 | **Helvetica、Times New Roman、Arial、Cambria、Symbol** |
| 字号 | 全尺寸显示时约 **9–10 pt** |
| 一致性 | 所有图与表的字体、字号必须一致 |
| 字体嵌入 | EPS/PS/PDF 必须**嵌入字体或转曲**，否则他机打开会缺字/变形 |
| 文件命名 | 作者姓氏前 5 字母 + 序号（`gonza1.tif`、`gonza2.pdf`）；表用 `gonza.t1.tif` |
| 压缩 | 图层需合并（flatten），尺寸不得超 7.16 × 8.8 in |

> ⚠️ IEEE 明确说：**事后提高分辨率无法改善画质**；它可以把图缩小，但**几乎无法放大**——所以宁可画大。
>
> 来源：IEEE Author Center《Resolution and Size》《File Formatting》。

---

## 2. Nature Portfolio（SCI 一区标杆）

### 2.1 尺寸

**原创研究与综述内容：**

| 栏宽 | 宽度 | 图注 <300 词时最大高 | <150 词 | <50 词 |
| --- | --- | --- | --- | --- |
| 1 栏 | **88 mm** | ~130 mm | ~180 mm | ~220 mm |
| 2 栏 | **180 mm** | ~185 mm | ~210 mm | ~225 mm |

**其他内容**（Perspective / Progress / Review 之外的栏目）：1 栏 58 mm、2 栏 121 mm、3 栏 185 mm。

> 注意这张表的设计逻辑：**图注越长，图能占的高度越小**。排版时图与图注是抢版面的，画图前先估图注长度。

### 2.2 文字与颜色

| 项目 | 规格 |
| --- | --- |
| 字体 | **无衬线**，优选 **Helvetica 或 Arial** |
| 字号 | **最小 5 pt，最大 7 pt**（注意：比 IEEE 的 9–10 pt 小得多） |
| 色彩模式 | 原创研究用 **RGB**；其他内容（含综述）用 **CMYK** |
| 线稿/图表/示意图 | 必须**矢量**：AI、EPS、PDF |
| 照片/复杂技术插画 | 位图，**≥ 300 dpi**，按可能使用的最大尺寸保存 |
| 单图大小 | ≤ **50 MB** |
| 组合布局 | 用 Adobe Illustrator 或 PowerPoint 等矢量程序拼版 |
| 字体可编辑性 | 所有文字、线、轴、框、箭头、比例尺必须保持**可编辑矢量** |

**Nature 明确不接受的**：

- 不接受把 **BMP、GIF、GIMP、JPG、PNG、Tex、TIFF** 用作矢量图（线稿）。
- **不推荐 Word**（图层与矢量格式会降级/扁平化）；Excel 需先转 PDF；PowerPoint 需完全可编辑。
- **不推荐 Photoshop** 做图：它是栅格程序，矢量数据容易被打平，后期制作团队还得回来找你要可编辑文件。
- **禁止**给对象加投影、3D 旋转、斜面等图形特效——导出时会变成低分辨率位图。

> 来源：Nature Branded Research Journals《Guide to preparing final artwork》（官方 PDF，本仓库已用自写提取器读取，见 `research/pdftext.mjs`）。

---

## 3. PLOS（CC-BY，SCI）

| 项目 | 规格 |
| --- | --- |
| 格式 | **TIFF 或 EPS**（PLOS 提示 EPS 常有字体损坏、遮罩过大、游离点，TIFF 更稳） |
| 宽度 | 789 – 2250 px @300 dpi = 6.68 – 19.05 cm |
| 高度 | 最大 2625 px @300 dpi = 22.23 cm |
| 与正文栏对齐 | 不要宽于 **5.2 in（13.2 cm）** |
| 分辨率 | **300 – 600 dpi**（低于 300 会糊；高于 600 可能被缩放） |
| 文件大小 | ≤ **10 MB** |
| 图内文字 | **仅 Arial、Times 或 Symbol**，**8–12 pt** |
| 色彩模式 | RGB（8 bit/通道）或灰度 |
| TIFF 要求 | 扁平化无图层、**无 alpha 通道**、**必须 LZW 压缩**、不得跨页 |
| 白边 | 建议留 **2 pt** 白边，防止排版时误裁 |
| 图注 | 写在正文里，**不得**写进图文件；不得在图内放作者名/标题/图号 |
| 许可 | 所有作品 **CC-BY**，因此图片可署名再分发 |

> 来源：PLOS Computational Biology《Figures》。

---

## 4. ACM / SIGCHI（CHI、UIST、SIGGRAPH、ICSE、OOPSLA 等）

ACM 系的**硬约束不是 DPI，而是无障碍**。CHI 2026 明确要求所有投稿遵循 **SIGCHI《Guide to an Accessible Submission》**，且「被审稿人标记为不可访问的论文必须重新分配审稿人」。

| 要求 | 具体做法 |
| --- | --- |
| **不要只靠颜色** | 仅用颜色区分元素的图表，对色觉障碍读者和黑白打印都不可用；必须**同时**用不同形状与纹理 |
| **每张图给文字描述** | 描述 ≠ 图注。描述是「看不见图的人」的替代信息，应包含图注与正文都没有的关键信息，**不要复述图注** |
| **表格用真表格** | 不能是图片，并要标记表头单元格 |
| **公式用标记公式** | 不能是公式截图 |
| **LaTeX 用户** | 用 `\Description{...}` 标签给图加描述 |
| **Word 用户** | 右键图片 → Format Picture → Layout & Properties → Alt Text |

> 来源：SIGCHI《Guide to an Accessible Submission》、CHI 2026 Papers 页面。

---

## 5. 会议通用（CVPR / NeurIPS / ICML / ACL / USENIX 等）

这些会议主要约束**页数与模板**（双栏、正文 10 pt 级别的 LaTeX 模板），对图像本身通常只要求「矢量优先、位图 ≥300 dpi」。真正决定审稿观感的是本仓库 [`01-figure-style-guide.md`](01-figure-style-guide.md) 里的通用规则，而不是某个数字。

**通用底线（跨所有会议都安全）：**

1. 图内文字用无衬线（Helvetica / Arial 系），与正文同一套字号逻辑；
2. 线稿与示意图导出**矢量 PDF/SVG**，照片与渲染图 ≥300 dpi；
3. 单栏图宽 ≈ 88 mm，双栏图宽 ≈ 180 mm（对齐 IEEE/Nature 的通行值）；
4. 图内最小字号 ≥5 pt（Nature 下限），投稿 PDF 里实际渲染不小于 7 pt 更稳。

---

## 6. 未取得一手来源的缺口（诚实记录）

| 出版方 | 情况 | 影响 |
| --- | --- | --- |
| **Elsevier**（含 Pattern Recognition、Information Sciences 等 SCI 一区） | 官方 artwork 页 `elsevier.com/researcher/author/policies-and-guidelines/artwork-and-media-instructions` 返回 **404**；`sciencedirect.com/.../guide-for-authors` 返回 **403**（Cloudflare） | 本仓库**不提供** Elsevier 的具体 DPI/列宽数字，避免以讹传讹。投稿前请直接打开你目标期刊的 Guide for Authors |
| **Science (AAAS)** | `science.org` 返回 **403**（Cloudflare） | 同上 |
| **ACM 主站**（`acm.org/publications/...`） | 返回 **403**（Cloudflare） | 已用 SIGCHI 分站作为 ACM 系的一手来源替代 |
| **USENIX** | 未调研 | 若目标为 OSDI/SOSP/NSDI，请以当年 CFP 的模板说明为准 |

> 这些缺口是**环境限制**（站点反爬）而非未调研。已如实记录，未用二手数字填充。
