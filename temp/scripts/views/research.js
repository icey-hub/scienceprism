/* ==========================================================================
   views/research.js — 研究工作区（对应 ResearchWorkspacePage 的 8 阶段）
   设计点：
     · 阶段切换有方向性：往后走从右进，往回走从左进（进入/退出同一条路径）
     · 左侧指示条是弹簧驱动的，可被下一次点击打断并从当前位置继续
     · 人工确认是「按住」而不是「点一下」：安全来自成本，而不是弹窗
     · 右侧上下文栏可拖拽改宽：1:1 跟手 + 越界橡皮筋 + 双击复位
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var d = P.data;
  var stages = d.stages;

  function stageById(id) { return stages.filter(function (s) { return s.id === id; })[0] || stages[0]; }
  function statusLabel(s) { return d.stageStatusLabel[s] || s; }
  function statusTone(s) {
    return s === 'complete' ? 'ok' : s === 'active' ? 'accent' : s === 'ready' ? 'warn' : s === 'error' ? 'danger' : '';
  }

  /* ------------------------------------------------------------ 阶段导航 -- */
  function stageNav(active) {
    return stages.map(function (s) {
      return '<button class="stage-item is-' + s.state + (s.id === active ? ' is-active' : '') + '" type="button" data-stage="' + s.id + '">' +
        '<span class="si-index">' + (s.state === 'complete' ? P.icon('check', 12) : String(s.index).padStart(2, '0')) + '</span>' +
        '<span class="si-copy"><strong>' + s.label + '</strong><small>' + s.desc + '</small></span>' +
        '<span class="si-status badge ' + statusTone(s.state) + '">' + statusLabel(s.state) + '</span>' +
        '</button>';
    }).join('');
  }

  /* -------------------------------------------------------------- 阶段内容 -- */
  function papers(selectable) {
    return d.papers.map(function (p) {
      var tone = p.eligibility === 'pass' ? 'ok' : p.eligibility === 'review' ? 'warn' : 'danger';
      var text = p.eligibility === 'pass' ? '符合' : p.eligibility === 'review' ? '待复核' : '排除';
      return '<div class="row-item" data-paper="' + p.id + '">' +
        (selectable ? '<button class="chip' + (p.selected ? ' on' : '') + '" type="button" data-pick="' + p.id + '">' + P.icon(p.selected ? 'check' : 'plus', 13) + '</button>' : '') +
        '<div class="grow"><div class="row-title">' + P.esc(p.title) + '</div>' +
        '<div class="row-sub">' + P.esc(p.authors.join(', ')) + ' · ' + p.venue + ' ' + p.year + ' · ' + p.ccf + '</div>' +
        '<div class="t-caption t-muted clamp2" style="margin-top:4px">' + P.esc(p.abstract) + '</div></div>' +
        '<span class="badge ' + tone + '">' + text + '</span>' +
        '<span class="t-caption t-num t-dim">' + p.quality + '</span></div>';
    }).join('');
  }

  var BODIES = {
    direction: function () {
      var dir = { question: d.project.question, scope: d.project.scope, keywords: ['长上下文', '检索增强', '可验证性', '引用归因'] };
      return '<div class="panel"><div class="panel-body stack">' +
        '<div class="field"><label>研究问题</label>' +
        '<textarea class="textarea" rows="3">' + P.esc(dir.question) + '</textarea>' +
        '<span class="hint">问题由你定义；AI 只能补充检索式与候选，不能替你改问题。</span></div>' +
        '<div class="grid-2">' +
        '<div class="field"><label>研究范围</label><input class="input" value="' + P.esc(dir.scope) + '"></div>' +
        '<div class="field"><label>种子关键词</label><input class="input" value="' + P.esc(dir.keywords.join('、')) + '"></div>' +
        '</div>' +
        '<div class="field"><label>本阶段绑定的 Skill</label>' +
        '<div class="row wrap gap2">' +
        ['literature-search', 'research-writing', 'paper-card'].map(function (s, i) {
          return '<span class="chip' + (i < 2 ? ' on' : '') + '">' + P.icon('sparkles', 13) + s + '</span>';
        }).join('') +
        '<button class="chip" type="button" data-skill-add>' + P.icon('plus', 13) + '添加 Skill</button>' +
        '</div></div>' +
        '<div class="row gap3"><button class="btn primary" type="button" data-save>保存方向</button>' +
        '<span class="t-caption t-dim">保存后进入人工确认，未确认不会解锁下一阶段。</span></div>' +
        '</div></div>';
    },
    search: function () {
      var sources = [
        { name: 'arXiv', count: 42, ok: true },
        { name: 'Semantic Scholar', count: 18, ok: true },
        { name: 'DBLP', count: 9, ok: true },
        { name: 'OpenReview', count: 0, ok: false }
      ];
      return '<div class="stack">' +
        '<div class="panel"><div class="panel-body">' +
        '<div class="row gap2"><input class="input grow" value="long-context retrieval verifiability citation attribution">' +
        '<button class="btn primary" type="button" data-run-search>' + P.icon('search', 15) + '运行检索</button></div>' +
        '<p class="t-caption t-dim" style="margin-top:8px">检索式由 AI 补充，但每条命中都会保留来源与抓取时间，便于回查。</p>' +
        '</div></div>' +
        '<div class="grid-3">' + sources.map(function (s) {
          return '<div class="tile"><div class="tile-label">' + s.name + '</div>' +
            '<div class="tile-value">' + s.count + '</div>' +
            '<div class="tile-note">' + (s.ok ? '已返回结果' : '本次未能完成检索') + '</div></div>';
        }).join('') + '</div>' +
        '<div class="panel"><div class="panel-body"><div class="section-head"><div>' +
        '<span class="t-overline">Raw Hits</span><h3>原始命中（前 3 条）</h3></div>' +
        '<span class="badge">69 条候选</span></div>' +
        '<div class="t-mono t-caption" style="line-height:1.7;color:var(--text-2)">' +
        '[arxiv] 2503.11422 · Retrieval-Augmented Generation with Verifiable Citations<br>' +
        '[arxiv] 2401.09771 · Long-Context Attention: A Survey of Efficiency Trade-offs<br>' +
        '[s2] 5f31c0a9 · Faithful Attribution for Multi-Hop Question Answering</div>' +
        '</div></div></div>';
    },
    selection: function () {
      return '<div class="stack">' +
        '<div class="panel"><div class="panel-head"><div><span class="t-overline">Filter Policy</span>' +
        '<div class="t-headline" style="margin-top:2px">筛选规则（硬约束）</div></div>' +
        '<span class="badge accent">写入项目约束</span></div>' +
        '<div class="panel-body"><div class="row wrap gap2">' +
        ['CCF-A', '会议 + 期刊', '2023 – 2026', '同行评审', '需要代码'].map(function (c, i) {
          return '<span class="chip' + (i < 4 ? ' on' : '') + '">' + c + '</span>';
        }).join('') + '</div>' +
        '<p class="t-caption t-dim" style="margin-top:10px">规则先于人工判断生效：不满足硬约束的候选会被标注原因，而不是直接消失。</p>' +
        '</div></div>' +
        '<div class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Candidates</span><div class="t-headline" style="margin-top:2px">候选论文</div></div>' +
        '<div class="row gap2"><span class="badge" data-pick-count>已选 4 / 8</span>' +
        '<button class="btn sm" type="button" data-save>保存选择</button></div></div>' +
        '<div class="panel-body tight" data-paper-list>' + papers(true) + '</div></div></div>';
    },
    replication: function () {
      return '<div class="panel"><div class="panel-body stack">' +
        '<div class="panel" style="box-shadow:none;background:var(--mat-fill)"><div class="panel-body">' +
        '<div class="row between gap3"><div><strong class="t-callout">这一阶段可以跳过</strong>' +
        '<p class="t-caption t-muted" style="margin-top:2px">跳过同样需要人工确认，并会写入项目记录。</p></div>' +
        '<button class="btn ghost" type="button" data-skip>跳过复现</button></div></div></div>' +
        '<div class="grid-2">' +
        '<div class="field"><label>代码仓库</label><input class="input" value="github.com/lab/svr-retrieval"></div>' +
        '<div class="field"><label>数据集</label><input class="input" value="SciRet-Long v2.3"></div>' +
        '</div>' +
        '<div class="field"><label>运行环境</label><input class="input" value="python 3.11 · torch 2.3 · 1×A100 80G"></div>' +
        '<div class="field"><label>复现备注</label><textarea class="textarea" rows="3">论文未给出随机种子；我们固定 5 个种子并报告 95% 置信区间。</textarea></div>' +
        '<div class="row gap3"><button class="btn primary" type="button" data-save>保存复现计划</button>' +
        '<span class="t-caption t-dim">复现结果会作为证据写入 Evidence Ledger。</span></div>' +
        '</div></div>';
    },
    innovation: function () {
      return '<div class="stack">' +
        '<div class="panel"><div class="panel-body"><div class="section-head"><div>' +
        '<span class="t-overline">Gap Finding</span><h3>从已确认证据中找空白</h3>' +
        '<p>只有被选中的论文与复现结论会进入这一步。</p></div>' +
        '<button class="btn" type="button" data-generate>' + P.icon('sparkles', 15) + '生成候选创新点</button>' +
        '</div></div></div>' +
        d.ideas.map(function (idea) {
          return '<div class="panel"><div class="panel-body">' +
            '<div class="row between gap3">' +
            '<div class="grow"><span class="t-overline">Idea</span>' +
            '<div class="t-title3" style="margin-top:3px">' + P.esc(idea.title) + '</div></div>' +
            '<button class="chip' + (idea.selected ? ' on' : '') + '" type="button" data-idea="' + idea.id + '">' +
            P.icon(idea.selected ? 'check' : 'plus', 13) + (idea.selected ? '已选择' : '选择') + '</button></div>' +
            '<p class="t-callout" style="margin-top:8px">' + P.esc(idea.summary) + '</p>' +
            '<div class="grid-2" style="margin-top:12px">' +
            '<div class="card flat"><span class="t-overline">新颖性</span><p class="t-callout" style="margin-top:4px">' + P.esc(idea.novelty) + '</p></div>' +
            '<div class="card flat"><span class="t-overline">风险</span><p class="t-callout" style="margin-top:4px">' + P.esc(idea.risk) + '</p></div>' +
            '</div>' +
            '<div class="row gap2 wrap" style="margin-top:10px">' + idea.evidence.map(function (e) {
              return '<span class="chip">' + P.icon('link', 12) + e + '</span>';
            }).join('') + '</div>' +
            '</div></div>';
        }).join('') + '</div>';
    },
    method: function () {
      return '<div class="panel"><div class="panel-body stack">' +
        '<div class="field"><label>方法名称</label><input class="input" value="' + P.esc(d.method.title) + '"></div>' +
        '<div class="field"><label>可检验假设</label><textarea class="textarea" rows="3">' + P.esc(d.method.hypothesis) + '</textarea></div>' +
        '<div class="grid-2">' +
        '<div class="field"><label>基线</label><div class="row wrap gap2">' + d.method.baselines.map(function (b) { return '<span class="chip on">' + P.esc(b) + '</span>'; }).join('') + '</div></div>' +
        '<div class="field"><label>消融</label><div class="row wrap gap2">' + d.method.ablations.map(function (b) { return '<span class="chip">' + P.esc(b) + '</span>'; }).join('') + '</div></div>' +
        '</div>' +
        '<div class="row gap3"><button class="btn primary" type="button" data-save>保存方法草案</button>' +
        '<button class="btn" type="button" data-generate>' + P.icon('sparkles', 15) + '重新生成候选</button></div>' +
        '</div></div>';
    },
    experiment: function () {
      var e = d.experiment;
      return '<div class="stack">' +
        '<div class="panel"><div class="panel-head"><div><span class="t-overline">Plan</span>' +
        '<div class="t-headline" style="margin-top:2px">实验计划</div></div>' +
        '<span class="badge warn"><i class="dot"></i>' + e.status + '</span></div>' +
        '<div class="panel-body stack">' +
        '<div class="grid-3">' +
        '<div class="field"><label>数据集</label><input class="input" value="' + P.esc(e.dataset) + '"></div>' +
        '<div class="field"><label>版本</label><input class="input" value="' + P.esc(e.version) + '"></div>' +
        '<div class="field"><label>随机种子</label><input class="input" value="5 seeds"></div>' +
        '</div>' +
        '<div class="field"><label>协议</label><textarea class="textarea" rows="2">' + P.esc(e.protocol) + '</textarea></div>' +
        '<div class="field"><label>执行命令（需要批准后才会运行）</label>' +
        '<input class="input t-mono" value="' + P.esc(e.command) + '"></div>' +
        '<div class="field"><label>成功判据</label><ul class="stack sm">' + e.successCriteria.map(function (c) {
          return '<li class="row gap2 t-callout">' + P.icon('target', 14) + P.esc(c) + '</li>';
        }).join('') + '</ul></div>' +
        '</div></div>' +

        '<div class="panel"><div class="panel-head"><div><span class="t-overline">Controlled Run</span>' +
        '<div class="t-headline" style="margin-top:2px">受控运行</div></div>' +
        '<span class="badge warn"><i class="dot"></i>等待批准</span></div>' +
        '<div class="panel-body">' +
        '<div class="grid-3" style="margin-bottom:var(--s4)">' + e.metrics.map(function (m) {
          return '<div class="tile"><div class="tile-label">' + m.name + '</div>' +
            '<div class="tile-value">' + m.value + '</div><div class="tile-note">' + m.uncertainty + '</div></div>';
        }).join('') + '</div>' +
        '<div class="card flat"><div class="row between gap3 wrap">' +
        '<div class="row gap3">' + P.icon('lock', 18) +
        '<div><strong class="t-callout">启动隔离执行</strong>' +
        '<p class="t-caption t-muted" style="margin-top:2px">权限：experiment.execute（仅本次运行）· 超时 120 秒 · 无网络</p></div></div>' +
        '<button class="hold-btn" type="button" data-hold-run>' +
        '<span class="hold-fill"></span><span>' + P.icon('play', 15) + '</span><span data-hold-label>按住批准并启动</span></button>' +
        '</div></div>' +
        '<p class="t-caption t-dim" style="margin-top:10px">按住 0.9 秒才会提交；提前松手会回弹，不会留下半启动状态。</p>' +
        '</div></div></div>';
    },
    writing: function () {
      return '<div class="stack">' +
        '<div class="grid-3">' +
        '<div class="tile"><div class="tile-label">已选论文</div><div class="tile-value">4</div><div class="tile-note">进入证据链</div></div>' +
        '<div class="tile"><div class="tile-label">创新点</div><div class="tile-value">2</div><div class="tile-note">已选择</div></div>' +
        '<div class="tile"><div class="tile-label">可引用指标</div><div class="tile-value">3</div><div class="tile-note">含不确定性</div></div>' +
        '</div>' +
        '<div class="panel"><div class="panel-head"><div><span class="t-overline">Handoff</span>' +
        '<div class="t-headline" style="margin-top:2px">写作交接</div></div>' +
        '<span class="badge ok"><i class="dot"></i>材料齐备</span></div>' +
        '<div class="panel-body stack">' +
        '<div class="field"><label>写作 Brief（大纲）</label>' +
        '<textarea class="textarea" rows="6">1. 问题：长上下文检索的引用不可回查\n2. 方法：快照化检索 + 证据充分性门禁\n3. 实验：SciRet-Long v2.3，5 种子 × 3 长度档\n4. 结果：Citation Recall 0.81 ± 0.02\n5. 限制：存储开销随跳数线性增长</textarea></div>' +
        '<div class="row gap3"><button class="btn primary" type="button" data-go="#/editor">整理材料并打开写作台 ' + P.icon('arrow-right', 15) + '</button>' +
        '<span class="t-caption t-dim">打开后仍可回到本阶段修改，证据关联会保持。</span></div>' +
        '</div></div></div>';
    }
  };

  /* -------------------------------------------------------------- 上下文 -- */
  function contextPane() {
    var rows = [
      ['研究问题', d.project.question],
      ['硬约束', 'CCF-A · 会议 + 期刊 · 2023–2026'],
      ['当前 Skill', 'literature-search、paper-card'],
      ['阶段任务', '等待人工确认'],
      ['Harness', 'run-9f21c4a8'],
      ['验证', '通过但有 1 条提示'],
      ['人工控制', 'AI 辅助，人工确认后才进入下一阶段']
    ];
    return '<div class="ctx-inner scroll">' +
      '<span class="t-overline">Run Context</span>' +
      '<div class="t-headline" style="margin:4px 0 var(--s4)">当前上下文</div>' +
      rows.map(function (r) {
        return '<dl class="ctx-item"><dt>' + r[0] + '</dt><dd>' + P.esc(r[1]) + '</dd></dl>';
      }).join('') +
      '<div class="card flat" style="margin-top:var(--s4)">' +
      '<div class="row gap2">' + P.icon('shield', 16) + '<strong class="t-caption">人工确认门禁</strong></div>' +
      '<p class="t-caption t-muted" style="margin-top:6px">角色只能收窄权限，不能扩大；Skill 不能越过审批。</p>' +
      '</div>' +
      '<button class="btn ghost" type="button" data-ctx-sheet style="margin-top:var(--s4);width:100%">' +
      P.icon('layers', 15) + '打开运行上下文抽屉</button>' +
      '</div>';
  }

  P.views.research = {
    render: function (ctx) {
      var active = stageById(ctx.stage || 'selection');
      var def = active;
      return '<div class="research" data-research>' +
        '<aside class="stage-nav scroll" data-stage-nav>' +
        '<span class="stage-indicator" data-indicator></span>' +
        stageNav(active.id) +
        '<div class="stage-note"><strong class="t-caption">人工确认门禁</strong>' +
        '<p>AI 负责补充与执行建议，每一阶段由你输入并确认。</p></div>' +
        '</aside>' +

        '<div class="stage-main">' +
        '<header class="stage-head">' +
        '<span class="t-overline" data-stage-overline>Stage ' + String(def.index).padStart(2, '0') + ' / 08</span>' +
        '<h2 class="t-title1" data-stage-title>' + def.label + '</h2>' +
        '<p class="t-callout t-muted" data-stage-desc>' + def.desc + '</p>' +
        '</header>' +
        '<div class="stage-body scroll" data-stage-body>' + BODIES[active.id]() + '</div>' +
        '<footer class="stage-foot">' +
        '<button class="btn quiet" type="button" data-prev>' + P.icon('arrow-left', 15) + '上一阶段</button>' +
        '<div class="row gap2">' +
        '<span class="t-caption t-dim" data-stage-hint>阶段输出通过校验后才能确认</span>' +
        '<button class="hold-btn" type="button" data-hold-approve>' +
        '<span class="hold-fill"></span><span>' + P.icon('check', 15) + '</span><span data-hold-label>按住人工确认</span>' +
        '</button>' +
        '<button class="btn primary" type="button" data-next>下一阶段' + P.icon('arrow-right', 15) + '</button>' +
        '</div></footer>' +
        '</div>' +

        '<div class="context-pane">' +
        '<div class="splitter" data-ctx-split></div>' +
        contextPane() +
        '</div>' +
        '</div>';
    },

    mount: function (root, ctx) {
      var research = root.querySelector('[data-research]');
      var nav = root.querySelector('[data-stage-nav]');
      var indicator = root.querySelector('[data-indicator]');
      var body = root.querySelector('[data-stage-body]');
      var overline = root.querySelector('[data-stage-overline]');
      var title = root.querySelector('[data-stage-title]');
      var desc = root.querySelector('[data-stage-desc]');
      var hint = root.querySelector('[data-stage-hint]');
      var current = stageById(ctx.stage || 'selection').id;
      var ctxWidth = 300;

      /* 指示条：弹簧驱动，可被下一次切换打断 */
      var ind = P.motion({ y: 0, h: 0 });
      ind.on(function (v) {
        indicator.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0)';
        indicator.style.height = P.round(v.h, 2) + 'px';
      });
      function placeIndicator(animate) {
        var item = nav.querySelector('.stage-item.is-active');
        if (!item) return;
        var target = { y: item.offsetTop + 9, h: item.offsetHeight - 18 };
        if (animate) ind.to(target, { preset: 'snappy' }); else ind.set(target);
      }

      /* 阶段切换：往后从右进、往回从左进 —— 进入和退出走同一条路径 */
      function go(id, dir, animate) {
        var next = stageById(id);
        if (!next || !BODIES[next.id]) return;
        current = next.id;
        history.replaceState(null, '', '#/research/' + next.id);
        P.$$('.stage-item', nav).forEach(function (el) {
          el.classList.toggle('is-active', el.dataset.stage === next.id);
        });
        overline.textContent = 'Stage ' + String(next.index).padStart(2, '0') + ' / 08';
        title.textContent = next.label;
        desc.textContent = next.desc;
        hint.textContent = next.state === 'complete' ? '已确认，可随时回到本阶段修改' : '阶段输出通过校验后才能确认';
        body.innerHTML = BODIES[next.id]();
        if (animate) {
          body.style.setProperty('--stage-dx', (dir >= 0 ? 18 : -18) + 'px');
          body.classList.remove('stage-swap');
          void body.offsetWidth;
          body.classList.add('stage-swap');
        }
        placeIndicator(animate);
        mountBody(body, next);
      }

      /* 点阶段：方向由索引差决定 */
      P.on(nav, '[data-stage]', 'click', function (e, el) {
        var from = stages.filter(function (s) { return s.id === current; })[0].index;
        var to = stageById(el.dataset.stage).index;
        go(el.dataset.stage, to >= from ? 1 : -1, true);
      });
      root.querySelector('[data-prev]').addEventListener('click', function () {
        var i = stages.indexOf(stageById(current));
        if (i > 0) go(stages[i - 1].id, -1, true);
      });
      root.querySelector('[data-next]').addEventListener('click', function () {
        var i = stages.indexOf(stageById(current));
        if (i < stages.length - 1) go(stages[i + 1].id, 1, true);
      });

      /* 按住确认：确认后本阶段置为已完成，并前进一阶段 */
      var hold = root.querySelector('[data-hold-approve]');
      var holdLabel = hold.querySelector('[data-hold-label]');
      var holdCtl = P.ui.holdButton(hold, {
        duration: 900,
        onComplete: function () {
          var s = stageById(current);
          s.state = 'complete';
          var el = nav.querySelector('[data-stage="' + s.id + '"]');
          if (el) {
            el.classList.remove('is-active');
            el.classList.add('is-complete');
            el.querySelector('.si-index').innerHTML = P.icon('check', 12);
            var b = el.querySelector('.si-status');
            b.className = 'si-status badge ok';
            b.textContent = '已完成';
          }
          holdLabel.textContent = '已确认';
          P.ui.toast('已确认：' + s.label + '（actor = human）', { icon: 'shield' });
          var i = stages.indexOf(s);
          window.setTimeout(function () {
            holdLabel.textContent = '按住人工确认';
            holdCtl.reset();
            if (i < stages.length - 1) go(stages[i + 1].id, 1, true);
          }, 620);
        }
      });

      /* 右侧上下文栏：拖拽改宽 + 越界橡皮筋 + 双击复位 */
      var MIN = 240, MAX = 440, DEFAULT = 300;
      function setWidth(v) { research.style.setProperty('--ctx-w', P.round(v, 2) + 'px'); }
      setWidth(DEFAULT);
      P.ui.splitter(root.querySelector('[data-ctx-split]'), {
        label: '调整上下文栏宽度',
        get: function () { return ctxWidth; },
        limit: function (raw) {
          if (raw < MIN) return MIN - P.rubberband(MIN - raw, 180);
          if (raw > MAX) return MAX + P.rubberband(raw - MAX, 180);
          return raw;
        },
        set: function (v) { ctxWidth = v; setWidth(v); },
        reset: function () { ctxWidth = DEFAULT; setWidth(DEFAULT); }
      });

      /* 运行上下文抽屉：拖拽关闭、动量投影、可中断 */
      root.querySelector('[data-ctx-sheet]').addEventListener('click', function () {
        P.ui.sheet({
          side: 'bottom',
          title: '运行上下文',
          desc: '这一层不是模态任务：它不遮断你的流程，只是把当前上下文摊开。',
          body: '<div class="stack">' +
            '<div class="grid-2">' +
            '<div class="card flat"><span class="t-overline">权限</span><p class="t-callout" style="margin-top:4px">project.read · patch.propose</p></div>' +
            '<div class="card flat"><span class="t-overline">网络</span><p class="t-callout" style="margin-top:4px">export.arxiv.org（只读）</p></div>' +
            '<div class="card flat"><span class="t-overline">预算</span><p class="t-callout" style="margin-top:4px">12,000 tokens · 120 秒</p></div>' +
            '<div class="card flat"><span class="t-overline">已加载 Skill</span><p class="t-callout" style="margin-top:4px">literature-search、paper-card</p></div>' +
            '</div>' +
            '<p class="t-caption t-dim">向下拖动抓手即可关闭；松手时的速度会决定它是回弹还是关闭。</p>' +
            '</div>'
        });
      });

      placeIndicator(false);
      mountBody(body, stageById(current));
      window.addEventListener('resize', function () { placeIndicator(false); });
    }
  };

  /* --------------------------------------------------------- 阶段内容装配 -- */
  function mountBody(body, stage) {
    P.$$('[data-pick]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = d.papers.filter(function (x) { return x.id === btn.dataset.pick; })[0];
        p.selected = !p.selected;
        btn.classList.toggle('on', p.selected);
        btn.innerHTML = P.icon(p.selected ? 'check' : 'plus', 13);
        var counter = body.querySelector('[data-pick-count]');
        if (counter) {
          var n = d.papers.filter(function (x) { return x.selected; }).length;
          counter.textContent = '已选 ' + n + ' / ' + d.papers.length;
        }
      });
    });

    P.$$('[data-save]', body).forEach(function (btn) {
      btn.addEventListener('click', function () { P.ui.toast('已保存，等待人工确认'); });
    });
    P.$$('[data-generate]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var original = btn.innerHTML;
        btn.innerHTML = P.icon('sparkles', 15) + '生成中…';
        window.setTimeout(function () {
          btn.disabled = false;
          btn.innerHTML = original;
          P.ui.toast('候选已生成，请人工比较后选择');
        }, 1100);
      });
    });
    var runSearch = body.querySelector('[data-run-search]');
    if (runSearch) runSearch.addEventListener('click', function () {
      runSearch.disabled = true;
      runSearch.innerHTML = P.icon('search', 15) + '检索中…';
      window.setTimeout(function () {
        runSearch.disabled = false;
        runSearch.innerHTML = P.icon('search', 15) + '运行检索';
        P.ui.toast('检索完成：69 条候选已回填', { icon: 'search' });
      }, 1200);
    });
    P.$$('[data-idea]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idea = d.ideas.filter(function (x) { return x.id === btn.dataset.idea; })[0];
        idea.selected = !idea.selected;
        btn.classList.toggle('on', idea.selected);
        btn.innerHTML = P.icon(idea.selected ? 'check' : 'plus', 13) + (idea.selected ? '已选择' : '选择');
      });
    });
    var skip = body.querySelector('[data-skip]');
    if (skip) skip.addEventListener('click', function () {
      P.ui.sheet({
        side: 'center',
        title: '确认跳过论文复现？',
        desc: '跳过会写入项目记录，并让下一阶段的证据强度下降。',
        body: '<p class="t-callout t-muted">这是不可逆的一步（可以重新发起，但历史记录会保留）。所以它需要一次明确的决定，而不是顺手点过。</p>',
        footer: '<button class="btn quiet" type="button" data-cancel>取消</button>' +
          '<button class="btn danger" type="button" data-confirm>确认跳过</button>',
        onMount: function (panel, close) {
          panel.querySelector('[data-cancel]').addEventListener('click', close);
          panel.querySelector('[data-confirm]').addEventListener('click', function () {
            close();
            P.ui.toast('已记录跳过论文复现', { icon: 'shield' });
          });
        }
      });
    });
    var skillAdd = body.querySelector('[data-skill-add]');
    if (skillAdd) skillAdd.addEventListener('click', function () {
      P.ui.sheet({
        side: 'right',
        title: '添加 Skill',
        desc: '只接受目录根下直接包含 SKILL.md 的文件夹。',
        body: '<div class="stack">' +
          ['paper-figure-style', 'statistics-audit', 'claim-evidence-audit', 'dataset-audit'].map(function (s) {
            return '<div class="row-item"><div class="grow"><div class="row-title">' + s + '</div>' +
              '<div class="row-sub">来自 .dsh/skills</div></div>' +
              '<button class="btn sm" type="button" data-add="' + s + '">添加</button></div>';
          }).join('') + '</div>',
        onMount: function (panel, close) {
          P.$$('[data-add]', panel).forEach(function (b) {
            b.addEventListener('click', function () {
              close();
              P.ui.toast('已添加 Skill：' + b.dataset.add + '（需勾选到阶段）', { icon: 'sparkles' });
            });
          });
        }
      });
    });
    /* 受控运行：按住批准并启动 */
    var holdRun = body.querySelector('[data-hold-run]');
    if (holdRun) {
      var label = holdRun.querySelector('[data-hold-label]');
      P.ui.holdButton(holdRun, {
        duration: 900,
        onComplete: function () {
          label.textContent = '已启动';
          P.ui.toast('受控运行已启动，日志会写回项目', { icon: 'play' });
        },
        onCancel: function () { label.textContent = '按住批准并启动'; }
      });
    }
  }
})();
