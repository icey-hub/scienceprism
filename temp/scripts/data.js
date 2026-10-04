/* ==========================================================================
   data.js — Demo 夹具数据
   全部是本地假数据，只为了让设计可被评估；不联网、不读后端。
   词汇对齐项目：研究方向 / 检索 / 筛选 / 复现 / 创新点 / 方法 / 实验 / 写作。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var ago = function (min) { return new Date(Date.now() - min * 60000).toISOString(); };

  P.data = {
    /* ------------------------------------------------------------ 项目列表 -- */
    projects: [
      { id: 'p-01', name: '可验证的长上下文检索', question: '如何让长上下文检索的每一步都能被引用回查？', tags: ['IR', 'RAG', '可验证性'], updatedAt: ago(24), progress: 62 },
      { id: 'p-02', name: '稀疏注意力中的位置外推', question: '稀疏模式能否保持长度外推的一致性？', tags: ['Transformer', '长文本'], updatedAt: ago(60 * 26), progress: 40 },
      { id: 'p-03', name: '科研图表的结构化生成', question: '如何把图表意图编译成可复现的矢量图？', tags: ['可视化', 'DSL'], updatedAt: ago(60 * 74), progress: 88 },
      { id: 'p-04', name: '证据链驱动的写作检查', question: '主张与证据的不一致能否被自动检出？', tags: ['NLP', '写作'], updatedAt: ago(60 * 120), progress: 55 },
      { id: 'p-05', name: '受限执行下的实验复现', question: '在权限收窄的沙箱里如何保证复现可比？', tags: ['Reproducibility'], updatedAt: ago(60 * 260), progress: 30 },
      { id: 'p-06', name: '多智能体协作的角色边界', question: '角色注册表能否替代提示词里的约定？', tags: ['Agent', '治理'], updatedAt: ago(60 * 500), progress: 70 }
    ],

    /* -------------------------------------------------------------- 当前项目 -- */
    project: {
      id: 'p-01',
      name: '可验证的长上下文检索',
      question: '如何让长上下文检索的每一步都能被引用回查？',
      scope: '信息检索 / 长文本理解，2022–2026，CCF-A 会议与期刊',
      model: 'deepseek-chat',
      progress: { percent: 62, completed: 5, total: 8 },
      nextAction: {
        title: '确认筛选后的 12 篇论文',
        reason: '结构校验已通过，等待人工决定',
        cta: '进入筛选阶段'
      },
      stats: [
        { label: '阶段进度', value: '62%', note: '5 / 8 阶段已完成' },
        { label: '待审批', value: '3', note: '需要人工决定' },
        { label: '论文资料', value: '48', note: '12 篇未读' },
        { label: '失败任务', value: '1', note: '2 个正在处理', risk: true }
      ],
      approvals: [
        { id: 'a1', stage: 'selection', label: '筛选论文 · 12 篇入选', note: '质量规则已通过，等待人工确认', age: ago(18) },
        { id: 'a2', stage: 'experiment', label: '实验计划 · 受控 Run', note: '将执行 python 脚本，需批准后启动', age: ago(52) },
        { id: 'a3', stage: 'method', label: '方法草案 · 基线选择', note: '补充了 2 个基线，等待确认', age: ago(190) }
      ],
      risks: [
        { id: 'r1', severity: 'high', title: '3 条主张缺少证据', detail: '写作交接后新增的主张尚未关联 Evidence' },
        { id: 'r2', severity: 'medium', title: '术语存在两种写法', detail: '「长上下文」与「长文本上下文」混用' },
        { id: 'r3', severity: 'low', title: '一次编译失败', detail: '缺失图文件 figures/arch.pdf' }
      ],
      runs: [
        { id: 'run-9f21c4a8', stage: '筛选论文', task: 'rank-candidates', status: 'completed', at: ago(21) },
        { id: 'run-71be03d5', stage: '论文检索', task: 'expand-queries', status: 'completed', at: ago(96) },
        { id: 'run-4c8a91fe', stage: '实验验证', task: 'plan-run', status: 'awaiting_approval', at: ago(52) },
        { id: 'run-0d5f77b2', stage: '方法设计', task: 'draft-method', status: 'running', at: ago(3) },
        { id: 'run-33a1e690', stage: '写作整合', task: 'compile', status: 'failed', at: ago(340) }
      ],
      constraints: [
        ['能力', 'project.read · patch.propose'],
        ['允许路径', 'paper/ · figures/'],
        ['网络白名单', 'export.arxiv.org'],
        ['上下文预算', '12,000 tokens'],
        ['最长运行', '120 秒']
      ],
      quality: { overall: 'warn', supported: 17, total: 21, needsVerification: 3, unsupported: 1, citations: '已识别 42 个引用', terminology: '1 组变体冲突', compile: '1 次失败' }
    },

    /* ---------------------------------------------------------------- 阶段 -- */
    stages: [
      { id: 'direction', index: 1, label: '研究方向', desc: '由研究者定义问题、边界与工作偏好', state: 'complete' },
      { id: 'search', index: 2, label: '论文检索', desc: '由 AI 补充检索式并保留来源', state: 'complete' },
      { id: 'selection', index: 3, label: '筛选论文', desc: '由质量规则与人工判断共同筛选', state: 'active' },
      { id: 'replication', index: 4, label: '论文复现', desc: '可选地验证已有工作和实验条件', state: 'ready' },
      { id: 'innovation', index: 5, label: '创新点', desc: '从已确认的证据中发现可检验空白', state: 'locked' },
      { id: 'method', index: 6, label: '方法设计', desc: '把创新点转为明确的方法与假设', state: 'locked' },
      { id: 'experiment', index: 7, label: '实验验证', desc: '记录数据、计划、结果与统计约束', state: 'error' },
      { id: 'writing', index: 8, label: '写作整合', desc: '在同一项目中将证据带入论文正文', state: 'locked' }
    ],
    stageStatusLabel: { locked: '未开始', ready: '待确认', active: '进行中', complete: '已完成', error: '需处理' },

    /* -------------------------------------------------------------- 论文候选 -- */
    papers: [
      { id: 'w1', title: 'Retrieval-Augmented Generation with Verifiable Citations', venue: 'ACL', year: 2025, authors: ['L. Chen', 'M. Okafor'], ccf: 'CCF-A', quality: 92, eligibility: 'pass', selected: true, abstract: '我们要求每个生成片段都携带可回溯的检索证据，并给出引用一致性指标。' },
      { id: 'w2', title: 'Long-Context Attention: A Survey of Efficiency Trade-offs', venue: 'TPAMI', year: 2024, authors: ['S. Ivanov', 'K. Tanaka'], ccf: 'CCF-A', quality: 88, eligibility: 'pass', selected: true, abstract: '系统梳理稀疏、线性与检索式注意力在长上下文下的效率—质量权衡。' },
      { id: 'w3', title: 'Faithful Attribution for Multi-Hop Question Answering', venue: 'EMNLP', year: 2025, authors: ['R. Silva'], ccf: 'CCF-B', quality: 81, eligibility: 'review', selected: true, abstract: '多跳问答中的归因路径存在证据泄漏，作者提出去泄漏的评测协议。' },
      { id: 'w4', title: 'Chunking Strategies for Retrieval over Scientific Corpora', venue: 'SIGIR', year: 2023, authors: ['A. Novak', 'J. Park'], ccf: 'CCF-A', quality: 79, eligibility: 'pass', selected: false, abstract: '比较固定窗口、语义边界与层级切分在科技文献上的召回差异。' },
      { id: 'w5', title: 'Measuring Hallucination under Retrieval Pressure', venue: 'NeurIPS', year: 2024, authors: ['D. Wright'], ccf: 'CCF-A', quality: 76, eligibility: 'review', selected: true, abstract: '在检索质量下降时，模型幻觉率的非线性上升曲线。' },
      { id: 'w6', title: 'A Reproducibility Checklist for IR Experiments', venue: 'ECIR', year: 2022, authors: ['P. Meyer'], ccf: 'CCF-B', quality: 68, eligibility: 'review', selected: false, abstract: '面向检索实验的可复现清单与自动化检查脚本。' },
      { id: 'w7', title: 'Sparse Retrieval Revisited with Learned Term Weights', venue: 'TOIS', year: 2025, authors: ['H. Ito'], ccf: 'CCF-A', quality: 85, eligibility: 'pass', selected: false, abstract: '学习式词权重让稀疏检索在长文档上接近稠密检索的召回。' },
      { id: 'w8', title: 'Evidence Ledgers: Tracking Claims Across a Paper', venue: 'NAACL', year: 2026, authors: ['Y. Zhang', 'C. Bell'], ccf: 'CCF-B', quality: 73, eligibility: 'review', selected: false, abstract: '把论文主张与实验产物绑定，支持写作期的自动核验。' }
    ],

    /* ---------------------------------------------------------------- 创新点 -- */
    ideas: [
      { id: 'i1', title: '检索步可回查的中间证据快照', summary: '把每次检索的查询、命中片段与筛选理由固化为不可变快照，使最终引用可逐跳回查。', evidence: ['w1', 'w3'], novelty: '现有工作只校验最终引用，不校验中间检索决策。', risk: '存储开销随跳数线性增长。', selected: true },
      { id: 'i2', title: '证据充分性门禁', summary: '在写作前对每条主张计算证据充分度，不足则阻断进入正文。', evidence: ['w5', 'w8'], novelty: '把「有没有证据」从写作后检查提前到写作前门禁。', risk: '门禁过严会拖慢写作节奏。', selected: true },
      { id: 'i3', title: '术语一致性投影', summary: '用项目级术语表在生成阶段约束用词，减少同一概念的多种写法。', evidence: ['w2'], novelty: '一致性约束下沉到生成投影而非事后检查。', risk: '术语表维护成本。', selected: false }
    ],

    /* ------------------------------------------------------------ 方法 / 实验 -- */
    method: {
      title: 'Snapshot-Verified Retrieval (SVR)',
      hypothesis: '若把检索中间态固化为快照并在写作前做证据充分性门禁，则引用可回查率提升而人工复核成本下降。',
      baselines: ['Dense-RAG', 'Sparse-BM25 + rerank', 'Long-context prompting'],
      ablations: ['去掉快照', '去掉门禁', '两者都去掉']
    },
    experiment: {
      dataset: 'SciRet-Long',
      version: 'v2.3 (2026-01)',
      protocol: '5 个随机种子 × 3 个长度档（32k / 128k / 512k），报告均值与 95% CI',
      command: 'python -m svr.run --config configs/longctx.yaml --seeds 5',
      status: '待批准',
      metrics: [
        { name: 'Citation Recall', value: '0.81', uncertainty: '±0.02' },
        { name: 'Attribution F1', value: '0.74', uncertainty: '±0.03' },
        { name: 'Human Review Cost', value: '−38%', uncertainty: '—' }
      ],
      successCriteria: ['Citation Recall ≥ 0.78', 'Attribution F1 ≥ 0.70', '人工复核成本下降 ≥ 25%']
    },

    /* ---------------------------------------------------------------- 证据 -- */
    evidence: [
      { id: 'c1', text: '快照机制使引用可回查率从 0.62 提升到 0.81。', status: 'supported', refs: ['e-w1', 'e-run9'] },
      { id: 'c2', text: '证据充分性门禁降低了写作期返工次数。', status: 'supported', refs: ['e-run9'] },
      { id: 'c3', text: '在 512k 长度下模型仍保持稳定的归因质量。', status: 'needs-verification', refs: ['e-w2'] },
      { id: 'c4', text: '该方法在所有检索基线上都取得最优结果。', status: 'unsupported', refs: [] }
    ],

    /* ---------------------------------------------------------- 助手 / Patch -- */
    chat: [
      { role: 'user', text: '把筛选阶段的入选标准再收紧一点：只保留 CCF-A 且 2023 年之后的工作。' },
      { role: 'assistant', text: '已按新标准重排候选：8 篇候选中 **4 篇**满足 CCF-A 且 ≥2023。\n其余 4 篇降级为参考，不会进入复现清单。' },
      { role: 'assistant', text: '我准备把筛选规则写入项目约束，并同步修改方法草案里的基线列表。需要你确认这次修改。', patch: true }
    ],
    patch: {
      file: 'configs/filter.yaml',
      lines: [
        { t: 'ctx', v: 'filters:' },
        { t: 'del', v: '-  venueLevel: CCF-B' },
        { t: 'add', v: '+  venueLevel: CCF-A' },
        { t: 'ctx', v: '   yearFrom: "2022"' },
        { t: 'del', v: '   yearFrom: "2022"' },
        { t: 'add', v: '   yearFrom: "2023"' },
        { t: 'ctx', v: '   peerReviewed: true' }
      ]
    },

    /* ---------------------------------------------------------------- 文稿 -- */
    manuscript: {
      file: 'paper/main.tex',
      section: '3. Method',
      lines: [
        { n: 1, html: '<span class="tk-comment">% SVR: snapshot-verified retrieval</span>' },
        { n: 2, html: '<span class="tk-cmd">\\section</span><span class="tk-brace">{</span>Method<span class="tk-brace">}</span>' },
        { n: 3, html: '<span class="tk-cmd">\\label</span><span class="tk-brace">{</span>sec:method<span class="tk-brace">}</span>' },
        { n: 4, html: '' },
        { n: 5, html: 'We cast retrieval as a sequence of <span class="tk-arg">snapshots</span>' },
        { n: 6, html: 'so that every citation can be traced back to the exact' },
        { n: 7, html: 'decision that produced it~<span class="tk-cite">\\cite{chen2025verifiable}</span>.' },
        { n: 8, html: '' },
        { n: 9, html: '<span class="tk-cmd">\\begin</span><span class="tk-brace">{</span>equation<span class="tk-brace">}</span>' },
        { n: 10, html: '  <span class="tk-math">\\mathcal{L}_{\\text{svr}} = \\sum_{k=1}^{K} \\lambda_k \\, \\| s_k - \\hat{s}_k \\|_2^2</span>' },
        { n: 11, html: '<span class="tk-cmd">\\end</span><span class="tk-brace">{</span>equation<span class="tk-brace">}</span>' },
        { n: 12, html: '' },
        { n: 13, html: 'Gate <span class="tk-arg">g(\\cdot)</span> blocks a claim when its evidence' },
        { n: 14, html: 'sufficiency falls below <span class="tk-math">\\tau = 0.7</span>. <span class="caret"></span>' }
      ],
      hl: 10
    },

    /* ----------------------------------------------------------- 快捷命令 -- */
    commands: [
      { id: 'go-start', label: '回到开始工作区', hint: '⌘1', icon: 'layout', run: function () { location.hash = '#/'; } },
      { id: 'go-cockpit', label: '项目概览（控制室）', hint: '⌘2', icon: 'grid', run: function () { location.hash = '#/project/p-01'; } },
      { id: 'go-research', label: '研究工作区 · 筛选论文', hint: '⌘3', icon: 'flask', run: function () { location.hash = '#/research/selection'; } },
      { id: 'go-editor', label: '论文编辑器', hint: '⌘4', icon: 'file-text', run: function () { location.hash = '#/editor'; } },
      { id: 'go-motion', label: '特效巡演 · 十个招牌动效', hint: '⌘5', icon: 'sparkles', run: function () { location.hash = '#/motion'; } },
      { id: 'go-design', label: '设计说明与手感实验室', hint: '⌘6', icon: 'sliders', run: function () { location.hash = '#/design'; } },
      { id: 'theme', label: '切换浅色 / 深色外观', hint: '⌘⇧D', icon: 'moon', run: function () { P.prefs.set('theme', P.prefs.effective().theme === 'dark' ? 'light' : 'dark'); } },
      { id: 'motion', label: '切换「降低动效」', hint: '', icon: 'waveform', run: function () { P.prefs.set('motion', P.prefs.effective().motion === 'reduced' ? 'auto' : 'reduced'); } },
      { id: 'approve', label: '打开人工审批抽屉', hint: '', icon: 'shield', run: function () { P.ui.approvalSheet(); } }
    ]
  };
})();
