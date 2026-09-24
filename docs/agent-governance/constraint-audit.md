# 约束审计（C-01 … C-16）

> 本文件是 I-03 的交付物，数据由 `constraintRegistry` **机器投影**生成，不是手抄。
> 复现：`node -e "import('./apps/backend/src/services/constraintRegistry/index.js').then(m=>console.log(JSON.stringify(m.constraintCatalog(),null,2)))"`

## 1. 摘要

| 维度 | 结果 |
| --- | --- |
| 约束总数 | **16** |
| 分层 | `core` **13** ｜ `standard` **3** ｜ `experimental` **0** |
| 有测试 | **14** |
| **无测试** | **2**（C-01、C-10，已锁进 `UNTESTED_CONSTRAINTS`，新增缺口会让门禁变红） |
| **文档与代码不一致（漂移）** | **9**（C-01、C-04、C-07、C-08、C-09、C-10、C-11、C-12、C-16） |
| 可追溯到 ADR | 14 |
| **疑似 AI 主观添加** | **2**（C-11 字段集、C-16 Feature Flag） |

**没有任何一条约束指向不存在的 seam**：注册表里 16 条的 `module:symbol` 全部经动态 import 验证真实导出（见 `constraintRegistry.test.js`）。

## 2. 全表（机器生成）

| ID | Constraint | Tier | Enforced at | Test | Provenance | Drift |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | Every workflow operation is scoped to an existing Project and its project-local storage. | core | `services/projectService.js:getProjectRoot` | **none** | adr:ADR-0003 | **yes** |
| C-02 | Only the current Research Stage can be changed or approved. | core | `services/researchWorkflow/stateMachine.js:applyStageUpdate` | `researchWorkflow.test.js` | adr:ADR-0002 | — |
| C-03 | A stage cannot be approved without data satisfying its readiness requirement. | core | `services/researchWorkflow/stageContracts.js:getStageReadiness` | `researchWorkflow.test.js` | adr:ADR-0002 | — |
| C-04 | AI output cannot approve a stage, select a paper, choose an innovation, authorize an experiment, or submit a final claim. | core | `services/researchWorkflow/commands.js:approveResearchWorkflow` | `researchStageSlice.test.js` | adr:ADR-0002 | **yes** |
| C-05 | Structured Harness output must validate against the named stage contract before it is treated as usable output. | core | `services/researchResearch/schemas.js:parseResearchStageOutput` | `phase10.test.js` | adr:ADR-0005 | — |
| C-06 | A Paper Candidate is selectable only when the server-side quality gate returns accept. | core | `services/researchResearch/qualityGate.js:applyQualityGate` | `phase10.test.js` | adr:ADR-0002 | — |
| C-07 | Harness work runs in a temporary, physically filtered project copy; original files change only through an explicit Patch application. | core | `services/harnessRuntime/index.js:startHarnessRun` | `harnessRuntime.test.js` | adr:ADR-0001 | **yes** |
| C-08 | Shell and experiment execution require an explicit capability and a human Run approval. | core | `services/researchWorkflow/application.js:runUiAction` | `experimentRunner.test.js` | adr:ADR-0004 | **yes** |
| C-09 | File scope, sensitive-file filtering, network access, and tool capabilities are denied unless granted and enforceable. | core | `services/harnessRuntime/capabilities.js:assertCapability` | `phase10.test.js` | adr:ADR-0006 | **yes** |
| C-10 | Each Harness Run is bounded by a timeout and a token budget. | standard | `services/harnessRuntime/index.js:createHarnessRun` | **none** | adr:ADR-0006 | **yes** |
| C-11 | Unknown metadata, unsupported results, and missing evidence must remain explicitly uncertain. | standard | `services/researchResearch/schemas.js:validateResearchStageOutput` | `evidenceLedger.test.js` | **ai-subjective** | **yes** |
| C-12 | Every Paper Claim must link to Evidence before it can be treated as a confirmed writing output. | core | `services/evidenceLedger/index.js:validateStageEvidence` | `evidenceLedger.test.js` | adr:ADR-0008 | **yes** |
| C-13 | Every successful workflow mutation is versioned and auditable. | core | `services/researchWorkflow/audit.js:appendAudit` | `researchWorkflow.test.js` | adr:ADR-0003 | — |
| C-14 | Every Experiment Run must be reproducible to code, dataset, environment, parameters, seed, resources, and success criteria. | core | `services/experimentRunner/manifest.js:buildExperimentManifest` | `experimentRunner.test.js` | adr:ADR-0009 | — |
| C-15 | Experiment results, Artifacts, and interpretations remain traceable and uncertain until human verification. | core | `services/experimentRunner/index.js:recordExperimentInterpretation` | `experimentRunner.test.js` | adr:ADR-0009 | — |
| C-16 | Experiment execution and advanced Harness adapters are rollout-controlled and cannot run when their Feature Flag is disabled. | standard | `services/featureFlags.js:assertFeatureEnabled` | `phase10.test.js` | **ai-subjective** | **yes** |

## 3. 漂移清单（9 条，文档承诺 > 代码实现）

| ID | 文档说 | 代码实际 |
| --- | --- | --- |
| **C-01** | 验证位置是 `pathUtils.js:safeJoin` | 四个项目存储全用 `path.join`；真正守卫是 `assertProjectId` + `getProjectRoot`。`safeJoin` 只服务文件路由 |
| **C-04** | "决策仍需人工审批路径" | 只是结构性的：`actor` 由调用方自报（`routes/researchWorkflow.js:27`），缺省即 `'human'`，没有任何东西区分 AI 与人类 |
| **C-07** | "原项目只通过显式 Patch 应用变更" | **全仓库没有 Patch 应用接口**，所以后半句只是"因为没实现而成立" |
| **C-08** | "Shell 和实验执行**默认关闭**" | `featureFlags.js` 默认 `experimentExecution: true` / `advancedHarness: true`。真正的控制是能力 + 审批，不是默认关 |
| **C-09** | 网络白名单由"Runtime tool-event 检查"约束 | `assertNetworkHost` 存在且被 `agentService.js:122,156` 调用，但 **Harness 路径从不调用**，网络白名单在那条路上不生效 |
| **C-10** | 每次 Run 受超时与 token 预算约束 | token 预算只传给 DeepSeek SDK；legacy adapter 完全不接收 limits，且没有累计预算 |
| **C-11** | 不确定性字段必须存在 | 这些字段多为 `.default([])` 可选，**没有任何代码要求它们** |
| **C-12** | 主张必须挂证据才能成为确认产出 | 证据门在 Harness adapter 里，不在写作阶段的 readiness 检查里 → **直接 PATCH 可绕过** |
| **C-16** | "advanced Harness **adapters**"（复数）受 flag 控制 | 只对 `adapter === 'deepseek'` 生效；legacy adapter 不受控 |

## 4. 只在 prompt 里生效的"伪约束"

这些规则写在提示词或前端文案里，**代码不拦**——正是「约束应该写进代码而不是 agent 本身」要解决的问题：

| 位置 | 文案 | 代码边界 |
| --- | --- | --- |
| `researchResearch/harnessAdapter.js:32` | "The human owns the research direction, paper selection, …" | 无：调用方身份无法验证（见 C-04） |
| `harnessAdapter.js:33` | "Provide analysis and structured suggestions only." | 无 |
| `harnessAdapter.js:34` | "Never claim that an unverified metadata field … is verified." | 无：元数据"验证"只是完整性检查 |
| `harnessAdapter.js:36` | 缺失支持要写进 `unsupportedClaims` | 无：从不与主张-证据矩阵交叉校验 |
| `harnessRuntime/capabilities.js:172` | "File changes must remain proposed Patches…" | 无应用接口，故恒真 |
| `EditorPage.tsx:4493` | 同行评审"do not propose patches or code" | **无**：走 `mode:'tools'`，`patch.propose` 照样授予 |
| 前端 `SelectionStage.tsx:78`、`ExperimentStage.tsx:43`、`WritingStage.tsx:27` | 本地重算可选性 / 就绪度 / 计划完整性 | 违反文档自己的「Constraint Ownership Rule」（后端才是权威解释者） |

**反例（有代码边界的）**：`routes/agent.js:32` 的 chat 模式禁止 patch，且 `:42-47` 不传工具 → 结构上不可能 patch。这是唯一一条 prompt 限制同时有代码边界的。

## 5. 结论：哪些是"之前 AI 主观加的"

| 判定 | 条目 | 依据 |
| --- | --- | --- |
| **AI 主观添加** | **C-16**（Feature Flag 分阶段开放） | 任何 ADR 与 `CONTEXT.md` 均无记载，只有 README 一句话 |
| **AI 主观添加** | **C-11 的字段集**（`caveats`/`limitations`/`unsupportedClaims`/`missingMetadata`） | 全部是可选 schema 默认值，无代码要求，文档自己标注 "unevenly applied" |
| 可追溯，保留 | 其余 14 条 | 均可追到 ADR-0001…0009 或 `CONTEXT.md` |

## 6. 后续处理（进入后续拍）

- C-01 / C-10 补测试（当前为已知缺口，已锁）。
- 9 条漂移逐条收口：要么改代码补齐，要么改文档对齐——**不允许继续两边不一致**。
- 2 条 AI 主观添加：C-16 补 ADR 或降级为 `experimental`；C-11 收敛为"一条强制通道 + 其余可选提示"。
- `docs/project-constraints.md` 改为**由注册表生成**，让漂移在 CI 变红（下一拍）。

## 7. 4 处高危绕过的处置（迭代 015，重新审视后据实修正）

早先的只读取证把这 4 处都列为"高危"。逐条读代码后，**结论需要修正**——只有 2 处是真的安全缺口：

| 位置 | 原判断 | 重审结论 | 处置 |
| --- | --- | --- | --- |
| `plotService.js` + `routes/plot.js` | 无门禁执行 LLM 生成的 Python | ✅ **成立且最严重**：模型写的代码直接被执行，无沙箱、无能力检查、无 flag。而受控 Experiment Run 却要两次人工决定 | **已收口**：执行前要求项目授予 `experiment.execute` **且** `experimentExecution` flag 打开，否则返回 `CAPABILITY_DENIED` / `FEATURE_FLAG_DISABLED` |
| `transferAgent/**` + `routes/transfer.js` | 零能力校验，写盘 + spawn pdflatex | ⚠️ **部分成立**：它写的是**新建项目**的 `.tex`，编译走白名单引擎 + `safeJoin`（与编辑器编译按钮同级，属基线能力）。真问题是它**完全不参与约束模型** | **已收口**：入口要求 `patch.propose`（默认已授予 → 现有流程不变），但项目可撤销；授权检查放在模板校验之前 |
| `routes/vision.js` | 未审批写盘 | ⚠️ **降级**：写的是**用户自己上传的图片**，人类上传动作本身即授权，不是"AI 生成变更未经审" | **已收口**：同样要求 `patch.propose`（默认授予、可撤销），让写入变为可拒绝 |
| `routes/llm.js` | 裸代理，无角色/项目/能力校验 | ⚠️ **降级**：`requireAuthIfRemote` 是全局 onRequest 钩子，**远端访问已强制鉴权**；本地优先单用户场景下它只是把调用方给的 messages 转发给已配置 provider，无权限提升 | **不改代码**，记录判断依据 |

**净结果**：4 处中 **1 处真高危已 fail-closed 收口**、2 处变为可拒绝、1 处据实降级并说明理由。新增 4 项测试覆盖三种拒绝路径（无能力 / flag 关闭 / 撤销能力）。
