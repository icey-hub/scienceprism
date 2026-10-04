# 本轮工作台里程碑任务约定

## 目标
在现有编辑器中完成首个可用里程碑：统一普通助手任务生命周期，支持上下文、真实停止、刷新恢复与重试；修改提案关联文稿版本，经统一应用接口审阅，拒绝覆盖用户的新修改。

## 非目标
本轮不迁移 Skill 目录、不收缩默认导航、不完成编译/引用闭环，不删除研究阶段或多 Agent 数据；这些属于 T06-T12。

## 写入边界
允许修改：
- `apps/backend/src/routes/agent.js`
- `apps/backend/src/routes/harnessRuns.js`
- `apps/backend/src/services/agentService.js`
- `apps/backend/src/services/agentRuntime.js`、`assistantService.js`、`assistantReply.js`
- `apps/backend/src/services/harnessRuntime/`
- `apps/backend/src/routes/projects.js` 中与助手应用互斥的文件保存路径
- `apps/backend/src/services/collab/docStore.js` 的已有保存与外部修改同步接线：防止定时保存覆盖助手应用，不增加协作功能
- `apps/backend/test/` 中与助手、Run、修改应用直接相关的测试
- `apps/frontend/src/` 中编辑器助手 / 修改审阅及其客户端接口文件
- `tasks/` 与 `docs/agent-governance/` 的本轮进度记录

不得触碰：
- `.dsh/skills/` 与研究阶段实现（T06 以后）
- 实验、绘图、OCR、协作专用能力
- 用户已有数据与无关工作树改动

## 验收标准
1. 普通问答与修改共用一个可查询、可取消、可重试的 Run 生命周期，取消会到达执行器。
2. 任务输入记录参与任务的文稿版本与必要上下文，前端不再发送重复的整项目文本。
3. 提案接受只能走统一应用接口；服务端预检版本冲突并保留用户的新内容；重复应用幂等，多文件失败有可恢复记录。
4. 聚焦测试、类型检查、构建与真实浏览器 / API 证据通过；未执行项明确记录。

## 当前进度 / 下一步
- 已验证基线：172 项后端测试、类型检查、前端构建通过。尚未完成三类真实任务基线与浏览器验收。
- 当前切片：Run 上下文和工具读取保留文件基线，应用先全量预检，再持久化恢复记录；重复应用不重复写入。
- 当前接线：前端已接入持久 Run 面板、服务端提案审阅和草稿版本；2026-10-03 的 npm run typecheck（bash-5134）退出 0。仍需运行期验收保存、停止、恢复与冲突。
- 原后端普通子任务目标已不可访问（send_message 返回 not found），未取得可验证结果；重新分配后端范围，Lead 继续前端与应用事务审查。
- 下一步：完成生命周期和编辑器接线 → 保存/停止/恢复/冲突浏览器验收 → quality → 治理记录与本地提交。
- 分工：Lead 独占前端、tasks 与治理文档；普通子 agent 只改后端 assistantService、assistantReply、harnessRuntime 生命周期/Context Pack、agent 路由及对应测试。不得触碰前端、治理、用户数据、patchApplication 和 git 写操作；完成后由 Lead 审查最终差异与统一验证。
- 执行记录：本轮已加载 incremental-implementation、api-and-interface-design、git-workflow-and-versioning、security-and-hardening、ponytail、writing-for-agents；复用已读内容。基线命令 npm test / npm run typecheck / npm run build 已成功，不因恢复会话重复执行；代码变更后的验证另记。
