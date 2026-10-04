# AGENTS.md — OpenPrism MVP 重构工作约定

> **重构开始日期**: 2026-10-04  
> **目标**: 将过度设计的研究工具收敛为可用的 LaTeX 编辑器 + AI 助手  
> **原则**: 删除优先于重写，MVP 优先于完美

## 重构背景

**现状问题**：
- 代码规模失控（EditorPage 4899 行，后端 91 个服务文件）
- 8 阶段研究流程、17 条约束、角色系统等过度设计
- 用户找不到基本功能入口，核心场景未打通
- 测试通过 193 项，但实际可用性未验证

**对标产品**: Cursor/Windsurf 的编辑器体验 + Codex 的 Skill 生态，不是 Overleaf

**核心用户需求**（已验证）:
> 打开 LaTeX 项目 → 选中内容/描述任务 → AI 修改 → 审阅差异 → 接受 → 编译查看

## 重构目标

### 产品层面
1. **5 分钟上手** — 新用户无需文档即可完成润色任务
2. **3 个核心场景** — 润色、编译修复、引用核对端到端可用
3. **可靠的基础** — 停止、刷新、冲突处理 100% 可靠
4. **简单的扩展** — 通过 Skill 而非内置功能扩展能力

### 技术层面
1. **核心编辑器 < 1000 行** — 拆分职责，删除重复逻辑
2. **后端 < 10 个核心文件** — 删除角色、约束、证据链等系统
3. **真实流式输出** — 不再伪装打字动画
4. **统一修改应用** — 删除前端直写路径

## 三阶段实施计划

### 阶段 1: 砍到 MVP（2-3 天）
**目标**: 删除 80% 代码，只保留核心编辑 + AI 助手

**删除清单**:
- ❌ 8 阶段研究流程（`apps/frontend/src/app/research/`）
- ❌ 角色系统（`apps/backend/src/services/agentRoles/`）
- ❌ 约束注册表（`apps/backend/src/services/constraintRegistry/`）
- ❌ Evidence Ledger（`apps/backend/src/services/evidenceLedger/`）
- ❌ 多 Agent 委派（写作子任务相关代码）
- ❌ 绘图面板（GPT Image、plot 等）
- ❌ OCR 功能（vision 相关）
- ❌ Transfer 面板
- ❌ 任务中心（简化为 Run 历史）

**保留清单**:
- ✅ 文件树 + CodeMirror 编辑器
- ✅ 单一 AI 助手入口
- ✅ Tectonic 编译 + PDF 预览
- ✅ Diff 视图（需重构）
- ✅ 基础 Skill 加载

**交付物**:
- 可运行的精简版（前端 < 2000 行）
- 测试覆盖核心路径（> 50 项）
- 启动速度 < 2 秒

### 阶段 2: 打通核心流程（3-5 天）
**目标**: 3 个场景端到端可用且可靠

**润色场景**:
- [x] 选中文本 → 点击"润色"
- [ ] 真实流式响应（< 1s 首 token）
- [ ] 显示 diff → 接受/拒绝
- [ ] 刷新后恢复状态
- [ ] 停止按钮可靠

**编译修复场景**:
- [x] 编译失败 → 显示错误
- [ ] 点击错误 → 定位到行
- [ ] AI 提出修复 → 审阅 diff
- [ ] 接受 → 重新编译成功

**引用核对场景**:
- [ ] 选中引用 → "核对元数据"
- [ ] 显示来源 + BibTeX
- [ ] 修改 BibTeX → 审阅 diff
- [ ] 接受 → 重新编译引用

**交付物**:
- 3 个场景的真实演示视频
- 冲突检测和恢复机制
- 每个场景 < 10 步操作

### 阶段 3: Skill 生态（按需）
**目标**: 让社区可以贡献 Skill

**Skill 标准**:
```markdown
---
name: latex-polish
description: 润色 LaTeX 学术文本
category: editing
---

# 系统提示词
你是 LaTeX 学术写作助手...

# 输入
- selection: 选中的文本
- context: 前后 500 字

# 输出
- type: patch
- format: unified-diff
```

**Skill 管理**:
- 目录扫描 `.dsh/skills/` 和 `~/skills/`
- 热加载（文件变化自动重载）
- Skill 选择器（按 category 分组）
- 执行沙箱（Node 权限模型）

**交付物**:
- 5 个常用 Skill（润色、翻译、格式化、引用、图表）
- Skill 开发文档
- 社区 Skill 模板仓库

## 新架构设计

### 前端结构（< 2000 行）
```
apps/frontend/src/
├── main.tsx                     # 入口
├── App.tsx                      # 路由（只有编辑器）
└── editor/
    ├── EditorView.tsx           # 主视图（< 500 行）
    ├── FileTree.tsx             # 文件树（< 200 行）
    ├── CodeEditor.tsx           # CodeMirror 包装（< 200 行）
    ├── AssistantPanel.tsx       # AI 对话 + Skill（< 300 行）
    ├── DiffView.tsx             # 修改审阅（< 200 行）
    ├── PdfPreview.tsx           # PDF + 编译错误（< 200 行）
    ├── SkillPicker.tsx          # Skill 选择（< 100 行）
    └── Settings.tsx             # 模型配置（< 100 行）
```

### 后端结构（< 10 个核心文件）
```
apps/backend/src/
├── index.js                     # Fastify 启动
├── routes/
│   ├── files.js                 # 文件 CRUD
│   ├── assistant.js             # AI 请求
│   ├── compile.js               # LaTeX 编译
│   └── skills.js                # Skill 管理
└── services/
    ├── fileService.js           # 文件读写 + 版本
    ├── assistantService.js      # OpenAI SDK + 流式
    ├── skillService.js          # Skill 加载 + 执行
    ├── compileService.js        # Tectonic 调用
    └── collabService.js         # Y.js 协作（可选）
```

### 数据模型简化
```javascript
// 项目结构
{
  id: 'uuid',
  name: 'My Paper',
  files: [...],          // 文件树
  runs: [...],           // AI 运行历史
  settings: {            // 模型配置
    provider: 'openai',
    model: 'gpt-4',
    apiKey: '...'
  }
}

// AI 运行
{
  id: 'run-uuid',
  projectId: 'uuid',
  skill: 'latex-polish',  // 可选
  input: {
    selection: '...',
    context: '...'
  },
  output: {
    type: 'patch',        // 或 'text'
    content: '...'
  },
  status: 'completed',    // pending/running/completed/failed
  tokens: { input: 100, output: 200 }
}

// 文件版本
{
  path: 'main.tex',
  content: '...',
  version: 5,             // 递增版本号
  updatedAt: '2026-10-04T...'
}
```

## 迁移策略

### 用户数据保留
- ✅ 所有 LaTeX 文件和 BibTeX
- ✅ 对话历史（转换为新 Run 格式）
- ✅ 项目配置（模型、编译选项）
- ❌ 研究阶段数据（导出为 JSON 备份）
- ❌ 约束规则（迁移为 Skill 前置校验）
- ❌ Evidence 链（导出为 Markdown）

### 向后兼容
- 旧项目路径保留，自动升级数据格式
- 提供 `migrate.js` 脚本手动迁移
- 保留 tag `v0-legacy-full-features` 供回退

### 破坏性变更
1. **研究阶段删除** — 用 Skill 替代（提供迁移 Skill）
2. **协作短期禁用** — Y.js 与 AI 修改冲突需重新设计
3. **绘图/OCR 移除** — 作为独立 Skill 或插件提供

## 开发约定

### 写入边界
- **允许修改**: `apps/` 下所有文件
- **允许删除**: 过度设计的模块（需先备份）
- **禁止触碰**: `.dsh/skills/` 已有 Skill（先兼容）

### 验收标准
每个阶段结束必须：
1. **跑通端到端** — 3 个场景真实演示
2. **测试通过** — 核心路径 > 80% 覆盖
3. **性能达标** — 首屏 < 2s，编译 < 5s，AI 首 token < 1s
4. **代码精简** — 前端 < 2000 行，后端 < 10 文件

### 质量门禁
```bash
# 每次提交前运行
npm run test           # 核心路径测试
npm run typecheck      # TypeScript 检查
npm run build          # 前端构建
npm run lint           # 代码风格

# 阶段结束运行
npm run test:e2e       # 端到端测试（3 个场景）
npm run benchmark      # 性能基准
```

### Git 工作流
```bash
# 1. 创建重构分支
git checkout -b refactor/mvp-editor

# 2. 每完成一个模块提交
git commit -m "refactor: remove research stages UI"

# 3. 阶段结束打 tag
git tag v1.0.0-alpha.1

# 4. 合并到主分支（需人工审阅）
# 不自动合并，等用户验收后手动 merge
```

## 风险与应对

### 高风险
- **现有用户数据丢失**
  - 应对: 提供迁移脚本 + 备份恢复
  - 验证: 测试 10 个真实项目迁移

- **核心功能回退**
  - 应对: 保留 legacy 分支，提供切换方式
  - 验证: 对比新旧版本功能清单

### 中风险
- **Skill 生态建立失败**
  - 应对: 先内置 5 个常用 Skill
  - 验证: 社区 1 个月内贡献 > 3 个 Skill

- **性能不达标**
  - 应对: 逐步优化，不阻塞发布
  - 验证: 真实项目测试 P95 延迟

### 低风险
- **测试覆盖下降**
  - 应对: 聚焦核心路径，删除过度测试
  - 验证: 核心场景覆盖 > 80%

## 成功指标

### 必须达到（MVP 发布前）
- [ ] 新用户 5 分钟完成润色任务
- [ ] 3 个核心场景端到端可用
- [ ] 停止按钮 100% 可靠
- [ ] 刷新不丢失状态
- [ ] 核心编辑器 < 1000 行
- [ ] 后端服务 < 10 文件

### 期望达到（v1.0 前）
- [ ] AI 响应 < 3 秒（P95）
- [ ] 编译错误定位 > 90% 准确
- [ ] 社区 Skill > 5 个
- [ ] 日活用户 > 100

### 可选达到（v2.0）
- [ ] 协作功能恢复
- [ ] 插件系统
- [ ] 云同步（可选）

## 当前状态

**阶段**: 诊断与计划  
**进度**: 已完成诊断文档，等待用户确认  
**下一步**: 
1. 用户确认重构方向
2. 备份当前版本（打 tag）
3. 创建重构分支
4. 开始删除研究阶段 UI

**关键决策等待确认**:
- [ ] 是否接受删除 8 阶段研究流程？
- [ ] 是否接受短期禁用协作功能？
- [ ] 是否接受测试从 193 降到 ~50 项？
- [ ] 预期多久完成 MVP（建议 2-3 周）？

## 参考资料

- [重构诊断报告](refactor-diagnosis.md) — 问题分析和对比
- [旧 AGENTS.md](AGENTS.md) — 历史工作约定（保留参考）
- [tasks/plan.md](tasks/plan.md) — 原渐进式改造计划（已放弃）
- [Aider 研究](docs/agent-governance/open-source-simplification.md) — 借鉴的开源实现

## 迭代日志

所有重构迭代记录在 `docs/refactor-iterations.md`，格式：
```markdown
### 迭代 R01: 删除研究阶段 UI（2026-10-04）
- 删除: `apps/frontend/src/app/research/` 8 个文件
- 影响: 导航栏从 6 个入口减少到 1 个
- 验证: `npm run build` 通过，启动无报错
- 提交: a1b2c3d
```

---

**更新日期**: 2026-10-04  
**版本**: v1.0.0-plan  
**状态**: 等待用户确认
