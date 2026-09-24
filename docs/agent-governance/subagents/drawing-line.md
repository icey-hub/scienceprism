# 子 agent 任务书 · 绘图线（I-11 / I-12 / I-13 / I-14）

> 每次迭代前必读。上级文档：`../requirements.md`、`../plan.md`、`../README.md`、仓库根 `AGENTS.md`。

## 1. 任务与目标

为 **agent 产出文档时的绘图** 选定并落地一个确定、可复现、可在仓库内运行的方案。

**目标能力不是「线段加方框」**（用户 U-07 明确指出）：要能画**复杂矢量插画**，基准样例是**细胞结构图**（细胞膜、细胞器、多层结构、填充、曲线、密集中文标注），同时覆盖架构图、时序图、对比图表。

覆盖迭代：
- **I-11** 绘图候选取证（含**复杂插画能力**维度）
- **I-12** 4 张参考图源文件 + `scripts/setup-diagram-toolchain.sh`
- **I-13** 绘图对比实验（9 维打分 + 产物并排提交）
- **I-14** 选定主方案 + `doc-diagram` skill + CI 可复现校验

## 2. 停止条件

`done` = I-11…I-14 完成，且：4 张参考图在候选方案下均有渲染产物并排提交；9 维打分表完整；主方案可**离线重复渲染**且重渲染 diff 为空；安装脚本可重复执行且**不写仓库外任何路径**。
`needs-verification` = 有产物但缺确定性/中文证据。

## 3. 独占写范围（只准写这些）

- `tools/diagram/**`（新建）
- `docs/assets/diagrams/**`（新建）
- `docs/agent-governance/drawing-candidates.md`、`drawing-comparison.md`（新建）
- `scripts/setup-diagram-toolchain.sh`（新建）

**不得触碰** `apps/**`（任何产品代码）、`package.json`、`package-lock.json`、`AGENTS.md`、`docs/agent-governance/{README,plan,requirements}.md`、`docs/agent-governance/subagents/**`。
需要新增依赖时，把**确切命令**写进报告，由 Lead 执行（Lead 独占 `package.json`）。

## 4. 必读基线

- `AGENTS.md` 的写入边界（安装只落仓库内）
- `docs/agent-governance/plan.md` 第 3.4 节（候选表与评分维度）
- `apps/frontend/src/app/EditorPage.tsx:97`（`FIGURE_EXTS` 含 `.svg`/`.pdf`）与 `apps/backend/src/routes/projects.js:296`（blob 接口）——**只读，用于确认查看端零改动**
- `docs/architecture-roadmap.md`（可作为真实架构图素材）

## 5. 已知事实（已取证；关键处仍需自己复核）

- 本机**没有** `mmdc` / `dot` / `d2` / `plantuml`；**没有** Java（PlantUML 出局）；仓库内零 diagram 依赖。
- **Google Chrome 153 已安装**（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）→ mermaid-cli 可用 `PUPPETEER_EXECUTABLE_PATH` 复用，**无需下载 Chromium**。
- `tectonic` 已装，但 `~/Library/Caches/Tectonic` 不存在 → 首次编译需联网；必须用 `TECTONIC_CACHE_DIR=./.cache/tectonic` 把缓存留在仓库内。
- 本机无 matplotlib / seaborn；但 `python3 -m venv ./.venv` 可把依赖装进仓库内。
- 中文字体：`Hiragino Sans GB`、`Songti.ttc`、`STHeiti`（无 PingFang）。
- 已确认可行的安装方式：`PUPPETEER_SKIP_DOWNLOAD=1 npm_config_cache=./.npm-cache npm i -D @mermaid-js/mermaid-cli`；D2 走官方 release 解包到 `./tools/d2`。
- **`brew install` 一律不可用**（写 `/opt/homebrew`，越界）。
- 查看端已解决：GUI 的 Figure 面板渲染项目树里的 `.svg`/`.pdf`，**无需任何前端改动**。

## 6. 非目标

- 不做产品内文档插图能力（`plotService` / `\includegraphics` 链路）——那是 backlog。
- 不配置任何 MCP（配置须写 `~/.dsh/settings.yaml`，越界；且取证结论是无 MCP 胜出）。
- 不使用 AI 生图作为主方案（会拼错图中文字、不确定）。
- 不改任何 `apps/**` 代码。

## 7. 交付物与验收

| 迭代 | 交付物 | 验收（可执行） |
| --- | --- | --- |
| I-11 | `drawing-candidates.md` | 每个候选给出：仓库内安装命令、离线可用性、确定性、输出格式、**复杂插画能力**、中文支持、CI 可验证性、失败模式；未能核实的标注 UNVERIFIED |
| I-12 | 4 张参考图源文件 + 安装脚本 | ① 模块依赖图 ② 时序图 ③ **细胞结构图** ④ 对比图表；脚本重复执行结果一致，且不写仓库外路径 |
| I-13 | `drawing-comparison.md` + 并排产物 | 9 维打分（渲染成功率、视觉质量、**复杂插画能力**、可编辑性、确定性、LaTeX 集成、离线可用、安装成本、CI 可验证性、中文支持）；产物提交 `docs/assets/diagrams/`；附截图证据 |
| I-14 | `doc-diagram` skill + CI 校验 | 源文件 → 产物可复现（重渲染 diff 为空）；中文不出现豆腐块（用 `read_image` 目视确认） |

## 8. 硬约束

- 读写/删除**仅限本仓库内**；安装与缓存全部落仓库内（`./.npm-cache`、`./.venv`、`./tools`、`./.cache`）；禁止 `brew`、全局 npm/pip、`~/.cache`、`~/Library/Caches`。
- **不要执行任何 git 写操作**。git 生命周期由 Lead 独占。
- 渲染产物必须**提交进仓库**（`.svg` 优先，必要时 `.pdf`），因为查看端直接读项目树里的文件。
- 中文标签必须用 `read_image` 目视确认，不能只看 SVG 里有 `<text>` 就判定通过。

## 9. 报告格式（回给 Lead）

```
状态：DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
迭代：I-1x
改动文件：（逐个列出）
候选与得分：（表格）
主方案与理由：
新增依赖命令：（原文，Lead 执行）
产物路径：（docs/assets/diagrams/...）
中文渲染证据：（read_image 结论）
未解未知：
```
