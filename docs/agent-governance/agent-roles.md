# Agent 角色注册表

> 目标 ② 的交付物。数据由 `agentRoles` 注册表**机器投影**生成，不是手抄。
> 复现：`node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(m.renderRoleTable()))"`

## 1. 摘要

| 维度 | 结果 |
| --- | --- |
| 角色数 | **8** |
| 权限分布 | `suggest-only` **3** ｜ `propose-patch` **3** ｜ `execute` **1** ｜ `interpret-results` **1** |
| 覆盖入口 | **12** 个真实导出符号（全部经动态 import 验证存在） |
| 非角色（强制模块） | **4** 个：Harness Runtime、Experiment Runner、Quality Gate、Evidence Ledger |

**为什么强制模块不算角色**：它们只负责执行规则，不持有 AI 权限等级。把 Harness Runtime 建模成"角色"会让"谁能改数据"这条线糊掉——它恰恰是拒绝别人的那一层。

## 2. 角色表（机器生成）

| Role | Purpose | Authority | Stages | Capabilities | Skills |
| --- | --- | --- | --- | --- | --- |
| `editor-chat-assistant` | Conversational writing help with no project mutation. | suggest-only | editor | none | none |
| `project-agent` | Tool-using project editor: polish, compile debugging, citation insertion, arXiv search. | propose-patch | editor | `project.read`, `patch.propose` | none |
| `paper-reviewer` | Read-only critique: peer review, consistency, missing citations, compile-log summary. | suggest-only | writing | `project.read` | `research-writing` |
| `research-stage-assistant` | One structured producer per Research Stage; JSON output only. | suggest-only | direction, search, selection, replication, ideation, method, experiment, writing | `project.read` | `literature-search`, `paper-card`, `dataset-audit`, `statistics-audit`, `research-writing` |
| `latex-conversion-engine` | Convert an uploaded image into LaTeX (equation, table, figure, algorithm, OCR). | propose-patch | editor | `project.read`, `patch.propose` | none |
| `plot-code-generator` | Turn a LaTeX table into a rendered figure by generating plotting code. | execute | experiment | `project.read`, `patch.propose`, `experiment.execute` | `statistics-audit` |
| `template-migration-agent` | Plan and perform a source-to-target LaTeX template migration. | propose-patch | editor | `project.read`, `patch.propose` | none |
| `experiment-interpreter` | Interpret a completed Experiment Run against its own Artifacts. | interpret-results | experiment | `project.read` | `statistics-audit` |

权限等级含义：

| Authority | 含义 |
| --- | --- |
| `suggest-only` | 只返回文本或结构化建议，什么都不改 |
| `propose-patch` | 可以提出文件变更，等人工确认 |
| `execute` | 可以在人工门禁通过后执行受控动作 |
| `interpret-results` | 可以读已完成的结果并解释，永不修改 |

## 3. 这个注册表修掉了什么

| 改造前 | 改造后 |
| --- | --- |
| **三个互相竞争的「LaTeX writing assistant」人格**（`agentService.js:177`、`routes/agent.js:74`、`EditorPage.tsx:1513`），权限各不相同 | 明确区分：`project-agent`（持 `patch.propose`）vs `paper-reviewer` / `editor-chat-assistant`（只读） |
| **同一端点按请求字段切换权限**（`routes/agent.js` 的 `mode: 'tools'` vs `'direct'`） | 权限由**角色**决定，不再由调用方传字段决定 |
| **prompt 里的假约束**：`EditorPage.tsx:4493` 同行评审写着"不要提 patch"，却走 `mode:'tools'`，`patch.propose` 照样授予 | `paper-reviewer` 角色只允许 `project.read`，测试断言它**不持有** `patch.propose` |
| 论文筛选的 AI 角色无人消费 | 已在迭代 009 删除该死契约 |
| `experiment-interpreter` 没有任何角色定义 | 显式登记，authority = `interpret-results` |

## 4. 测试强制的不变量

`apps/backend/test/agentRoles.test.js` 6 项：

1. 8 个角色格式合法、id 唯一、authority 合法、必须有 `forbiddenActions` / `handoff` / `outputContract` / 至少一个 entrypoint。
2. **角色只能收窄能力词表，不能扩张**：每条 `allowedCapabilities` 必须 ∈ `HARNESS_CAPABILITIES`；四个只读角色断言**不持有** `patch.propose` 与 `experiment.execute`；**只有 `plot-code-generator` 持有 `experiment.execute`**。
3. **每个 entrypoint 的 `module:symbol` 经动态 import 验证真实导出**（12 个入口全过）。
4. 强制模块**不得**作为角色出现。
5. **角色解析只会收窄**：给定项目已授予的全部能力，`paper-reviewer` 只得到 `project.read`；给定更少的授予，取交集；未知角色返回 `UNKNOWN_ROLE`；任何角色都不会浮现项目未授予的能力。
6. 投影一致（权限分布求和 = 总数、入口计数一致、渲染表含每个角色）。

## 5. 复现命令

```bash
# 角色表与分布
node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(m.renderRoleTable()))"
node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(JSON.stringify(m.roleCatalog(),null,2)))"

# 角色解析只收窄
node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(m.resolveRoleCapabilities('paper-reviewer',{granted:['project.read','patch.propose','experiment.execute']})))"

# 门禁
node --test apps/backend/test/agentRoles.test.js
```

## 6. 下一步（迭代 018）

把角色接进 Harness Runtime：由 `role` 解析出能力与 skill 集合，替换散落在各处的按阶段 prompt 拼接；前端在运行前展示"角色 / 能力 / 可用 skill"。当前注册表**零行为变更**——没有任何调用点消费它。
