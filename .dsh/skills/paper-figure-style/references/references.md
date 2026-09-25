# 来源清单（一手来源 + 取用记录）

> 所有 URL 均为本次调研**实际访问过**的地址；标注了 HTTP 状态与取用到的关键内容。
> 取用日期：**2026-09-24**（本机系统时间，见文末校验命令）。

---

## 1. 出版方官方图表规范（一手）

| # | 来源 | URL | 状态 | 取到的硬规格 |
| --- | --- | --- | --- | --- |
| 1 | IEEE Author Center · Resolution and Size | <https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/resolution-and-size/> | 200 | 矢量 PS/EPS/PDF；彩色/灰度 >300 dpi；黑白线稿 >600 dpi；单栏 3.5 in / 88.9 mm / 21 picas；双栏 7.16 in / 182 mm / 43 picas |
| 2 | IEEE Author Center · File Formatting | <https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/file-formatting/> | 200 | 接受 PS/EPS/PDF/PNG/TIFF；不接受 VSD/GIF/BMP；字体白名单 Helvetica / Times New Roman / Arial / Cambria / Symbol；字号约 9–10 pt；必须嵌入字体或转曲；文件命名规范；图形上限 7.16×8.8 in |
| 3 | Nature Branded Research Journals · *Guide to preparing final artwork*（官方 PDF） | <https://www.nature.com/documents/NRJs-guide-to-preparing-final-artwork.pdf> | 200（2.5 MB PDF） | 1 栏 88 mm / 2 栏 180 mm；其他内容 58/121/185 mm；最大高度随图注长度（<300/<150/<50 词）；字号 5–7 pt；无衬线 Helvetica/Arial；原创研究 RGB、其他 CMYK；线稿矢量 AI/EPS/PDF；位图 ≥300 dpi；单图 ≤50 MB；不接受 BMP/GIF/GIMP/JPG/PNG/Tex/TIFF 作矢量图；不推荐 Word/Photoshop |
| 4 | PLOS Computational Biology · Figures | <https://journals.plos.org/ploscompbiol/s/figures> | 200 | TIFF/EPS；宽 789–2250 px @300dpi（6.68–19.05 cm）；高 ≤2625 px；300–600 dpi；≤10 MB；图内文字仅 Arial/Times/Symbol，8–12 pt；RGB 或灰度；扁平化、无 alpha、LZW；2 pt 白边；图注在正文；全部作品 CC-BY |
| 5 | SIGCHI · Guide to an Accessible Submission | <https://sigchi.org/resources/guides-for-authors/accessibility/> | 200 | 不要只靠颜色（必须用形状与纹理）；每张图提供文字描述（≠图注）；表格用真表格并标表头；公式用标记公式；LaTeX 用 `\Description{...}` |
| 6 | CHI 2026 · Papers（要求遵循上条指南） | <https://chi2026.acm.org/for-authors/presenting/papers/> | 200 | 「Authors are expected to follow SIGCHI's Guide to an Accessible Submission」；被审稿人标记为不可访问的论文须重新分配审稿人 |

### 未取得一手来源（诚实记录，未用二手数字填充）

| 来源 | URL | 状态 | 说明 |
| --- | --- | --- | --- |
| Elsevier Artwork and media instructions | `elsevier.com/researcher/author/policies-and-guidelines/artwork-and-media-instructions` | **404** | 该路径已失效 |
| Elsevier（新版路径） | `elsevier.com/publishing/artwork-and-media-instructions` | **404** | — |
| Elsevier ScienceDirect Guide for Authors | `sciencedirect.com/journal/pattern-recognition/publish/guide-for-authors` | **403** | Cloudflare 拦截 |
| Science (AAAS) 投稿说明 | `science.org/content/page/instructions-preparing-initial-manuscript` | **403** | Cloudflare 拦截 |
| ACM 主站无障碍投稿指南 | `acm.org/publications/accessible-submission` | **403** | Cloudflare 拦截（已用 SIGCHI 分站替代） |
| Paul Tol 配色方案 | `personal.sron.nl/~pault/` | **连接失败**（TLS ECONNRESET） | 未取得；本仓库**不转录其色值** |

---

## 2. 方法论文献与权威参考

| # | 来源 | URL / DOI | 取到的内容 |
| --- | --- | --- | --- |
| 7 | Rougier, Droettboom & Bourne (2014) *Ten Simple Rules for Better Figures*, PLOS Comput Biol 10(9): e1003833 | <https://doi.org/10.1371/journal.pcbi.1003833> | Rule 1 知道受众 / Rule 2 明确信息 / Rule 3 适配媒介 / Rule 4 图注不可省 / Rule 5 不要相信默认值 / Rule 6 有效用色 / Rule 7 不要误导 / Rule 8 避免 chartjunk / Rule 9 信息优先于美观 |
| 8 | Okabe, M. & Ito, K. *Color Universal Design (CUD)* | <https://jfly.uni-koeln.de/color/> | 色盲友好调色板的原始出处（作者本人为强红色盲）；色样以图片形式给出，**本仓库未从该页转录色值** |
| 9 | Crameri, F. (2018) *Scientific colour maps* | DOI <https://doi.org/10.5281/zenodo.1243862>；<https://www.fabiocrameri.ch/colourmaps/> | 感知均匀、色盲可读、黑白打印可区分的科学配色（如 batlow）；版本 8.0.1 |
| 10 | matplotlib 官方文档 · Choosing Colormaps | <https://matplotlib.org/stable/users/explain/colors/colormaps.html> | 感知均匀色图对多数应用最佳；`viridis/plasma/inferno/magma/cividis`；`jet` 的 L\* 值剧烈波动，不适合需要感知比较的数据 |
| 11 | ColorBrewer（Harrower & Brewer） | <https://colorbrewer2.org/> | 顺序/发散/定性色板；本仓库实测到的 `#f7fbff`→`#08519c` 等端点即出自其 Blues/Greens/Purples/RdPu |

---

## 3. 图片与元数据来源（本次采集实际使用的接口）

| # | 来源 | URL | 用途 |
| --- | --- | --- | --- |
| 12 | arXiv API | `https://export.arxiv.org/api/query` | 扫描 12 个 cs.* 分类共 3153 篇，按 comment 字段匹配 CCF venue |
| 13 | arXiv abs 页面 | `https://arxiv.org/abs/<id>` | 逐篇核验许可证（**API 不返回 license 字段，必须走 abs 页**） |
| 14 | arXiv HTML（LaTeXML 渲染） | `https://arxiv.org/html/<id>v<n>` | 提取 `<figure>`、`<img>`、`<object data="*.svg">` 直链 |
| 15 | ar5iv | `https://ar5iv.labs.arxiv.org/html/<id>` | 旧论文的 HTML 渲染回退通道 |
| 16 | Crossref REST API | `https://api.crossref.org/journals/<ISSN>/works` | 按许可证与被引数筛选 Nature Communications（ISSN 2041-1723）的 CC-BY 论文 |
| 17 | Nature 文章页 | `https://www.nature.com/articles/<doi-suffix>` | 二次确认页面许可证；提取全分辨率图片直链 |
| 18 | Springer Nature 媒体服务 | `https://media.springernature.com/full/springer-static/image/...` | 下载 Nature 系全分辨率插图 |
| 19 | GitHub Search API | `https://api.github.com/search/repositories` | 16 组查询 → 144 个仓库的星数/许可证/推送时间 |
| 20 | GitHub git trees API | `https://api.github.com/repos/<owner>/<repo>/git/trees/HEAD?recursive=1` | 递归统计 SKILL.md，区分「真 skill 库」与「聚合列表」 |
| 21 | raw.githubusercontent.com | `https://raw.githubusercontent.com/...` | 抓取相关 SKILL.md 正文 + LICENSE 原文探针 |

---

## 4. 被引用/借鉴的高星 skill 与风格资源（附许可证）

### 4.1 可商用（本仓库采纳其机制）

| 仓库 | 星数（实测快照） | 许可证 | 借鉴内容 |
| --- | --- | --- | --- |
| `wanshuiyin/Auto-claude-code-research-in-sleep` | 16597 | **MIT** | `figure-spec`：确定性 JSON→SVG；「优先于 AI 插画」；画布 500×350 / 900×500 |
| `Orchestra-Research/AI-Research-SKILLs` | 13006 | **MIT** | `academic-plotting`：图表选型优先级矩阵；Okabe–Ito 色值 |
| `garrettj403/SciencePlots` | 9250 | **MIT** | matplotlib 期刊样式表（`plt.style.use(['science','ieee'])`） |
| `Master-cai/Research-Paper-Writing-Skills` | 7084 | **MIT** | 论文写作/图表打磨（写作侧，非绘图规范） |
| `K-Dense-AI/scientific-agent-skills` | 46482 | **MIT** | 166 个科研 skill；`scientific-visualization` 数据图定位 |
| `zLanqing/codex-claude-academic-skills` | 4262 | **MIT** | 24 个学术 skill，含 `matplotlib` 子 skill |
| `colour-science/colour` | 2654 | **BSD-3-Clause** | 色差、**色盲模拟**、色彩空间转换 |
| `Haojae/scipilot-figure-skill` | 2469 | **MIT**（有 LICENSE 文件） | 「可视化顾问」数据剖析→图型推荐；灰度预览；中文混排与负号方框修复；渲染后视觉自检闭环 |
| `axismaps/colorbrewer` | 1102 | **Apache-2.0** | ColorBrewer 配色原始实现 |
| `Azhi-ss/academic-figure-skills` | 125 | **MIT** | 唯一带 `stages:` frontmatter 的绘图流水线（frontmatter 格式参考） |

### 4.2 明确不采纳（许可证或机制问题）

| 仓库 | 星数 | 原因 |
| --- | --- | --- |
| `anthropics/skills` | 177917 | **Proprietary**（其 `pdf/SKILL.md` frontmatter 明写）；且 20 个 skill 中 0 个涉及论文绘图 |
| `Imbad0202/academic-research-skills` | 49371 | **CC BY-NC 4.0**（LICENSE 原文探针）→ 禁商用 |
| `ChenLiu-1996/figures4papers` | 7059 | **CC BY-NC 4.0**（LICENSE 原文探针）→ 禁商用；且只是该仓库的 house style |
| `Trae1ounG/paper-plot-skills` | 834 | **无 LICENSE 文件** |
| `VILA-Lab/FigMirror` | 518 | **无 LICENSE 文件** |
| `chingswy/Skill-Research-Figure` | 173 | **无 LICENSE 文件** |
| `c-narcissus/paper-framework-figure-studio-pro` | 2174 | **无 LICENSE 文件** |
| `Orchestra-Research/.../academic-plotting` 的「Gemini 生图做架构图」子流程 | — | 输出不可复现 + 会拼错标签，与本仓库既有约束冲突（**只借鉴其数据图部分**） |

> ⚠️ **星数可信度声明**：上表星数为本机 `api.github.com` 实测快照，但数值显著高于 GitHub 常规量级（如 `anthropics/skills` 177917★），**不排除本机网络环境返回合成/镜像数据**。仅可用于同快照内的相对排序，不可对外引用绝对星数。

---

## 5. 本仓库自研产出（非外部来源）

| 文件 | 说明 |
| --- | --- |
| [`01-figure-style-guide.md`](01-figure-style-guide.md) | 27 条绘图规则，每条挂 📐官方 / 📊实测 / 👁目视 / 📚文献 证据标记 |
| [`02-venue-specs.md`](02-venue-specs.md) | 各 venue 硬规格 + 缺口诚实记录 |
| [`03-palette-and-typography.md`](03-palette-and-typography.md) | 配色、字号、线宽（含 291 张图的实测分布） |
| [`04-skill-survey.md`](04-skill-survey.md) | 高星 skill 调研 + 许可证合规核验 |
| [`skills/paper-figure-style/SKILL.md`](skills/paper-figure-style/SKILL.md) | 自研 skill（融合上述全部） |
| [`check/check-figure-style.mjs`](check/check-figure-style.mjs) | 零依赖风格门禁 |
| [`styleboard/styleboard.svg`](styleboard/styleboard.svg) | 视觉样板（通过门禁） |
| [`check/fixtures/bad-figure.svg`](check/fixtures/bad-figure.svg) | 负例（证明门禁会红） |
| [`research/`](research/) | 全部调研脚本与原始数据 |

---

## 6. 复现校验

```bash
# 取用日期
date

# 图片语料统计（矢量图数量、论文数）
find pic/gallery -name 'fig*.svg' | wc -l
node pic/check/analyze-gallery.mjs

# 风格门禁：正例必须过、负例必须红
node pic/check/check-figure-style.mjs pic/styleboard/styleboard.svg   # 期望退出码 0
node pic/check/check-figure-style.mjs pic/check/fixtures/bad-figure.svg  # 期望退出码 1
```
