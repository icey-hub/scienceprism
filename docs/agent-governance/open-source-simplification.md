# 开源借鉴：收缩成实用的科研 / LaTeX 编辑核心

核对日期：2026-10-02。本文是 agent 内部研究记录；不是 SciencePrism 运行生成的科研产物。
本次只读官方文档与公开源码，没有安装候选项目、调用模型或进行部署 / 性能对照。
目标来自用户的当前反馈：功能太多、华而不实，实际操作不如 Codex + skill 顺手。

## 结论

建议保留一个清晰的操作闭环：**打开论文 → 选中内容 / 描述任务 → 看修改差异 → 接受 → 编译定位错误**。
围绕这个闭环改善 skill 可用性、上下文与取消行为；高级研究流程继续作为可选入口。
三个项目分别贡献一个可借鉴部分，均不建议整体迁入或按其功能清单扩建。

| 项目 | 优先借鉴 | 不照搬 | 核实的许可 | 证据 |
| --- | --- | --- | --- | --- |
| Aider | 明确可编辑文件、小上下文、局部差异编辑 | 双模型模式、整套 repo graph、自动提交 | Apache-2.0 | [上下文](https://aider.chat/docs/repomap.html)、[编辑格式](https://aider.chat/docs/more/edit-formats.html)、[许可证](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt) |
| OpenCode | skill 摘要发现、按需进入对话、可取消运行协调 | 全量 Agent 平台、全部客户端、直接引入 Effect 架构 | MIT | [skill 文档](https://opencode.ai/docs/skills/)、[运行协调源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/run-coordinator.ts)、[许可证](https://github.com/anomalyco/opencode/blob/dev/LICENSE) |
| TeXlyre | 编辑 / PDF 的连续操作、源码定位、功能按文件类型出现 | 协作、备份、Typst、多编译引擎与插件体系一起搬入 | AGPL-3.0-or-later | [官方 README](https://github.com/TeXlyre/texlyre)、[package.json](https://github.com/TeXlyre/texlyre/blob/main/package.json)、[许可证](https://github.com/TeXlyre/texlyre/blob/main/LICENSE) |

以下分别区分上游已核实的实现与针对本项目的建议；建议不代表已经开发或验证。

## 1. Aider：把编辑任务与上下文压小

已核实：官方文档用相关文件加紧凑 repository map 建立上下文；map 受 token 预算控制。
文档还明确不建议把所有文件加入对话。[Repository map](https://aider.chat/docs/repomap.html)、[FAQ](https://aider.chat/docs/faq.html)
编辑格式中 `diff` 只输出 SEARCH / REPLACE 块；`whole` 要返回完整文件，文档指出其成本与速度代价。[Edit formats](https://aider.chat/docs/more/edit-formats.html)
源码 `RepoMap.get_repo_map` 区分对话文件与其他文件；`get_ranked_tags_map_uncached` 按预算选取摘要。[repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
`EditBlockCoder.apply_edits` 记录成功 / 失败的块，并把失败的匹配信息回传；存在 dry-run 入口。[editblock_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_coder.py)

对本项目的建议：

- 默认传选区、当前文件附近正文、相关 `\input` / `\include` 路径与相关 BibTeX 条目；更多全文由只读工具获取。
- 编辑器显示当前已包含的文件 / 选区，用户可明确追加；后台继续执行既有路径、能力与证据边界。
- 延用本项目现有局部 patch 机制，优先产出有路径、原文和替换文本的提案，再呈现差异和接受操作。
- 原文匹配多处、文件版本变化、路径不一致时明确报冲突；重新读取当前文件后再生成提案。
- 短论文项目先用文件树、章节标题与引用关系；只有测出上下文检索瓶颈后才考虑完整符号图。

不照搬的具体原因：Aider 源码含向其他已加入文件寻找匹配、缩进宽容匹配等恢复策略；科研文件应先保证改动对象明确。
这些策略不能当作本项目“唯一匹配、路径固定、所有改动原子应用”的现成保证。[editblock_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_coder.py)
官方 architect 模式可使用两个模型；这与本机共享网关和当前减功能目标不匹配。[Chat modes](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/modes.md)

## 2. OpenCode：skill 是任务说明，运行生命周期可收束

已核实：skill 文档要求 `SKILL.md` 的 `name` / `description`，提供可用摘要，并由 `skill({ name })` 把正文带入对话。
文档支持按 skill 名称控制权限，拒绝的 skill 不进入可用列表。[Agent Skills](https://opencode.ai/docs/skills/)
`tool/skill.ts` 先查 skill，再执行 `permission.assert`，随后输出正文、基准目录和最多 10 个资源路径。
资源路径列表不等于把所有附属文件内容一起塞入上下文。[skill 工具源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/skill.ts)
这里的“按需”指进入模型对话的时机；没有据此断言所有磁盘内容也到使用时才读取。
`SessionRunCoordinator` 同 key 运行复用现有执行，合并后续唤醒；停止时清除待唤醒标记并中断 owner fiber。
接口定义要求等待执行清理。[run-coordinator.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/run-coordinator.ts)

对本项目的建议：

- 编辑器与研究页使用同一份可用 skill 目录；默认提供摘要，只有匹配任务或用户选定时读取正文。
- 用户最常用的润色、编译排错、引文核对可作为 skill 选择；少造一个永久角色或独立页面。
- 保留现有 role / capability 校验；加载一个 skill 只增加任务说明，不应扩大写入或执行权限。
- 取消操作贯穿 UI → HTTP 请求 → Harness → 模型调用 → 工具；停止后不再启动下一工具或下一模型请求。
- 重复点击同一项目任务应复用或明确拒绝正在运行的任务，避免表面停止后后台继续生成。

上游协调器允许不同 key 并发，**不是全局模型串行器**；本项目需继续遵守共享网关单发规则。
可以借其状态和清理原则，以现有 Promise / AbortController 完成最小实现；不必引入其全部 Effect service / layer。
这两条属于针对本项目的适配判断，来源是协调器源码与本仓库 U-20，而非上游提供的部署保证。

## 3. TeXlyre：借编辑连续性，避免再造“大平台”

已核实：官方 README 描述浏览器编译、并排编辑 / PDF、编译日志与 SyncTeX；离线依赖仍需首次取得。
它同时包含协作、评论、审阅、备份、多种插件和 Typst，因此不能把整个项目称为“极简实现”。[README](https://github.com/TeXlyre/texlyre)
`Editor.tsx` 依据文件类型展示操作，源码中保存、格式化、源码定位按钮与编辑器当前状态相连。
它也包含插件、评论和审阅分支，适合参考局部交互，整页复制会重新引入复杂性。[Editor.tsx](https://github.com/TeXlyre/texlyre/blob/main/src/components/editor/Editor.tsx)
`LaTeXSourceMapService` 独立处理映射的装载、可用性、正反向定位与清空；解析失败时清空数据并通知监听器。[LaTeXSourceMapService.ts](https://github.com/TeXlyre/texlyre/blob/main/src/services/LaTeXSourceMapService.ts)

对本项目的建议：

- 让编辑、修改差异、编译错误、PDF 预览在同一工作台完成，减少切页和重复选择项目。
- 保存状态、编译运行状态与“该 PDF 对应哪个源码版本”清楚可见，避免新源码配旧 PDF。
- 沿用现有编译红线和错误跳转，先处理第一条真实编译错误；源码变化后及时清掉过期诊断。
- AI 的“修复编译错误”只提局部修改，接受后再编译；不把成功生成文本显示为成功编译。
- 保持本项目已有 Tectonic 路径；浏览器 WASM、多引擎与 SyncTeX 只有真实需求出现时再比较。

TeXlyre 的源码映射是可参考的模块边界；本次未验证其编译器与本项目字体、模板或后端环境兼容。
不建议因此增加协作协议、插件市场、Typst、云备份或新的编译引擎。

## 4. 与当前代码的衔接

本项目已有能力边界、局部 patch、研究 skill 正文读取和有预算的 context pack，适合收口现有能力。
核对入口：[agentService.js](../../apps/backend/src/services/agentService.js)、[researchSkills.js](../../apps/backend/src/services/researchResearch/researchSkills.js)、[contextPackager.js](../../apps/backend/src/services/harnessRuntime/contextPackager.js)。
本次读取时，`read_research_skill` 仅在传入启用列表非空时进入工具；提示只列名称，编辑器未自动得到研究阶段绑定。
因此“仓库有 skill”与“当前编辑任务能发现并使用 skill”是两件事；先修可达性再增加 skill 数量。
当前 skill 格式要求 `stages`，不能直接假设任意外部 `SKILL.md` 即可被产品发现；兼容迁移需单独验收。
本轮已修复 Legacy adapter 到 `AgentExecutor.invoke`、模型与 arXiv 工具的取消传递；按已授予能力提供工具，记录 Skill 工具事件并停止吞掉工具错误。还移除了 Legacy / Fake 不使用的工作区复制、Context Pack 外的重复输入，并保留降级运行预算与用量。
核对入口：[legacyAdapter.js](../../apps/backend/src/services/harnessRuntime/adapters/legacyAdapter.js)、[agentService.js](../../apps/backend/src/services/agentService.js)、[Harness Runtime](../../apps/backend/src/services/harnessRuntime/index.js)。
以上修复由实际 LangChain / OpenAI SDK 配合模拟 HTTP 验证；完整质量门禁通过 172 项测试。编辑器通用 Skill 发现、界面收缩与真实模型质量对照仍未完成，详见[当前状态](README.md)。

建议按收益排队：

1. 在已修复取消传递的基础上，改善 skill 摘要可读性和编辑器可达性；以实际任务与失败路径验证。
2. 将首屏聚焦编辑 / 对话 / PDF，研究流程和复杂设置作为按需入口；保留原数据。
3. 统一聊天中返回文本、局部 patch 和编译反馈的交付体验；不新增第二套 patch owner。
4. 以三类常见任务评估：润色一段、修一条编译错误、核一条引用；记录完成时间与人工返工。
5. 只有上述任务显著受限，才考虑更复杂的检索、协作或 Agent 委派。

## 5. 许可与证据边界

许可类型已逐项查官方文件；本次没有复制任何上游代码，也没有确认本项目的最终发布许可。
Aider 的 Apache-2.0 允许复用但须遵守第 4 节的许可证、修改标识及适用 NOTICE / attribution 义务。[LICENSE.txt](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt)
OpenCode 的 MIT 要求复制或实质复用时保留版权与许可声明。[LICENSE](https://github.com/anomalyco/opencode/blob/dev/LICENSE)
TeXlyre 的 package 与源码头写明 AGPL-3.0-or-later；README 简写 AGPL-3.0。[package.json](https://github.com/TeXlyre/texlyre/blob/main/package.json)、[App.tsx](https://github.com/TeXlyre/texlyre/blob/main/src/App.tsx)
若复用并修改 AGPL 受保护程序且向用户提供网络交互，第 13 节要求提供取得对应源码的机会；不能按 MIT 组件处理。
本轮只参考其交互与边界，具体复制或组合前另核许可兼容性与受保护作品范围。[LICENSE 第 13 节](https://github.com/TeXlyre/texlyre/blob/main/LICENSE)

- 文档与源码来自 2026-10-02 可访问的上游 main / dev 页面；分支会变化，正式复用时需固定 commit 和许可快照。
- 读取了 Aider 编辑 / map、OpenCode skill / 运行协调、TeXlyre 编辑器 / source map 源码；不冒称完整审计。
- TeXlyre 的 `LaTeXService.ts` / `GenericTypesetterService.ts` 正文抓取失败，未据其内部实现作断言。
- 没有部署候选项目、验证离线首开、中文字体、资源占用或模型质量；“更适合本项目”是基于目标的判断。
- 不用 star 数、宣传评价或二手文章作为质量证据；上游能力存在也不等于本项目接入后可靠。
