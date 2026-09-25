# SciencePrism

<img src="static/logo-rotating.gif" alt="SciencePrism 标志" width="180">

面向个人本地使用的科研与 LaTeX 工作台。你可以在同一个项目里整理研究问题、检索和筛选论文、记录证据与实验计划，再进入文稿编辑器。AI 用于提出建议和生成草稿；阶段确认、实验执行和文件改动仍由你决定。

[English](README.md)

## 快速开始

本仓库在 Node.js 26 上验证过；项目没有声明更低版本的兼容范围。安装依赖后启动前后端：

~~~bash
npm ci
npm run dev
~~~

在浏览器打开 http://localhost:5173。前端开发服务器使用 5173 端口，后端 API 使用 8787 端口。进入「项目」创建项目，可选模板，然后填写研究问题；项目概览会给出进入研究流程和编辑器的入口。PDF 编译需要本机安装 LaTeX 引擎，例如 Tectonic 或 TeX Live。

如果要分别启动：

~~~bash
npm run dev:backend
npm run dev:frontend
~~~

## 模型设置

不配置模型也能创建项目、管理文件和编辑文稿。使用 AI 功能时，在编辑器的「工作区设置」填写 OpenAI 兼容端点、模型和 API Key。该设置保存在当前浏览器的 localStorage 中。

也可以在启动后端前设置环境变量，作为请求未提供相应字段时的后备值：

~~~bash
export SCIENCEPRISM_LLM_ENDPOINT=https://example.com/v1
export SCIENCEPRISM_LLM_MODEL=your-model
export SCIENCEPRISM_LLM_API_KEY=your-key
npm run dev
~~~

后端的 `npm run dev` 不会自动读取仓库根目录的 `.env`。如果使用 `.env`，请先在 Shell 中加载；不要把密钥提交到 Git。编辑器 Agent Tools 的默认运行时是 Legacy LangChain；DeepSeek Harness 是可选运行时，需要单独配置 SDK，见 [DeepSeek Harness 说明](docs/deepseek-harness.md)。

## 实际工作流程

研究流程依次包含方向、检索、筛选、可选复现、创新点、方法、实验和写作。当前论文检索实现了 arXiv 来源；检索结果和 AI 建议需要你确认。实验计划与实验运行分开，运行前还需要单独批准并授予项目执行能力。

项目内主要入口：

- 项目概览：`/project/:projectId`，查看当前阶段、任务和下一步。
- 研究阶段：`/editor/:projectId/research/:stage`，逐阶段记录决定。
- 文稿编辑：`/editor/:projectId`，编辑 LaTeX、编译并预览 PDF。
- 项目资料、任务、证据与设置：通过项目导航进入。

完整规则见 [研究流程](docs/research-workflow.md)、[Harness Runtime](docs/harness-runtime.md)、[实验运行](docs/experiment-runner.md) 和 [证据账本](docs/evidence-ledger.md)。

## 数据与命令

项目默认保存在仓库的 `data/`（已被 Git 忽略）；可在启动前用 `SCIENCEPRISM_DATA_DIR` 指定其他目录。项目的工作流、证据和运行记录保存在各项目的 `.scienceprism/` 下。仓库的 `aidoc/` 存放已提交的科研示例产物，与个人项目数据分开。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动前后端 |
| `npm test` | 运行后端测试 |
| `npm run typecheck` | 检查前端 TypeScript |
| `npm run build` | 构建前端 |
| `npm run quality` | 测试、类型检查、构建和图表布局检查 |

完整质量检查需要 Chrome；在非默认安装路径下设置 `SCIENCEPRISM_CHROME` 为浏览器可执行文件路径。

更多项目背景见 [领域上下文](CONTEXT.md)、[项目约束](docs/project-constraints.md) 和 [架构实施记录](docs/architecture-roadmap.md)。开发过程与历史迭代另见 [治理记录](docs/agent-governance/README.md)。
