# Round 2 对比文档（round-01 → round-02）

> 生成时间：2026-09-24 ｜ 分支：`feat/agent-governance-r2` ｜ 上一轮 tag：`round-01-complete`
> 本轮 10 拍（011–020），10 条提交，25 个文件改动，**零依赖变更**。
> 本文档是**过程对比记录**（R-11）；本轮的工具产出交付物见 `aidoc/`（Round 1 已产出 1 篇）。

## 1. 一句话结论

Round 1 让工具**能跑通**，Round 2 把"约束"和"角色"从**文档与 prompt 里的说法**变成**代码里的可执行边界**：16 条约束全部有测试、可开关、漂移从 9 降到 5；8 个角色登记并接进 Harness Runtime，角色只能收窄能力；4 处高危绕过重新审视后 1 处真高危已 fail-closed、2 处变为可拒绝、1 处据实降级。

## 2. 指标快照对比

| 指标 | round-01 | round-02 | 变化 |
| --- | --- | --- | --- |
| 后端测试 | 51（全通过） | **78（全通过）** | +27 |
| 前端类型检查 / 构建 | 通过 | 通过 | — |
| 约束注册表 | 不存在 | **16 条机器可读** | 新增 |
| 约束有测试 | 14/16 | **16/16** | 缺口清零 |
| 文档-代码漂移 | 9 条 | **5 条** | −4 |
| 约束可选开关 | 不存在 | **已落地**（`core` 不可关） | 新增 |
| 角色注册表 | 0 个显式角色 | **8 角色 + 4 强制模块** | 新增 |
| 角色接入 Runtime | — | **已接入**（只收窄、未知角色 fail-closed） | 新增 |
| 高危绕过 | 4 处全开 | **1 处 fail-closed、2 处可拒绝、1 处据实降级** | 质变 |
| 依赖变更 | 0 | **0** | — |

### 可视化对比（绘图方案仍未落地，用文本条形图）

```text
后端测试通过数      round-01 ███████████████████████████████████████████  51/51
                    round-02 ██████████████████████████████████████████████████████████████████████████  78/78

约束有测试比例      round-01 ██████████████████████████████████████████████░░  14/16
                    round-02 ████████████████████████████████████████████████  16/16

文档-代码漂移       round-01 █████████                                          9
                    round-02 █████                                              5

显式角色数          round-01                                          0
                    round-02 ████████                                          8
```

## 3. 本轮 10 拍

| # | 拍型 | 变更 | 验证证据 | commit |
| --- | --- | --- | --- | --- |
| 011 | 加 | **约束注册表骨架**（16 条：tier / scope / enforcement seam / testRef / provenance / drift）+ 审计文档（由注册表投影生成） | 5 项门禁测试；**16 个 `module:symbol` 经动态 import 验证真实导出**；注册表 id 与文档表格完全一致 | `680b1c9` |
| 012 | 加 | **约束可选开关**（`.scienceprism/constraint-policy.json`） | `core` 一律拒绝关闭（`CORE_CONSTRAINT_IMMUTABLE`）；未知 id 记 `UNKNOWN_CONSTRAINT`；被关掉的约束仍可见 | `a406ba6` |
| 013 | 减 | **收口 4 条漂移 + 补 2 条测试缺口** | 漂移 9 → 5、无测试 2 → 0；C-12 证据门移进 readiness（**直接 PATCH 不再能绕过**）；C-16 改为 gate 所有真实适配器 | `8306385` |
| 014 | 验证 | 验证 011–013 | `quality` exit 0；零依赖变更；越界自查（`/tmp` 命中文件比本会话早 4 天，非我所有，未删） | `8e702e9` |
| 015 | 加 | **收口 4 处高危绕过（重审后修正结论）** | plot 真高危 fail-closed；transfer/vision 变可拒绝；llm 据实降级；4 条拒绝路径测试 | `47d9a05` |
| 016 | 验证 | 验证 015 | 4 条拒绝路径全绿；**能力语义实测**（默认 `experiment.execute=false`、`patch.propose=true`、撤销后 `false`） | `b982415` |
| 017 | 加 | **角色注册表**（8 角色 + 4 强制模块 + 12 真实入口符号） | 6 项门禁测试；能力只能收窄；只读角色断言不持有 `patch.propose`/`experiment.execute`；**只有 `plot-code-generator` 持有 execute** | `574cb98` |
| 018 | 加 | **角色接入 Harness Runtime** | 角色取交集；未知角色 400 `UNKNOWN_ROLE`；Run 记录 `role`/`roleAuthority`；不传角色行为不变 | `aca88fc` |
| 019 | 减 | **删 prompt 假约束，改用角色在代码里强制** | 研究阶段删除已被角色取代的那句 prompt；前端 3 个只读任务改传 `role:'paper-reviewer'`；`role` 透传链打通并测试 | `0c931df` |
| 020 | 验证 | 本对比文档 + tag `round-02-complete` + 推 `scienceprism` | 见第 6 节 | 本次提交 |

## 4. 本轮最有价值的产出

### ① 「约束以代码形式加，而不是加在 agent 本身」——有了三个真实样本

| 改造前（prompt 里的说法） | 改造后（代码里的边界） |
| --- | --- |
| 研究阶段 prompt 写 "Provide analysis and structured suggestions only" | 该阶段真的以 `research-stage-assistant` 角色运行，只持 `project.read` → **结构上无法提 Patch**，prompt 那句删除 |
| 前端 `peer_review` / `consistency_check` / `missing_citations` 写着"不要提 patch"却持有 `patch.propose` | 改传 `role:'paper-reviewer'` → 后端把能力收窄到 `project.read`，**那句话第一次成为真的** |
| 文档说 C-12「主张必须挂证据」，实际只在 Harness adapter 里查 | 检查移进 `getStageReadiness('writing')` → **直接 PATCH 设 `ready:true` 不再能绕过** |

### ② 重审推翻了早先的取证结论

4 处"高危绕过"逐条读代码后，**只有 plot 完全成立**：它让模型写 Python 然后执行，无沙箱、无能力检查、无 flag；而受控 Experiment Run 却要两次人工决定。transfer 写的是新建项目的 `.tex`、编译走白名单引擎（与编辑器编译同级）；vision 写的是用户自己上传的图片；llm 已在全局鉴权钩子保护内。**据实降级 2 处、说明理由 1 处，而不是为了凑数强行改。**

### ③ 测试真的在守边界，不是走过场

- 16 个约束的 enforcement 指向**经动态 import 验证真实存在**
- 16 个 testRef 指向**真实存在的同名测试**
- 注册表 id 集合与文档表格**完全一致**（多一条少一条都红）
- 12 个角色入口符号**经动态 import 验证**
- 「只有 `plot-code-generator` 持有 `experiment.execute`」是**断言**，不是注释

## 5. 可复现命令

```bash
npm run quality                                   # 78 项测试 + tsc + build

# 约束注册表
node -e "import('./apps/backend/src/services/constraintRegistry/index.js').then(m=>console.log(JSON.stringify(m.constraintCatalog(),null,2)))"

# 角色注册表
node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(m.renderRoleTable()))"

# 角色只收窄
node -e "import('./apps/backend/src/services/agentRoles/index.js').then(m=>console.log(m.resolveRoleCapabilities('paper-reviewer',{granted:['project.read','patch.propose','experiment.execute']})))"

# 本轮零依赖变更核对
git diff --name-only round-01-complete..HEAD -- package.json package-lock.json
```

## 6. 决策与遗留

### 本轮决策
- **重审优先于执行**：4 处高危绕过没有照单全改，而是逐条读代码后修正结论（1 真高危 / 2 可拒绝 / 1 降级）。
- **角色只收窄**：不新增能力词表，角色只能从项目已授予里减。
- **未知角色 fail-closed**：不静默无约束运行。

### 遗留（进入 Round 3）
1. **剩余 5 条漂移**：C-04（actor 自报，无法区分 AI 与人类）、C-07（**根本没有 Patch 应用接口**）、C-09（`assertNetworkHost` 未接进 Harness 路径）、C-10（legacy 适配器不接收 limits）、C-11（不确定性字段全为可选）。
2. **目标 ③ 未开始**：产品侧 skill 缺口 3 个（`research-direction`、`claim-evidence-audit`、`figure-table-plan`）+ 开发侧 playbook。
3. **目标 ④ 未开始**：复杂矢量插画级绘图方案（细胞结构图基准）；本轮仍只有文本条形图。
4. **目标 ⑤ 部分**：工具已产出 1 篇文档到 `aidoc/`；`aidoc/` 落点策略（R-15）仍未在产品侧确认。
5. **`docs/project-constraints.md` 尚未改为由注册表生成**：目前靠门禁测试比对 id 集合，尚未整表生成。
6. **角色尚未在前端展示**：运行前"角色 / 能力 / 可用 skill"摘要未做。
7. **失败重试回灌未做**：模型输出不合契约时直接失败，未把校验错误回喂模型重试。
