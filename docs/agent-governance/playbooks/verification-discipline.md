# Playbook: 验证纪律

> 开发侧 playbook。**不要**放进 `.dsh/skills`（那是产品研究 skill 的源目录）。

## 核心一条

**"门禁是绿的"不等于"门禁有用"。** 必须证明它会红。

## 每次声称完成之前

### 1. 证明门禁会拦

对每条新门禁，做一次破坏实验：

```bash
# 制造违规
printf '\n<!-- drift -->\n' >> <被门禁保护的产物>
node --test <门禁测试>        # 必须变红
# 还原
<重新生成>
node --test <门禁测试>        # 必须恢复绿
```

**迭代 023 的真实教训**：门禁测试导入的路径写错了，比对的是工作区外一份干净文件，于是"制造漂移"实验**假绿**。如果我只看到绿就交付，就会把一个无效门禁发出去。

### 2. 门禁要指向真实存在的东西

不要断言"某个函数存在"，要**动态 import 并检查导出**：

```js
const module = await import(absolutePath);
assert.notEqual(module[symbol], undefined);
```

同理，`testRef` 要检查测试文件里**真的有同名 `test('...')`**。

### 3. 工作区边界自检（每次迭代都做）

```bash
# 有没有写到工作区外
ls -d <工作区外可疑路径> 2>/dev/null
# 依赖是否被动过
git diff --stat <上轮 tag>..HEAD -- package.json package-lock.json
```

**迭代 021 的真实教训**：脚本 `REPO_ROOT` 层级写错，把 4 张图写到工作区外，且门禁跟着读错目录。发现后按 U-02/U-03 **上报用户取得授权**才删除，没有自行处理。

**同一类错误在本会话里犯了三次**，都是把命令输出重定向到 `/tmp`（`/tmp/q.txt`、`/tmp/exp.log`）。规则说"写只在工作区内"，而 `/tmp` 在工作区外——**它读起来像"临时目录所以无所谓"，这正是它反复发生的原因**。

**硬性做法**：任何重定向、日志、临时产物一律写到工作区内的 `.cache/`（已 gitignore）：

```bash
node scripts/foo.mjs > .cache/foo.log 2>&1     # ✅
node scripts/foo.mjs > /tmp/foo.log 2>&1       # ❌ 越界
```

重定向之前**先看一眼路径的第一个字符**：`/` 开头就是工作区外。`git add -A` 之前同理——未跟踪且未 ignore 的目录会被一起提交（`pic/` 149 MB 就是这样进了一次未推送的提交）。

### 4. 目视的东西必须真的看

中文标签、图表、UI——**不能只看源码里有 `<text>` 节点就判定通过**，字形可能缺失。

用 `read_image` 打开**栅格化后的产物**确认。

### 5. 声称前先采集证据，不要靠记忆

```bash
npm run quality                                  # 测试 + 类型检查 + 构建
node --test apps/backend/test/*.test.js          # 真实数字
git status --short                               # 工作树是否干净
```

迭代日志里的旧数字**不可信**——每轮开始时重跑一遍。

## 验证的三种典型形态

| 形态 | 做法 | 例子 |
| --- | --- | --- |
| **负向测试** | 断言"不该发生的事被拒" | 未知角色 → 400 `UNKNOWN_ROLE`；撤销能力 → 403 |
| **不变量测试** | 断言两条事实一致 | 声明的可达阶段 == 代码实际调用；注册表 id == 文档表格 |
| **可复现测试** | 重跑生成器，断言产物逐字节一致 | SVG 与生成器比对 |

## 什么时候**不该**做字节比对

PNG 这类由外部渲染器（headless Chrome）产出的东西，**跨版本字节不同**。硬做逐字节比对会制造假红。

诚实的替代：比对**尺寸 + 非空**，并在注释里写清为什么不做字节比对。

## 相关位置

- 迭代日志（每拍的验证证据）：`docs/agent-governance/iterations.md`
- 每轮对比文档：`docs/agent-governance/rounds/`
- 约束注册表门禁：`apps/backend/test/constraintRegistry.test.js`
- 绘图产物门禁：`apps/backend/test/diagramAssets.test.js`
- skill 可达性门禁：`apps/backend/test/researchSkillReachability.test.js`
