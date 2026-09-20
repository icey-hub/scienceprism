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

科研流程和原有项目、编辑器共用同一套工作区。每个阶段都有独立界面和 URL，状态及审计事件保存在项目内的 `.openprism/research-workflow.json` 中（运行时保留 `OPENPRISM_*` 前缀以兼容现有配置）。

1. **研究方向** —— 输入研究问题、范围、约束和验收标准。
2. **论文检索** —— 在人工方向基础上扩展可追溯的论文查询和结果。
3. **论文筛选** —— 执行服务端质量门禁，例如 CCF 期刊/会议要求，再由人勾选需要的论文。
4. **论文复现** —— 可选地记录和评估已选论文的复现实验计划。
5. **创新点** —— 由 DeepSeek Harness 提供多个有证据依据的创新候选，人来决定保留哪个方向。
6. **方法设计** —— 对比 AI 辅助的方法方案，由人确认最终方法。
7. **实验验证** —— 审查数据集，定义命令和评价标准，记录已批准的实验方案。
8. **论文写作** —— 将经过确认的证据、决策和结果交给原有 LaTeX 写作工作区。

页面跳转不等于获得授权。后端会强制执行阶段顺序、论文质量门禁、人工确认和审计记录。当前实验阶段只记录经过确认的方案，不会执行任意 Shell 命令。

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

在 Workspace Settings 中将 **Agent Runtime** 设置为 **DeepSeek Harness**。SciencePrism 会自动探测标准本地 SDK 路径，也可以手动指定：

```text
OPENPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
```

可选运行参数包括 `OPENPRISM_HARNESS_PROFILE`、`OPENPRISM_HARNESS_PROVIDER`、`OPENPRISM_HARNESS_MAX_TOKENS` 和 `OPENPRISM_HARNESS_TIMEOUT_MS`。Harness 无法启动时，默认回退到原有 LangChain 运行时；设置 `OPENPRISM_HARNESS_FALLBACK=false` 可关闭回退。

每次 Harness 请求都运行在项目临时副本中，文本修改以待确认 Diff 返回，只有用户应用 Diff 后才会改变原项目。

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
export OPENPRISM_CCF_VENUE_CATALOG_JSON='{"NeurIPS":"CCF-A","SIGIR":"CCF-A"}'
```

目录只是元数据适配器，不能覆盖年份、同行评审、代码要求或人工确认失败的结果。完整规则见 [docs/research-workflow.md](docs/research-workflow.md)。

## 项目文档

- [科研流程说明](docs/research-workflow.md)
- [科研 Skill 说明](docs/research-skills.md)
- [DeepSeek Harness 集成](docs/deepseek-harness.md)

## 隐私和安全

SciencePrism 按本地优先设计。API key、PAT、密码、证书和私有数据集应始终留在 Git 之外。只在本机使用 `.env` 文件，提交前检查 `.gitignore`；任何已经暴露的凭据都应立即撤销并重新生成。

<div align="center">
  <sub>为希望获得 AI 辅助、同时保留科研主导权的研究者而做。</sub>
</div>
