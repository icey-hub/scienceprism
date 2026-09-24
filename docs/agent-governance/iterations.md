# 迭代日志（200 轮预算 · 加 / 减 / 验证 三拍循环）

> 每拍一行：编号、拍型、变更、验证证据。
> 拍型：**加** = 引入能力；**减** = 删除/收缩冗余；**验证** = 可执行证据 + 回归。
> 硬要求：「减」拍必须真实删除东西，并说明为什么安全；只增不减不算通过。
> **提交约定**：每条 commit 的标题带 `iter-NNN`，可用 `git log --grep iter-NNN` 定位。

## 节奏映射（Round 1）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 001 | 加 | 基线提交 + tag + 分支 + 治理脚手架（需求/计划/看板/任务书） | ✅ |
| 002 | 加 | 第二隔离策略（Node 权限模型）+ 策略选择 + 隔离方式记录 | ✅ |
| 003 | 减 | 删除无断言的 `project.write` 能力（词表 5 → 4） | ✅ |
| 004 | 验证 | 验证 002–003：全量门禁 + 回归对比 + 边界自检（含越界自查） | ✅ |
| 005 | 加 | 阶段契约**从 zod schema 派生**（类型 / 字符模式 / 严格性 / 语义注记） | ✅ |
| 006 | 加 | 源名归一化到注册适配器 + 真实模型驱动脚本 | ✅ |
| 007 | 验证 | **真实模型跑通全流程，工具产出 `aidoc/` 文档** | ✅ |
| 008 | 减 | 收敛 `project-constraints.json` 的重复默认值（5 处 → 1 处） | ✅ |
| 009 | 减 | 删无溯源的兜底草稿 + 死契约 `paper_screening` | ✅ |
| 010 | 验证 | Round 1 收尾 + `rounds/round-01-comparison.md` + 推 scienceprism | ⬜ |

### 计划重排说明（诚实记录）

原计划 005 = 约束注册表骨架。实际执行时，**真实模型跑不通写作管线**——这是 R-01「agent 工作流还不完善」的活样本，且直接阻塞 U-21（迭代要留下工具产出的文档）。因此把 005/006 换成契约与源解析修复，约束注册表顺延到 Round 2 前段。理由：先让工具真的能产出文档，治理改造才有可验证的对象。

## 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 001 | 加 | 基线提交、tag `round-00-baseline`、分支 `feat/agent-governance-r1`、治理脚手架 | `git diff round-00-baseline..HEAD -- apps/ packages/` 无输出（零产品代码改动） |
| 002 | 加 | `adapters.js`：Node 权限模型回退（`nodePermissionCommand`）、纯函数 `chooseIsolationStrategy`、`isOsSandboxApplicable`；`index.js`：Run 记录 `execution.isolation` | `npm run quality` exit 0（44 项）；新增 4 项测试：隔离记录、策略选择表（5 组）、回退策略真实越权拒绝（读 `/etc/hosts` → `ERR_ACCESS_DENIED`；工作区内写入成功）、OS 沙箱可用性报告 |
| 003 | 减 | **删除 `project.write`**（`HARNESS_CAPABILITIES` 5 → 4）。安全依据：全仓库零断言，授予它不产生任何行为；写入只能经 `patch.propose` + 人工应用表达。同时修正 `docs/harness-runtime.md` 的误导表述。**未删** `assertNetworkHost`：复核发现它在 `agentService.js:122,156` 确被调用，属「Harness 路径未接线」的**加**项 | `node --test` 45 项通过；`npm run quality` exit 0；新增词表锁测试（含「存储的未知能力授权会被丢弃而非静默生效」负向断言） |
| 004 | 验证 | 验证 002–003：全量门禁 + 回归对比 + 工作区边界自检 | ① `npm run quality` exit 0（45 项 / 0 失败 / tsc / build）。② 回归：后端测试 40 → 45；能力词表 5 → 4；产品代码仅 3 文件。③ 边界：`package.json`/`package-lock.json` 零变更；工区内产物仅 `.npm-cache`/`tools`/`.cache`（均已 gitignore）。④ **越界自查**：早期探测在 `/tmp` 写过文件，违反 U-02/U-03，已全部删除并复查无残留 |
| 005 | 加 | **阶段契约从 zod schema 派生**。旧契约只给字段名（`queries[]`），模型据此返回对象数组 + 多余字段 → `.strict()` 全拒。现在派生：字段类型、正则模式（`id` 必须无空格）、严格性规则、以及各阶段**引用语义注记**（如 `recommendation` 必须是 `proposals[].id` 之一）。同时 `contextPackager` 不再重复存整份契约（prompt 已含），避免同一文本重复计入 token 预算 | `node --test` 48 项通过；`npm run quality` exit 0；新增契约漂移锁测试、提示词类型/严格性断言、真实模型失败形状回归用例 |
| 006 | 加 | **源名归一化**。搜索阶段曾在 `validation.ok=true` 的情况下静默搜到 0 篇：模型把 `sources` 填成场地描述（`arXiv (cs.CL) — preprint server`），每个都命中不了 Source Adapter 注册表。现在 input 广播 `availableSources`，模型给的源名与注册 id 求交，未注册的记为 `SOURCE_NOT_REGISTERED`，全部落空时回退到注册集 | `node --test` 48 项通过；新增回归用例使用真实模型返回的散文形状，断言回退后仍能搜到论文；随后真实管线从 **0 篇 → 39 篇通过质量门** |
| 007 | 验证 | **真实模型端到端跑通**：`scripts/produce-research-document.mjs` 用项目自身服务层串行执行 方向 → 检索 → 选择 → 跳过复现 → 创新点 → 方法 → 实验计划 → 写作交接 | 4 次串行模型调用（严格单发，遵守 U-20），约 90 秒；产出 `aidoc/aidoc-research-document/research/writing-brief.md`（8581 字符、6 条带 Evidence ID 的 claim、9 节大纲、12 条局限）；同时产出 `.scienceprism/{research-workflow,evidence-ledger,harness-runs}.json` 审计记录。文档**主动声明**所引 3 篇论文并非 RAG 主题，把贡献定位为提案而非已验证结果 |
| 008 | 减 | **约束默认值 5 处 → 1 处**。新增 `config/projectConstraintDefaults.js` 作为唯一来源；`harnessRuntime/index.js` 的 4 个本地常量、`projectHub/dashboard.js` 的 `DEFAULT_CONSTRAINTS`、`deepseekAdapter.js` 的 `49152` 字面量全部改为引用它。安全依据：三处数值完全相同（`49152/600000/1/1`），合并后行为不变；`DEFAULT_CONSTRAINTS` 与 `CONSTRAINT_FILE` 的导出经 grep 确认**全仓库零消费**，故一并删除。顺带发现并处理第 5 处重复（`deepseekAdapter`） | `npm run quality` exit 0（49 项）；`grep -rn "49152\|600000" apps/backend/src` 只剩 defaults 模块；`grep DEFAULT_TIMEOUT_MS…` 产品代码已无本地常量；新增**防重复门禁测试**：扫描 `src` 树，任何文件重述 `49152` 或再声明本地约束默认常量即失败 |
| 009 | 减 | ① **删除无溯源的兜底草稿**：Harness 失败时不再用代码编造 `paper-gap-N` 创新点与 `method-draft-N` 方法候选（含中文占位文案）。安全依据：这些内容看起来像 AI 产出，却没有 Run / 模型 / 上下文 / 溯源，正是 ADR-0001 与 C-04 要禁止的；删除后失败阶段留空，由 readiness 门禁挡住审批。② **删除死契约 `paper_screening`**：schema、注册表项、别名、语义注记、以及 `contextPackager` 与 `researchSkills` 两张别名表里的条目。安全依据：真正跑 LLM 的只有 4 个阶段（`search_strategy`/`innovation_ideas`/`method_proposals`/`writing`），论文筛选由确定性质量门决定；捆绑 skill 声明的是工作流阶段名（`selection`）而非该契约名 | `npm run quality` exit 0（51 项）；新增两项测试：① Harness 失败后 `ideas` 为空、`task.status=failed`、且审批被 `STAGE_NOT_READY` 挡住；② 阶段契约词表锁（8 → 7，且断言 `paper_screening` 不得回归）；`grep -rn paper_screening apps/` 产品代码零残留 |

## 环境变化记录

- 本会话文件策略从 `workspace-write` 变为 `danger-full-access`，外层沙箱撤掉后 `/usr/bin/sandbox-exec` 恢复可用（exit 0），基线 4 个红测试**在无代码改动时即转绿**。迭代 002 的价值因此改为：让 Runner 在 OS 沙箱**不可用**的环境（容器 / CI / 嵌套沙箱）仍能执行，并记录实际使用的隔离方式。
- 本机 LLM 网关 `127.0.0.1:7864` 与 DSH 会话**共享并发**（U-20）；模型选用免费的 `global:deepseek-v4.1-flash`（**不用** `-sg` 变体）。该模型是推理模型，max_tokens 给小了会返回空内容。
