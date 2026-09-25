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
| 010 | 验证 | Round 1 收尾 + `rounds/round-01-comparison.md` + tag + 推 scienceprism | ✅ |

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
| 010 | 验证 | Round 1 收尾：写 `rounds/round-01-comparison.md`（round-00 基线 vs round-01 全指标、10 拍清单、工具交付物、2 个真实缺陷、7 项遗留、可复现命令）；打 tag `round-01-complete`；推 `scienceprism` | `git tag -l "round-*"` → `round-00-baseline` / `round-01-complete`；`git push -u scienceprism feat/agent-governance-r1` 成功（新分支），PR：https://github.com/icey-hub/scienceprism/pull/new/feat/agent-governance-r1 ；`npm run quality` exit 0（51 项） |

## Round 1 完成（迭代 001–010）

- 交付物（工具真实产出）：`aidoc/aidoc-research-document/research/writing-brief.md` + 3 份 `.scienceprism/` 审计记录。
- 对比文档：`docs/agent-governance/rounds/round-01-comparison.md`。
- 分支：`feat/agent-governance-r1`（已推 `scienceprism`）；tag `round-01-complete`。
- 关键指标：后端测试 40（36 通过 / 4 失败）→ **51（全通过）**；能力词表 5 → 4；阶段契约 8 → 7；约束默认值来源 5 → 1；无溯源兜底草稿 2 → 0。
- 遗留进 Round 2：约束注册表、4 处高危绕过、角色注册表、`assertNetworkHost` 接线、失败重试回灌、复杂矢量插画绘图方案、`aidoc/` 落点策略。

## Round 2 节奏映射（迭代 011–020）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 011 | 加 | 约束注册表骨架（零行为变更）+ 机器生成的审计文档 | ✅ |
| 012 | 加 | 约束策略与可选开关（`.scienceprism/constraint-policy.json`，`core` 不可关） | ✅ |
| 013 | 减 | 收口漂移：改代码补齐或改文档对齐（9 条 → 5 条） | ✅ |
| 014 | 验证 | 验证 011–013：门禁 + 回归 + 边界自检 + 越界自查 | ✅ |
| 015 | 加 | 收口 4 处高危绕过（重审后：1 处真高危已收口、2 处变为可拒绝、1 处降级） | ✅ |
| 016 | 验证 | 验证 015：门禁 + 拒绝路径 + 能力语义 + 边界自检 | ✅ |
| 017 | 加 | 角色注册表（8 角色 + 4 强制模块 + 只收窄的能力解析） | ✅ |
| 018 | 加 | 角色接入 Harness Runtime（角色只收窄；未知角色 fail-closed；Run 记录角色） | ✅ |
| 019 | 减 | 删 prompt 假约束（改用角色在代码里强制）+ 打通 role 透传 | ✅ |
| 020 | 验证 | Round 2 收尾 + `rounds/round-02-comparison.md` + 推 scienceprism | ⬜ |

## Round 2 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 011 | 加 | 新增 `services/constraintRegistry/`：16 条约束的机器可读注册表（tier / scope / `module:symbol` seam / testRef / provenance / drift），加 `listConstraints` / `getConstraint` / `constraintCatalog` / `renderConstraintCatalog` 投影。**零行为变更**：没有任何调用点，enforcement 只是引用既有 seam。同时产出 `docs/agent-governance/constraint-audit.md`（数据由注册表投影生成，非手抄） | `npm run quality` exit 0（56 项）；新增 5 项门禁测试：① 16 条格式合法且 id 唯一；② **每条 `module:symbol` 经动态 import 验证真实导出**；③ 每条 `testRef` 指向的测试文件里确实存在同名 `test(...)`；④ 注册表 id 集合与 `docs/project-constraints.md` 表格**完全一致**（多一条少一条都红）；⑤ 投影一致（分层求和、tested+untested=total、漂移清单一致）。审计结论：13 core / 3 standard / 14 有测试 / **9 条漂移** / **2 处 AI 主观添加**（C-11 字段集、C-16） |
| 012 | 加 | **约束可选开关**（R-06 / D-5）：新增 `constraintRegistry/policy.js`。项目用 `.scienceprism/constraint-policy.json` 声明要关掉哪些约束；`normalizeConstraintPolicy` 只接受 `standard`/`experimental` 级，**`core` 级一律拒绝**并记 `CORE_CONSTRAINT_IMMUTABLE`，未知 id 记 `UNKNOWN_CONSTRAINT`；策略文件缺失 = 全部开启；`constraintPolicyProjection` 让被关掉的约束**仍然可见**而不是被隐藏 | `npm run quality` exit 0（59 项）；新增 3 项测试：① 关闭 `standard` 生效、关闭 `core` 被拒且保持开启、未知 id 被拒；② 无策略文件时 16 条全开；③ 存储的策略文件同时列 `C-08`(core) 与 `C-16`(standard) 时，只有 `C-16` 被关，`C-08` 仍在投影里显示为 enabled |
| 013 | 减 | **收口 9 条漂移中的 4 条，并补掉 2 条测试缺口**。① **改代码**：C-12 —— 把主张-证据检查从 Harness adapter 移进 `getStageReadiness('writing')` 的 `validate` 钩子，**直接 PATCH 设 `ready:true` 不再能绕过证据门**；C-16 —— `advancedHarness` 从"只 gate deepseek"改为 gate **所有真实适配器**（仅测试用的 fake adapter 豁免），与文档的 "adapters" 复数一致。② **改文档**：C-01 的验证位置原本错引 `pathUtils.js:safeJoin`（四个项目存储实际用 `path.join`），改为真实守卫 `getProjectRoot` + `assertProjectId`；C-08 的「默认关闭」是假的（`featureFlags` 默认 true），改为「需要显式能力 + 人工审批，且可被 flag 关掉」。③ **补测试**：C-01 新增「未知 Project 被拒而非落到共享根」，C-10 新增「Run limits 回退到共享默认值」 | `npm run quality` exit 0（63 项，59 → 63）；注册表投影：**漂移 9 → 5**（剩余 C-04、C-07、C-09、C-10、C-11，均需更大改动）、**无测试 2 → 0（16/16 全有测试）**；新增 4 项测试，其中 C-12 的用例专门验证「`ready:true` + 空 `evidenceIds` → readiness 拒绝」、C-16 的用例验证「legacy 适配器在 flag 关闭时被 `FEATURE_FLAG_DISABLED` 拒绝，fake 仍可用」 |
| 014 | 验证 | 验证 011–013 三拍：全量门禁 + 回归对比 + 工作区边界自检 + 越界自查 | ① `npm run quality` **exit 0**（63 项 / 0 失败 / tsc / build）。② 回归：后端测试 **51 → 63**；约束 **16/16 全有测试**（原 14/16）；漂移 **9 → 5**；本轮改动 12 个文件（产品代码 5 个 + 测试 3 个 + 文档 4 个）。③ 边界：`package.json` / `package-lock.json` **零变更**（未装任何依赖）；工区内安装产物仅 `.npm-cache` / `tools` / `.cache`，均已 gitignore。④ **越界自查**：`/tmp` 下唯一命中的 `scienceprism-clipboard.png` 时间戳为 **9月20日**，早于本会话（9月24 14:55 起）4 天，**非本会话产生**，且非我所有，未删除。⑤ 注册表自检：16 条 enforcement seam 全部经动态 import 验证真实导出；16 条 testRef 全部指向真实存在的同名测试 |
| 015 | 加 | **收口高危绕过，并在重审后据实修正早先的取证结论**。① **plot（真高危，已 fail-closed）**：该路由让模型写 Python 然后执行，此前**无沙箱、无能力检查、无 flag**，而受控 Experiment Run 却要两次人工决定；现在执行前要求项目授予 `experiment.execute` **且** `experimentExecution` flag 打开，否则 `CAPABILITY_DENIED` / `FEATURE_FLAG_DISABLED`。② **transfer（部分成立）**：它写的是**新建项目**的 `.tex`、编译走白名单引擎 + `safeJoin`（与编辑器编译同级，属基线能力），真问题是完全不参与约束模型 → 入口加 `patch.propose` 检查（默认已授予，现有流程不变、项目可撤销），且授权检查放在模板校验**之前**。③ **vision（降级）**：写的是**用户自己上传的图片**，人类上传动作本身即授权，不是"AI 变更未经审" → 仍加 `patch.propose` 使其可拒绝。④ **llm（降级）**：`requireAuthIfRemote` 是全局 onRequest 钩子，**远端访问已强制鉴权**；本地优先单用户下只是转发调用方 messages，无权限提升 → **不改代码**并记录依据 | `npm run quality` exit 0（67 项，63 → 67）；新增 `routeCapabilityGates.test.js` 4 项测试：无 `experiment.execute` 时 plot 被拒、flag 关闭时 plot 被拒、撤销 `patch.propose` 时 transfer 返回 403、撤销时 vision 被拒。处置结论写入 `constraint-audit.md` 第 7 节 |
| 016 | 验证 | 验证 015 拍：全量门禁 + 拒绝路径 + 能力语义 + 边界自检 | ① `npm run quality` **exit 0**（67 项 / 0 失败 / tsc / build）。② 4 条拒绝路径测试全绿：plot 无能力被拒、plot flag 关闭被拒、transfer 撤销能力返回 403、vision 撤销能力被拒。③ **能力语义实测**：默认 `experiment.execute = false`（→ plot 默认 fail-closed）、默认 `patch.propose = true`（→ transfer/vision 现有流程不受影响）、撤销后 `patch.propose = false`（→ 可拒绝）。④ 边界：`package.json` / `package-lock.json` **零变更**；工作树干净 |
| 017 | 加 | **角色注册表**（目标 ②）：新增 `services/agentRoles/`，登记 **8 个角色**（`editor-chat-assistant`、`project-agent`、`paper-reviewer`、`research-stage-assistant`、`latex-conversion-engine`、`plot-code-generator`、`template-migration-agent`、`experiment-interpreter`），每个写明 purpose / stageScope / authority / 允许能力 / 允许 skill / 输出契约 / 交接 / 禁止行为 / **真实 entrypoint 符号**；另登记 **4 个强制模块**（Harness Runtime、Experiment Runner、Quality Gate、Evidence Ledger）并断言它们**不得**作为角色。**零行为变更**：无任何调用点。产出 `docs/agent-governance/agent-roles.md`（表格由注册表投影生成） | `npm run quality` exit 0（73 项，67 → 73）；新增 6 项门禁测试：① 8 角色格式/唯一性/必填字段；② **能力只能收窄**——每条 ∈ `HARNESS_CAPABILITIES`，四个只读角色断言不持有 `patch.propose` 与 `experiment.execute`，且**只有 `plot-code-generator` 持有 `experiment.execute`**；③ **12 个 entrypoint 的 `module:symbol` 经动态 import 验证真实导出**；④ 强制模块不得是角色；⑤ `resolveRoleCapabilities` 只取交集、未知角色返回 `UNKNOWN_ROLE`、任何角色都不浮现未授予能力；⑥ 投影一致。修掉的问题：三个竞争人格、同一端点按请求字段切权限、`EditorPage.tsx:4493` 的 prompt 假约束 |
| 018 | 加 | **角色接入 Harness Runtime**（目标 ② 收尾）：`createHarnessRun` 接受 `request.role`，用 `resolveRoleCapabilities` 把项目授予与角色允许**取交集**得到有效能力；命名角色**只能删能力、不能加**；**未知角色 fail-closed**（400 `UNKNOWN_ROLE`），不再"静默无约束运行"；Run 记录 `role` 与 `roleAuthority`，被删掉的能力进入 `capabilities.denied` **可见而非静默**。不传角色时行为完全不变 | `npm run quality` exit 0（76 项，73 → 76）；新增 3 项测试：① 项目授予 `project.read`+`patch.propose`+`research.search` 时，`paper-reviewer` 角色只拿到 `project.read`，且 `patch.propose` 出现在 `denied`；② 未知角色抛 `UNKNOWN_ROLE`；③ 不传角色时授予保持 `project.read`+`patch.propose` 不变 |
| 019 | 减 | **删掉 prompt 里的假约束，改用角色在代码里强制**（U-04「约束以代码形式加而不是加在 agent 本身」）。① **研究阶段**：prompt 里那句 "Provide analysis and structured suggestions only" **已删除**——因为该阶段现在真的以 `research-stage-assistant` 角色运行（只持 `project.read`），**结构上无法提 Patch**，重述即为冗余。② **前端三个只读任务**（`peer_review` / `consistency_check` / `missing_citations`）此前 prompt 写着"不要提 patch"却走 `mode:'tools'` 并持有 `patch.propose`——现在它们传 `role: 'paper-reviewer'`，后端把能力收窄到 `project.read`，**那句话第一次成为真的**。③ 打通 `role` 透传链：`client.ts` → `routes/agent.js` → `agentRuntime` → `runHarnessRequest` → `createHarnessRun` | `npm run quality` exit 0（78 项，76 → 78，含**前端 tsc 类型检查**）；新增/扩展 3 项测试：① 研究阶段的 Harness 请求携带 `role=research-stage-assistant` 且 `capabilities=['project.read']`；② prompt 断言**不再包含**那句被角色取代的文案；③ `POST /api/agent/run` 传未知角色时返回 **400 且响应体含角色名**——只有路由真的转发了 role 才会如此，以此证明透传链而非 prompt 文案 |

## Round 3 节奏映射（迭代 021–030）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 021 | 加 | **复杂矢量插画级绘图方案**（手写 SVG + Chrome 栅格化，4 张参考图） | ✅ |
| 022 | 减 | **删掉不可达的 skill 绑定与孤儿 skill `paper-screening`**（改标说明见下） | ✅ |
| 023 | 验证 | 验证 021–022 + **绘图产物可复现门禁** + 把结论回填 R-12/R-13 | ✅ |
| 024 | 加 | 产品侧 skill 补齐（5 → 8）+ 清理不可达阶段声明 + 技能集锁 | ✅ |
| 025 | 减 | 开发侧 playbook 落 `docs/agent-governance/playbooks/` + `.dsh/skills` 隔离门禁 | ✅ |
| 026 | 验证 | 验证 024–025：门禁 + 回归 + 边界自检 + 越界复查 | ✅ |
| 027 | 加 | **收口 C-07**：实现真正的人工确认 Patch 应用路径（文档承诺变成真的） | ✅ |
| 028 | 减 | 删死代码：零引用导出 9 → 2（含整个 `deepseekHarnessService.js`） | ✅ |
| 029 | 验证 | 验证 027–028：门禁 + 回归 + 边界自检 + 死代码复扫 | ✅ |
| 030 | 验证 | Round 3 收尾 + `rounds/round-03-comparison.md` + 推 scienceprism | ⬜ |

## Round 3 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 021 | 加 | **复杂矢量插画级绘图方案**（目标 ④，R-12/R-13）。新增 `scripts/build-diagrams.mjs`（零依赖 Node 脚本）：产出 4 张参考图 SVG，并用**本机已装的 Chrome headless** 栅格化为 PNG，全部落在 `docs/agent-governance/assets/diagrams/`。**基准按你的纠正设为细胞结构图**（不是线段方框）：细胞膜磷脂双分子层 + 核膜/核孔/核仁/染色质 + 3 个带嵴线粒体 + 粗面内质网/核糖体 + 高尔基体叠层 + 溶酶体 + 液泡 + 中心体 + 游离核糖体 + **12 个中文标注与引线**。产出 `drawing-comparison.md`（候选对比表含"是否经实际渲染验证"列、未验证项诚实清单、复现命令）。**过程中自查并修正两处**：① 我把探测文件写到了 `/tmp`（违反 U-02/U-03），已立即清理并复查无残留；② 生成器原放在被 gitignore 的 `tools/` 下会漏提交，已移到受跟踪的 `scripts/` | ① `node scripts/build-diagrams.mjs` 输出 4 张图全部 `rasterised=true`（SVG 3.6–19.4KB，PNG 29–321KB）。② **目视复核（`read_image`，不以 SVG 里有 `<text>` 为通过标准）**：中文无豆腐块、图形分层正确；发现并修掉"核仁/粗面内质网"标注重叠与中心体不明显两处后重渲染。③ `npm run quality` exit 0（78 项）。④ 诚实记录 5 项未验证：TikZ 版细胞图未渲染（需联网预热缓存）、matplotlib 版未渲染（需 venv）、Mermaid/D2/Graphviz 未安装、SVG→PDF 未做、CI 可复现门禁未做（留给 022） |
| 022 | 减 | **删掉一半不可达的 skill 绑定 + 一个孤儿 skill**。取证：`application.js` 只对 **4 个契约阶段**调用 `runResearchStage`（`search_strategy`/`innovation_ideas`/`method_proposals`/`writing`），归一化后是 `search`/`ideation`/`method`/`writing`；而 `DEFAULT_RESEARCH_SKILL_BINDINGS` 声明了 **8 个阶段**的绑定，其中 `direction`/`selection`/`replication`/`experiment` **永远不会被加载**。删除项：① 4 个死绑定键；② **`.dsh/skills/paper-screening/` 整个 skill**——它只绑在 `selection` 上，而筛选由确定性服务端质量门（C-06）决定、根本不跑 Harness，所以永远加载不到，且与代码已强制的门禁重复；③ `roles.js` 的 `allowedSkills` 与 3 处文档（`docs/research-skills.md`、`README.md`、`README_ZH.md`）同步。同时导出 `HARNESS_EXECUTED_STAGES` 与 `RESEARCH_SKILL_STAGE_ALIASES`，让门禁测试用模块自己的映射而不是重新推导 | `npm run quality` exit 0（81 项，78 → 81）；新增 `researchSkillReachability.test.js` **3 项不变量**：① 声明的可达阶段集合必须仍与 `application.js` 里 `runResearchStage` 的实际调用一致（新增/移除阶段会红）；② 任何绑定键都不得指向不跑 Harness 的阶段；③ **每个捆绑 skill 都必须能从某个会跑 Harness 的阶段到达**（`paper-screening` 会因此变红，从而强制删除）。`grep -rn paper-screening` 全仓仅剩 `docs/research-skills.md` 里那条**说明删除原因**的记录 |
| 023 | 验证 | 验证 021–022 + 把绘图产物接成**可复现门禁** + 回填 R-12/R-13 验收。① `scripts/build-diagrams.mjs` 改为导出 `FIGURES` / `buildSvg` / `OUTPUT_DIR`，且**只在直接执行时才跑 main**（导入无副作用）。② 新增 `diagramAssets.test.js` 3 项：**提交的 SVG 必须与生成器逐字节一致**、每张图有 PNG 且尺寸与 SVG 声明一致（PNG 不做逐字节比对——headless Chrome 版本差异会导致假红，已在注释里说明理由）、参考图集固定为 4 张。③ R-10/R-11/R-12/R-13 状态回填 | ① `npm run quality` **exit 0**（84 项，81 → 84）。② **门禁有效性实证**（不以"它绿了"为通过）：往 `module-graph.svg` 追加一行注释 → 门禁**变红**并报 `no longer matches the generator`；重跑生成器还原 → **恢复绿**。③ 生成器仍可独立执行（无副作用导入已验证） |
| 024 | 加 | **产品侧 skill 补齐**（目标 ③）：新增 **3 个 skill** —— `experiment-design-audit`（方法阶段：审批前审查基线/指标/消融/随机种子/成功标准）、`claim-evidence-audit`（写作阶段：把每条论断归类为 supported / needs-verification / unsupported）、`figure-table-plan`（写作阶段：规划图表，**把迭代 021 的零安装矢量路线写进 skill**，并要求"必须看栅格化产物，不能以源码里有 text 节点为通过"）。同时：① `dataset-audit` / `statistics-audit` 补上 `method` 阶段（原绑定的 `experiment` 不跑 Harness）；② 清理 4 个既有 skill frontmatter 里**不可达阶段的声明**；③ 绑定更新为 search→1、ideation→1、method→4、writing→5；④ `roles.js` 的 `research-stage-assistant.stageScope` 收窄为真正会执行的 4 个阶段并注明理由；⑤ `agent-roles.md` 的角色表**由注册表投影重新生成**（不再手改） | `npm run quality` exit 0（85 项，84 → 85）；`researchSkillReachability.test.js` 新增第 4 项**技能集锁**（增删 skill 必须是有意为之）；可达性三不变量继续通过；DSH 侧确认：3 个新 skill 已出现在会话可用技能目录中，`paper-screening` 已消失 |
| 025 | 减 | **开发侧资产与产品 skill 的根目录隔离**（目标 ③ 收尾）。问题：`.dsh/skills` 是**产品研究 skill 的源目录**（会被复制进 Harness 工作区），且加载器 `researchSkills.js:129` **静默丢弃**没有合法 `stages:` frontmatter 的目录——开发侧文档放进去会**无声消失**。处置：① 新建 `docs/agent-governance/playbooks/` 并写入 2 份 playbook：`adding-a-constraint.md`（把规则写进代码的 6 步流程 + 本轮真实出现的 6 种反模式）与 `verification-discipline.md`（门禁必须证明会红、边界自检、目视复核、何时不该做字节比对）；② **新增隔离门禁**：断言 `.dsh/skills` 下每个子目录都是有效产品 skill（即与加载器实际解析出的目录集合完全一致）；③ `AGENTS.md` 写入「Skill 与 playbook 的根目录分离」硬约束并把 playbook 加入迭代前必读；④ 顺手修正 AGENTS.md 两处过期引用（goal id 与轮次列表） | `npm run quality` exit 0（86 项，85 → 86）；**隔离门禁实证**：往 `.dsh/skills` 丢一个无 frontmatter 的 `dev-playbook/` → 门禁**变红**并报 `silently dropped`；删除后**恢复绿** |
| 026 | 验证 | 验证 024–025 两拍：全量门禁 + 回归对比 + 工作区边界自检 + 越界复查 | ① `npm run quality` **exit 0**（86 项 / 0 失败 / tsc / build）。② 回归：产品 skill **5 → 8**、绑定阶段 **8 → 4**（全部可达）、角色 8 个 / 12 个真实入口、测试 **81 → 86**。③ 边界：`package.json` / `package-lock.json` **零变更**；**越界复查通过**——工作区外**无**新目录（023 修的 `REPO_ROOT` 未再复发）。④ 本轮 6 条提交、33 个文件改动 |
| 027 | 加 | **收口 C-07：把"文档撒谎"变成真的**。C-07 声称"原项目只经显式 Patch 应用变更"，但**全仓库根本没有应用 Patch 的接口**，所以这半句只是"因为没实现而成立"。处置：实现 `applyHarnessRunPatches`（`services/harnessRuntime/index.js`）+ `POST /api/projects/:id/harness-runs/:runId/apply`，刻意做得**很窄**：① 必须**人工已接受**该 Run（否则 `409 PATCH_APPLICATION_REQUIRES_ACCEPTANCE`，拒绝态同样拒绝）；② 每个路径**在写入时按当前策略重新校验**（不是信任创建时的结论）→ `403 PATH_DENIED`；③ 同一 Patch **绝不应用两次**（`409 NO_PATCHES_TO_APPLY`）；④ Run 记录 `appliedPatches` / `patchApplication` 并追加 `patches.applied` 事件。注册表 C-07 的 `enforcement` 改指新 seam、`testRef` 指向新测试、**drift 归零**；`docs/project-constraints.md` 的 C-07 行同步（列出三条失败码） | `npm run quality` exit 0（90 项，86 → 90）；新增 4 项测试：① 未接受 → 拒绝且**项目文件保持 `old`**；② 接受 → 应用成功、文件变 `new`、记录 `appliedPatches` 与事件、**二次应用被拒**；③ **apply 时按当前策略复核**——创建时 `allowedPaths:['sections']` 允许该 patch，应用前收窄为 `['other']` → `PATH_DENIED` 且文件不变；④ 人工**拒绝**态同样无法应用。注册表投影：**漂移 5 → 4**（剩 C-04/C-09/C-10/C-11） |
| 028 | 减 | **删死代码：先取证再动手**。机械扫描后端每个导出符号的引用数，得到 **9 个零引用导出**；逐个核实后**删 7 留 2**。删除项：① **整个 `services/deepseekHarnessService.js`**（9 行兼容 shim，全仓无人引用该文件）；② `capabilities.js:assertToolCapability`（**死包装**——`harnessRuntime/index.js:84` 直接用 `capabilityForToolName`，审计早先说"tool-event 用 assertToolCapability"是**错的**）；③ `experimentRunner:activeExperimentRunCount`；④ `researchWorkflow/stageTask.js:stageTaskProjection`；⑤ `researchWorkflow/index.js` 的三个兼容别名 `createResearchWorkflow`/`readResearchWorkflow`/`patchResearchWorkflow`。**保留并加注释说明**的 2 个：`registerResearchSourceAdapter`（roadmap 第 267 行明确承诺"为后续 OpenAlex、Semantic Scholar、Crossref 留出 Seam"）与 `registerHarnessAdapter`（唯一能在不改本模块的前提下增删适配器/在测试中替换适配器的入口） | 删除前逐个 grep 核实、删除后复扫确认；净 **−29 行**（删 39 / 增 10，增的是给保留缝写的理由注释）；`npm run quality` exit 0（**90 项**，与删除前一致——证明删的确实是死代码而非被测试间接依赖）；复扫结果 **9 → 2**，且剩下 2 个都带"为什么保留"的注释 |
| 029 | 验证 | 验证 027–028 两拍：全量门禁 + 回归 + 工作区边界自检 + 死代码复扫 | ① `npm run quality` **exit 0**（90 项 / 0 失败 / tsc / build）。② 约束注册表：16 条 **16/16 有测试**、**漂移 4 条**（C-04/C-09/C-10/C-11）。③ 边界：`package.json` / `package-lock.json` **零变更**；越界复查通过（工作区外无新目录）。④ 死代码复扫：零引用导出 **9 → 2**，且 2 个都带保留理由注释。⑤ Round 3 至今 **44 个文件改动、9 条提交** |
| 023b | 修复 | **发现并修复一处我自己造成的越界写入**。把生成器从 `tools/diagram/` 移到 `scripts/` 时，`REPO_ROOT` 仍是 `../..`（对 `scripts/` 而言多了一级），于是脚本一直把图写到 **`/Users/icey/Desktop/project/prism-code/docs/…`（工作区外）**。更糟的是**门禁测试也跟着读那个错目录**，所以第一次"制造漂移"实验**假绿**——测试比对的是工作区外那份被重新生成的干净文件 | ① 已把 `REPO_ROOT` 改为 `..` 并在注释里写明这段历史；`OUTPUT_DIR` 现为 `<repo>/docs/agent-governance/assets/diagrams`（工区内）。② 重新执行"制造漂移 → 应变红 → 还原 → 应变绿"实验，**这次门禁正确变红**，证明修复到位。③ 越界目录 `/Users/icey/Desktop/project/prism-code/docs/` 创建于本会话 16:09（父目录 `prism-code/` 原本就存在），**内容全部是我生成的 4 张图**；按 U-02/U-03 我不得在工作区外删除，**已上报用户**；用户明确授权后已执行 `rm -rf /Users/icey/Desktop/project/prism-code/docs`，复查**已不存在**，父目录 `prism-code/`（`.DS_Store`/`.pnpm-store`/`OpenPrism`）完好，工区内 8 个产物文件不受影响 |

### 改标说明（诚实记录）

Round 3 节奏映射里 022 原写"绘图产物接可复现门禁"。实际执行时我在目标 ③ 方向先取证，发现**一半 skill 绑定是死配置 + 一个 skill 永远加载不到**——这是比绘图门禁更实的冗余，且属"减"拍的正当目标，因此把 022 改为删死配置，把绘图产物门禁并入 023（验证拍，那里天然适合加校验）。

## Round 4 节奏映射（迭代 031–040）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 031 | 加 | **收口 C-09**：网络 allowlist 由 fail-open 改为 fail-closed（代码与文档一致） | ✅ |
| 032 | 减 | 收口 C-11：不确定性收敛为**一条强制通道**（`unsupportedClaims` 必须点名 claim id） | ✅ |
| 033 | 验证 | 验证 031–032：门禁 + 回归 + 边界自检 + **运行时直证两处修复生效** | ✅ |
| 034 | 加 | 收口 C-10：Run 的 token 预算现在**传给每个适配器**（legacy 也生效） | ✅ |
| 035 | 减 | 收口 C-04：**删掉 `actor` 的 `'human'` 缺省**，决策必须显式声明身份 → **漂移全部清零** | ✅ |
| 036 | 验证 | 验证 034–035：门禁 + 回归 + 边界自检 + **漂移归零确认** | ✅ |
| 037 | 加 | **R-15 落地**：把"产出落 `aidoc/`"从**环境巧合**变成产品策略 + 注册约束 **C-17** | ✅ |
| 038 | 减 | 删 6 处无用导入 + 合并重复词表（重复组 8 → 5） | ✅ |
| 039 | 验证 | 验证 037–038：门禁 + 回归 + 边界自检 + 无用导入复扫（0） | ✅ |
| 040 | 验证 | Round 4 收尾 + `rounds/round-04-comparison.md` + 推 scienceprism | ⬜ |

## Round 4 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 031 | 加 | **收口 C-09，并发现一个真实的 fail-open**。原注册表把 C-09 记为"Harness 路径不查网络白名单"，但逐条读代码后**该说法会误导**：① legacy 适配器**根本不发工具事件**（只发 `adapter/started`/`assistant/message`/`turn/end`），所以工具事件缝只看到 deepseek 的事件；② deepseek 对 `research.search` **在启动前就 fail-closed**（`CAPABILITY_POLICY_UNENFORCEABLE`）；③ 唯一能联网的是 `agentService` 的两个 arXiv 工具，它们**先 `assertCapability` 再 `assertNetworkHost`** 才 `fetch`。**但顺着这条线查出一个真问题**：`assertNetworkHost` 在 `networkAllowlist` **为空时放行任意主机**（`if (allowlist.length && ...)`），而 `capabilityPrompt` 明确告诉模型 "Allowed network hosts: **none**" —— **代码 fail-open、文档说 fail-closed**。已改为 `if (!allowlist.includes(host))` 拒绝，并加注释写明这段历史；注册表 C-09 的 `enforcement` 改指 `assertNetworkHost`、`testRef` 指向新测试、**drift 归零**；`docs/project-constraints.md` 的 C-09 行写明"网络双重 fail-closed" | `npm run quality` exit 0（91 项，90 → 91）；新增 1 项测试覆盖 5 种情形：白名单内主机放行、白名单外拒绝、**空白名单拒绝任意主机**、缺 `research.search` 能力拒绝、非法 URL 拒绝；改动前确认**无任何测试依赖旧的 fail-open 行为**（`grep networkAllowlist apps/backend/test` 只有一处非空白名单用法）；注册表投影：**漂移 4 → 3**（剩 C-04/C-10/C-11） |
| 032 | 减 | **收口 C-11，并纠正一处"代码比文档更严"**。原注册表记为"不确定性字段全为可选、无代码要求"，但读代码后发现**方向反了**：`validateStageEvidence` 对**任何**非 supported 的 claim 一律报错——**即使模型已按契约把该 claim 写进 `unsupportedClaims`**。而 stage prompt 明确说"If support is missing, add the item to `unsupportedClaims` and keep the claim explicitly unverified"——**代码把契约允许的行为也拒了**。处置：把 `unsupportedClaims` 变成**唯一强制通道**——证据矩阵判定不 supported 的 claim，**只要被点名就接受**（不确定性显式化，正是 C-11 要的），**未点名则报 `UNSUPPORTED_CLAIM`/`EVIDENCE_REQUIRES_VERIFICATION`**；`caveats`/`limitations`/`missingMetadata` 保留为可选提示。配套：① `mentionsId` 用 id 字符集做边界，**`claim-1` 不会被 `claim-10` 冒充**；② writing_brief 契约新增一条说明，要求点名 claim id；③ C-11 从 `standard` 升为 **`core`**（它是 roadmap 明列的"总体不变量"之一），provenance 从 `ai-subjective` 改为 `adr`（ADR-0008 + roadmap 不变量），并注明**原字段集确为 AI 添加、现降为可选提示** | `npm run quality` exit 0（92 项，91 → 92）；新增 1 项测试覆盖 3 种情形：**点名则接受**、未点名则拒、**用 `claim-10` 冒充 `claim-1` 仍被拒**；改动前确认既有测试只覆盖"未声明"路径（`evidenceLedger.test.js:115`），不依赖被纠正的过严行为；注册表投影：**漂移 3 → 2**（剩 C-04/C-10）、**AI 主观添加 2 → 1**（只剩 C-16）、core 13 → 14 |
| 033 | 验证 | 验证 031–032 两拍：全量门禁 + 回归 + 工作区边界自检 + **运行时直证** | ① `npm run quality` **exit 0**（92 项 / 0 失败 / tsc / build）。② **运行时直证两处修复**（不只看测试绿）：直接调用 `assertNetworkHost({granted:['research.search'],networkAllowlist:[]}, 'https://anything.example/')` → 抛 `NETWORK_DENIED`，确认 fail-open 已消除。③ 约束注册表：16 条 **16/16 有测试**、**漂移 2 条**（C-04/C-10）、**AI 主观添加 1 条**（C-16）。④ 边界：`package.json` / `package-lock.json` **零变更**；越界复查通过 |
| 034 | 加 | **收口 C-10：Run 的 token 预算现在真的对 legacy 路径生效**。原漂移："token 预算只传给 DeepSeek SDK，legacy 适配器完全不接收 limits，等于无上限"。改动：① `harnessRuntime/index.js` 在调用 `adapter.run` 时新增 `limits: run.limits`（**每个适配器都拿到**，不再只有 SDK）；② `legacyAdapter` 接收并转发 `limits`；③ `agentService` 把模型构造抽成**可导出、可测**的 `buildToolAgentModel({ llmConfig, limits })`，在有预算时给 `ChatOpenAI` 传 `maxTokens`（无预算则用 provider 默认），`runToolAgent` 改用它并保留原有的 API key 早退检查。注册表 C-10 的 `enforcement` 改指该函数、`testRef` 指向新测试、**drift 归零**；`docs/project-constraints.md` 的 C-10 行写明"limits 传给每个适配器"与两条失败码 | `npm run quality` exit 0（94 项，92 → 94）；新增 2 项测试：① `buildToolAgentModel({limits:{maxTokens:1234}})` 的模型 `maxTokens === 1234`，无 limits 时为 `undefined`（用 provider 默认）；② **用迭代 028 特意保留的 `registerHarnessAdapter` 缝做探针**，影子掉 fake 适配器并捕获 `adapter.run` 的实参，断言 `limits.timeoutMs` 与 `limits.maxTokens` 都等于共享默认值，测试后把真适配器注册回去。注册表投影：**漂移 2 → 1**（只剩 C-04） |
| 035 | 减 | **收口 C-04：删掉"没人认领就当成人类"的缺省值 → 漂移全部清零**。原漂移："人工审批路径只是结构性的——`actor` 由调用方自报（`body.actor \|\| header \|\| collabAuth?.sub \|\| 'human'`），无法区分 AI 与人类。"**真正的缺陷在最后那个 `'human'` 缺省**：任何未表明身份的调用方（包括 AI 驱动的 API 调用）都会被审计轨迹记成"人类决策"，而这**没有任何人做过**。处置：① `actorFromRequest` **不再回退到 `'human'`**，无人认领时返回 `null`；② 新增并导出 `requireActor`，对 5 个决策路由（approve/reject/skip/recover/reset）强制要求身份——缺失报 `400 ACTOR_REQUIRED`，取值不在 `human`/`ai`/`system` 内报 `400 INVALID_ACTOR`（**防止 AI 被"手滑"标成人类**）；③ 前端 3 处决策调用**显式声明 `actor: 'human'`**（UI 上确实是人类点击），`client.ts` 的 `approveResearchWorkflow`/`resetResearchWorkflow` 把 actor 提为**类型必填**并抽出 `ResearchActor` 类型，避免未来调用者踩坑。注册表 C-04 的 `enforcement` 改指 `routes/researchWorkflow.js:requireActor`、`testRef` 指向新测试、**drift 归零**；`docs/project-constraints.md` 的 C-04 行写明两个失败码与"无人类缺省值" | `npm run quality` exit 0（95 项，94 → 95，**含前端 tsc**——前端改动必须过类型检查）；新增 1 项路由级测试覆盖 5 种情形：无 actor → `400 ACTOR_REQUIRED`、非法 actor（`'Human Being'`）→ `400 INVALID_ACTOR`、**被拒的决策不得改变任何状态**（`currentStage` 与 `version` 都不变）、显式 `actor:'human'` → 200 且**审计记录的正是 `human`**、`x-scienceprism-actor` 头作为替代途径可用。**注册表投影：漂移 9 → 5 → 4 → 3 → 2 → 1 → 0，16 条约束全部无漂移** |
| 036 | 验证 | 验证 034–035 两拍：全量门禁 + 回归 + 边界自检 + 漂移归零确认 | ① `npm run quality` **exit 0**（95 项 / 0 失败 / **前端 tsc** / build）。② **漂移归零确认**：约束注册表 16 条、**16/16 有测试、漂移 0**（Round 2 起点是 9 条）。③ **运行时直证 C-04**：`an approval decision must identify its actor` 单测通过（无 actor 必拒、非法 actor 必拒、被拒决策不改状态、显式 actor 被审计记录、header 途径可用）。④ 边界：`package.json` / `package-lock.json` **零变更**；越界复查通过 |
| 037 | 加 | **R-15 落地：把"产出落 aidoc/"从环境巧合变成产品策略**。取证发现**产品里根本没有 `aidoc` 概念**——`aidoc/` 之所以有东西，只是因为我跑驱动脚本时在 `.env` 里设了 `SCIENCEPRISM_DATA_DIR=<repo>/aidoc`，而 **`.env` 是 gitignored 的**：**新克隆跑一遍不会落到 `aidoc/`**。也就是说 R-15 与 C-07 同一类问题——**碰巧成立**。处置：① 新增产品模块 `services/researchWorkflow/documentLanding.js`，导出 `DOCUMENT_LANDING_DIR_NAME='aidoc'`、`resolveDocumentLandingDir(repoRoot,{override})`、`assertDocumentLandingPath(absolute, landingDir)`（越界抛错）；② 驱动脚本改为**钉住**落点（`resolveDocumentLandingDir(REPO_ROOT, { override: SCIENCEPRISM_AIDOC_DIR })` 并写回 `SCIENCEPRISM_DATA_DIR`），产出后调 `assertDocumentLandingPath` **越界即失败**，不再继承 `.env`；③ **注册约束 C-17**（tier `core`，`enforcement` 指向 `assertDocumentLandingPath`，**provenance = `context`（用户需求 R-15/U-21）**——这是第一条**来自用户要求**而非 AI 臆造的约束）；④ `docs/project-constraints.md` 增 C-17 行，R-15 在需求表标记完成 | `npm run quality` exit 0（99 项，95 → 99）；新增 `documentLanding.test.js` **4 项**：默认落点为 `<repo>/aidoc`、显式 override 生效、**产出路径越界（含 `docs/agent-governance/...` 与落点目录自身）必须抛错**、以及**源码扫描驱动脚本**——断言它用 `resolveDocumentLandingDir(REPO_ROOT…)` 钉住落点、产出后调用 `assertDocumentLandingPath`，且**不得出现从环境回退的写法**（防止有人改回 `.env` 依赖）。注册表投影：**17 条、17/17 有测试、漂移 0**；溯源 ADR 15 / context 1 / AI 主观 1 |
| 038 | 减 | **删无用导入 + 合并重复词表**（先取证，再动手）。取证三项：① **零引用源文件 0 个**（无死文件）；② **未使用具名导入 6 处**；③ **跨文件重复字面量集合 8 组**。处置：**删 6 处无用导入**（`analyzeSource.js` 的 `isTextFile`、`analyzeTarget.js` 的 `listFilesRecursive`、`applyTransfer.js` 的 `safeJoin`、`ProjectDashboardPage.tsx` 的 `useMemo`、`ProjectPage.tsx` 的 `FileArchive`、`TransferPanel.tsx` 的 `transferSubmitImages`——每处都先确认"全文件只出现在 import 行"）。**合并 3 组重复词表**：① 新增中立模块 `researchWorkflow/executedStages.js` 持有 `HARNESS_EXECUTED_STAGES`——它此前**同时**被 `researchSkills.js` 定义、被 `roles.js` 的 `stageScope` 复制（**这是我在迭代 024 自己制造的重复**），现由 `roles.js` 导入，`researchSkills.js` 转导出；放在 workflow 层而非让 `agentRoles` 反向依赖 `researchResearch`；② 证据词表（**16 种 kind + 8 种状态**）此前在 `evidenceLedger/schema.js` 导出、又在 `researchResearch/schemas.js` **逐字内联**，现改为导入 `EVIDENCE_KINDS` / `VERIFICATION_STATUSES` | 删除前后均复扫确认；**重复组 8 → 5**（其余 5 组为低价值：敏感目录表、论文元数据字段、run 状态跨 3 模块、真值集合）；`npm run quality` exit 0（**99 项**，与改动前一致——证明删的是真死代码、合并的是等价词表而非行为变更）；合并前先确认 `evidenceLedger` 不 import `researchResearch`、`researchSkills` 不 import `agentRoles`（**无循环依赖**） |
| 039 | 验证 | 验证 037–038 两拍：全量门禁 + 回归 + 边界自检 + 无用导入复扫 | ① `npm run quality` **exit 0**（99 项 / 0 失败 / tsc / build）。② 约束注册表：**17 条、17/17 有测试、漂移 0**、core 15。③ **落点仍正确**：`resolveDocumentLandingDir(<repo>)` = `<repo>/aidoc`。④ **无用导入复扫 0**（原 6）。⑤ 边界：`package.json` / `package-lock.json` **零变更**；越界复查通过 |

## Round 5 节奏映射（迭代 041–050）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 041 | 加 | **角色可见性**：新增 `GET /api/agent/roles`，前端在阶段侧栏展示运行角色/权限/能力/Skill | ✅ |
| 042 | 减 | 消除前端 `ResearchStageId` 双词汇（**两处独立字面量列表 → 单一共享定义**） | ✅ |
| 043 | 验证 | 验证 041–042：门禁 + 回归 + 边界自检（含 /tmp）+ 词汇单一来源确认 | ✅ |
| 044 | 加 | **失败重试回灌**：契约校验失败时把错误回喂模型重试一次（严格串行、有界、可审计） | ✅ |
| 045 | 减 | 删掉敏感目录表的第二份拷贝（该表若漂移会直接影响隔离安全） | ✅ |
| 046 | 验证 | 验证 044–045：门禁 + 回归 + 边界自检 + 隔离行为实证 | ✅ |
| 047 | 加 | **`project-constraints.md` 整表由注册表生成**（末个人工维护面消失，门禁比对整表而非仅 id 集合） | ✅ |
| 048 | 减 | “什么算已结束的 Run”从 **4 处调用点**收敛为 1 个常量（并判定 taskCenter 那处不该合并） | ✅ |
| 049 | 验证 | 验证 047–048：门禁 + 回归 + 边界自检 + 表格生成性与单一定义确认 | ✅ |
| 050 | 验证 | Round 5 收尾 + `rounds/round-05-comparison.md` + 推 scienceprism | ⬜ |

## Round 5 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 041 | 加 | **角色可见性（用户选定的方向）**。取证：角色注册表自迭代 018 起**只存在于服务层**，前端完全看不到"谁将代表我行动"。处置：① 新增 `GET /api/agent/roles?stage=`，返回 `catalog` 与**投影后的角色列表**（id / purpose / authority / capabilities / skills / forbiddenActions / stageScope）；② `client.ts` 新增 `getAgentRoles` 与 `AgentRoleSummary` 类型；③ `ResearchWorkspacePage` 按当前阶段拉取；④ `ResearchStageLayout` 侧栏新增「RUNNING ROLE」面板，**列出该阶段全部适用角色**（不硬编码角色 id）并注明"角色只能收窄权限、审批仍由人工完成"；⑤ `research.css` 配套样式。**过程中发现两处**：① **前端存在两套 `ResearchStageId` 词汇**——UI 用 `innovation`、`client.ts` 用 `ideation`，二者**并不相同**（tsc 直接报错暴露），已在调用处用既有的 `toHarnessResearchStage` 转换，并在 `client.ts` 注释里记下这处重复待清理（→ 042 拍）；② **我又把命令输出写到了 `/tmp/q.txt`**（违反写入边界），已删除并复查 `/tmp` 无残留 | `npm run quality` exit 0（**100 项**，99 → 100，含前端 tsc 与 build）；新增 1 项路由测试：全量返回 8 个角色、`?stage=writing` 收窄到 2 个且都含 `writing`、投影携带 authority/capabilities/skills/forbiddenActions、**未知阶段返回空数组而非全量**；**端到端实跑**路由：`writing` 返回 `paper-reviewer`(1 skill) 与 `research-stage-assistant`(8 skill)，能力均为 `project.read` |
| 042 | 减 | **消除前端 `ResearchStageId` 双词汇**（041 拍发现的问题）。取证：**两个文件各自定义了一份同名的字面量列表**——`app/research/researchStages.ts` 用 `innovation`，`api/client.ts` 用 `ideation`，**两份内容不同**。这不是命名差异而是**两套并行词汇**：把 UI 的阶段值传给 API 函数**无法通过类型检查**，而报错信息完全看不出"存在两套词汇"。处置：① 新建中立共享模块 `apps/frontend/src/researchStageIds.ts` 持有两个类型（`ResearchStageId` / `HarnessResearchStageId`），**名字本身表明属于哪套词汇**；② `researchStages.ts` 改为**转导出**（现有 13 个导入方无需改动）；③ `client.ts` **删掉本地定义**，内部 **16 处**改用 `HarnessResearchStageId`；④ `workflowAdapter.ts` 的 re-export 改指共享模块。**为何放中立模块**：先确认 `api/` 层**没有任何** import `app/` 层的先例，直接让 client 依赖 app 会**反转分层**，所以词汇下沉到共享模块 | `npm run quality` exit 0（**103 项**，100 → 103，含前端 tsc 与 build）；**词汇定义处从 2 个文件收敛到 1 个**；新增 `frontendVocabulary.test.js` **3 项不变量**：① 两个类型在全前端**各只能有一处定义**、且必须在共享模块；② 两套词汇**只在创新阶段不同**（`innovation` ↔ `ideation`）且 `toHarnessResearchStage`/`fromHarnessResearchStage` **往返可逆**；③ **`api/` 层不得 import `app/` 层**（锁住分层）。**门禁实证**：往 `client.ts` 追加一行重复的 `export type ResearchStageId` → 门禁**变红**并报 `must be declared once`；还原后**恢复绿**，且工作区无临时文件残留 |

| 043 | 验证 | 验证 041–042 两拍：全量门禁 + 回归 + 工作区边界自检（含 /tmp）+ 词汇单一来源确认 | ① `npm run quality` **exit 0**（103 项 / 0 失败 / 前端 tsc / build）。② **词汇单一来源确认**：前端仅 **1 个文件**定义两个阶段类型（原为 2 个文件各自的字面量列表）。③ **角色路由在 harness 词汇下仍可用**：`?stage=ideation` 返回 `research-stage-assistant`（200）。④ 边界：`package.json` / `package-lock.json` **零变更**；**工作区外无目录**；**/tmp 无我的残留**（041 拍的 `/tmp/q.txt` 已清除且复查） |

| 044 | 加 | **失败重试回灌（校验错误回喂模型）**。此前模型输出一旦不合契约就**直接失败**，模型永远不知道被拒的原因——真实跑通过程中这类失败出现过多次（字段名不全、sources 填成场馆名、id 含非法字符）。处置：① `buildResearchHarnessPrompt` 新增 `repair` 参数，把上次被拒原因写进 prompt；② 新增 `validationRepairInstructions(validation)` 把校验错误**逐条引用**回喂（最多 10 条），并重申"不要臆造 Evidence id"；③ `runResearchHarnessStage` 抽出单次尝试，失败后**重试一次**，返回 `attempts` 记录每次的 ok / runId / errorCodes；④ 新增 `MAX_VALIDATION_ATTEMPTS = 2`。**三条边界**：**只重试校验失败**（传输失败属 Run limit 职责，不在此重试）、**严格串行**（U-20：重试是 await 的，绝不与首次并发）、**有界**（最多 2 次尝试，不会循环） | `npm run quality` exit 0（**106 项**，103 → 106，含前端 tsc 与 build）；新增 3 项测试：① **先错后对**——第一次缺字段被拒、第二次按修复指令补全 → 接受，且**第二个 prompt 必须包含 "Your previous reply was rejected" 与被拒字段名**，`attempts` 两次记录为 [false, true]；② **连错两次**——只调用 **2 次**（不是 3 次）且 `attempts` 两次均为 false；③ **传输失败不重试**——`ok:false` 的 Run 只调用 **1 次**。C-05 文档行同步写明"一次修复尝试 + attempts 记录" |

| 045 | 减 | **删掉敏感目录表的第二份拷贝**。取证：`capabilities.js` 的 `SENSITIVE_DIRECTORIES` 与 `harnessRuntime/index.js` 的 `IGNORED_DIRS` 是**同一份 6 个目录名**（`.git` / `.scienceprism` / `.openprism` / `.agent_runs` / `.cache` / `node_modules`）。这组重复**比其他几组更危险**：它决定哪些目录不进入 Harness 工作区、不进入 Context Pack——两份一旦漂移，就会出现"被 `isSensitivePath` 拦住、却被另一处放行"的缝隙。**删除的安全性依据**：① `IGNORED_DIRS` 全仓只有 **2 个使用点**，**两处都已同时调用 `isSensitivePath`**；② 实测 `isSensitivePath` 对 6 个目录名的**裸名、子路径、目录内文件**三种形态全部返回 true。故删除是**行为等价**的 | `npm run quality` exit 0（**107 项**，106 → 107，**与删除前测试数一致**——证明是等价删除而非行为变更）；**跨文件重复字面量组 5 → 4**；新增 1 项门禁：① `harnessRuntime/index.js` **不得再出现 `IGNORED_DIRS`**（源码扫描）；② `isSensitivePath` 必须覆盖 6 个目录的三种形态；③ **普通项目文件（`main.tex`、`sections/method.tex`）不得被该过滤器误伤** |
| 046 | 验证 | 验证 044–045 两拍：全量门禁 + 回归 + 工作区边界自检 + **隔离行为实证** | ① `npm run quality` **exit 0**（107 项 / 0 失败 / 前端 tsc / build）。② 约束注册表：**17 条、17/17 有测试、漂移 0**。③ **隔离行为实证**（不只看测试绿）：删除 `IGNORED_DIRS` 后直接调用 `isSensitivePath('.git')=true`、`isSensitivePath('.env')=true`、`isSensitivePath('main.tex')=false`；`isPathAllowed('main.tex', 默认策略)=true`、`isPathAllowed('.env', 默认策略)=false`——**敏感文件仍被拦、普通文件仍放行**。④ 边界：`package.json` / `package-lock.json` **零变更**；工作区外无目录；`/tmp` 无我的残留 |
| 047 | 加 | **`project-constraints.md` 整表改为由注册表生成**——这是**最后一个人工维护的约束面**。取证：文档表格有 6 列（ID / Constraint / **Module** / **Validation location** / **Failure behaviour** / State），而注册表只有 5 个字段，**缺 Module 与 Failure behaviour**，所以此前只能用门禁比对 **id 集合**——行内的失败行为写错了也查不出来。处置：① 把文档现有数据**程序化提取**并注入注册表，为 17 条各补 `module` / `failure` / `validationLocation` 三个字段（`validationLocation` 保留原文散文，`enforcement` 仍是机器校验的指针）；② 新增 `renderConstraintTable()` 按文档自身的列渲染；③ 用渲染结果**重新生成**文档表格；④ 文档顶部写明"此表为生成物，请改注册表"；⑤ 门禁从"比对 id 集合"升级为**比对整张表**，并在注册表 well-formed 测试里要求三个新字段存在 | `npm run quality` exit 0（**108 项**，107 → 108，含前端 tsc 与 build）；**门禁实证**：手动往 C-01 行插入 `TAMPERED` → 门禁**变红**并报 `differs from the registry projection; regenerate it instead of editing it by hand`；还原 → **恢复绿**，无临时文件残留；实测"提交表格 == 渲染结果: **true**" |
| 048 | 减 | **"什么算已结束的 Harness Run"从 4 处调用点收敛为 1 个常量**。取证：`['completed','failed','cancelled']` 在 **2 个模块的 4 个调用点**重复出现（`harnessRuntime` 的取消与人工决定各 1 处、`observability` 的时长计算与汇总过滤各 1 处）。语义是同一个："Run 是否已结束"。**漂移后果具体**：新增一个终止状态（如 `timed_out`）时必须找齐 4 处，漏掉一处就会让**已结束的 Run 在运行中心永远显示为进行中**，或让 `decideHarnessRun` **拒绝一个早已结束的 Run**。处置：导出 `TERMINAL_HARNESS_RUN_STATUSES`，4 处改为引用。**关键判断：第 5 处不该合并**——`taskCenter.js:33` 的同一字面量属于 **task 词汇**（`TASK_STATUSES` 还含 `queued`/`rejected`），"任务结束"与"Run 结束"**不是同一概念，只是字符串巧合**；强行合并会在两者语义分岔时埋雷，故保留并**加注释说明为何不合并** | `npm run quality` exit 0（**109 项**，108 → 109，含前端 tsc 与 build）；新增 1 项门禁：① 常量内容必须是这 3 个值；② **源码扫描** `harnessRuntime/index.js` 里该字面量**只能出现 1 次**（定义处）、`observability/index.js` **必须 0 次**；③ 断言 `taskCenter` 仍持有自己的 `TASK_STATUSES`（防止被"顺手合并"）。**诚实说明**：朴素扫描的"重复组数"仍是 4（定义处 + taskCenter 有意保留被算作一组），**真正的改善是调用点 4 → 1**，由门禁锁住 |
| 049 | 验证 | 验证 047–048 两拍：全量门禁 + 回归 + 工作区边界自检 + 表格生成性与单一定义确认 | ① `npm run quality` **exit 0**（109 项 / 0 失败 / 前端 tsc / build）。② 约束注册表：**17 条、17/17 有测试、漂移 0**。③ **表格生成性实测**：`docs/project-constraints.md` 的表格 == `renderConstraintTable()` → **true**。④ **终止状态单一定义**：`TERMINAL_HARNESS_RUN_STATUSES` 在 `harnessRuntime` 与 `observability` 各引用 3 次、字面量仅存在于定义处。⑤ 边界：`package.json` / `package-lock.json` **零变更**；工作区外无目录；`/tmp` 无我的残留 |

## Round 6 逐拍记录

| 064 | 验证 | 验证 063 的去重：全量门禁 + 回归 + 边界 + 交付数据完整性 | ① `npm run quality` **exit 0**（114 项 / 图 6 张 0 缺陷）。② 依赖 **零变更**。③ 工作区外 **无残留**。④ **交付数据完整性**：`experiment-cot-gsm8k.json` = **600 条 / 200 题**（冒烟覆盖后已恢复并复核）。⑤ 论文结构检查 `structure ok`。逐文件 diff 复核：6 个脚本各仅 `+2 / −16~25`，**无附带损伤** |

## Round 6 逐拍记录

| 063 | 减 | **用安全方式重做：`loadDotEnv` 从 6 份收敛为 1 个共享模块** | 新增 `scripts/lib/script-helpers.mjs`（含 `loadDotEnv`/`hash`/`sampleByHash`）。**改用精确字符串匹配**逐文件替换（一次一个文件，每次 `node --check` 验证），**未再出现批量正则的附带损伤**——逐文件 diff 仅 `+2 行 import / −16~25 行函数体，无常量或 import 被误删。门禁 **114 项全绿**、6 张图 0 缺陷。**过程中一次真实事故**：为验证脚本能跑，我用 2 题冒烟运行，**覆盖了 600 条真实实验数据**（`experiment-cot-gsm8k.json`），已从 git 恢复——也正因如此，"可复现"门禁当时变红，**证明了它在守护数据集**。教训已写入 playbook：验证脚本时不要实跑会写覆盖交付数据的脚本，改用语法检查 + 门禁 |

## Round 6 逐拍记录

| 062 | 减 | **尝试消除 `loadDotEnv` 在 6 个脚本中的重复——失败并回滚**，转而加强拦住它的门禁 | 重复属实（约 90 行），但我用**一条正则跨文件批量替换**，正则过贪，**连带删掉常量、import 与整个函数体**：`render-brief-pdf.mjs` 丢 `projectId`/`projectRoot`/`briefPath`/`absoluteTex`/`log`；`experiment-evidence-gate.mjs` 丢全部 import 与实验常量（脚本当场跑不起来）。**已全量回滚 `scripts/`**，未提交损坏代码。真实收获是门禁：原 `documentLanding.test.js` **只扫一个 driver**，故 `render-brief-pdf.mjs` 的同类损伤未被第一时间发现 → **已扩展为扫两个 driver**，且断言改为"不依赖各 driver 变量名的共享不变量"。playbook 新增"禁止一条正则跨文件批量重构" |

## Round 6 逐拍记录

| 061 | 加 | **论文结构门禁**：把"图和论文没关系 / 没有结果图"这两次真实失败变成可执行的规则 | 新增 `scripts/check-paper-structure.mjs`；五条规则（须有 Results 章节 / Results 须含图 / 至少一张图来自实验数据 / 不得有"自认无关"的插图附录 / 每张图须有图题）。抽 `scripts/figure-inventory.mjs` 作共享清单，避免门禁与结构检查对"哪些图来自数据"判断不一致。**两次破坏实验验证**：删掉 Results → 报"no Results section"；把结果图换成 Illustrative Figures 附录 → **同时命中 4 条**（含本轮真实发生过的那条）。已接入 `npm test`（113 → 114） |

## Round 6 逐拍记录（051–060）

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 050 | 验证 | Round 5 收尾：对比文档 + tag | 五份对比文档齐备；tag `round-05-complete`；分支 `feat/agent-governance-r5` 推 `scienceprism` |
| 051 | 加 | **整理项目 + 修复我把 `pic/`（149MB）误提交的越界事故** | 我在用户明确说"不用入库"后，用 `git add -A` 把 498 个文件扫进提交。重做 7 个**未推送**的本地提交（保留原信息、剔除 pic，与备份分支差异仅 `.gitignore` +6 行）；加 `.gitignore` 防复发（**根因**：未跟踪且未 ignore 的目录）；`.git` **153M → 39M**；`pic/` 0 个已跟踪 / 498 文件仍在磁盘 |
| 052 | 加 | 用项目做**变异测试实验**（软件工程方向，后被用户改方向） | 真代码、真缺陷、真测试；冒烟 2 killed / 3 survived。**强杀时留下一个变异体在源码里**，用 git 还原并验证树干净——这个风险我提前设计了守卫，也确实发生了 |
| 053 | 加 | **换 AI 方向**：GSM8K 上的思维链消融（数据集/参考论文自找） | GSM8K 测试集 1319 题（自下载）；参考论文用 **arXiv API 核实**（非记忆）：Wei 2201.11903、Wang 2203.11171、Kojima 2205.11916、DeepSeek-R1 2501.12948、GSM8K 2110.14168 |
| 054 | 加 | 跑实验：**600 次真实生成**（3 条件 × 200 题，temperature 0，严格串行） | CoT 增益**恰好为 0**（0.955 vs 0.955，不一致仅 2/200）；强制格式 **−0.01** 且慢 28%；**96% 结果与条件无关**（188 全对 / 8 全错 / 4 不一致）；**隐藏推理比可见答案更不准**（25 vs 1）；**exact-match 低估 1.0 个百分点**（`12` vs `12.00`） |
| 055 | 加 | 结果图 + 记入证据账本 + 用项目写作阶段产出论文 | 三面板结果图；实验与 5 篇参考文献记为 Evidence；论文 5 页。**发现产品缺陷**：`handoff-writing` 输入**不含证据账本**，导致论文无法引用自己跑出的实验结果 —— 已修（模型随即正确指出实验条目是 `pending` 而非 confirmed） |
| 056 | 减 | 论文删掉无关配图，补上**自己的结果图** | 原附录 4 张图与论文无关（附录自认）；改为只收录结果图 + 被研究的系统图。图件目录拷贝前清空，避免旧图残留 |
| 057 | 验证 | **图全英文 + 不单调**（用户批评后重做） | 论文英文而图中中文 → 全部改英文；三柱状图 → **置信区间哑铃图 + 两个 2×2 列联矩阵 + 结论直接标注**。布局检查第一次**没通过**（刻度与图例重叠、脚注越界），已修，现 0 重叠 0 越界 |
| 058 | 加 | **内置"图必须数据现算 + 可复现 + 布局干净"三条门禁** | 生成器可注入数据/输出路径；扰动数据验证"图真的读数据"（**只比对真实数据证明不了这点**：写死的数字在一致数据下照样通过）。**两次破坏实验验证**：注入重叠标签 → 挂 2 项；硬编码数字 → 只挂"数据现算"那一项 |

> **如实说明**：Round 6 的"加 / 减 / 验证"三拍节奏**被打断了两次**——用户先要求"整理项目"，中途又要求"换人工智能方向"。所以 051–058 不是严格的三拍循环，而是按用户当次指令推进的。**没有为了凑节奏而伪造拍型。**

## 本地质量整合（迭代 065）

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 065 | 验证与修复 | 以个人本地使用为范围复核项目流程：修复项目/模板标识和符号链接可导致的目录越界、阻止文件接口删除项目根目录；修正概览尚无 Harness 运行却声称 AI 输出完成的提示；将自洽性实验未完成记录移到 `.cache/` 检查点；只补 CoT 实验 `format#173` 的 HTTP 502，保留原错误审计信息并从完整原始记录重算分析、图和论文。补测回答错误，准确率不变，解析失败 2 → 1。 | 完整性门禁在补测前因 HTTP 502 确实变红、补测后转绿；`npm run quality` exit 0（126 项测试、类型检查、构建、6 图 0 布局缺陷）；Codex 内置浏览器走通创建项目、初始化、概览、编辑器并复核提示；`tectonic main.tex` exit 0；`git diff --check` exit 0。40 题 × 3 次采样的自洽性实验仍有部分请求未完成，已有记录保存在仓库内 `.cache/`。 |

## 环境变化记录

- 本会话文件策略从 `workspace-write` 变为 `danger-full-access`，外层沙箱撤掉后 `/usr/bin/sandbox-exec` 恢复可用（exit 0），基线 4 个红测试**在无代码改动时即转绿**。迭代 002 的价值因此改为：让 Runner 在 OS 沙箱**不可用**的环境（容器 / CI / 嵌套沙箱）仍能执行，并记录实际使用的隔离方式。
- 本机 LLM 网关 `127.0.0.1:7864` 与 DSH 会话**共享并发**（U-20）；模型选用免费的 `global:deepseek-v4.1-flash`（**不用** `-sg` 变体）。该模型是推理模型，max_tokens 给小了会返回空内容。
