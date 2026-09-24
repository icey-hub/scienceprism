# Round 1 对比文档（round-00 基线 → round-01）

> 生成时间：2026-09-24 ｜ 分支：`feat/agent-governance-r1` ｜ 基线 tag：`round-00-baseline`（`33a2b5b`）
> 本轮 10 拍，共 16 条提交（含治理文档）。下一轮从本分支尖端切出。
> 说明：本文档是**过程对比记录**（R-11）；本轮的**交付物**是工具真实跑出来的文档，见第 4 节。

## 1. 一句话结论

Round 1 没有去动"约束注册表"这个原定主角，而是先解决了一个更前置的事实：**这个项目的 agent 工作流在真实模型下根本跑不通**。修完之后，工具第一次自己产出了一篇科研文档（8581 字符），并且顺手删掉了 5 处重复默认值、1 个死契约、2 处无溯源兜底草稿。

## 2. 指标快照对比

| 指标 | round-00 基线 | round-01 | 变化 |
| --- | --- | --- | --- |
| 后端测试 | 40 项（**36 通过 / 4 失败**） | **51 项（51 通过 / 0 失败）** | +11 项，红转绿 |
| 前端类型检查 | 通过 | 通过 | — |
| 生产构建 | 通过 | 通过 | — |
| 能力词表（可授予） | 5 项（含从未断言的 `project.write`） | **4 项** | −1（虚高项清除） |
| 阶段契约（LLM 输出契约） | 8 个（含无人调用的 `paper_screening`） | **7 个** | −1（死契约清除） |
| 约束默认值来源 | **5 处**各写一遍 | **1 处**（`config/projectConstraintDefaults.js`） | −4 |
| 本地约束默认常量声明 | 4 个 | **0** | −4 |
| 无溯源的兜底草稿 | 2 处（创新点 / 方法候选） | **0** | −2 |
| 真实模型端到端可用 | ❌ 不可用（阶段契约校验失败） | ✅ 可用 | 质变 |
| 工具产出文档 | 0 | **1 篇**（+3 份审计记录） | +1 |
| 改动的产品文件 | — | 15 个 | — |

### 可视化对比（绘图方案在 Round 2 落地，本轮用文本条形图）

```text
后端测试通过数      基线 ████████████████████████████████████░░░░  36/40
                   现在 ███████████████████████████████████████████  51/51

约束默认值来源数    基线 █████                                            5
                   现在 █                                                  1

能力词表虚高项      基线 █                                                1  (project.write)
                   现在                                              0

无溯源兜底草稿      基线 ██                                               2
                   现在                                              0
```

## 3. 本轮 10 拍

| # | 拍型 | 变更 | 验证证据 | commit |
| --- | --- | --- | --- | --- |
| 001 | 加 | 基线提交 + tag + 分支 + 治理脚手架（需求 / 计划 / 看板 / 三份任务书） | `git diff round-00-baseline..HEAD -- apps/ packages/` 无输出 | `33a2b5b` `7854331` `79a1329` |
| 002 | 加 | **Node 权限模型**作为第二隔离策略 + 纯函数 `chooseIsolationStrategy` + Run 记录 `execution.isolation` | `npm run quality` exit 0；真实越权拒绝（读 `/etc/hosts` → `ERR_ACCESS_DENIED`，工作区内写入成功）；策略选择表 5 组 | `189b94c` |
| 003 | 减 | 删除**从未被断言的 `project.write`** 能力（词表 5 → 4） | 45 项通过；词表锁测试 + 「存储的未知能力授权会被丢弃而非静默生效」负向断言 | `628437e` |
| 004 | 验证 | 全量门禁 + 回归对比 + 工作区边界自检 | exit 0；**越界自查**发现并清理了早期探测写在 `/tmp` 的文件 | `a457df0` |
| 005 | 加 | **阶段契约从 zod schema 派生**：类型、字符模式、严格性规则、各阶段引用语义注记；`contextPackager` 不再重复存整份契约 | 48 项通过；契约漂移锁 + 提示词类型/严格性断言 + 真实失败形状回归 | `fa34fc8` |
| 006 | 加 | **源名归一化**：input 广播 `availableSources`，未注册源记 `SOURCE_NOT_REGISTERED`，全部落空时回退注册集 | 48 项通过；检索从 **0 篇 → 39 篇通过质量门** | `8e15d11` |
| 007 | 验证 | **真实模型端到端跑通**并产出文档（4 次串行调用，约 90 秒） | `aidoc/aidoc-research-document/research/writing-brief.md`（8581 字符 / 6 claim / 9 节 / 12 局限） | `462e15d` |
| 008 | 减 | **约束默认值 5 处 → 1 处**；删除零消费的死导出 | 49 项通过；新增**防重复门禁**：扫描 `src` 树，重述 `49152` 或再声明本地常量即失败 | `cab9bad` |
| 009 | 减 | 删除**无溯源兜底草稿**（`paper-gap-N` / `method-draft-N`）+ **死契约 `paper_screening`**（schema / 注册表 / 别名 / 注记 / 两张别名表） | 51 项通过；失败后阶段留空且被 `STAGE_NOT_READY` 挡住；阶段词表锁 8 → 7 | `27a7144` |
| 010 | 验证 | 本对比文档 + tag `round-01-complete` + 推 `scienceprism` | 见第 6 节复现命令 | 本次提交 |

## 4. 本轮的交付物（工具真实产出，U-21）

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 写作 Brief | `aidoc/aidoc-research-document/research/writing-brief.md` | 8581 字符；6 条 claim 均带真实 Evidence ID 与置信度；9 节大纲；12 条局限 |
| 工作流审计 | `aidoc/aidoc-research-document/.scienceprism/research-workflow.json` | 阶段版本、审批、阶段数据 |
| 证据账本 | `aidoc/aidoc-research-document/.scienceprism/evidence-ledger.json` | 论文与主张-证据关系 |
| Harness 运行记录 | `aidoc/aidoc-research-document/.scienceprism/harness-runs.json` | 运行、上下文哈希、校验结果 |

值得记录的一点：文档**主动声明**检索到的 3 篇论文并非 RAG 主题，因此把贡献定位为"提案"而非已验证结果，并把缺失事实标为 `AUTHOR_INPUT_NEEDED`。产品的证据纪律在真实模型下是生效的。

## 5. 过程中修掉的两个真实产品缺陷（本轮最有价值的产出）

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 契约只讲字段名不讲类型 | 模型返回 `queries: [{...}]` + 7 个多余字段 → `.strict()` 全拒，**每个阶段都失败** | 契约从 schema 派生：类型、正则模式（`id` 不能有空格）、严格性规则、引用语义注记 |
| 源名不归一化 | 模型把 `sources` 填成"arXiv (cs.CL) — preprint server" → 10 个源全未注册 → **静默搜到 0 篇却报 `validation.ok=true`** | input 广播注册源 id；未注册源记 `SOURCE_NOT_REGISTERED`；全部落空时回退注册集 |

## 6. 可复现命令

```bash
# 全量质量门禁（51 项测试 + 前端类型检查 + 生产构建）
npm run quality

# 契约派生与词表
node -e "import('./apps/backend/src/services/researchResearch/schemas.js').then(m=>console.log(m.RESEARCH_STAGES))"
node -e "import('./apps/backend/src/services/harnessRuntime/capabilities.js').then(m=>console.log(m.HARNESS_CAPABILITIES))"

# 约束默认值唯一来源
grep -rn "49152" apps/backend/src          # 应只有 config/projectConstraintDefaults.js

# 用真实模型重新产出文档（串行单发，遵守 U-20）
node scripts/produce-research-document.mjs

# 零产品代码改动的基线核对
git diff --name-only round-00-baseline..HEAD -- apps/ packages/
```

## 7. 决策与遗留

### 本轮决策
- **计划重排**：原定 005 = 约束注册表，因真实模型跑不通管线（R-01 活样本，且阻塞 U-21）而改为契约 / 源解析修复。理由：先让工具真能产出文档，治理改造才有可验证的对象。
- **`.env` 承载密钥**（已被 gitignore），不写入仓库；模型选用免费的 `global:deepseek-v4.1-flash`，**不用** `-sg` 变体。

### 遗留（进入 Round 2）
1. **约束注册表本身尚未落地**（原 005 顺延）：16 条约束仍需代码化、可开关、可审计。
2. **4 处高危绕过未收口**：`transfer` 零能力校验、`plot` 无门禁执行 LLM 生成的 Python、`vision` 未审批写盘、`/api/llm` 裸代理。
3. **角色注册表未落地**：8 角色分类法已取证，未实现。
4. **`assertNetworkHost` 未接进 Harness 路径**（`agentService` 里有调用）。
5. **阶段失败后无重试回灌**：模型输出不合契约时直接失败，未把校验错误回喂模型重试。
6. **绘图方案未落地**：本轮只有文本条形图；复杂矢量插画（细胞结构图）评测在 Round 2。
7. **`aidoc/` 里只有 1 篇文档**；R-15（工具产出统一入 `aidoc/`）仍需产品侧确认落点策略。
