# AGENTS.md — 本仓库的 agent 工作约定

领域词汇：`CONTEXT.md`。既有架构计划：`docs/architecture-roadmap.md`（阶段 1–10 已完成）。

## 每次迭代前的必读（硬性）

动手改任何文件之前，按顺序读完：

1. `aidoc/requirements.md` — 需求（用户原始需求 + 追加要求）
2. `aidoc/plan.md` — 执行计划、设计与非目标
3. `aidoc/README.md` — 当前进度、下一步最小动作、恢复协议
4. 若本次迭代属于某条子 agent 线，读对应任务书：
   `aidoc/subagents/constraint-line.md`（I-03…I-06）、
   `aidoc/subagents/role-line.md`（I-07…I-08）、
   `aidoc/subagents/drawing-line.md`（I-11…I-14）

**迭代收尾**：更新 `aidoc/README.md` 的迭代表与「当前状态」，并单独提交；不更新看板的迭代不算完成。

## 子 agent 派发规则（硬约束）

派发前必须先查**当前存活的子 agent 数量**：

- **存活数 ≥ 2 → 不派发，先等已有子 agent 结束**，结束后重新计数再决定（U-16）。
- 存活数 ≤ 1 时才可派发，且**一次只派 1 个**。
- 子 agent 不得执行 git 写操作；分支、提交、推送由 Lead 独占。
- 子 agent 的写范围必须互不重叠，并在任务书里写明「不得触碰」清单。

## 目标（goal-1475d1ce）

把 agent 工作流从「规则写在 prompt 里」改造成「规则写在代码里」：

1. **约束注册表** — 可执行、可开关、可审计、可测试，替代散落在 prompt / 路由 / 页面里的约束。
2. **收口 4 处高危绕过** — `transfer` 零能力校验、`plot` 无门禁执行 LLM 生成的 Python、`vision` 未审批写盘、`/api/llm` 裸代理。
3. **角色注册表** — 8 个角色，逐个写明 authority / 允许能力 / 允许 skill / 禁止行为，并接入 Harness Runtime。
4. **skill 补齐** — 产品侧研究 skill + 开发侧 playbook。
5. **文档绘图** — 目标是**复杂矢量插画级**（细胞结构图、架构图、对比图表），不是线段加方框。

## 非目标

- 不改产品内 LaTeX 文档插图能力；不做 Skill 市场；不重构 `EditorPage.tsx` 组合根。
- 不改视觉设计；不做移动端与无障碍；不推 `origin`（OpenDCAI/OpenPrism）。
- 不推倒重写现有 16 条约束：先零行为变更包装，再逐条迁移。

## 迭代节奏

- **1 迭代 = 1 个已提交且已验证的纵向切片**：改动 + 可执行验证证据 + 1 条 commit。
- 每 **10 迭代 = 1 个 round**：新分支 + 一份前后对比文档。
- Round 1 = `feat/agent-governance-r1`（I-01…I-10）；Round 2 = `feat/agent-governance-r2`（I-11…I-20）。
- 每次迭代收尾 `npm run quality` 必须全绿；不绿就不提交。
- 每轮结束推送 `scienceprism` 并留 PR 给人工审，**不自动合并**。

## 文档目录约定

- **agent 产出的一切文档放 `aidoc/`**：需求、计划、看板、任务书、审计、对比文档、绘图产物。
- `docs/` 是项目自身文档（ADR、roadmap、约束清单、契约），agent 不往里塞新产出。

## 写入边界（硬约束）

- 读写与删除**仅限本仓库内**；安装只落本仓库内。
- 允许：`npm i -D`（配 `npm_config_cache=./.npm-cache`）、`python3 -m venv ./.venv`、解包到 `./tools/`、缓存写 `./.cache/`。
- 禁止：`brew install`、全局 `npm`/`pip`、写 `~/.dsh`、`~/.codex`、`~/.cache`、`/opt/homebrew`。
- 读工作区外的文件可以（含 skill 目录）；写与删不行。外部信息走 `web_search` / `web_fetch`。
- 推送目标只有 `scienceprism`。
- **用户未明确指示执行时，不得擅自改代码**（U-12）；状态记为「尚未进入执行计划」。

## 本机基线事实（踩坑清单）

- `experimentRunner` 的 4 个测试在本机**必红**：`/usr/bin/sandbox-exec` 返回 `sandbox_apply: Operation not permitted`（exit 71）。这是环境限制，不是代码缺陷。
- 已实证的替代隔离：**Node 权限模型**（`node --permission --allow-fs-read/write=<workspace>`）在本机可用，实测能拦住越权读 `/etc/hosts`、越权写、`child_process` 与网络；坑是 workspace 必须传**真实路径**（`/tmp` 是 `/private/tmp` 的软链，授权匹配不上）。
- 本机无 matplotlib / seaborn（产品 `plotService` 因此不可用）；LaTeX 只有 `tectonic`（无 `pdflatex`/`xelatex`/`latexmk`）；无 Java。
- `.dsh/skills` 是**产品研究 skill 的源目录**，且只认带 `stages:` frontmatter 的 skill；开发侧 skill 不放这里。
- 前端已有 `react-markdown` + `remark-gfm`；GUI 的 Figure 面板会渲染项目树里的 `.svg`/`.pdf`，所以提交 SVG 即可查看，无需前端改动。
