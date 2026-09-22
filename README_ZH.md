<div align="center">

<img src="static/logo-rotating.gif" alt="SciencePrism 标志" width="180"/>

# SciencePrism

### 人主导、AI 辅助的科研工作流：从问题到论文

[![Node.js 版本](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-icey--hub%2Fscienceprism-181717?logo=github)](https://github.com/icey-hub/scienceprism)
[![Issues](https://img.shields.io/github/issues/icey-hub/scienceprism)](https://github.com/icey-hub/scienceprism/issues)

[中文](README_ZH.md) | [English](README.md)

</div>

SciencePrism 是一个本地优先的科研工作台，用于把研究者自己的问题转化为可追溯的证据、可复现的实验和最终论文。研究者掌握研究方向、论文筛选、创新点选择、方法确定和最终论断，AI 负责补充检索、结构化分析和写作辅助。

## 科研流程

科研流程和原有项目、编辑器共用同一套工作区。每个阶段都有独立界面和 URL，状态及审计事件保存在项目内的 `.scienceprism/research-workflow.json` 中。运行时配置使用 `SCIENCEPRISM_*` 前缀，同时继续兼容旧的 `OPENPRISM_*` 配置。

1. **研究方向** —— 输入研究问题、范围、约束和验收标准。
2. **论文检索** —— 在人工方向基础上扩展可追溯的论文查询和结果。
3. **论文筛选** —— 执行服务端质量门禁，例如 CCF 期刊/会议要求，再由人勾选需要的论文。
4. **论文复现** —— 可选地记录和评估已选论文的复现实验计划。
5. **创新点** —— 由 DeepSeek Harness 提供多个有证据依据的创新候选，人来决定保留哪个方向。
6. **方法设计** —— 对比 AI 辅助的方法方案，由人确认最终方法。
7. **实验验证** —— 审查数据集，定义结构化入口和评价标准，批准实验计划，再通过受控 Experiment Runner 执行。
8. **论文写作** —— 将经过确认的证据、决策和结果交给原有 LaTeX 写作工作区。

页面跳转不等于获得授权。后端会强制执行阶段顺序、论文质量门禁、人工确认和审计记录。系统不会执行自由文本 Shell 命令；受控 Run 还需要单独批准和明确的项目执行能力。

### 工作流核心（第二阶段）

后端是科研工作流状态的唯一来源。工作流核心拆分为状态机、阶段契约、审批命令、审计事件、数据迁移、文件持久化和前端投影 Module；前端只消费这些投影，不再自行推断阶段状态。

当前命令支持初始化、更新阶段、审批、驳回、跳过可选复现、恢复和重置。查询投影包括当前工作流、阶段详情、待审批事项和审计时间线：

- `GET /api/projects/:id/research-workflow`
- `GET /api/projects/:id/research-workflow/stages/:stageId`
- `GET /api/projects/:id/research-workflow/pending-approvals`
- `GET /api/projects/:id/research-workflow/audit`

写入请求可以携带 `expectedVersion` 执行乐观并发检查，并使用 `idempotencyKey` 安全重试。已有的 `.openprism` 工作流文件及 schema 1/2 数据会迁移到 schema 3 的项目本地格式，迁移不会删除旧来源。

### 统一 Harness Runtime（第三阶段）

后端现在为科研阶段 AI 辅助提供统一的 Harness Runtime。一次 Run 可以使用 DeepSeek SDK Adapter、旧版 LangChain Adapter 或用于测试的确定性 Fake Adapter。Runtime 统一负责临时工作区、环境注入、事件、待确认 Patch、输出校验、资源限制、取消、暂停/恢复、重试、重放和人工决定。

Run 记录持久化在 `.scienceprism/harness-runs.json`。HTTP 接口支持列出和创建 Run、查询单个 Run，以及控制运行生命周期：

- `GET /api/projects/:id/harness-runs`
- `GET /api/projects/:id/harness-runs/:runId`
- `POST /api/projects/:id/harness-runs`
- `POST /api/projects/:id/harness-runs/:runId/start`
- `POST /api/projects/:id/harness-runs/:runId/pause`
- `POST /api/projects/:id/harness-runs/:runId/resume`
- `POST /api/projects/:id/harness-runs/:runId/cancel`
- `POST /api/projects/:id/harness-runs/:runId/replay`
- `POST /api/projects/:id/harness-runs/:runId/decision`

默认能力只有 `project.read` 和 `patch.propose`。额外能力、允许访问的路径、网络访问、Token 预算、超时、并发数和重试次数，必须通过项目内的 `.scienceprism/project-constraints.json` 授权。Run 始终在项目临时副本中执行，待确认 Patch 不会自动应用到原项目。详见 [docs/harness-runtime.md](docs/harness-runtime.md) 和 [docs/project-constraints.md](docs/project-constraints.md)。

### 受约束的上下文打包（第四阶段）

每次 Run 启动前，后端都会为当前任务生成确定性的 Context Pack。内容包括当前文件、用户选区、相关项目文件、项目约束投影、已确认 Evidence 摘要、最近人工决策、适用 Skill、阶段输出契约和人工指令。敏感文件、`.dsh/skills` 文件以及 `allowedPaths` 之外的路径不会进入上下文。

打包器会按任务相关性排列文件，保持当前文件最高优先级，并通过 `contextTokenBudget` 控制上下文大小：先裁剪内容，再移除低优先级文件。每个 Run 都会保存实际使用的 `contextPack`、`contextHash`，以及包含文件哈希、实际大小、Evidence ID、决策 ID、Skill、警告和阶段契约的精简 `contextManifest`。即使临时工作区已经清理，也可以检查模型实际看到的上下文。

可以在项目约束文件中设置预算和文件范围：

```json
{
  "capabilities": ["project.read", "patch.propose"],
  "allowedPaths": ["main.tex", "sections"],
  "contextTokenBudget": 12000
}
```

文件或工作流版本过期、Evidence 版本冲突和 Evidence 缺失都会记录为明确警告。警告不会批准输出，也不会替代人工审查。详见 [docs/harness-runtime.md](docs/harness-runtime.md) 和 [docs/adr/0007-context-packaging.md](docs/adr/0007-context-packaging.md)。

### Evidence Ledger 和溯源链（第五阶段）

证据以项目级账本形式保存在 `.scienceprism/evidence-ledger.json`。Evidence Ledger 为论文、数据集、代码、环境、方法、实验计划与运行、结果、日志、图表、表格、人工笔记、产物和论文主张提供统一 Interface。读取旧的 `.scienceprism/evidence.json` 或 `.openprism/evidence*.json` 时，会自动迁移到新的账本格式。

每条记录都会保留来源 URL 或路径、获取时间、摘要、验证状态、版本以及可选的 SHA-256 哈希。记录之间可以建立 `supports`、`uses`、`produces`、`derived-from`、`contradicts` 等类型化关系。关系图还会指出 Evidence 版本变化影响了哪些研究阶段和论文主张。

Evidence Ledger HTTP 接口包括：

- `GET /api/projects/:id/evidence`
- `GET /api/projects/:id/evidence/graph`
- `GET /api/projects/:id/evidence/impact/:evidenceId`
- `GET /api/projects/:id/evidence/claims/matrix`
- `POST /api/projects/:id/evidence`
- `POST /api/projects/:id/evidence/relations`

Research Harness 的输出会在阶段 Schema 校验后，再与已确认 Evidence 进行比对。缺失、未验证或版本过期的引用会返回明确的校验错误，不能被写成已验证事实，也不能替代工作流审批。写作阶段会展示主张-证据矩阵，区分已支持、无支持和需要核验的论文主张。

详细记录契约和架构决策见 [docs/evidence-ledger.md](docs/evidence-ledger.md) 与 [docs/adr/0008-evidence-ledger-and-provenance.md](docs/adr/0008-evidence-ledger-and-provenance.md)。

### 研究阶段纵向切片（第六阶段）

第六阶段打通第一条端到端科研路径：

`研究方向 -> 论文检索 -> 论文筛选 -> 证据确认 -> 写作 Brief -> LaTeX 编辑器`

论文检索现在通过 `researchSources` Source Adapter Seam 执行。目前已实现 arXiv Adapter，后续可以在同一 Interface 后接入 OpenAlex、Semantic Scholar 和 Crossref。检索候选会统一格式化、去重、合并为论文实体，执行元数据质量检查并按来源优先级排序；服务端质量门禁和人工选择仍然是必需步骤。

每个科研阶段都使用统一的 Stage Task 生命周期：输入上下文、Harness 任务、结构化输出、自动校验、人工决定和审计记录。失败或未通过校验的任务不能审批阶段；重试任务不会改变已经确认的前置结果。筛选解释、创新点比较、方法候选、实验计划和写作交接都保存在同一套任务记录中。

人工确认的论文会写入 Evidence Ledger。写作 Brief 中的 Paper Claims 保留 `evidenceIds` 关联，生成的 `research/writing-brief.md` 会自动在编辑器中打开，作为可编辑的交接文档，不会覆盖主 `.tex` 文稿。实验执行属于后续受控阶段；当前流程只记录实验计划，不执行任意 Shell 命令。

阶段契约和实现记录见 [docs/research-stage-contracts.md](docs/research-stage-contracts.md) 与 [docs/architecture-roadmap.md](docs/architecture-roadmap.md)。

### 项目产品闭环（第七阶段）

每个项目现在都有一个 `/project/:projectId` 项目驾驶舱。它从后端状态投影研究问题、阶段进度、待人工审批事项、最近 Harness 运行、失败任务、Evidence 风险、资料库信号和下一步行动。新项目会先进入首次使用引导，保存研究问题、模型、Harness 约束和第一阶段，再进入研究流程。

项目内提供四个连续视图：

- **论文资料库**：导入检索候选，按 arXiv/DOI/URL/标题去重，管理标签和收藏，记录阅读状态、笔记和批注，生成 BibTeX，执行来源元数据检查，并保留项目 Evidence 引用。
- **任务中心**：统一查看 Harness、论文导入、编译、研究阶段和受控 Experiment Run，支持进度、日志、失败详情、重试、取消和 Harness 重放。每次 Experiment Run 仍需人工明确批准后才能执行。
- **写作质量**：集中查看主张-证据矩阵、LaTeX 引用完整性、关键词术语变体、编译失败和已有 Writing Harness 检查结果。

项目数据保存在 `.scienceprism/paper-library.json` 和 `.scienceprism/tasks.json`。对应 HTTP 接口包括：

- `GET /api/projects/:id/dashboard`、`POST /api/projects/:id/initialize`
- `GET/POST/PATCH/DELETE /api/projects/:id/papers`
- `GET /api/projects/:id/tasks`、`POST /api/projects/:id/tasks/:taskId/retry`、`POST /api/projects/:id/tasks/:taskId/cancel`
- `GET/POST /api/projects/:id/writing-quality`

产品闭环继续遵守现有不变量：AI 输出仍然只是建议或待确认 Patch，来源缺失或不确定的 Evidence 始终显式待核验，驾驶舱导航不能授予实验执行权限。

### 受控实验运行（第八阶段）

实验流程现在明确区分 Experiment Plan 和 Experiment Run。研究流程批准计划后，结构化 Run Manifest 会记录代码快照、数据集版本、运行环境、参数、随机种子、资源预算、成功标准和声明的产物路径。Run 还需要第二次人工批准，并且项目约束必须显式授予 `experiment.execute`。

生产 Node Adapter 只允许项目内的 `.js`、`.mjs` 或 `.cjs` 入口，在项目临时副本中以 `shell: false` 执行。自由文本 command 只作为计划备注保存，不能直接执行。Runner 会把 stdout、stderr、指标、声明的图表/表格/检查点/输出、环境快照和 Manifest 保存到 `.scienceprism/experiment-runs/<run-id>/`。Fake Adapter 仅用于测试。

完成或失败的 Run 会自动写入 Evidence Ledger，分别保持 `pending` 或 `unverified` 状态。失败 Run 支持取消和重试；重试会创建新的待批准 Run。已完成 Run 可以按持久化指标比较，结果解释只能引用同一 Run 产生的 Artifact，不能修改实测指标。

HTTP 接口位于 `/api/projects/:id/experiment-runs`，支持列出/创建 Run、批准/拒绝、启动、取消、重试、解释和比较已完成 Run。详见 [docs/experiment-runner.md](docs/experiment-runner.md) 与 [docs/adr/0009-controlled-experiment-runs.md](docs/adr/0009-controlled-experiment-runs.md)。

### 前端工作台拆分和增强（第九阶段）

项目驾驶舱现在提供独立的待审批、项目约束、Harness 运行和 Evidence 视图：

- `/project/:projectId/approvals`：查看待审批阶段、缺失字段和进入阶段的入口。
- `/project/:projectId/runs`：查看 Harness 生命周期、事件日志、Context Hash、输出校验、Patch 入口，并支持重放、恢复、人工接受或拒绝结果。
- `/project/:projectId/evidence`：查看主张-证据矩阵摘要、Evidence 节点和关系数量。
- `/project/:projectId/settings`：查看后端投影的能力、允许路径、网络白名单、Token 预算和超时。

论文资料库仍支持阅读状态、笔记、批注和来源检查；任务中心保留进度、日志、失败详情、重试和取消；写作质量保留主张-证据矩阵和稿件检查。编辑器的协作、编译、PDF、AI 和 Diff 应用流程保持不变，Diff、PDF 预览、设置持久化和协作身份持久化已移入独立的 editor Module。项目、工作流、Harness、Evidence、实验、协作、编辑器和转换 API 现在都有领域 Adapter，`api/client.ts` 仅作为兼容入口。

长任务页面会明确显示加载、空态、错误、进度和决定状态，并区分“AI 建议 / 人工确认 / 已应用 / 已拒绝 / 失败 / 已取消”。视觉回归场景见 [docs/frontend-visual-regression.md](docs/frontend-visual-regression.md)，完整执行记录见 [docs/architecture-roadmap.md](docs/architecture-roadmap.md)。

### 测试、可观测性和迁移（第十阶段）

第十阶段增加统一的后端质量门禁和测试入口：

```bash
npm test       # 后端 Module、API 契约、迁移和纵向切片测试
npm run quality # 测试后再执行前端生产构建
```

项目可观测性投影位于 `GET /api/projects/:id/observability`，提供 Harness 和 Experiment Run 的耗时、Token 用量、状态和失败率、人工决定驳回率、最近 Run ID、Context Hash、Context Manifest、错误，以及 Evidence 主张缺失支持率。`GET /api/projects/:id/feature-flags` 提供当前生效的分阶段开关。

受控实验执行和高级 Harness Adapter 由 `experimentExecution`、`advancedHarness` 两个 Feature Flag 控制。为兼容已有行为，默认保持开启；可以使用 `SCIENCEPRISM_FEATURE_EXPERIMENT_EXECUTION=false` 或 `SCIENCEPRISM_FEATURE_ADVANCED_HARNESS=false` 全局关闭，也可以在项目的 `.scienceprism/project-constraints.json` 中进一步关闭：

```json
{
  "featureFlags": {
    "experimentExecution": false,
    "advancedHarness": true
  }
}
```

旧 `.openprism` 工作流/Evidence 文件和旧 Schema 会迁移到 `.scienceprism`，不会删除旧来源。旧浏览器设置和协作名称首次读取时会提升为 `scienceprism-*` 存储键。每次 Harness Run 都保留 Run ID、审计事件、输出校验、Context Hash 和 Context Manifest，便于定位线上问题。

## 为什么是 SciencePrism

- **人保持主导权**：AI 不能批准论文、选择创新点、授权实验或编造结果。
- **质量门禁**：未知元数据会标记为 `needs-review`；筛选接口只接受通过策略且获得人工 `accept` 决策的论文。
- **证据链**：论文卡片、数据集审查、统计检查、实验计划和写作交接都保存在项目中。
- **项目级 Skill**：可在第一个流程页面上传自己的 `SKILL.md`，并绑定到兼容的阶段。
- **DeepSeek Harness**：在隔离工作区运行科研阶段辅助，并使用项目内置科研 Skill。

## 原有写作工作区

科研流程不是另起一个简陋工具，而是和原有学术写作工作区融合使用：

- 支持 AI Chat、Agent Diff、Tools 和自动补全的 LaTeX 编辑器。
- 支持 TexLive、Tectonic 或自动回退的编译、PDF 预览和错误诊断。
- 支持 ACL、CVPR、NeurIPS、ICML 模板及模板转换。
- 支持 BibTeX、文件树项目管理、论文检索、网络搜索、图表和公式识别。
- 支持 AI 审稿报告、一致性检查、缺失引用检查和编译摘要。
- 可选 Yjs/WebSocket 多人实时协作。

## 快速开始

### 环境要求

- Node.js 18 或更高版本
- npm 9 或更高版本
- 用于 PDF 编译的 LaTeX 引擎（TexLive 或 Tectonic）

### 安装和运行

```bash
git clone https://github.com/icey-hub/scienceprism.git
cd scienceprism
npm install
npm run dev
```

也可以分别启动前后端：

```bash
npm run dev:backend
npm run dev:frontend
```

构建生产前端：

```bash
npm run build
```

### 配置模型

在 Workspace Settings 中配置模型和 OpenAI 兼容端点。环境变量是可选项，只在本机使用占位符配置，绝不要把密钥提交到 Git：

```text
DEEPSEEK_API_KEY=<your-key>
DEEPSEEK_BASE_URL=<optional-endpoint>
```

Harness 运行时优先读取工作区设置，其次读取本机的 `DEEPSEEK_API_KEY`。

## DeepSeek Harness

在 Workspace Settings 中将 **Agent Runtime** 设置为 **DeepSeek Harness**。统一 Harness Runtime 会自动探测标准本地 SDK 路径，也可以手动指定：

```text
SCIENCEPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
```

可选运行参数包括 `SCIENCEPRISM_HARNESS_PROFILE`、`SCIENCEPRISM_HARNESS_PROVIDER`、`SCIENCEPRISM_HARNESS_MAX_TOKENS` 和 `SCIENCEPRISM_HARNESS_TIMEOUT_MS`。Harness 无法启动时，默认回退到原有 LangChain 运行时；设置 `SCIENCEPRISM_HARNESS_FALLBACK=false` 可关闭回退。

每次 Harness Run 都运行在项目临时副本中，文本修改以待确认 Diff 返回，只有用户应用 Diff 后才会改变原项目。Run 状态、事件、校验结果、错误、人工决定和模型实际看到的上下文都可以通过 Harness Run API 查询。

## 项目级 Skill

内置科研 Skill 位于 `.dsh/skills`：

| Skill | 流程阶段 | 作用 |
| --- | --- | --- |
| `literature-search` | 方向、检索 | 将人工问题扩展为可追溯查询。 |
| `paper-screening` | 筛选 | 解释质量证据，但不能绕过质量门禁。 |
| `paper-card` | 复现、创新、方法 | 连接论文论断、方法、实验和局限。 |
| `dataset-audit` | 实验、写作 | 检查数据来源、访问、许可和可复现性。 |
| `statistics-audit` | 实验、写作 | 检查实验单位、重复、误差和比较。 |
| `research-writing` | 写作 | 生成受证据约束的结构、论断和引用。 |

要添加自己的 Skill，打开 `/editor/:projectId/research/direction`，点击 **添加 Skill**，上传包含一个或多个 `SKILL.md` 的目录。上传只会把选中的 Skill 文件存放到 `.dsh/skills`，Skill 指令不能绕过服务端门禁或人工确认。

## CCF 质量策略

可以通过 JSON 对象提供正式的 venue 目录，将期刊/会议映射到 CCF 等级：

```bash
export SCIENCEPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

目录只是元数据适配器，不能覆盖年份、同行评审、代码要求或人工确认失败的结果。完整规则见 [docs/research-workflow.md](docs/research-workflow.md)。

## 项目文档

- [领域上下文](CONTEXT.md)
- [项目约束清单](docs/project-constraints.md)
- [研究阶段契约](docs/research-stage-contracts.md)
- [研究流程契约与迁移策略](docs/research-workflow-contract.md)
- [架构决策](docs/adr/)
- [科研流程说明](docs/research-workflow.md)
- [科研 Skill 说明](docs/research-skills.md)
- [Harness Runtime](docs/harness-runtime.md)
- [Evidence Ledger](docs/evidence-ledger.md)
- [受控实验运行](docs/experiment-runner.md)
- [架构执行路线图](docs/architecture-roadmap.md)
- [前端视觉回归场景](docs/frontend-visual-regression.md)
- [DeepSeek Harness 集成](docs/deepseek-harness.md)

## 隐私和安全

SciencePrism 按本地优先设计。API key、PAT、密码、证书和私有数据集应始终留在 Git 之外。只在本机使用 `.env` 文件，提交前检查 `.gitignore`；任何已经暴露的凭据都应立即撤销并重新生成。

<div align="center">
  <sub>为希望获得 AI 辅助、同时保留科研主导权的研究者而做。</sub>
</div>
