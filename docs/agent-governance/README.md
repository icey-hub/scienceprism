# Agent Governance — 迭代看板

> **这是本目标（`goal-1475d1ce`）的唯一进度事实源。**
> 新会话恢复时：先读本文件 → 再读仓库根 `AGENTS.md` → 然后按「恢复协议」继续。
> 每次迭代收尾必须更新本文件的迭代表与「当前状态」。
> agent 产出的一切文档都在 `docs/agent-governance/`；`docs/` 是项目自身文档，不要混。

## 迭代前检查清单（每次迭代必做）

1. 读 `requirements.md`（需求有没有新增/变化）→ 读 `plan.md`（本次迭代的产出与验收）→ 读本文件「当前状态」。
2. 若属子 agent 线，读 `subagents/<线>.md` 的独占写范围与硬约束，确认本次要改的文件都在授权范围内。
3. **派子 agent 前先查存活数：≥2 就先等已有子 agent 结束再派（U-16）；≤1 才可派，且一次只派 1 个。**
4. 核对 git 现实：`git branch --show-current`、`git log --oneline -3`、`git status --short` 与看板记录一致；不一致先对齐再动手。
5. 重跑基线：`node --test apps/backend/test/*.test.js`，以**实测**为准，不相信记录里的旧数字。
6. 动手；收尾跑 `npm run quality`，更新本文件迭代表 + 「当前状态」，单独提交。

## 停止条件

`done` = Round 1（I-01…I-10）与 Round 2（I-11…I-20）全部完成，且每轮各有：
对比文档、`npm run quality` 全绿、分支已推 `scienceprism`、PR 留待人工审。
其余状态：`blocked`（缺依赖/权限/信息）、`needs-verification`（实现有但证据不足）、`scope-exceeded`（继续会越过非目标）。

## 决策记录（用户已确认）

| ID | 决策 | 结果 |
| --- | --- | --- |
| D-1 | 解除 `.gitignore` 对 `AGENTS.md` 的忽略并入库 | ✅ 已执行 |
| D-2 | MCP：本轮放弃 | ✅ 采纳（无任何 MCP 胜出；配置还须写工作区外） |
| D-3 | 开发侧 skill 放 `docs/agent-governance/playbooks/` | ✅ 采纳 |
| D-4 | Round 2 从 r1 尖端切出 | ✅ 采纳 |
| D-5 | 接受 `core` 级约束不可关（tier 模型） | ✅ 采纳 |
| D-6 | Round 1 收口 4 处高危绕过 | ✅ 采纳（默认转 fail-closed） |
| U-01…U-16 | 用户追加要求（子 agent 上限与**等待规则**、写边界、必读文档、`docs/agent-governance/` 目录、**未获指示不得执行**） | 见 `requirements.md` 第二节（单一事实源，不在此重复） |

## 子 agent 分工与派发规则

写范围互不重叠：

| 线 | 负责迭代 | 独占写范围 |
| --- | --- | --- |
| 约束线 | I-03 / I-04 / I-05 / I-06 | `apps/backend/src/services/constraintRegistry/**`、`apps/backend/test/constraintRegistry.test.js`、`docs/agent-governance/constraint-audit.md` |
| 角色线 | I-07 / I-08 | `apps/backend/src/services/agentRoles/**`、`apps/backend/test/agentRoles.test.js`、`docs/agent-governance/agent-roles.md` |
| 绘图线 | I-11 / I-12 / I-13 / I-14 | `tools/diagram/**`、`docs/agent-governance/assets/diagrams/**`、`docs/agent-governance/drawing-*.md`、`scripts/setup-diagram-toolchain.sh` |

派发规则（U-13 / U-16，硬约束）：**先查存活数；≥2 就先等已有子 agent 结束；≤1 才可派，一次只派 1 个。**
子 agent 不得执行 git 写操作。

Lead 独占：`package.json`、`.gitignore`、`AGENTS.md`、本文件、`docs/project-constraints.md`（产品侧生成物，属项目文档）、4 处高危绕过所在的路由、以及全部 git 生命周期操作（分支/提交/推送）。

## Round 0 基线（实测，tag `round-00-baseline`）

| 指标 | 值 |
| --- | --- |
| 后端测试 | 40 项：**36 通过 / 4 失败**（全在 `experimentRunner.test.js`） |
| 前端类型检查 | 通过 |
| 约束条数 | 16（C-01…C-16） |
| 产品 skill | 6 |
| ADR / docs | 9 / 11 |
| 后端源码 | 12,065 行 / 16 路由 / 11 服务模块 |
| 前端源码 | 10,601 行 / 42 文件 |
| 显式角色定义 | 0 |
| 约束开关 | 不存在 |
| 文档绘图 | 无 diagram 依赖；无 SVG 资产 |

## Round 1 — `feat/agent-governance-r1`

| # | 迭代 | 状态 | 证据 |
| --- | --- | --- | --- |
| I-01 | 基线提交 + tag + 分支 + 治理脚手架 | ✅ 完成 | commit `33a2b5b`、tag `round-00-baseline`、`AGENTS.md`、`docs/agent-governance/` 全套（需求/计划/看板/三份任务书） |
| I-02 | 修复 4 个红测试至 40/40 | 🔄 进行中（**代码未落地**） | 根因：`experimentRunner/adapters.js:40 probeSandboxApplicability()` 在本机必失败（`sandbox-exec` exit 71）。已实证 Node 权限模型可作第二隔离策略 |
| I-03 | 约束审计结论落文档 + 逐条复核 | ⬜ 未开始 | 取证已完成（16 条：9 条仅部分生效、2 条直接矛盾、2 处 AI 主观添加） |
| I-04 | 约束注册表骨架（零行为变更） | ⬜ 未开始 | — |
| I-05 | 约束策略与可选开关 + tier 分级 | ⬜ 未开始 | — |
| I-06 | 4 处高危绕过收口 + 约束测试门禁 | ⬜ 未开始 | — |
| I-07 | 角色注册表（8 角色） | ⬜ 未开始 | 取证已完成（8 角色分类法可直接验证落地） |
| I-08 | 角色接入 Harness Runtime | ⬜ 未开始 | — |
| I-09 | 产品 skill 补齐 3 个 | ⬜ 未开始 | — |
| I-10 | Round 1 收尾 + `rounds/round-01-comparison.md` + 推 scienceprism | ⬜ 未开始 | — |

## Round 2 — `feat/agent-governance-r2`（从 r1 尖端切出）

| # | 迭代 | 状态 |
| --- | --- | --- |
| I-11 | 绘图候选取证（含复杂插画能力维度） | ⬜ 未开始 |
| I-12 | 参考图集（架构图 / 时序图 / **细胞结构图** / 对比图表）+ 渲染脚本 | ⬜ 未开始 |
| I-13 | 绘图对比实验（9 维打分，产物并排提交） | ⬜ 未开始 |
| I-14 | 选定主方案 + 封装 `doc-diagram` skill + CI 可复现校验 | ⬜ 未开始 |
| I-15 | 约束建议 API（结构化提案，不执行代码） | ⬜ 未开始 |
| I-16 | 约束代码生成器（提案 → 真实代码 + 测试，待确认 Patch） | ⬜ 未开始 |
| I-17 | 前端约束建议面板 + 溯源显示 + i18n | ⬜ 未开始 |
| I-18 | 端到端验收（对话→提案→批准→生效→拦截→禁用放行） | ⬜ 未开始 |
| I-19 | 角色/约束可见性 + 文档同步 | ⬜ 未开始 |
| I-20 | Round 2 收尾 + `rounds/round-02-comparison.md` | ⬜ 未开始 |

## 当前状态

**阶段：Round 3 进行中（迭代 021–030）。**

- **Round 3 进度**：021 ✅ 复杂矢量插画级绘图方案；022 ✅ **减**：删掉一半不可达的 skill 绑定 + 孤儿 skill；023 ✅ **验证**：绘图产物接可复现门禁 + 回填 R-12/R-13；024 ✅ **加**：产品侧 skill 补齐（5 → 8 个）+ 技能集锁；025 ✅ **减**：开发侧 playbook 落地 + `.dsh/skills` 隔离门禁；026 ✅ **验证**：门禁 exit 0、零依赖变更、越界复查通过；027 ✅ **加**：收口 C-07——实现人工确认的 Patch 应用路径（漂移 **5 → 4**）；028 ✅ **减**：删死代码（零引用导出 **9 → 2**，含整个 `deepseekHarnessService.js`）；029 ✅ **验证**：门禁 exit 0、漂移 4、越界复查通过；下一步 030（Round 3 收尾 + 对比文档）。
- **剩余漂移 4 条**：C-04（actor 自报）、C-09（`assertNetworkHost` 未接进 Harness 路径）、C-10（legacy 适配器不接收 limits）、C-11（不确定性字段全为可选）。
- **目标 ③ 已闭环**：产品侧 8 个 skill（全部绑到真正会跑 Harness 的 4 个阶段）+ 开发侧 2 份 playbook（`playbooks/adding-a-constraint.md`、`playbooks/verification-discipline.md`），并有隔离门禁防止两者混放。
- **越界事故已闭环**：我因脚本路径写错，曾把 4 张图写到**工作区外**的 `/Users/icey/Desktop/project/prism-code/docs/`；根因已修（`REPO_ROOT` 层级），并在**取得用户明确授权后**删除该目录，复查无残留、父目录完好。
- **skill 可达性已成为不变量**：3 项门禁测试锁住「声明可达阶段 == 代码实际调用」「绑定不得指向不跑 Harness 的阶段」「每个捆绑 skill 必须可达」。
- **绘图结论**：主方案 = **手写 SVG**。它是本机约束下唯一同时满足「能画复杂插画 + 零安装 + 离线 + 中文直出 + 可 diff + 不越界写缓存」的方案。产物在 `docs/agent-governance/assets/diagrams/`，详见 `drawing-comparison.md`。
- **剩余待办**：目标 ③ skill 补齐；目标 ⑤ `aidoc/` 落点策略；剩余 5 条漂移（C-04/C-07/C-09/C-10/C-11）。
- 会话内 goal：`goal-16c676ec`（armed，200 轮预算，已用 22 拍）。

- 子 agent 机制实测：6 次派发 5 次失败，且存活者无法从 Lead 侧终止；因此**以 Lead 串行为主**（U-15），派发前先查存活数（U-16）。

## 历史轮次（细节见各自对比文档）

| 轮次 | 分支 | tag | 对比文档 | 关键结果 |
| --- | --- | --- | --- | --- |
| Round 1（001–010） | `feat/agent-governance-r1` | `round-01-complete` | `rounds/round-01-comparison.md` | 测试 40（36 通过 / 4 失败）→ 51 全通过；工具首次产出文档 `aidoc/aidoc-research-document/research/writing-brief.md`；能力词表 5 → 4；阶段契约 8 → 7；约束默认值来源 5 → 1；无溯源兜底草稿 2 → 0 |
| Round 2（011–020） | `feat/agent-governance-r2` | `round-02-complete` | `rounds/round-02-comparison.md` | 测试 51 → 78；约束注册表落地且 16/16 有测试；漂移 9 → 5；角色 0 → 8 并接入 Runtime；高危绕过 1 fail-closed / 2 可拒绝 / 1 降级；零依赖变更 |

Round 1 的 PR 待你审：https://github.com/icey-hub/scienceprism/pull/new/feat/agent-governance-r1

## 剩余待办（进入 Round 3）

- **剩余 5 条漂移**：C-04（actor 自报，无法区分 AI 与人类）、C-07（**无 Patch 应用接口**）、C-09（`assertNetworkHost` 未接进 Harness 路径）、C-10（legacy 适配器不接收 limits）、C-11（不确定性字段全为可选）。
- **约束审计结论**：16 条中 13 core / 3 standard；**2 处疑似 AI 主观添加**（C-11 字段集、C-16 Feature Flag）。详见 `constraint-audit.md`。
- **目标 ③④⑤**：skill 补齐、复杂矢量插画绘图方案、`aidoc/` 落点策略。

## 恢复条件（满足才继续）

1. 用户明确说「开始执行」。
2. 派子 agent 前先查存活数：**≥2 就先等其结束**，≤1 才派且一次只派 1 个（U-16）。
3. 从 I-02 开始：落地第二隔离策略 → 40 项测试全绿 → 更新本文件并单独提交。

## 恢复协议

1. 读本文件的「当前状态」与迭代表，确认最后完成的迭代与 commit。
2. 读仓库根 `AGENTS.md` 的必读清单、子 agent 派发规则、写入边界与踩坑清单。
3. `git log --oneline -5` 与 `git status --short` 对照，确认工作树与记录一致；不一致就先对齐再动手。
4. 重跑 `node --test apps/backend/test/*.test.js` 确认当前真实测试状态（不要相信记录里的旧数字）。
5. 从「恢复条件」继续；每次迭代收尾更新本文件并单独提交。

## 每轮对比文档

| 轮次 | 文档 | 对比对象 |
| --- | --- | --- |
| Round 1 | `rounds/round-01-comparison.md` | round-00 基线 vs round-01 |
| Round 2 | `rounds/round-02-comparison.md` | round-01 vs round-02 |

对比文档固定结构：① 上轮指标快照 ② 本轮 10 次迭代清单（变更 / 验证证据 / commit hash）③ 前后指标对比表 ④ 可视化对比图 ⑤ 决策与遗留 ⑥ 可复现命令。
