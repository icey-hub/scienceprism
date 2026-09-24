# 迭代日志（200 轮预算 · 加 / 减 / 验证 三拍循环）

> 每拍一行：编号、拍型、变更、验证证据。
> 拍型：**加** = 引入能力；**减** = 删除/收缩冗余；**验证** = 可执行证据 + 回归。
> 硬要求：「减」拍必须真实删除东西，并说明为什么安全；只增不减不算通过。
> **提交约定**：每条 commit 的标题带 `iter-NNN`，可用 `git log --grep iter-NNN` 定位。

## 节奏映射（Round 1，迭代 001–010）

| # | 拍型 | 内容 | 状态 |
| --- | --- | --- | --- |
| 001 | 加 | 基线提交 + tag + 分支 + 治理脚手架（需求/计划/看板/任务书） | ✅ |
| 002 | 加 | 第二隔离策略（Node 权限模型）+ 策略选择 + 隔离方式记录 | ✅ |
| 003 | 减 | 清虚高与死 seam：`project.write` 声明、`assertNetworkHost` 未接线 | 🔄 |
| 004 | 验证 | 验证 002–003：全量测试 + 边界自检 + 记录 | ⬜ |
| 005 | 加 | 约束注册表骨架（零行为变更）+ 审计文档 | ⬜ |
| 006 | 减 | 收敛 `project-constraints.json` 的 4 处重复默认值 + 第 5 个读写点 | ⬜ |
| 007 | 验证 | 验证 005–006 + 文档一致性门禁 | ⬜ |
| 008 | 加 | 约束策略与可选开关（tier：core 不可关） | ⬜ |
| 009 | 减 | 删 prompt 假约束与装饰性重复（`paper_screening` 角色、无溯源兜底草稿） | ⬜ |
| 010 | 验证 | Round 1 收尾 + `rounds/round-01-comparison.md` + 推 scienceprism | ⬜ |

## 逐拍记录

| # | 拍型 | 变更摘要 | 验证证据 |
| --- | --- | --- | --- |
| 001 | 加 | 基线提交、tag `round-00-baseline`、分支 `feat/agent-governance-r1`、治理脚手架 | `git diff round-00-baseline..HEAD -- apps/ packages/` 无输出（零产品代码改动） |
| 002 | 加 | `adapters.js`：新增 Node 权限模型回退（`nodePermissionCommand`）、纯函数 `chooseIsolationStrategy`、`isOsSandboxApplicable`；`index.js`：Run 记录 `execution.isolation` | `npm run quality` → 44 项测试通过 / 0 失败、tsc 通过、vite build 通过、exit 0。新增 4 项测试：隔离记录、策略选择表（5 组）、回退策略真实越权拒绝（读 `/etc/hosts` → `ERR_ACCESS_DENIED`；工作区内写入成功）、OS 沙箱可用性报告 |
| 003 | 减 | （进行中） | — |

## 环境变化记录

- 本轮会话的文件策略从 `workspace-write` 变为 `danger-full-access`，外层沙箱撤掉后 `/usr/bin/sandbox-exec` 恢复可用（exit 0），因此基线 4 个红测试**在无代码改动时即转绿**。迭代 002 的价值因此改为：让 Runner 在 OS 沙箱**不可用**的环境（容器 / CI / 嵌套沙箱）仍能执行，并把实际使用的隔离方式记录下来。
