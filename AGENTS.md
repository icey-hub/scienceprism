# AGENTS.md — OpenPrism 模块化重构工作约定

> **日期**: 2026-10-04  
> **分支**: fix/agent-runtime-reliability  
> **状态**: 重构计划已完成，等待开始实施

## 🎯 重构方向确认

### 产品定位
**OpenPrism 是一个研究工具**，不是单纯的编辑器：
- ✅ 8 阶段研究流程是产品核心价值
- ✅ Evidence Ledger 证据追踪
- ✅ AI 能力层（Harness Runtime + Skill 系统）
- ✅ 约束和角色系统
- ✅ 多 Agent 协作

**对标产品**: Notion Research + Overleaf + Zotero + ChatGPT

### 真正的问题

不是功能太多，而是：
1. **EditorPage.tsx 承载了太多职责**（4899 行）
2. **模块间耦合严重**，难以维护和扩展
3. **核心功能不够可靠**（停止失败、刷新丢失、假打字动画）
4. **缺少产品级打磨**（错误处理、进度显示、性能优化）

### 重构策略

**模块化重构 + 产品级打磨**
- 保留所有功能
- 拆分 EditorPage 成 5-6 个独立模块
- 提升可靠性和用户体验
- 4 周完成

## 📋 已完成的工作

### 诊断和规划文档（2026-10-04）

1. **[REFACTOR-SUMMARY.md](REFACTOR-SUMMARY.md)** - 总纲
   - 产品定位修正
   - 模块化重构方案
   - 4 周实施计划

2. **[docs/refactor-research-tool.md](docs/refactor-research-tool.md)** - 详细方案
   - 三层架构设计
   - 模块划分
   - 成功指标

3. **[docs/refactor-quick-wins.md](docs/refactor-quick-wins.md)** - 快速改进
   - 5 个 1-2 天见效的改进
   - 可立即实施

4. **[docs/refactor-progress.md](docs/refactor-progress.md)** - 进度追踪
   - Week 1-4 详细计划
   - 代码行数追踪
   - 风险和应对

5. **已推送到 GitHub**
   - 分支: `fix/agent-runtime-reliability`
   - 远程: `scienceprism`
   - 最新提交: `1a4fc7e`

## 🏗️ 新的模块架构

```
apps/frontend/src/modules/
├── research-workflow/       # 研究流程模块（8 阶段）
│   ├── ResearchView.tsx
│   ├── StageNavigation.tsx
│   └── stages/
│       ├── DirectionStage.tsx
│       ├── SearchStage.tsx
│       └── ... (完整 8 个阶段)
│
├── document-editor/         # 文档编辑模块
│   ├── EditorView.tsx      (< 500 行)
│   ├── FileTree.tsx        (< 300 行)
│   ├── CodeEditor.tsx      (< 400 行)
│   └── useEditorState.ts   (< 200 行)
│
├── ai-assistant/            # AI 助手模块
│   ├── AssistantPanel.tsx
│   ├── SkillPicker.tsx
│   └── RunHistory.tsx
│
├── compilation/             # 编译模块
│   ├── CompileButton.tsx
│   ├── PdfPreview.tsx
│   └── ErrorList.tsx
│
└── evidence-tracking/       # 证据追踪模块
    ├── EvidenceLedger.tsx
    └── CitationManager.tsx
```

**EditorPage.tsx** 只保留布局和组合逻辑（< 500 行）

## 📅 4 周实施计划

### Week 1: 拆分 EditorPage
**目标**: EditorPage 从 4899 行 → < 500 行

- Day 1-2: 文档编辑模块
- Day 3: AI 助手模块
- Day 4: 编译模块
- Day 5: 集成测试

**验收**:
- [ ] EditorPage.tsx < 500 行
- [ ] 5 个独立模块
- [ ] 所有功能正常
- [ ] 193 项测试通过

### Week 2: 完善研究流程
**目标**: 研究阶段与编辑器深度集成

- 阶段间数据流可视化
- 研究与写作联动
- Evidence 追踪完善
- 阶段完成度显示

**验收**:
- [ ] 阶段间数据流清晰
- [ ] 研究结果可直接用于写作
- [ ] Evidence 到文档的追踪可靠
- [ ] 用户知道下一步该做什么

### Week 3: 产品级打磨
**目标**: 可靠性、性能、用户体验达标

- 真实流式输出（< 1s 首 token）
- 停止按钮 100% 可靠
- 刷新不丢失状态
- 自动保存 + 历史版本
- 性能优化（首屏 < 2s）

**验收**:
- [ ] 核心操作 0 失败
- [ ] 性能指标达标
- [ ] 用户体验流畅
- [ ] 数据不丢失

### Week 4: 测试和文档
**目标**: 准备发布

- 端到端测试
- 性能基准测试
- 用户文档
- 发布准备

**验收**:
- [ ] 所有测试通过
- [ ] 文档完整
- [ ] 可以给真实用户试用

## 📊 成功指标

### 代码质量
- EditorPage.tsx: 4899 行 → < 500 行 ⬇️ 90%
- 模块平均大小: < 800 行
- 模块间耦合度: 低
- 测试覆盖: > 80%

### 产品质量
- 8 阶段流程流畅
- 停止/刷新/保存 100% 可靠
- 性能达标（< 2s 首屏）
- 用户可以完成完整研究流程

### 用户体验
- 新用户 15 分钟完成第一个阶段
- 研究数据可追溯
- 错误处理友好
- 文档齐全

## 🚀 下一步

### 立即可以开始的工作

**创建模块结构**:
```bash
mkdir -p apps/frontend/src/modules/{document-editor,ai-assistant,compilation,evidence-tracking,research-workflow}
```

**第一步：拆分文档编辑模块**（Day 1，4-6 小时）:
1. 提取文件树 → `FileTree.tsx`
2. 提取 CodeMirror → `CodeEditor.tsx`
3. 提取状态管理 → `useEditorState.ts`
4. 提取文件操作 → `fileCommands.ts`
5. 更新 EditorPage 导入

**预计产出**:
- EditorPage 从 4899 行 → ~3400 行
- 4 个新模块文件（各 < 300 行）

## 📝 开发约定

### 写入边界
- **允许修改**: `apps/frontend/src/` 下所有文件
- **允许新建**: `apps/frontend/src/modules/` 下所有模块
- **保留不动**: `.dsh/skills/` 已有 Skill（先兼容）
- **谨慎修改**: 后端 `apps/backend/src/` （改前端为主）

### 提取原则
1. **单一职责** - 每个模块只做一件事
2. **清晰接口** - 通过 props 传递数据
3. **独立测试** - 每个模块可以独立测试
4. **渐进迁移** - 先提取，再优化，保证功能不变
5. **保留兼容** - EditorPage 暂时保留旧代码，稳定后再删除

### 验收标准
每次提取后必须：
- [ ] 所有功能正常工作
- [ ] 测试通过（`npm test`）
- [ ] 类型检查通过（`npm run typecheck`）
- [ ] 构建成功（`npm run build`）
- [ ] 性能不退化

### Git 工作流
```bash
# 每完成一个模块提交一次
git add apps/frontend/src/modules/document-editor/
git commit -m "refactor(editor): extract FileTree module

- Extract file tree rendering and operations
- EditorPage: 4899 → 4100 lines
- All features work, tests pass"

# Week 1 结束推送
git push scienceprism fix/agent-runtime-reliability
```

## ⚠️ 风险和应对

| 风险 | 应对措施 |
|------|---------|
| 模块间依赖复杂 | 先提取纯展示组件，再处理状态 |
| 状态管理混乱 | 使用 Context 或状态提升 |
| 测试失败 | 每次提取后立即运行测试 |
| 协作功能冲突 | Y.js 保持独立，后续优化 |
| 性能退化 | 保持代码结构，不做提前优化 |

## 📚 参考文档

- [REFACTOR-SUMMARY.md](REFACTOR-SUMMARY.md) - 总体计划和决策
- [docs/refactor-research-tool.md](docs/refactor-research-tool.md) - 详细技术方案
- [docs/refactor-progress.md](docs/refactor-progress.md) - 进度追踪
- [docs/refactor-quick-wins.md](docs/refactor-quick-wins.md) - 快速改进方案

## 🎯 当前状态

**阶段**: 规划完成，准备开始实施  
**分支**: fix/agent-runtime-reliability  
**最新提交**: 1a4fc7e (已推送)  
**下一步**: 创建模块目录，开始拆分文档编辑模块

---

**最后更新**: 2026-10-04  
**方向确认**: 保留所有功能，模块化重构，4 周完成  
**GitHub**: https://github.com/icey-hub/scienceprism/tree/fix/agent-runtime-reliability
