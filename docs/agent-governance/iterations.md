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
| 029 | 验证 | 验证 027–028 | ⬜ |
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
| 023b | 修复 | **发现并修复一处我自己造成的越界写入**。把生成器从 `tools/diagram/` 移到 `scripts/` 时，`REPO_ROOT` 仍是 `../..`（对 `scripts/` 而言多了一级），于是脚本一直把图写到 **`/Users/icey/Desktop/project/prism-code/docs/…`（工作区外）**。更糟的是**门禁测试也跟着读那个错目录**，所以第一次"制造漂移"实验**假绿**——测试比对的是工作区外那份被重新生成的干净文件 | ① 已把 `REPO_ROOT` 改为 `..` 并在注释里写明这段历史；`OUTPUT_DIR` 现为 `<repo>/docs/agent-governance/assets/diagrams`（工区内）。② 重新执行"制造漂移 → 应变红 → 还原 → 应变绿"实验，**这次门禁正确变红**，证明修复到位。③ 越界目录 `/Users/icey/Desktop/project/prism-code/docs/` 创建于本会话 16:09（父目录 `prism-code/` 原本就存在），**内容全部是我生成的 4 张图**；按 U-02/U-03 我不得在工作区外删除，**已上报用户**；用户明确授权后已执行 `rm -rf /Users/icey/Desktop/project/prism-code/docs`，复查**已不存在**，父目录 `prism-code/`（`.DS_Store`/`.pnpm-store`/`OpenPrism`）完好，工区内 8 个产物文件不受影响 |

### 改标说明（诚实记录）

Round 3 节奏映射里 022 原写"绘图产物接可复现门禁"。实际执行时我在目标 ③ 方向先取证，发现**一半 skill 绑定是死配置 + 一个 skill 永远加载不到**——这是比绘图门禁更实的冗余，且属"减"拍的正当目标，因此把 022 改为删死配置，把绘图产物门禁并入 023（验证拍，那里天然适合加校验）。

## 环境变化记录

- 本会话文件策略从 `workspace-write` 变为 `danger-full-access`，外层沙箱撤掉后 `/usr/bin/sandbox-exec` 恢复可用（exit 0），基线 4 个红测试**在无代码改动时即转绿**。迭代 002 的价值因此改为：让 Runner 在 OS 沙箱**不可用**的环境（容器 / CI / 嵌套沙箱）仍能执行，并记录实际使用的隔离方式。
- 本机 LLM 网关 `127.0.0.1:7864` 与 DSH 会话**共享并发**（U-20）；模型选用免费的 `global:deepseek-v4.1-flash`（**不用** `-sg` 变体）。该模型是推理模型，max_tokens 给小了会返回空内容。
