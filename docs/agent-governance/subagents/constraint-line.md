# 子 agent 任务书 · 约束线（I-03 / I-04 / I-05 / I-06）

> 每次迭代前必读。上级文档：`../requirements.md`、`../plan.md`、`../README.md`、仓库根 `AGENTS.md`。

## 1. 任务与目标

把散落在 prompt / 路由 / 页面里的约束，改造成**代码里可执行、可开关、可审计、可测试**的约束注册表，并收口 4 处高危绕过。

覆盖迭代：
- **I-03** 约束审计结论落文档 + 逐条复核（带 file:line）
- **I-04** 约束注册表骨架（**零行为变更**，enforcement 先包装现有函数）
- **I-05** 约束策略与可选开关 + tier 分级
- **I-06** 4 处高危绕过收口 + 约束测试门禁

## 2. 停止条件

`done` = I-03…I-06 全部完成，且：`npm run quality` 全绿；每条约束都有存在的测试；删掉任一约束的测试会让门禁变红；`core` 级约束拒绝关闭。
`needs-verification` = 实现有但缺证据。`blocked` = 需要 Lead 决策或跨范围改动。

## 3. 独占写范围（只准写这些）

- `apps/backend/src/services/constraintRegistry/**`（新建）
- `apps/backend/test/constraintRegistry.test.js`（新建）
- `docs/agent-governance/constraint-audit.md`（新建）
- `docs/adr/0010-*.md`（新建）
- `docs/project-constraints.md`（改为生成物）
- I-06 收口：`apps/backend/src/routes/{transfer,vision,plot,llm}.js`、`apps/backend/src/services/transferAgent/**`

**不得触碰**：`apps/backend/src/services/harnessRuntime/**`、`apps/backend/src/services/agentRoles/**`、`apps/backend/src/services/experimentRunner/**`、`package.json`、`package-lock.json`、`.gitignore`、`AGENTS.md`、`docs/agent-governance/{README,plan,requirements}.md`、`docs/agent-governance/subagents/**`、`tools/**`、`docs/agent-governance/assets/**`。
需要改上述任一文件时：**停下来报告 Lead**，不要自己改。

## 4. 必读基线

- `docs/project-constraints.md`（现有 16 条 C-01…C-16）
- `apps/backend/src/services/harnessRuntime/capabilities.js`（能力词表、路径/敏感文件/网络断言、`capabilityPrompt` 把策略写进 prompt）
- `apps/backend/src/services/featureFlags.js`、`apps/backend/src/services/projectHub/dashboard.js`（约束文件的 5 个读写点，4 套重复默认值）
- `apps/backend/src/services/researchWorkflow/{stateMachine,stageContracts,commands,application}.js`
- `apps/backend/test/*.test.js`（现有 40 项测试的写法）

## 5. 已知事实（已取证，可直接引用但关键处仍需自己复核）

- 16 条约束里 **9 条只是部分生效**：C-01、C-04、C-07、C-08、C-09、C-10、C-11、C-12、C-16。
- **2 处直接矛盾**：C-08「Shell 和实验执行默认关闭」而 `featureFlags.js:9-12` 默认 `true`；C-01 引用的 `safeJoin` 不是工作流存储的守卫（实际是 `path.join` + `assertProjectId`）。
- **2 处疑似 AI 主观添加**：C-16（Feature Flag，任何 ADR / CONTEXT.md 均无记载）、C-11 的字段集（`caveats`/`limitations`/`unsupportedClaims`/`missingMetadata` 全是 `.default([])` 可选，无代码要求）。
- **4 处高危绕过**：`transferAgent/**` + `routes/transfer.js` 零能力校验却直接写盘并 spawn pdflatex；`plotService.js:133` 执行 LLM 生成的 Python 无门禁；`routes/vision.js:54` 未审批写 assets；`routes/llm.js` 裸代理（无角色/项目/能力校验）。
- `project.write` 在 `apps/backend/src` 里除声明行外零引用 → 能力词表虚高。
- `actor` 由调用方自报：`routes/researchWorkflow.js:27` `body.actor || header || collabAuth?.sub || 'human'` → C-04「AI 不能审批」目前只是结构性的。
- 缺测试的强制点：`PROJECT_NOT_FOUND`、`STAGE_GATE`、`409 QUALITY_GATE`/needs-review、`HARNESS_TIMEOUT`/`maxTokens`、`assertNetworkHost`（**从未在 Harness 路径被调用**）、禁用 flag 阻止启动。

## 6. 非目标

- 不改实验执行与 Harness Runtime 的内部行为。
- 不推倒重写 16 条约束；I-04 必须**零行为变更**。
- 不做前端 UI（约束开关面板属 I-17，由 Lead 安排）。
- 不动 `core` 语义：`core` 不可关，要改必须改代码 + ADR。

## 7. 交付物与验收

| 迭代 | 交付物 | 验收（可执行） |
| --- | --- | --- |
| I-03 | `constraint-audit.md` | 每条带 file:line；含漂移清单 + 「只在 prompt 生效的伪约束」清单；抽 3 条做反证检查 |
| I-04 | `constraintRegistry/` + ADR-0010 + 生成的 `project-constraints.md` | 现有 40 项测试全绿（零行为变更）；文档一致性测试存在且有效 |
| I-05 | `.scienceprism/constraint-policy.json` 解析 + tier 规则 | 关闭 `standard` 约束后确实不生效（负向测试）；`core` 拒绝关闭；审计留痕 |
| I-06 | 4 处收口 + 测试门禁 | 每处有负向测试证明现在被拒；删除任一约束的测试 → 门禁变红 |

## 8. 硬约束

- 读写/删除**仅限本仓库内**；安装只落仓库内（`npm_config_cache=./.npm-cache`、`./.venv`、`./tools/`、`./.cache/`）；禁止 `brew`、全局 npm/pip。
- **不要执行任何 git 写操作**（不 add / commit / branch / push）。git 生命周期由 Lead 独占。
- 需要新增依赖时，把确切命令写进报告，由 Lead 执行。
- 不要写 `AGENTS.md`、`docs/agent-governance/README.md`、`plan.md`、`requirements.md`。

## 9. 报告格式（回给 Lead）

```
状态：DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
迭代：I-0x
改动文件：（逐个列出，含新增/修改）
验证证据：（确切命令 + 结果，例如 node --test 输出行）
新增依赖命令：（如需，原文给出）
未解未知：
跨范围需求：（需要 Lead 改哪些文件）
```
