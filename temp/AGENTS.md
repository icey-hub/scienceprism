# AGENTS.md — temp/ 前端 Demo（Apple Design 重设计）

> 本文件只覆盖 `temp/` 这个任务文件夹。仓库根 `AGENTS.md` 的治理约定不适用于本目录
> （本目录**不是**迭代产物，不参与 `npm run quality`，不进 aidoc/）。

## 目标

用 Apple 的人机界面方法论（*Designing Fluid Interfaces* 等）重做一遍 SciencePrism 的**前端外观与手感**，
产出一个**可以直接打开、可以上手拖**的交互 Demo，放在 `temp/` 下。

用户诉求原文要点：先设计前端、放 temp、先不动项目、只读项目前端、想看 demo、利用 apple-design。

## 非目标

- 不改仓库任何既有文件（只读 `apps/frontend/src/**` 作为设计输入）。
- 不接后端、不发请求、不读 `aidoc/`、不写 `apps/`。
- 不追求功能等价：没有真实 LaTeX 编译、没有真实模型调用，数据全部是本地 fixture。
- 不做 i18n 双语切换、不做移动端适配（桌面优先，仅保证窄窗可用）。
- 不引入任何依赖 / 构建步骤（无 React、无 npm install、无打包）。

## 范围与写入边界

- **只允许写**：`temp/**`。
- **只读参考**：`apps/frontend/src/app/**`（LandingPage / ProjectDashboardPage / ResearchWorkspacePage /
  EditorPage / design-tokens.css / apple-ui.css / research/*）。
- 交付物是**零依赖静态站点**：classic `<script>`（不用 ES module，保证 `file://` 双击可用）。

## 信息架构对齐（读项目后确认）

| 项目里的页面 | Demo 对应视图 | 保留的 IA |
| --- | --- | --- |
| `LandingPage` `/` | `#/` 开始工作区 | 左侧栏 + 3 个入口卡 + 最近文稿网格 |
| `ProjectDashboardPage` `/project/:id/:view` | `#/project/p-01?tab=` | 概览/资料/任务/审批/运行/证据/设置 |
| `ResearchWorkspacePage` 8 阶段 | `#/research/:stage` | 方向→检索→筛选→复现→创新→方法→实验→写作，人工门禁 |
| `EditorPage` `/editor/:id` | `#/editor` | 三栏（工具侧栏 / LaTeX 编辑 / PDF）+ 顶部工具条 |
| — | `#/motion` | 新增：特效巡演（十个招牌动效，自动播放 + 慢放） |
| — | `#/design` | 新增：把设计依据本身做成可复核的一页 |

## 验收标准（可执行）

1. `python3 -m http.server` 起在 `temp/`，用无头 Chromium 打开 6 个路由，控制台**零 error / 零 warning**。
2. 每个路由有截图证据（`temp/.verify/*.png`）。
3. 手势可证：拖分栏有 1:1 跟手 + 越界橡皮筋；拖底部抽屉可中断反向；审批行滑动越阈值才提交；
   人工确认是按住式（松手回弹）。
4. 招牌特效可证：英雄过渡有中途克隆 + 目标淡入；动态岛宽度按内容生长；照片缩放能沿原路缩回。
5. 偏好可证：`prefers-reduced-motion: reduce` 下无位移动画，只剩淡入，并弹出诊断条说明原因；
   `prefers-reduced-transparency` 下玻璃变实心；`prefers-contrast: more` 下加边框。
6. 零构建：`index.html` 用 `file://` 直接打开也能跑（无 module / 无 fetch）。

## 进度

- [x] 只读盘点项目前端 IA 与设计 token
- [x] 设计方向定稿（见 `README.md` 的「设计决策」）
- [x] 第一轮：5 视图 + 交互底座（弹簧 / 手势 / 动量投影 / 偏好）
- [x] 第二轮（用户反馈「感觉没有 Apple 的特效」后）：招牌特效层
      —— 英雄过渡、照片缩放、液态玻璃高光、动态岛、橡皮筋滚动、弹簧列表重排、
      挤压与拉伸、速度即拉伸、环境光斑、特效巡演页 `#/motion`、慢放 0.25×、
      以及**「减弱动态效果」诊断条**（这很可能是用户看不到动效的真正原因）
- [x] 无头浏览器验证（见下）

### 验证结果（本机实测，可复跑）

| 检查 | 实测 |
| --- | --- |
| 6 个路由控制台 | 全部 `<no console messages found>`（error + warn） |
| 英雄过渡 | 点文稿卡片：中途 `.hero-clone` 存在 + 目标淡入中；1.6s 后克隆移除、标题正确、URL → `#/project/p-01` |
| 动态岛 | 编译：`编译中 · 43%` → `编译成功 · 12.4s` |
| 照片缩放 | 点 PDF：`.zoom-panel` 1 → 0（沿原路缩回） |
| 减弱动效诊断条 | 强制 `media('motion')=true` → 诊断条出现；点「临时预览完整动效」→ `motion=full`、诊断条移除 |
| 分栏条 1:1 | 合成指针事件拖 +80px → `.ed-side` 330px → **410px** |
| 动量投影 | `project(1200)=598.8`、`project(-800)=-399.2`，与 `v/1000·d/(1−d)` 一致 |
| 滑动决策 | 大拖 140px → 行被移除（3→2）；小拖 30px → 回弹保留 |
| 按住确认 | 按住 1.5s → 阶段推进到「论文复现」，已完成阶段 2→3 |
| 抽屉拖拽关闭 | 抓手拖 300px 释放 → `.sheet` 1→0 |
| 降低透明度 | `backdrop-filter` 计算值 `none` |
| 帧率 | `#/motion` 十个 demo 同时播放 → **60 fps** |
| `file://` 直开 | 渲染与阶段切换正常，零控制台错误 |

### 过程中修掉的真实缺陷

1. `ui.setRing(null, …)` 抛 TypeError，导致研究工作区与编辑器的 `mount` 整体中断（首轮验证捕获）。
2. `.btn.ghost` 覆盖 `.btn.primary` 底色但没覆盖前景色 → 切换态按钮白字白底、肉眼不可见；
   改用独立 `.btn.is-on` 并置于 `.ghost` 之后。
3. 材料演示把花纹画在玻璃上面，四档材料看不出差别；改为花纹在下、玻璃在上。

### 下一步（未执行，等用户决定）

把结论回灌到 `apps/frontend`：先抽 `motion/` 原语 → 换分栏条与抽屉 → 英雄过渡与动态岛 →
合并 token → 最后才动 `EditorPage.tsx` 组合根（仓库约定本迭代不重构它）。
