# Playbook: 把一条约束加进代码（而不是加进 prompt）

> 开发侧 playbook。**不要**把这类文档放进 `.dsh/skills`——那是**产品研究 skill 的源目录**，会被复制进 Harness 工作区，且只认带 `stages:` frontmatter 的 skill，放错地方会被**静默忽略**。

## 何时用

- 用户说"以后不许再这样"，或你自己发现一条只写在 prompt / 文档里的规则。
- 想给项目加一条能被机器检查、能被开关、能追溯来源的约束。

## 铁律

**一条约束 = 代码里的强制点 + 一个真实存在的测试 + 一条可追溯的来源。**

缺任何一项，它就只是"说法"，不是约束。

## 步骤

### 1. 先找强制点（seam），再写规则

打开 `apps/backend/src/services/constraintRegistry/constraints.js`，看现有 16 条怎么写的：`enforcement` 必须指向一个**真实导出的函数**。

```js
enforcement: { module: 'services/researchWorkflow/stageContracts.js', symbol: 'getStageReadiness' }
```

如果你写不出这个 `module:symbol`，说明这条规则**还没有强制点**——那它就不是约束，而是一个待办。

### 2. 定 tier

| tier | 含义 | 能否被项目关掉 |
| --- | --- | --- |
| `core` | 产品不变量：人的权威、路径安全、默认只读、证据可追溯 | **不能**（改需改代码 + ADR） |
| `standard` | 常规质量约束 | 能，默认开 |
| `experimental` | 推测性、未经人工确认 | 能，默认关 |

判断标准：**一个项目有没有资格为了自己方便而关掉它？** 没有 → `core`。

### 3. 登记

在 `constraints.js` 里加一条，字段齐全：

```js
{
  id: 'C-17',
  statement: '一句话说清"什么情况下会发生什么"',
  tier: 'core',
  scope: ['workflow'],
  enforcement: { module: 'services/.../x.js', symbol: 'exportedFunction' },
  testRef: { file: 'x.test.js', name: 'the exact test name' },
  provenance: { source: 'adr', ref: 'ADR-00NN' },   // 或 'ai-subjective' + 说明
  drift: null                                        // 文档与代码不一致时写清楚
}
```

`provenance.source` 只能取 `adr` / `context` / `ai-subjective`。**如果你写不出任何人类决策来源，就老实写 `ai-subjective`** —— 那正是用户最想看到的东西。

### 4. 写测试（不是"顺手加一个"，而是必需）

`testRef` 指向的测试文件里必须真的存在**同名** `test('...')`。门禁会逐个动态 import 校验。

测试要能**证明约束会拦**，不是证明它存在：

```js
// 好：证明越权被拒
await assert.rejects(() => doTheThing(), (error) => error.code === 'CAPABILITY_DENIED');

// 差：只证明函数能跑
assert.ok(typeof doTheThing === 'function');
```

### 5. 接线

- 强制点若还没被调用，就去调用它（例如把检查移进 `getStageReadiness` 的 `validate` 钩子）。
- 若约束需要跨模块，先问：**是不是该收窄接口而不是加分支？**

### 6. 跑门禁并确认它真的会红

```bash
node --test apps/backend/test/constraintRegistry.test.js
npm run quality
```

然后**故意破坏一次**（把强制点短路、把测试删掉），确认门禁变红，再还原。

> 只看到"绿"不算通过。迭代 023 我就是因为没验证门禁会红，带着一个指向错目录的测试交付了。

## 反模式（都在这轮改造里真实出现过）

| 反模式 | 真实例子 |
| --- | --- |
| 约束只写在 prompt 里 | `EditorPage.tsx` 三个只读任务写着"不要提 patch"，却持有 `patch.propose` |
| 声明了能力但从不断言 | `project.write` 在词表里，全仓零引用 |
| 文档承诺 > 代码实现 | 16 条里 9 条漂移，最严重的是"原项目只经 Patch 变更"——**应用 Patch 的接口根本不存在** |
| 契约只给字段名不给类型 | 模型返回 `queries: [{...}]`，`.strict()` 全拒，每个阶段都失败 |
| 兜底代码伪造内容 | Harness 失败时用代码编造创新点草稿，没有 Run / 模型 / 上下文 / 溯源 |
| 绑定指向不会执行的路径 | 一半 skill 绑在永远不跑 Harness 的阶段 |

## 相关位置

- 注册表：`apps/backend/src/services/constraintRegistry/{constraints,index,policy}.js`
- 门禁：`apps/backend/test/constraintRegistry.test.js`
- 审计：`docs/agent-governance/constraint-audit.md`（由注册表投影生成）
- 人面向清单：`docs/project-constraints.md`
