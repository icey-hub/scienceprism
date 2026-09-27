# 写作子 Agent 真实流程验收（2026-09-27）

## 范围与复现资料

用已完成的[可解释图异常检测研究项目](../../aidoc/028127fc-3b3a-4b4b-93ec-02beb626d776/main.tex)建立两份内容相同的本地验收副本，保留先前阶段和 Evidence Ledger，将写作阶段设为待运行。原项目及论文未被重跑或改写。两份副本分别通过 SciencePrism `handoff-writing` 入口执行，模型均为 `gpt-5.6-luna`，Legacy 适配器，人工指令完全相同。调用严格串行。副本位于已忽略的 `data/`，单 Agent 项目 ID 为 `cc3b86de-f3ca-4786-a522-e3d6cbebc70b`，多 Agent 项目 ID 为 `205c2e9e-eaaa-49fe-bb7e-1dc040fd568c`。

项目实际生成的[单 Agent Brief](../../aidoc/writing-delegation-validation/single-agent-brief.md)、[多 Agent Brief](../../aidoc/writing-delegation-validation/multi-agent-brief.md)、[两份审查原文](../../aidoc/writing-delegation-validation/child-reviews.md)和[Run 数据快照](../../aidoc/writing-delegation-validation/run-comparison.json)保存在 `aidoc/`。快照只含投影后的运行记录、校验和用量，不含 API 密钥。

## 实际结果

耗时取首个 Run 的 `createdAt` 到最后一个 Run 的 `finishedAt`，是本次单例观测，不是性能基准。token 为供应商在每次 LangChain 模型调用中报告的用量，包含工具循环中的所有模型轮次。

| 模式 | Run 数 | 耗时 | 输入 token | 输出 token | 总 token | 写作输出校验 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 单 Agent | 1 | 33.904 秒 | 23,748 | 1,653 | 25,401 | 通过 |
| 多 Agent | 3 | 128.372 秒 | 155,760 | 6,058 | 161,818 | 通过 |

多 Agent 本次耗时为单 Agent 的 **3.79 倍**、总 token 为 **6.37 倍**。两者都停在写作阶段，阶段任务为 `awaiting_approval`、`humanDecision=null`；浏览器中的“下一阶段”不可用。两个 Brief 分别保留 3/4 条有引用的主张和 7/6 条未确认主张，均没有把实验结果声明为已经人工确认。

| 职责 | Run ID | 父 Run ID | 状态 | token |
| --- | --- | --- | --- | ---: |
| 单 Agent 写作 | `ff16d4a5-e980-4719-ba66-cb58a64aa746` | — | completed | 25,401 |
| 多 Agent：论断与证据审查 | `aa61c124-4636-4e41-843e-45cc0ebda997` | `5969e5b2-d862-4f3d-8e2d-58c835e20bfb` | completed | 53,507 |
| 多 Agent：方法与结论审查 | `5773f1fb-5ec8-4c59-ba04-02eded01e92c` | `5969e5b2-d862-4f3d-8e2d-58c835e20bfb` | completed | 85,435 |
| 多 Agent：协调写作 | `5969e5b2-d862-4f3d-8e2d-58c835e20bfb` | — | completed | 22,876 |

SciencePrism 写作页已目视核对两个子 Run 的 ID、状态、审查文本及 token，用量和协调 Run 同时展示；重新打开页面后仍能看到多 Agent 模式。多 Agent Brief 顶部记录了上述三个 Run 的来源。

## 审查价值与边界

两份审查正确指出：方法计划包括更多扰动和对照，而[实际执行脚本](../../aidoc/028127fc-3b3a-4b4b-93ec-02beb626d776/experiments/reddit_gcn_explain.py)只完成了小规模删边与随机删边对照；实验主 Run 的 Evidence 仍为 `pending`；单图、共享拓扑的三个 mask 和九个成功解释实例不能支持通用性能或解释真值。这些是模型意见，已与代码、账本和论文范围说明交叉核对，其中不少限制原文已经披露，不能把“被审查指出”写成新发现。

审查还提示局部两跳子图上的解释目标和全图检测目标需要严格区分。[现有论文](../../aidoc/028127fc-3b3a-4b4b-93ec-02beb626d776/main.tex)的方法已将 $c_v$ 定义在未遮蔽的局部图上；这条意见是对读者可能误解之处的提醒，尚未构成新实验结论。

模型仍会误报。第一次试运行曾声称 12 个候选节点中三个排除原因未记录，但论文附录和 `results.json` 均列明因局部子图超过 3,000 节点而跳过。加入“先核对可读项目文件”的审查提示后，这条误报没有在最终运行中重复；最终第二份审查又称可读的 `metrics.json` 为空，而本地该文件为非空、可解析的 738 字节 JSON。审查输出始终标为未经确认的意见，不能据此修改研究事实。

在首次试运行中，旧后端进程忽略 `agentMode=multi-agent`，只创建了一个 Run。检查 Run 谱系后发现问题，随后启动当前代码的独立 SciencePrism 实例并重新执行上述对照；旧进程结果未纳入表格。修改代码后需重启后端，重建静态前端后也需重启它以刷新静态文件清单。

## 结论

写作阶段的串行委派、父子 Run 持久化、人工确认和证据校验已通过真实模型与浏览器验收。对这个单项目，额外审查带来有用的范围提醒，也产生误报和显著 token 成本。因此保留写作阶段的显式可选模式，暂不推广到其他阶段；后续若扩展，应先改善可访问的证据摘要并在更多项目上评估审查收益。
