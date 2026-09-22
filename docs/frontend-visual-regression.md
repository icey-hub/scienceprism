# Frontend Visual Regression Scenarios

阶段九使用以下稳定 URL 作为手工或后续自动化视觉回归场景。场景只验证布局、状态可见性和跨页面导航，不提交项目数据、不启动实验，也不应用 AI Patch。

| 场景 | URL | 关键断言 |
| --- | --- | --- |
| 项目初始化 | `/project/:projectId` | 首次使用表单、研究问题输入、约束选项和保存入口可见 |
| 项目驾驶舱 | `/project/:projectId` | 阶段进度、审批、风险、最近运行和下一步入口不溢出 |
| 约束投影 | `/project/:projectId/settings` | 能力、路径、网络、Token 预算和超时来自后端投影 |
| 审批收件箱 | `/project/:projectId/approvals` | 待审批数量、缺失字段和阶段入口可见 |
| Harness 控制台 | `/project/:projectId/runs` | 空态、运行状态、事件、Patch、恢复/重试/人工决定入口可见 |
| Evidence 链 | `/project/:projectId/evidence` | 主张状态、Evidence 节点和关系数量可读 |
| 研究阶段 | `/editor/:projectId/research/direction` | 阶段导航、人工门禁、上下文和编辑器返回入口不遮挡 |
| 编辑器 Diff/PDF | `/editor/:projectId` | 文件树、编辑区、Diff 应用/拒绝和 PDF 预览保持稳定 |

验证记录应包含视口、项目是否已初始化、后端投影是否为空、是否存在运行中任务以及截图或 DOM 断言结果。
