# AGENTS.md — 本仓库的 agent 工作约定

领域词汇：`CONTEXT.md`。既有架构计划：`docs/architecture-roadmap.md`（阶段 1–10 已完成）。

## 每次迭代前的必读（硬性）

动手改任何文件之前，按顺序读完：

1. `docs/agent-governance/requirements.md` — 需求（用户原始需求 + 追加要求）
2. `docs/agent-governance/plan.md` — 执行计划、设计与非目标
3. `docs/agent-governance/README.md` — 当前进度、下一步最小动作、恢复协议
4. 若本次迭代属于某条子 agent 线，读对应任务书：
   `docs/agent-governance/subagents/constraint-line.md`（I-03…I-06）、
   `docs/agent-governance/subagents/role-line.md`（I-07…I-08）、
   `docs/agent-governance/subagents/drawing-line.md`（I-11…I-14）
5. 改约束或做验证时，读对应 playbook：
   `docs/agent-governance/playbooks/adding-a-constraint.md`（把规则写进代码的完整流程）、
   `docs/agent-governance/playbooks/verification-discipline.md`（门禁必须证明会红、边界自检、目视复核）

**迭代收尾**：更新 `docs/agent-governance/README.md` 的迭代表与「当前状态」，并单独更新 `iterations.md`；不更新看板的迭代不算完成。

## Skill 与 playbook 的根目录分离（硬约束）

- `.dsh/skills/` — **只放产品研究 skill**。它会被复制进 Harness 工作区，且加载器**只认带 `stages:` frontmatter 的 skill，不合规项被静默丢弃**。门禁 `researchSkillReachability.test.js` 会断言该目录下每个子目录都是有效产品 skill。
- `docs/agent-governance/playbooks/` — **开发侧 playbook**（本仓库怎么改、怎么验证）。放错到 `.dsh/skills` 会被静默忽略。

## 子 agent 派发规则（硬约束）

派发前必须先查**当前存活的子 agent 数量**：

- **存活数 ≥ 2 → 不派发，先等已有子 agent 结束**，结束后重新计数再决定（U-16）。
- 存活数 ≤ 1 时才可派发，且**一次只派 1 个**。
- 子 agent 不得执行 git 写操作；分支、提交、推送由 Lead 独占。
- 子 agent 的写范围必须互不重叠，并在任务书里写明「不得触碰」清单。

## 原治理目标（历史记录：goal-16c676ec）

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
- Round 1 = `feat/agent-governance-r1`（迭代 001–010）；Round 2 = `feat/agent-governance-r2`（011–020）；Round 3 = `feat/agent-governance-r3`（021–030）。
- 每次迭代收尾 `npm run quality` 必须全绿；不绿就不提交。
- 每轮结束推送 `scienceprism` 并留 PR 给人工审，**不自动合并**。
  用户已明确要求将当前成果提交主分支，迭代 065 因此已快进并推送到 `scienceprism/main`；后续按用户当次指令处理。

## 文档目录约定

- `aidoc/` — **科研工具（SciencePrism）产出的文档落地目录**：工具生成的手稿、写作 Brief、报告、图表等。**不是** agent 治理文档的目录。
- `docs/agent-governance/` — agent 的治理文档：需求、计划、看板、任务书、审计、对比文档。
- `docs/` — 项目自身文档（ADR、roadmap、约束清单、契约）。

## 写入边界（硬约束）

- 读写与删除**仅限本仓库内**；安装只落本仓库内。
- 允许：`npm i -D`（配 `npm_config_cache=./.npm-cache`）、`python3 -m venv ./.venv`、解包到 `./tools/`、缓存写 `./.cache/`。
- 禁止：`brew install`、全局 `npm`/`pip`、写 `~/.dsh`、`~/.codex`、`~/.cache`、`/opt/homebrew`。
- 读工作区外的文件可以（含 skill 目录）；写与删不行。外部信息走 `web_search` / `web_fetch`。
- 推送目标只有 `scienceprism`。
- **用户未明确指示执行时，不得擅自改代码**（U-12）；状态记为「尚未进入执行计划」。
- **本机 LLM 网关 `127.0.0.1:7864` 与 DSH 会话共享并发**（U-20）：模型调用必须串行、单发，禁止并发压测或批量并行。
- **迭代交付物必须是项目真实跑出来的文档**（U-21）：工具产出放 `aidoc/`；agent 的治理 md 只作内部过程记录。

## 历史环境基线与踩坑清单

- 迭代 001 时，`experimentRunner` 的 4 个测试因 `/usr/bin/sandbox-exec` 返回 exit 71 而失败；这是**历史基线**，不代表当前门禁状态。迭代 065 的 `npm run quality` 已通过 126 项后端测试、类型检查、构建和 6 张图的布局检查。
- 已实证的替代隔离：**Node 权限模型**（`node --permission --allow-fs-read/write=<workspace>`）在本机可用，实测能拦住越权读 `/etc/hosts`、越权写、`child_process` 与网络；坑是 workspace 必须传**真实路径**（`/tmp` 是 `/private/tmp` 的软链，授权匹配不上）。
- 本机无 matplotlib / seaborn（产品 `plotService` 因此不可用）；LaTeX 只有 `tectonic`（无 `pdflatex`/`xelatex`/`latexmk`）；无 Java。
- `.dsh/skills` 是**产品研究 skill 的源目录**，且只认带 `stages:` frontmatter 的 skill；开发侧 skill 不放这里。
- 前端已有 `react-markdown` + `remark-gfm`；GUI 的 Figure 面板会渲染项目树里的 `.svg`/`.pdf`，所以提交 SVG 即可查看，无需前端改动。
