# SciencePrism 架构完善执行计划

> 状态：第一至五阶段已执行，第六阶段及以后尚未执行
>
> 目的：把 SciencePrism 从“带研究页面的 LaTeX 编辑器”逐步完善为以项目约束为核心、以 DeepSeek Harness 为受控执行引擎、以证据链为数据主线、以人工审批为最终控制点的科研工作台。

## 使用方式

后续执行时，先检索本文件，再按阶段推进。每完成一个任务，将对应的 `[ ]` 改为 `[x]`，并补充实际变更、测试结果和遗留风险。除非明确调整计划，不跨阶段堆叠未验证的功能。

架构讨论统一使用以下术语：Module、Interface、Implementation、Depth、Seam、Adapter、Leverage、Locality。每次拆分或抽象都执行一次 deletion test：删除该 Module 后，如果复杂度只是移动而没有减少，就不增加这个 Module。

## 当前基线

- DeepSeek Harness 已有临时工作区、SDK 加载、JSON 输出契约、项目 Skill 和人工审批雏形。
- 研究流程已经包含方向、检索、筛选、复现、创新点、方法、实验和写作阶段。
- 后端工作流状态位于 `apps/backend/src/services/researchWorkflow/index.js`，研究 Harness 适配位于 `apps/backend/src/services/researchResearch/harnessAdapter.js`。
- `apps/backend/src/services/deepseekHarnessService.js` 同时负责 SDK、临时目录、环境、会话、补丁和回退，职责过多，Interface 较浅。
- 前端的研究工作流模型和后端状态模型存在重复，容易出现状态推断不一致。
- 项目约束主要散落在 Prompt、路由和页面逻辑中，还没有成为可执行的统一 Interface。
- Evidence Ledger 已成为项目级证据账本，记录来源、版本、验证状态和溯源关系；资料库和批量阅读体验仍留给后续阶段。
- 实验阶段目前主要记录计划，还没有受控的实验运行和产物管理；Experiment Runner 留给阶段八。
- `apps/frontend/src/app/EditorPage.tsx` 规模较大，写作、编译、AI、协作和文件管理缺少清晰 Seam。
- 当前已有项目级 `CONTEXT.md`、ADR 目录和覆盖核心 Module 的一方测试；跨进程、浏览器和完整 API 契约测试仍未补齐。

## 总体不变量

这些规则在所有阶段都必须成立：

1. AI 只能提出建议、生成分析或准备 Patch，不能自动替代人工审批。
2. 未验证的元数据、实验结果和论文主张必须显式标记不确定性。
3. 所有阶段输出都必须经过结构校验，并关联当前项目、阶段、运行和证据。
4. Harness 默认只读；文件修改只能通过待确认 Patch；Shell 和实验执行默认关闭。
5. 项目约束由后端统一解释，前端只展示后端投影，不自行推断关键状态。
6. 每次 AI 运行都必须可追踪、可恢复、可审计，包含模型、Skill、上下文和工具调用信息。
7. 论文主张必须能追溯到 Evidence Ledger；没有来源、未确认或版本过期的内容只能作为待验证建议。

## 已补充的产品能力缺口

当前计划已经覆盖底层架构，但产品闭环还需要明确补齐以下能力。它们不是孤立页面，而是建立在工作流、Harness Runtime 和 Evidence Ledger 之上的用户能力。

### 项目驾驶舱

- 项目目标、研究问题、当前阶段、待审批事项、最近 Harness 运行和失败任务需要在一个项目首页集中呈现。
- 新用户需要有首次使用引导：创建项目、选择模板、填写研究问题、配置模型、设置约束和开始第一阶段。
- 项目需要支持状态摘要、风险摘要和下一步建议，而不是只显示文件列表。

### 论文资料库和阅读工作流

- 检索结果需要进入可管理的论文库，支持去重、收藏、标签、阅读状态、批注和研究笔记。
- 论文详情需要展示元数据来源、质量检查、代码/数据链接、相关证据和被哪些阶段引用。
- PDF、BibTeX、摘要、批注和人工判断需要归入项目，而不是停留在一次检索响应中。

### 任务和运行中心

- Harness Run、论文导入、编译和实验运行进入轻量任务中心。
- 任务需要支持进度、日志、取消、重试、失败原因和产物入口；只对确实需要的长任务保留恢复能力。
- 用户需要能区分“AI 正在建议”“等待人工确认”“已应用”“失败”和“已取消”。

### 写作质量闭环

- 研究证据应能生成写作 Brief、章节大纲、主张-证据矩阵和引用清单。
- 编辑器需要提供引用缺失、主张无证据、术语不一致、数据表述不一致和编译问题的检查结果。
- AI 修改必须支持 Diff、逐条接受、拒绝、撤销和关联证据，而不是一次性覆盖正文。

### 模型和 Harness 设置

- 设置页只支持当前实际需要的 Provider、Endpoint、Token 预算、默认模型和运行权限。
- Harness 运行前展示本次使用的模型、Skill、权限和上下文摘要；暂不建设 Skill 市场、版本管理或复杂权限后台。

这些能力的共同验收标准是：用户可以知道下一步做什么、AI 做了什么、依据是什么、哪里需要人工决定，以及失败后如何继续。

## 前端体验目标

当前前端的主要问题不是 CSS 数量少，而是信息架构、状态模型和交互反馈不足。后续前端计划需要同时提升产品深度和视觉完成度。

### 信息架构

- 项目层：项目驾驶舱、研究流程、论文资料库、运行中心、写作空间、项目设置。
- 研究层：阶段导航、阶段上下文、证据侧栏、待审批事项、Harness 运行状态。
- 写作层：文件树、编辑区、编译预览、AI 会话、Diff、引用和质量检查。
- 全局层：模型设置和当前运行状态；不额外建设命令中心、帮助中心或全局活动流。

### 交互完整性

- 所有异步操作都要有加载、空态、成功、失败、重试、取消和恢复状态。
- 长任务要显示阶段、进度、日志和产物，不允许只显示一个“处理中”。
- AI 输出要分为建议、待确认、已应用、已拒绝和已过期。
- 删除、覆盖、应用 Patch、批准实验和切换项目等高风险操作需要明确确认和撤销路径。
- 重要状态变化要在相关页面保留清晰状态和运行记录，不只依赖 Toast。

### 视觉和可用性

- 建立统一的色彩、字体、间距、层级、表格、状态标记、弹窗、侧栏和按钮 Design Token。
- 研究页面使用工作台布局，优先保证扫描、比较、批量确认和上下文切换效率。
- 减少装饰性卡片，使用稳定的栅格和面板层级表达信息关系。
- 以桌面端为主，保证常用窗口尺寸下工具栏、表格和长文本不遮挡、不溢出。
- 关键流程提供真实的空态示例和下一步行动，而不是只显示空白页面。

### 前端质量验收

- [ ] 首次用户可以从项目首页完成创建项目、配置模型并进入研究方向。
- [ ] 用户可以从任意页面找到当前任务、待审批事项和失败运行。
- [ ] 研究阶段、运行中心和编辑器之间切换时，输入和上下文不会丢失。
- [ ] 所有长任务都有可查看的日志、取消、重试或恢复入口。
- [ ] 常用桌面视口没有溢出、遮挡或不可操作控件。

### 本轮暂不做

为控制产品复杂度，以下能力不纳入当前执行范围：

- 无障碍专项、屏幕阅读器支持、键盘导航体系和移动端适配。
- 多人研究决策协作、审批协作、协作活动流和企业级权限体系。
- 项目快照、归档、恢复、删除保护以及完整项目导入导出恢复系统。
- 全局通知中心、命令中心、帮助中心和独立活动时间线。
- Skill 市场、Skill 版本/权限/验证后台，以及阶段级多模型编排。
- 超出实际长任务需要的复杂任务调度中心。

## 阶段一：领域模型和项目约束

目标：让项目约束成为正式的领域 Module，而不是散落在 Prompt 和页面中的隐含规则。

### 任务

- [x] 创建根目录 `CONTEXT.md`，定义研究方向、论文候选、证据、方法、实验计划、实验运行、产物和论文主张。
- [x] 创建 `docs/adr/`，记录 Harness 隔离、人工审批、项目数据存储、实验执行和模型 Adapter 决策。
- [x] 梳理每个阶段的人工拥有字段、AI 可建议字段、审批条件、驳回条件和证据要求。
- [x] 定义项目约束清单：文件范围、网络访问、工具权限、Shell 权限、Token 预算、超时和敏感文件过滤。
- [x] 定义研究工作流的状态不变量和迁移规则，并记录现有 `.scienceprism` 数据的迁移策略。
- [x] 输出一份阶段输入、输出、证据和审批关系表，作为后续统一 Interface 的依据。

### 验收标准

- [x] 新增阶段或修改约束时，可以先查阅 `CONTEXT.md` 和 ADR，而不是依赖代码猜测。
- [x] 每条核心约束都有明确归属 Module、验证位置和失败表现。
- [x] 前端、后端和 Harness 使用同一套阶段术语。

### 第一阶段执行记录

- 实际变更：新增根级 `CONTEXT.md`；新增 `docs/adr/0001` 至 `0005`；新增 `docs/project-constraints.md`、`docs/research-stage-contracts.md` 和 `docs/research-workflow-contract.md`。
- 术语决策：统一 `ideation` 为后端 canonical stage ID，标记 frontend 的 `innovation` 为别名；区分 Experiment Plan、Experiment Run 和 Harness Run；明确 Paper Candidate、Evidence 和 Paper Claim 的关系。
- 现状校验：文档引用并对齐当前 `researchWorkflow`、`researchResearch/schemas`、`qualityGate`、`harnessAdapter`、`deepseekHarnessService` 和研究路由的已有行为。
- 测试结果：完成 Markdown/路径/引用静态检查；未执行应用测试，因为本阶段没有修改运行时代码，且仓库当前未提供项目级测试脚本。
- 遗留风险：`getStageReadiness` 仍是字段存在性检查；前端仍保留阶段状态投影逻辑；没有乐观并发检查、完整敏感文件过滤、Evidence Ledger、真实 Experiment Run 或写作交接的 claim-evidence 校验。这些留给路线图后续阶段。

## 阶段二：统一研究工作流核心

目标：建立唯一的后端工作流状态源，前端只消费查询投影。

### 任务

- [x] 将工作流拆为状态机、阶段契约、审批决策、审计事件和数据迁移几个内部 Module。
- [x] 为工作流提供命令 Interface：初始化、更新阶段、提交审批、驳回、跳过、重置和恢复。
- [x] 为工作流提供查询 Interface：当前状态、阶段详情、待审批事项、审计时间线和前端投影。
- [x] 让 `routes/researchWorkflow.js` 只负责请求解析、权限和响应，不负责领域编排。
- [x] 移除前端 `ResearchWorkspacePage` 对阶段状态的重复推断，改为使用后端投影。
- [x] 增加版本号、并发检查、幂等请求和旧数据迁移。

### 验收标准

- [x] 前后端不存在两套互相竞争的阶段状态模型。
- [x] 每次状态变化都有命令、操作者、前置版本和审计事件。
- [x] 状态迁移可以通过纯函数测试，不需要启动浏览器或 Harness。

### 第二阶段执行记录

- 实际变更：新增 `stateMachine`、`stageContracts`、`commands`、`queries`、`projection`、`audit`、`migrations` 和文件存储 Adapter；研究路由只保留 HTTP 解析、操作者上下文、错误映射和响应；前端改为消费后端阶段投影。
- 命令 Interface：支持初始化、更新、审批、驳回、跳过、重置和恢复；新增 `GET /stages/:stageId`、`GET /pending-approvals` 和 `GET /audit` 查询。
- 并发与幂等：mutation 支持 `expectedVersion` 乐观并发检查和 `idempotencyKey` 持久化回执；同一进程按项目串行化文件写入；旧 schema 1/2 和 `.openprism` 路径迁移到 schema 3。
- 测试结果：`node --test apps/backend/test/researchWorkflow.test.js` 通过 3 项；`npm run build` 通过。构建仍保留已有 SVG 运行时路径和大 bundle warning。
- 遗留风险：未实现跨进程文件锁、完整 API 契约测试和浏览器集成测试；阶段契约目前负责工作流 readiness，Harness 输出的 Zod 校验仍由既有 Research Stage Contract Module 负责。

## 阶段三：统一 Harness Runtime

目标：把 DeepSeek Harness 从一次性调用提升为可恢复、可审计、受约束的运行平台。

### 任务

- [x] 建立 Harness Run Module，统一创建、启动、暂停、恢复、取消、查询和重放运行。
- [x] 将 SDK 加载、临时工作区、环境注入、事件收集、Patch 收集和错误回退收敛到 Runtime 内部。
- [x] 建立 DeepSeek SDK Adapter、现有 LangChain Adapter 和测试 Fake Adapter。
- [x] 建立工具能力模型，例如 `project.read`、`research.search`、`patch.propose`、`experiment.execute`。
- [x] 默认拒绝写入、Shell、越界路径和未授权网络；所有能力通过项目约束授予。
- [x] 记录 Run ID、项目、阶段、模型、Skill、上下文哈希、工具事件、输出验证、Patch 和人工决定。
- [x] 增加 Token、超时、并发、取消和失败重试策略。

### 验收标准

- [x] 业务阶段不再直接依赖具体 DeepSeek SDK。
- [x] 同一个阶段可以切换真实 Harness、Legacy Agent 和 Fake Adapter。
- [x] 一次失败运行可以查看原因、恢复或重放，而不是只能重新点击。
- [x] Harness 无法绕过项目约束，也不能直接提交人工决策。

### 第三阶段执行记录

- 实际变更：新增 `apps/backend/src/services/harnessRuntime/`，包含 Run 存储、生命周期、能力策略、临时工作区、事件/ Patch 收集、超时/并发/取消/暂停/恢复/重放、人工决定和输出验证；新增 DeepSeek、LangChain、Fake 三个 Adapter。
- 运行 Interface：新增 `/api/projects/:id/harness-runs` 查询和创建接口，以及 `start`、`pause`、`resume`、`cancel`、`replay`、`decision` 命令；旧 `runDeepSeekHarness` 保留为兼容入口，研究阶段改为依赖 Runtime。
- 安全策略：默认只授予 `project.read` 和 `patch.propose`；项目可通过 `.scienceprism/project-constraints.json` 授予能力、文件范围、网络白名单和资源限制。原项目仍不会作为执行工作区，Patch 不会自动应用。
- 审计数据：Run 文件记录 Run ID、项目、阶段、模型、Skill、上下文哈希、能力、限制、事件、输出校验、错误、Patch 和人工决定；API Key 不写入 Run 文件。
- 测试结果：`node --test apps/backend/test/harnessRuntime.test.js` 通过 4 项；`node --test apps/backend/test/researchWorkflow.test.js` 通过 4 项；`npm run build` 通过；真实后端 `GET /api/health` 返回 200。构建仍保留已有 SVG 运行时路径提示和大 bundle warning。
- 遗留风险：运行锁目前是单进程锁；DeepSeek SDK 的底层 profile 若新增未被能力模型识别的高风险工具，需要在 Adapter 的工具事件映射中补充名称；实验执行能力仍默认关闭，完整 Experiment Runner 留给阶段八。

## 阶段四：项目上下文打包器

目标：让 Harness 获得与当前任务相关、经过约束筛选的上下文，而不是简单复制整个项目。

### 任务

- [x] 根据阶段、当前文件、用户选区、项目约束、已确认证据和最近决策构建上下文包。
- [x] 支持文件优先级、Token 预算、证据摘要、上下文哈希和敏感文件过滤。
- [x] 将适用 Skill、阶段契约和人工指令作为结构化上下文传入。
- [x] 记录每次运行实际使用的上下文清单，支持问题复现。
- [x] 对过期上下文、冲突版本和缺失证据进行显式提示。

### 验收标准

- [x] 每个 Harness Run 都可以回答“模型看到了什么”。
- [x] 上下文大小受预算控制，且不会泄露项目外文件或敏感配置。
- [x] 同一输入和同一上下文可以在 Fake Adapter 中稳定复现。

### 第四阶段执行记录

- 实际变更：新增 `apps/backend/src/services/harnessRuntime/contextPackager.js`，在 Run 创建时读取受约束的项目快照，按当前文件、显式文件和阶段相关文件排序，并生成文件内容、Evidence 摘要、最近人工决策、Project Constraint 投影、Skill、阶段契约、用户选区和提示的结构化 Context Pack。
- 运行接入：`Harness Runtime` 固化 `contextPack`、`contextHash` 和 `contextManifest`；DeepSeek SDK Adapter 与 LangChain Adapter 使用同一份快照，重试、暂停恢复和 fallback 不重新读取变化中的项目文件。
- 约束行为：上下文文件遵循 `project.read`、`allowedPaths` 和敏感文件过滤；`contextTokenBudget` 控制内容和清单，低优先级文件会被淘汰，活跃文件保留为高优先级上下文项。原始 Project 仍不会作为执行工作区写入。
- 不确定性提示：支持文件哈希和 Workflow 版本过期检测、Evidence 版本冲突、缺失 Evidence、无可用文件和无 `project.read` 等显式警告；警告不会替代人工判断。
- 测试结果：`node --test apps/backend/test/harnessRuntime.test.js` 通过 5 项；`node --test apps/backend/test/researchWorkflow.test.js` 通过 4 项；新增测试覆盖预算、文件优先级、敏感文件过滤、上下文哈希、Manifest 和不确定性提示。
- 遗留风险：Evidence Ledger 尚未成为正式 Stage 5 Module，目前打包器兼容项目中的 `evidence-ledger.json`/`evidence.json` 和工作流中的已确认记录；跨进程运行锁、浏览器集成测试和真实 Provider 的 token 用量校准仍未完成。

## 阶段五：Evidence Ledger 和溯源链

目标：把证据从零散 ID 提升为贯穿科研流程和写作流程的核心数据。

### 任务

- [x] 建立 Evidence Ledger，统一记录论文、数据集、代码、环境、方法、实验运行、日志、图表、表格、人工笔记和论文主张。
- [x] 为证据记录来源、原始 URL 或路径、获取时间、摘要、验证状态、版本或哈希。
- [x] 建立研究问题到论文、方法、数据集、实验、结果和论文主张的关系图。
- [x] 要求 Harness 输出引用已有证据，缺失时输出明确的待验证项。
- [x] 在写作阶段增加主张-证据矩阵、引用完整性检查和不支持主张检测。

### 验收标准

- [x] 任意论文主张都可以反查到证据和来源。
- [x] 证据发生版本变化时，可以识别受影响的阶段和主张。
- [x] Harness 不能把没有来源的推测写成已验证事实。

### 第五阶段执行记录

- 实际变更：新增 `apps/backend/src/services/evidenceLedger/`，提供项目级 Ledger 记录、来源与版本字段、原子存储、关系图、影响追踪、主张-证据矩阵和版本冲突检查；兼容旧 `.scienceprism/evidence.json` 与 `.openprism/evidence*.json`。
- 运行接入：新增 `/api/projects/:id/evidence` 查询与写入接口；Context Pack 只注入已确认 Evidence 和关系；Research Harness 的 `writing_brief` 在结构校验后执行 Ledger 引用校验；写作阶段显示主张状态、缺失证据、待核验证据和版本变化。
- 人工控制：Ledger 写入不会替代工作流审批；`pending`、`unverified` 或过期 Evidence 只能产生 `needs-verification`/`unsupported` 状态，不能成为已验证论文主张。
- 测试结果：`node --test apps/backend/test/evidenceLedger.test.js apps/backend/test/harnessRuntime.test.js apps/backend/test/researchWorkflow.test.js` 通过 14 项；`npm run build` 通过。构建仍有既有 SVG 运行时路径提示、`pdfjs-dist` eval 提示和大 bundle warning。
- 遗留风险：当前关系写入和文件锁仍是单进程本地能力；论文资料库、逐条人工确认界面、编辑器正文引用扫描和跨进程锁留给阶段六至十。

## 阶段六：研究阶段纵向切片

目标：先完成一条端到端主路径，再扩展所有阶段。

第一条切片固定为：

`研究方向 -> 论文检索 -> 论文筛选 -> 证据确认 -> 写作 Brief -> LaTeX 编辑器`

### 任务

- [x] 把每个阶段统一为“输入上下文 -> Harness 任务 -> 结构化输出 -> 自动校验 -> 人工确认 -> 审计事件”。
- [x] 将 arXiv 检索抽成 Source Adapter，并为后续 OpenAlex、Semantic Scholar、Crossref 留出 Seam。
- [x] 增加论文去重、实体合并、元数据验证和来源优先级。
- [x] 完善筛选解释、复现计划、创新点比较、方法候选和写作 Brief。
- [x] 让写作 Brief 自动进入编辑器，并保留证据和主张关联。

### 验收标准

- [x] 新用户可以不依赖手工修改 JSON，完成第一条端到端路径。
- [x] 每个阶段都能看到输入、AI 建议、验证结果、人工决定和下一步。
- [x] 失败阶段可以重试，不会破坏已确认的前置结果。

### 第六阶段执行记录

- 实际变更：新增 `researchSources` Source Adapter Seam 和 arXiv Adapter；新增候选论文实体合并、去重、来源优先级和元数据验证 Module。旧 `/api/arxiv/search` 也改为复用同一 Adapter。
- 纵向切片：研究方向、检索、筛选确认、创新点、方法、实验计划和写作交接都保存统一的 Stage Task，记录输入、Harness Run、结构化输出、验证结果、错误、人工决定和审计关联。阶段审批会拒绝最近失败或未通过验证的任务。
- Evidence 与编辑器：人工选择的论文写入 Evidence Ledger 并保留来源与版本；写作 Brief 的 Paper Claims 继续执行 Evidence 校验，生成 `research/writing-brief.md`，前端自动打开该文件，不覆盖主 LaTeX 文稿。
- 测试结果：`node --test apps/backend/test/researchStageSlice.test.js` 通过 3 项；该测试覆盖来源去重、Fake Harness 端到端方向到 Brief、Evidence 关联和失败重试；原有工作流、Harness、Evidence 测试共 14 项通过；`npm run build` 通过。
- 遗留风险：当前实际 Source Adapter 只有 arXiv；来源检索仍是同步请求；Stage Task 和 Evidence Ledger 使用已有单进程文件锁；写作 Brief 生成的是可编辑交接文档，正文主张仍需人工接受和写回主 LaTeX 文件。

## 阶段七：产品功能闭环

目标：把底层 Module 组合成用户可以持续使用的科研工作流，而不是一组分散的 AI 页面。

### 任务

- [ ] 将项目首页升级为项目驾驶舱，展示研究目标、阶段进度、待审批事项、最近运行、风险和下一步。
- [ ] 增加首次使用引导和项目初始化流程，覆盖模板、研究问题、模型、约束和第一阶段。
- [ ] 建立论文资料库，支持论文导入、去重、标签、收藏、阅读状态、笔记、批注、BibTeX 和来源检查。
- [ ] 建立轻量任务中心，接入 Harness、论文导入、编译和实验任务，提供日志、重试和失败详情。
- [ ] 建立写作质量面板，接入主张-证据矩阵、引用完整性、术语一致性、编译问题和 AI 检查结果。

### 验收标准

- [ ] 用户可以从一个项目驾驶舱理解项目现状和下一步，而不需要逐页寻找。
- [ ] 论文从检索到阅读、筛选、证据引用和写作可以在项目内连续完成。
- [ ] Harness 和实验等长任务能从任务中心查看日志、重试、取消，并在确有需要时恢复或进入产物页面。
- [ ] 关键运行、证据和写作检查结果都能从项目内回查。

## 阶段八：受控实验运行

目标：把实验从“记录计划”提升为安全、可复现、可追溯的运行。

### 任务

- [ ] 建立实验 Run Manifest，包含代码版本、数据集版本、环境、命令、参数、种子、资源预算和成功标准。
- [ ] 采用分级权限：生成计划、人工批准、隔离执行、产物归档、结果解释。
- [ ] 建立 Experiment Runner Adapter，禁止直接执行任意 Shell。
- [ ] 保存日志、指标、图表、表格、检查点和环境快照。
- [ ] 将实验结果自动写回 Evidence Ledger，并支持取消、失败重试和结果比较。

### 验收标准

- [ ] 没有人工批准时不会执行实验。
- [ ] 每个结果都能复现到代码、数据、环境和运行参数。
- [ ] Harness 只能解释运行结果，不能伪造运行结果。

## 阶段九：前端工作台拆分和增强

目标：在不重写全部前端的情况下，逐步提高功能深度和 Locality。

### 任务

- [ ] 从 `EditorPage.tsx` 抽离项目状态、文件树、编辑器、编译、PDF、AI、协作和设置 Module。
- [ ] 把 `api/client.ts` 按领域拆分为项目、工作流、Harness、证据、实验和协作 Adapter。
- [ ] 增加项目驾驶舱、项目约束面板、Harness 运行控制台、待审批收件箱和证据链视图。
- [ ] 增加论文资料库、阅读详情、批注、笔记和来源验证视图。
- [ ] 增加轻量任务中心和失败详情入口。
- [ ] 增加 Patch、证据和实验产物的预览与确认流程。
- [ ] 展示“AI 建议 / 人工确认 / 已应用 / 已拒绝”的明确状态。
- [ ] 增加运行恢复和失败重试提示；保留现有编辑器协作能力，不扩展研究决策协作。
- [ ] 建立统一 Design Token、空态、加载态、错误态和进度态规范。
- [ ] 对项目首页、研究阶段、运行中心和编辑器建立可复用的视觉回归场景。

### 验收标准

- [ ] 页面不再自行实现领域规则，只展示后端投影。
- [ ] 研究流程、Harness 运行和编辑器之间可以互相跳转并保留上下文。
- [ ] 新增一个研究阶段不需要继续扩大单个超大页面。

## 阶段十：测试、可观测性和迁移

目标：让后续扩展建立在稳定的测试 Interface 上。

### 任务

- [ ] 增加质量门禁、工作流迁移、Schema 校验和证据关系的单元测试。
- [ ] 增加 Fake Harness Adapter、工具权限、路径安全和上下文打包测试。
- [ ] 增加后端 API 契约测试和前后端工作流集成测试。
- [ ] 增加“研究方向到写作 Brief”的端到端测试。
- [ ] 为旧 `.openprism` 数据、旧工作流 JSON 和浏览器存储建立迁移测试。
- [ ] 增加运行耗时、Token、失败率、人工驳回率和证据缺失率的可观测指标。
- [ ] 使用 Feature Flag 分阶段开放实验执行和高级 Harness 能力。

### 验收标准

- [ ] 关键规则可以通过 Module Interface 测试，不依赖页面手工验证。
- [ ] 旧项目可以迁移，新项目使用统一数据格式。
- [ ] 线上问题可以通过 Run ID、审计事件和上下文清单定位。

## 推荐执行顺序

1. 阶段一：建立 `CONTEXT.md`、ADR 和项目约束清单。
2. 阶段二：统一研究工作流状态和前后端 Interface。
3. 阶段三：抽出 Harness Runtime 与 Fake Adapter。
4. 阶段四：实现上下文打包器和运行复现。
5. 阶段五：建立 Evidence Ledger。
6. 阶段六：完成“方向到写作 Brief”的第一条纵向切片。
7. 阶段七：完成项目驾驶舱、资料库、任务中心和写作质量闭环。
8. 阶段八：增加受控实验运行。
9. 阶段九：拆分前端并完善工作台体验。
10. 阶段十：补齐测试、可观测性和迁移。

## 第一阶段完成定义

第一阶段完成后，不要求新增用户功能，但必须具备：

- `CONTEXT.md`
- 至少一份记录当前关键决策的 ADR
- 阶段输入、输出、证据和审批关系表
- 项目约束清单
- 工作流状态不变量和迁移策略
- 下一阶段可直接使用的 Module 清单和 Seam 说明

第一阶段完成后，再开始设计统一 Harness Runtime 的具体 Interface。
