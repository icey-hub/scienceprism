# 执行计划（Round 1 + Round 2）

> 本文件是**计划的单一事实源**。每次迭代前必读（见 `AGENTS.md`）。
> 需求依据：`requirements.md`。进度事实源：`README.md`。

## 1. 目标

把 agent 工作流从「规则写在 prompt 里」改造成「规则写在代码里」：
约束注册表（可执行 / 可开关 / 可审计 / 可测试）、角色注册表、skill 补齐、复杂矢量插画级文档绘图。

## 2. 非目标

- 不改产品内 LaTeX 文档插图能力（`plotService` / `\includegraphics` 链路）。
- 不做 Skill 市场 / 版本后台；不重构 `EditorPage.tsx` 组合根。
- 不改视觉设计；不做移动端与无障碍；不推 `origin`（OpenDCAI/OpenPrism）。
- 不推倒重写现有 16 条约束：先零行为变更包装，再逐条迁移。

## 3. 核心设计

### 3.1 约束即代码 + 可选开关

现状病灶：约束分散在四处——`docs/project-constraints.md` 文档表、`harnessRuntime/capabilities.js:161 capabilityPrompt()`（写进 prompt）、`capabilityForToolName()`（工具名正则猜权限）、以及散落在 `stateMachine.js` / `qualityGate.js` / `experimentRunner` / 路由里的硬编码判断。

目标形态：`apps/backend/src/services/constraintRegistry/`
- 一条约束 = 一个模块，导出 `{ id, statement, tier, scope, enforcement(ctx), testRef, provenance }`。
- `provenance` 记录 `author: human|ai`、`addedAt`、`rationale`、`approvedBy`、`runId` → AI 主观添加的约束可查、可审、可撤。
- `docs/project-constraints.md` 改为**由代码生成** + 一致性测试（文档漂移直接 CI 红）。
- 开关：`.scienceprism/constraint-policy.json` 逐条 `enabled` + presets（strict / standard / relaxed），启用/禁用写审计事件。

**tier 分级（D-5）**：
- `core` — 产品不变量（AI 不能审批、路径安全、默认只读、证据可追溯）：不可关，要改必须改代码 + 走 ADR。
- `standard` — 常规质量约束：可关，默认开。
- `experimental` — AI 提议、未经人工确认：可关，默认关。

### 3.2 角色注册表

`apps/backend/src/services/agentRoles/` + `docs/agent-roles.md`：
`{ id, purpose, stageScope, allowedCapabilities, allowedSkills, outputContract, authority, handoff, forbiddenActions }`

已取证得到的 8 角色分类法（待验证落地）：`editor-chat-assistant`、`project-agent`、`paper-reviewer`、`research-stage-assistant`、`latex-conversion-engine`、`plot-code-generator`、`template-migration-agent`、`experiment-interpreter`。
非角色（属强制模块，不进角色模型）：Harness Runtime、Experiment Runner、Quality Gate、Evidence Ledger。

### 3.3 skill 补齐与根目录隔离

`.dsh/skills` 是**产品研究 skill 的源目录**，且只认带 `stages:` frontmatter 的 skill（`researchSkills.js:123` 静默丢弃不合规项）。
- 产品侧：补 3 个研究 skill（`research-direction`、`claim-evidence-audit`、`figure-table-plan`）。
- 开发侧：放 `docs/agent-governance/playbooks/`（零发现机制风险，D-3）。

### 3.4 文档绘图（U-07 修正版）

**目标不是线段加方框，而是复杂矢量插画**（例如细胞结构图：多层形状、填充、曲线、密集标注）。因此评测基准与候选集必须覆盖插画能力，而不是只比架构图工具。

候选（工作区合规性已核对）：

| 候选 | 工作区内做法 | 插画能力 |
| --- | --- | --- |
| **手写 SVG**（agent 直接产出） | 零安装，纯文本提交 | **最高**：任意矢量图形、渐变、路径、分组 |
| **TikZ + 已装 tectonic** | `TECTONIC_CACHE_DIR=./.cache/tectonic`（首次需联网预热） | **最高**（论文级），语法重 |
| **matplotlib patches（./.venv）** | `python3 -m venv ./.venv` + pip 装到仓库内 | 高：Circle/Ellipse/Path/FancyArrow，可出 SVG/PDF |
| **Mermaid CLI**（repo devDependency + 复用已装 Chrome） | `PUPPETEER_SKIP_DOWNLOAD=1 npm_config_cache=./.npm-cache npm i -D @mermaid-js/mermaid-cli`；渲染时 `PUPPETEER_EXECUTABLE_PATH` 指向已装 Chrome | 低：只有节点-连线 |
| **D2** | 官方 release 解包到 `./tools/d2` | 低：只有节点-连线 |
| Graphviz WASM（`@viz-js/viz`，纯 npm） | repo devDependency | 低：只有节点-连线 |
| PlantUML / 任意 MCP / AI 生图 | — | ❌ 无 JRE / 配置须写工作区外 / 生图会拼错文字且不确定 |

**参考图集（I-12 固定 4 张）**：① 模块依赖图 ② 时序/流程图 ③ **复杂插画：细胞结构图** ④ 对比图表。
**评分 9 维**：渲染成功率、视觉质量、**复杂插画能力**、可编辑性、确定性、LaTeX 集成、离线可用、安装成本、CI 可验证性、中文支持。
**产物**：并排提交 `docs/assets/diagrams/`，附截图证据。查看端零改动——GUI 的 Figure 面板已渲染项目树里的 `.svg`/`.pdf`（`FIGURE_EXTS`，`EditorPage.tsx:97`）。

## 4. Round 1 — `feat/agent-governance-r1`

| # | 迭代 | 产出与验证 |
| --- | --- | --- |
| I-01 | 基线提交 + tag + 分支 + 治理脚手架 | ✅ `33a2b5b` / `7854331`、tag `round-00-baseline` |
| I-02 | 修复 4 个红测试至 40/40 | 根因：`sandbox-exec` 在本机 exit 71。修法：给 Runner 加第二隔离策略（Node 权限模型），不牺牲真实隔离测试 |
| I-03 | 约束审计结论落文档 + 逐条复核 | 每条带 file:line；含漂移清单与「只在 prompt 生效的伪约束」清单 |
| I-04 | 约束注册表骨架（**零行为变更**） | enforcement 先包装现有函数；文档改为生成 + 一致性测试；ADR-0010 |
| I-05 | 约束策略与开关 + tier | 禁用后确实不生效（负向测试）；`core` 拒绝关闭；审计留痕 |
| I-06 | 4 处高危绕过收口 + 约束测试门禁 | transfer 零校验 / plot 无门禁执行 / vision 未审批写盘 / llm 裸代理；删测试则门禁红 |
| I-07 | 角色注册表（8 角色） | 覆盖全部 AI 入口；ADR-0011 |
| I-08 | 角色接入 Harness Runtime | golden test 行为一致；越权被拒 |
| I-09 | 产品 skill 补齐 3 个 | SKILL.md 契约 + stage 绑定 + 发现/绑定测试 |
| I-10 | Round 1 收尾 | `rounds/round-01-comparison.md` + tag + 推 scienceprism |

## 5. Round 2 — `feat/agent-governance-r2`（从 r1 尖端切出）

| # | 迭代 | 产出与验证 |
| --- | --- | --- |
| I-11 | 绘图候选取证（含插画能力维度） | `drawing-candidates.md` |
| I-12 | 4 张参考图源文件 + `scripts/setup-diagram-toolchain.sh`（缓存全部重定向进仓库） | 脚本可重复执行 |
| I-13 | 绘图对比实验 | `drawing-comparison.md` + 并排产物 + 9 维打分 |
| I-14 | 选定主方案 + `doc-diagram` skill + CI 可复现校验 | 重渲染 diff 为空 |
| I-15 | 约束建议 API（严格 schema，不执行代码） | 提案结构校验测试 |
| I-16 | 约束代码生成器（→ 真实代码 + 测试，待确认 Patch） | 绝不 eval；白名单/AST 校验；人工批准后才落盘 |
| I-17 | 前端约束建议面板 + 溯源 + i18n | 启用/禁用/编辑/拒绝可用 |
| I-18 | 端到端验收 | 对话→提案→批准→生效→拦截→禁用放行→审计 |
| I-19 | 角色/约束可见性 + 文档同步 | 运行前摘要 + 设置页开关列表 |
| I-20 | Round 2 收尾 | `rounds/round-02-comparison.md` |

## 6. 分支 / 提交 / 对比文档规范

- 分支：r1 从基线提交切出；r2 从 r1 尖端切出（D-4）。
- 提交：一次迭代一条 commit，`feat(constraints): I-05 约束策略与可选开关`，body 写验证命令与结果。
- 标签：每轮 `round-0N-complete`；每轮留 PR 给人工审，不自动合并。
- 对比文档固定结构：① 上轮指标快照 ② 本轮 10 次迭代清单 ③ 前后指标对比表 ④ 可视化对比图 ⑤ 决策与遗留 ⑥ 可复现命令。

## 7. 质量门禁

每次迭代收尾 `npm run quality`（后端测试 + tsc + build）必须全绿。新增门禁：约束注册表一致性、每条约束必须有存在的测试、角色注册表覆盖全部 AI 入口、绘图产物可复现、**工作区边界自检**（无安装/缓存写入仓库外）。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 4 个红测试是环境性的，易误判为代码缺陷 | I-02 单独归因，保留 fail-closed 语义 |
| 约束重构爆炸半径大（16 条散布多处） | 零行为变更包装 + golden test + 负向测试，逐条迁移 |
| 「全部可选」与产品不变量冲突 | tier 模型，`core` 不可关 |
| LLM 生成约束代码 = 任意代码执行风险 | 绝不 eval；只以 Patch 形式、人工批准后落盘；白名单/AST 校验 |
| 工作区只写 vs 工具默认缓存 | 全部重定向进仓库；禁用 brew、全局 npm/pip |
| `.dsh/skills` 双用途冲突 | 开发侧 skill 移出该目录 |
| 10 次迭代跨会话丢上下文 | 每迭代提交 + 更新 `README.md`，新会话按恢复协议续 |

## 9. 计划变更记录

- 2026-09-24：初版（Round 1 + Round 2）。
- 2026-09-24：按 U-07 修正绘图目标为**复杂矢量插画级**，重做 I-11…I-14 的基准与候选集；按 U-02/U-03 将全部安装与缓存重定向进仓库，MCP 路线关闭。
