# 子 agent 任务书 · 角色线（I-07 / I-08）

> 每次迭代前必读。上级文档：`../requirements.md`、`../plan.md`、`../README.md`、仓库根 `AGENTS.md`。

## 1. 任务与目标

建立 **agent 角色注册表**，把「靠 prompt 隐式定义的角色」变成代码里显式的角色对象，并接入 Harness Runtime 的能力/skill 解析。

覆盖迭代：
- **I-07** 角色注册表（8 角色）+ `docs/agent-governance/agent-roles.md` + ADR-0011
- **I-08** 角色解析器（role → 能力 + skill 集合），供 Harness Runtime 使用

## 2. 停止条件

`done` = I-07 / I-08 完成，且：注册表覆盖全部 AI 入口（与代码交叉核对）；越权角色被拒（负向测试）；golden test 证明改造前后同输入行为一致。
`blocked` = 需要改 Lead 独占文件（如 `harnessRuntime/index.js` 的接线）。

## 3. 独占写范围（只准写这些）

- `apps/backend/src/services/agentRoles/**`（新建）
- `apps/backend/src/services/harnessRuntime/roleResolver.js`（新建，**只允许新建这一个文件**）
- `apps/backend/test/agentRoles.test.js`（新建）
- `docs/agent-governance/agent-roles.md`（新建）
- `docs/adr/0011-*.md`（新建）

**不得触碰**：`apps/backend/src/services/harnessRuntime/index.js` 及其他既有文件、`apps/backend/src/services/constraintRegistry/**`、`apps/backend/src/routes/**`、`apps/backend/src/services/experimentRunner/**`、`apps/backend/src/services/transferAgent/**`、`package.json`、`package-lock.json`、`AGENTS.md`、`docs/agent-governance/**`。
接线到 Runtime（`index.js`）由 **Lead 在 I-08 执行**：你只提供 `roleResolver.js` 与「需要改哪一行」的精确说明。

## 4. 必读基线

- `CONTEXT.md`（权威词汇：Harness Run、Approval、Project Constraint、Project Skill、Experiment Plan vs Run、Evidence、Paper Claim）
- `docs/adr/0001`、`0002`、`0006`、`0009`（隔离 / 人工审批 / 能力默认值 / 受控实验）
- `apps/backend/src/services/harnessRuntime/capabilities.js`（`HARNESS_CAPABILITIES`、默认 `project.read` + `patch.propose`）
- 全部 AI 入口：`services/{agentService,agentRuntime,deepseekHarnessService,llmService}.js`、`researchResearch/harnessAdapter.js`、`researchWorkflow/{application,stageTask}.js`、`routes/{agent,vision,plot,llm}.js`、`transferAgent/nodes/*.js`、`experimentRunner/index.js`、`apps/frontend/src/app/EditorPage.tsx` 内的各 task prompt

## 5. 已知事实（已取证；关键处仍需自己复核）

- 当前**显式角色 0 个**；6 类 AI 入口全靠 prompt 隐式定义。
- 三个互相竞争的「LaTeX writing assistant」人格：`agentService.js:177`、`routes/agent.js:74`、`EditorPage.tsx:1513`，权限各不相同。
- 同一端点按 `mode` 切换权限：`routes/agent.js:60-62`（tools，带 patch）vs `:64-76`（direct，只出 JSON）——权限是请求字段而非角色。
- **prompt 假约束**：`EditorPage.tsx:4493` 同行评审写着「不要提 patch」，却走 `mode:'tools'`，`patch.propose` 照样授予。
- 唯一有代码边界的是 chat 模式：`routes/agent.js:32` 禁止 patch，且 `:42-47` 不传工具 → 结构上不可能 patch。
- `transferAgent/**` 完全不经过能力机制；`experiment-interpreter` 没有任何 prompt / 角色定义（`experimentRunner/index.js:474-480`）。
- `/api/llm` 让前端自定义服务端生效的角色（`EditorPage.tsx:2054`、`:2084`）。
- 已取证得到的 8 角色分类法（可作起点，需自己验证）：`editor-chat-assistant`、`project-agent`、`paper-reviewer`、`research-stage-assistant`、`latex-conversion-engine`、`plot-code-generator`、`template-migration-agent`、`experiment-interpreter`。
- 非角色（属强制模块）：Harness Runtime、Experiment Runner、Quality Gate、Evidence Ledger。

## 6. 非目标

- 不改 4 处高危绕过（属约束线 I-06）。
- 不改前端 UI；不做角色管理后台。
- 不引入新的权限体系：角色只能**收窄** `HARNESS_CAPABILITIES`，不得新增能力。

## 7. 交付物与验收

| 迭代 | 交付物 | 验收（可执行） |
| --- | --- | --- |
| I-07 | `agentRoles/` + `docs/agent-governance/agent-roles.md` + ADR-0011 | 注册表覆盖全部 AI 入口（清单与代码交叉核对，逐条给 file:line）；每个角色写明 authority / 能力 / skill / 禁止行为 |
| I-08 | `roleResolver.js` | 给定 role → 返回能力与 skill 集合；越权（请求超出角色能力）被拒（负向测试）；golden test 对比改造前后行为一致；附「Lead 需在 `index.js` 改哪一行」的精确说明 |

## 8. 硬约束

- 读写/删除**仅限本仓库内**；安装只落仓库内；禁止 `brew`、全局 npm/pip。
- **不要执行任何 git 写操作**。git 生命周期由 Lead 独占。
- 需要新增依赖时，把确切命令写进报告，由 Lead 执行。
- 角色不得新增 `HARNESS_CAPABILITIES` 之外的能力；`core` 约束（AI 不能审批/选择/授权）不可被任何角色绕过。

## 9. 报告格式（回给 Lead）

```
状态：DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
迭代：I-0x
改动文件：（逐个列出）
角色清单：（id → authority → 能力 → 禁止行为）
验证证据：（确切命令 + 结果）
Lead 需改的文件与行：（精确说明，例如 index.js:xxx 调用 resolveRole）
未解未知：
```
