/* ==========================================================================
   views/cockpit.js — 项目控制室（对应 ProjectDashboardPage）
   设计点：
     · 顶部用分段控件切换视图，指示块可按住拖动、松手落定（提示手势方向）
     · 待审批事项用「滑动决定」：释放速度经动量投影决定落点，而不是就近吸附
     · 设置页集中放可达性开关，让「降低动效 / 透明度 / 对比」当场可验
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var d = P.data;
  var pr = d.project;

  var TABS = [
    { value: 'overview', label: '概览' },
    { value: 'library', label: '资料' },
    { value: 'tasks', label: '任务' },
    { value: 'approvals', label: '审批' },
    { value: 'runs', label: '运行' },
    { value: 'evidence', label: '证据' },
    { value: 'settings', label: '设置' }
  ];

  function badgeFor(state) {
    var map = {
      completed: ['ok', '已完成'], running: ['info', '运行中'], awaiting_approval: ['warn', '待批准'],
      failed: ['danger', '失败'], queued: ['', '排队中']
    };
    var m = map[state] || ['', state];
    return '<span class="badge ' + m[0] + '"><i class="dot"></i>' + m[1] + '</span>';
  }

  function approvalRow(a) {
    return '<div class="swipe" data-swipe="' + a.id + '">' +
      '<div class="swipe-action approve">' + P.icon('check', 16) + '<span>批准</span></div>' +
      '<div class="swipe-action reject"><span>驳回</span>' + P.icon('x', 16) + '</div>' +
      '<div class="swipe-face">' +
      '<span class="ar-index">!</span>' +
      '<div class="grow"><div class="row-title">' + P.esc(a.label) + '</div>' +
      '<div class="row-sub">' + P.esc(a.note) + ' · ' + P.fmtTime(a.age) + '</div></div>' +
      '<span class="swipe-hint">滑动决定</span>' +
      '</div></div>';
  }

  function tile(t) {
    var m = /^([0-9.]+)(.*)$/.exec(t.value);
    return '<div class="tile' + (t.risk ? ' is-risk' : '') + '">' +
      '<div class="tile-label">' + P.esc(t.label) + '</div>' +
      '<div class="tile-value" data-count-to="' + (m ? m[1] : '') + '" data-count-suffix="' + (m ? m[2] : '') + '">' +
      (m ? '0' + m[2] : P.esc(t.value)) + '</div>' +
      '<div class="tile-note">' + P.esc(t.note) + '</div></div>';
  }

  function runRow(r) {
    return '<div class="run-row">' +
      '<span class="status-dot ' + r.status + '"></span>' +
      '<div class="grow"><div class="t-callout" style="font-weight:var(--w-medium)">' + P.esc(r.stage) + ' · ' + P.esc(r.task) + '</div>' +
      '<div class="t-caption t-muted">' + P.fmtTime(r.at) + ' · <code class="t-mono">' + r.id + '</code></div></div>' +
      badgeFor(r.status) + '</div>';
  }

  /* ---------------------------------------------------------------- 概览 -- */
  function overview() {
    return '<div class="tile-grid" data-tiles>' + pr.stats.map(tile).join('') + '</div>' +

      '<div class="panel"><div class="panel-body">' +
      '<div class="next-card">' +
      '<span class="nc-icon">' + P.icon('bolt', 20) + '</span>' +
      '<span class="nc-copy"><span class="t-overline">下一步</span>' +
      '<strong style="display:block;margin-top:2px">' + P.esc(pr.nextAction.title) + '</strong>' +
      '<small>' + P.esc(pr.nextAction.reason) + '</small></span>' +
      '<button class="btn primary" type="button" data-go="#/research/selection">' + P.esc(pr.nextAction.cta) + '</button>' +
      '</div>' +
      '<div class="meter" style="margin-top:var(--s4)">' +
      '<span class="t-caption t-dim" style="width:74px">阶段进度</span>' +
      '<div class="bar prism"><i data-bar="' + pr.progress.percent + '" style="width:0%"></i></div>' +
      '<span class="t-caption t-num" data-bar-label>' + pr.progress.completed + ' / ' + pr.progress.total + '</span>' +
      '</div></div></div>' +

      '<div class="panel-grid">' +
      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Review Queue</span>' +
      '<div class="t-headline" style="margin-top:2px">待审批事项</div></div>' +
      '<button class="btn sm quiet" type="button" data-go-tab="approvals">全部 ' + pr.approvals.length + '</button></div>' +
      '<div class="panel-body tight" data-swipe-list>' + pr.approvals.map(approvalRow).join('') +
      '<p class="t-caption t-dim" style="padding:8px 10px 2px">提示：把任意一行向左或向右滑动，看释放速度如何决定落点。</p></div></section>' +

      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Risk Register</span>' +
      '<div class="t-headline" style="margin-top:2px">项目风险</div></div>' +
      '<button class="btn sm quiet" type="button" data-go-tab="evidence">检查证据</button></div>' +
      '<div class="panel-body tight">' + pr.risks.map(function (r) {
        return '<div class="row-item"><span class="status-dot ' + (r.severity === 'high' ? 'failed' : r.severity === 'medium' ? 'awaiting_approval' : 'completed') + '"></span>' +
          '<div class="grow"><div class="row-title">' + P.esc(r.title) + '</div><div class="row-sub">' + P.esc(r.detail) + '</div></div></div>';
      }).join('') + '</div></section>' +

      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Recent Runs</span>' +
      '<div class="t-headline" style="margin-top:2px">最近 Harness 运行</div></div>' +
      '<button class="btn sm quiet" type="button" data-go-tab="runs">控制台</button></div>' +
      '<div class="panel-body"><div class="run-list">' + pr.runs.slice(0, 4).map(runRow).join('') + '</div></div></section>' +

      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Signals</span>' +
      '<div class="t-headline" style="margin-top:2px">当前配置</div></div>' +
      '<button class="btn sm quiet" type="button" data-go-tab="settings">约束</button></div>' +
      '<div class="panel-body"><dl class="dl">' +
      '<div><dt>模型</dt><dd>' + pr.model + '</dd></div>' +
      '<div><dt>Harness 权限</dt><dd>project.read · patch.propose</dd></div>' +
      '<div><dt>证据主张</dt><dd>' + pr.quality.supported + ' / ' + pr.quality.total + ' 已支持</dd></div>' +
      '<div><dt>写作检查</dt><dd><span class="badge warn"><i class="dot"></i>需要处理</span></dd></div>' +
      '</dl></div></section>' +
      '</div>';
  }

  /* ---------------------------------------------------------------- 资料 -- */
  function library() {
    return '<section class="panel"><div class="panel-head">' +
      '<div><span class="t-overline">Paper Library</span><div class="t-headline" style="margin-top:2px">论文资料库</div></div>' +
      '<span class="t-caption t-muted">48 篇已导入 · 12 篇未读</span></div>' +
      '<div class="panel-body tight">' + d.papers.map(function (p) {
        var tone = p.eligibility === 'pass' ? 'ok' : p.eligibility === 'review' ? 'warn' : 'danger';
        var toneText = p.eligibility === 'pass' ? '符合筛选' : p.eligibility === 'review' ? '需要复核' : '建议排除';
        return '<div class="row-item">' +
          '<button class="chip' + (p.selected ? ' on' : '') + '" type="button" data-pick="' + p.id + '">' +
          P.icon(p.selected ? 'check' : 'plus', 13) + '</button>' +
          '<div class="grow"><div class="row-title">' + P.esc(p.title) + '</div>' +
          '<div class="row-sub">' + P.esc(p.authors.join(', ')) + ' · ' + P.esc(p.venue) + ' ' + p.year + ' · ' + P.esc(p.ccf) + '</div></div>' +
          '<span class="badge ' + tone + '">' + toneText + '</span>' +
          '<span class="t-caption t-num t-dim" style="width:26px;text-align:right">' + p.quality + '</span>' +
          '</div>';
      }).join('') + '</div></section>';
  }

  /* ---------------------------------------------------------------- 任务 -- */
  function tasks() {
    return '<section class="panel"><div class="panel-head">' +
      '<div><span class="t-overline">Task Center</span><div class="t-headline" style="margin-top:2px">任务中心</div></div>' +
      '<span class="t-caption t-muted">失败可重试，启动前始终需要人工批准</span></div>' +
      '<div class="panel-body">' + pr.runs.map(function (r, i) {
        var pct = r.status === 'completed' ? 100 : r.status === 'running' ? 62 : r.status === 'awaiting_approval' ? 84 : 38;
        return '<div class="row-item" style="display:block">' +
          '<div class="row gap3"><span class="status-dot ' + r.status + '"></span>' +
          '<div class="grow"><div class="row-title">' + P.esc(r.stage) + ' · ' + P.esc(r.task) + '</div>' +
          '<div class="row-sub">' + P.fmtTime(r.at) + ' · <code class="t-mono">' + r.id + '</code></div></div>' +
          badgeFor(r.status) +
          (r.status === 'failed' ? '<button class="btn sm ghost" type="button" data-retry="' + i + '">重试</button>' : '') +
          '</div>' +
          '<div class="bar" style="margin-top:9px"><i data-bar="' + pct + '" style="width:0%"></i></div>' +
          '</div>';
      }).join('') + '</div></section>';
  }

  /* ---------------------------------------------------------------- 审批 -- */
  function approvals() {
    return '<section class="panel"><div class="panel-head">' +
      '<div><span class="t-overline">Human Inbox</span><div class="t-headline" style="margin-top:2px">待审批收件箱</div></div>' +
      '<span class="badge warn"><i class="dot"></i>' + pr.approvals.length + ' 项等待</span></div>' +
      '<div class="panel-body" data-swipe-list>' + pr.approvals.map(approvalRow).join('') +
      '<div class="card flat" style="margin-top:var(--s4)">' +
      '<div class="row between gap3"><div><strong class="t-callout">批量确认</strong>' +
      '<p class="t-caption t-muted" style="margin-top:2px">一次确认多条会削弱「逐条看过」的保证，所以这里仍然要求按住。</p></div>' +
      '<button class="hold-btn" type="button" data-hold-open>' +
      '<span class="hold-fill"></span><span>' + P.icon('shield', 15) + '</span><span>按住确认</span></button>' +
      '</div></div></div></section>';
  }

  /* ---------------------------------------------------------------- 运行 -- */
  function runs() {
    return '<section class="panel"><div class="panel-head">' +
      '<div><span class="t-overline">Harness Console</span><div class="t-headline" style="margin-top:2px">运行控制台</div></div>' +
      '<span class="t-caption t-muted">上下文、工具事件、验证结果与待确认 Patch 都可回查</span></div>' +
      '<div class="panel-body">' + pr.runs.map(function (r) {
        return '<div class="row-item" style="display:block">' +
          '<div class="row gap3"><span class="status-dot ' + r.status + '"></span>' +
          '<div class="grow"><div class="row-title">' + P.esc(r.stage) + ' / ' + P.esc(r.task) + '</div>' +
          '<div class="row-sub">adapter: deepseek · 更新于 ' + P.fmtTime(r.at) + '</div></div>' +
          badgeFor(r.status) +
          '<button class="btn sm quiet" type="button" data-run-open="' + r.id + '">详情</button></div>' +
          '</div>';
      }).join('') + '</div></section>';
  }

  /* ---------------------------------------------------------------- 证据 -- */
  function evidence() {
    var counts = { supported: 0, 'needs-verification': 0, unsupported: 0 };
    d.evidence.forEach(function (c) { counts[c.status]++; });
    return '<div class="tile-grid">' +
      '<div class="tile"><div class="tile-label">论文主张</div><div class="tile-value">' + d.evidence.length + '</div><div class="tile-note">写作交接后生成</div></div>' +
      '<div class="tile"><div class="tile-label">已支持</div><div class="tile-value">' + counts.supported + '</div><div class="tile-note">引用可回查</div></div>' +
      '<div class="tile"><div class="tile-label">待核验</div><div class="tile-value">' + counts['needs-verification'] + '</div><div class="tile-note">证据不足</div></div>' +
      '<div class="tile is-risk"><div class="tile-label">无支持</div><div class="tile-value">' + counts.unsupported + '</div><div class="tile-note">不应出现在正文</div></div>' +
      '</div>' +
      '<section class="panel"><div class="panel-head">' +
      '<div><span class="t-overline">Evidence Ledger</span><div class="t-headline" style="margin-top:2px">主张-证据矩阵</div></div>' +
      '<span class="badge warn"><i class="dot"></i>需要核验</span></div>' +
      '<div class="panel-body tight">' + d.evidence.map(function (c) {
        var tone = c.status === 'supported' ? 'ok' : c.status === 'needs-verification' ? 'warn' : 'danger';
        var text = c.status === 'supported' ? '已支持' : c.status === 'needs-verification' ? '待核验' : '无支持';
        return '<div class="row-item">' +
          '<div class="grow"><div class="row-title">' + P.esc(c.text) + '</div>' +
          '<div class="row-sub">Evidence：' + (c.refs.length ? c.refs.join('、') : '尚未关联') + '</div></div>' +
          '<span class="badge ' + tone + '">' + text + '</span></div>';
      }).join('') + '</div></section>';
  }

  /* ---------------------------------------------------------------- 设置 -- */
  function sw(pref, label, desc, on) {
    return '<label class="checkline" style="padding:11px 0">' +
      '<span class="grow"><span class="checkline-copy"><strong>' + label + '</strong><small>' + desc + '</small></span></span>' +
      '<button class="switch" type="button" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-pref="' + pref + '"></button>' +
      '</label>';
  }
  function settings() {
    var e = P.prefs.effective();
    return '<div class="panel-grid">' +
      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Constraints</span>' +
      '<div class="t-headline" style="margin-top:2px">项目约束</div></div>' +
      '<span class="badge accent">后端投影</span></div>' +
      '<div class="panel-body"><dl class="dl">' + pr.constraints.map(function (c) {
        return '<div><dt>' + P.esc(c[0]) + '</dt><dd>' + P.esc(c[1]) + '</dd></div>';
      }).join('') + '</dl>' +
      '<p class="t-caption t-dim" style="margin-top:var(--s3)">这些限制由后端解释并在 Harness 运行前强制执行，页面只展示当前有效策略。</p>' +
      '</div></section>' +

      '<section class="panel"><div class="panel-head"><div><span class="t-overline">Appearance &amp; Motion</span>' +
      '<div class="t-headline" style="margin-top:2px">外观与动效</div></div>' +
      '<button class="btn sm quiet" type="button" data-pref-reset>跟随系统</button></div>' +
      '<div class="panel-body">' +
      sw('theme', '深色外观', '当前：' + (e.theme === 'dark' ? '深色' : '浅色'), e.theme === 'dark') +
      '<div class="divider"></div>' +
      sw('motion', '降低动效', '位移动画替换为交叉淡入，弹簧不再过冲', e.motion === 'reduced') +
      sw('transparency', '降低透明度', '玻璃材料变为实心，去掉模糊', e.transparency === 'reduced') +
      sw('contrast', '提高对比度', '实心底色 + 明确边框', e.contrast === 'more') +
      '<p class="t-caption t-dim" style="margin-top:var(--s3)">这三个开关映射系统偏好（<code>prefers-reduced-motion</code> 等），默认跟随系统；手动切换只覆盖本次会话。</p>' +
      '</div></section></div>';
  }

  var BODIES = { overview: overview, library: library, tasks: tasks, approvals: approvals, runs: runs, evidence: evidence, settings: settings };

  P.views.cockpit = {
    render: function (ctx) {
      return '<div class="page-scroll scroll" data-page>' +
        '<div class="page-wrap">' +
        '<div class="page-head">' +
        '<div class="ph-copy"><span class="t-overline">Project Control Room</span>' +
        '<h2 class="t-title1">' + P.esc(pr.question) + '</h2>' +
        '<p class="t-callout">' + P.esc(pr.scope) + '</p></div>' +
        '<div class="row gap2">' +
        '<button class="btn ghost" type="button" data-go="#/design">' + P.icon('sliders', 15) + '设计说明</button>' +
        '<button class="btn primary" type="button" data-go="#/research/selection">进入筛选阶段 ' + P.icon('arrow-right', 15) + '</button>' +
        '</div></div>' +
        '<div data-tabs></div>' +
        '<div data-body>' + overview() + '</div>' +
        '</div></div>';
    },

    mount: function (root, ctx) {
      var body = root.querySelector('[data-body]');
      var current = ctx.tab && BODIES[ctx.tab] ? ctx.tab : 'overview';
      var seg = P.ui.segmented(root.querySelector('[data-tabs]'), {
        items: TABS,
        value: current,
        onChange: function (v) { show(v, true); }
      });

      function show(tab, animate) {
        if (!BODIES[tab]) return;
        current = tab;
        body.innerHTML = BODIES[tab]();
        if (animate) {
          body.classList.remove('view-enter');
          void body.offsetWidth;
          body.classList.add('view-enter');
        }
        mountBody(body, tab);
      }

      /* 「概览」页里的按钮切到别的页签 */
      P.on(root, '[data-go-tab]', 'click', function (e, el) { seg.select(el.dataset.goTab); });

      mountBody(body, current);
      requestAnimationFrame(function () { seg.place(); });
    }
  };

  /* --------------------------------------------------------- 内容装配 -- */
  function mountBody(body, tab) {
    /* 数字滚动 + 进度条：都从当前值出发，不是从 0 重新播动画 */
    P.$$('[data-count-to]', body).forEach(function (el) {
      var to = parseFloat(el.dataset.countTo);
      if (isNaN(to)) return;
      P.ui.counter(el, to, { suffix: el.dataset.countSuffix || '' });
    });
    P.$$('[data-bar]', body).forEach(function (el) {
      var to = parseFloat(el.dataset.bar) || 0;
      var s = new P.Spring(0, {
        damping: 1, response: 0.6, restDelta: 0.2, restSpeed: 0.4,
        onUpdate: function (v) { el.style.width = P.round(v, 2) + '%'; }
      });
      s.to(to);
    });

    /* 滑动决定：释放速度 → 投影 → 落点 */
    P.$$('.swipe-face', body).forEach(function (face) {
      var a = pr.approvals.filter(function (x) { return x.id === face.parentElement.dataset.swipe; })[0];
      P.ui.swipeRow(face, {
        onApprove: function () { settle(face, true, a); },
        onReject: function () { settle(face, false, a); }
      });
    });

    /* 按住确认 */
    P.$$('[data-hold-open]', body).forEach(function (btn) {
      P.ui.holdButton(btn, {
        duration: 900,
        onComplete: function () { P.ui.approvalSheet(); },
        onCancel: function () {}
      });
    });

    /* 资料页：勾选候选 */
    P.$$('[data-pick]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = d.papers.filter(function (x) { return x.id === btn.dataset.pick; })[0];
        p.selected = !p.selected;
        btn.classList.toggle('on', p.selected);
        btn.innerHTML = P.icon(p.selected ? 'check' : 'plus', 13);
      });
    });

    P.$$('[data-retry]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.row-item');
        var bar = row.querySelector('[data-bar]');
        if (bar) {
          var s = new P.Spring(parseFloat(bar.style.width) || 38, {
            damping: 1, response: 0.6, restDelta: 0.2, restSpeed: 0.4,
            onUpdate: function (v) { bar.style.width = P.round(v, 2) + '%'; }
          });
          s.to(100);
        }
        btn.disabled = true;
        btn.textContent = '已重试';
        P.ui.toast('已重新排队：失败 Run 可重试', { icon: 'undo' });
      });
    });

    P.$$('[data-run-open]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        P.ui.sheet({
          side: 'right',
          title: '运行详情',
          desc: btn.dataset.runOpen,
          body: '<div class="stack">' +
            '<div class="card flat"><span class="t-overline">上下文</span>' +
            '<p class="t-callout" style="margin-top:6px">contextHash <code class="t-mono">7f31c0a9e4b2</code> · 模型 deepseek-chat · 12,000 tokens 预算</p></div>' +
            '<div class="card flat"><span class="t-overline">事件</span>' +
            '<pre class="t-mono" style="margin-top:6px;white-space:pre-wrap;line-height:1.6">[10:02:11] tool.call project.read\n[10:02:14] tool.call paper.search\n[10:02:39] validate ok=true warnings=1\n[10:02:41] patch.propose files=1</pre></div>' +
            '<div class="card flat"><span class="t-overline">待确认 Patch</span>' +
            '<p class="t-callout" style="margin-top:6px">configs/filter.yaml（1 个文件）</p>' +
            '<button class="btn ghost" type="button" data-go="#/editor" style="margin-top:8px">打开编辑器 Diff</button></div>' +
            '</div>'
        });
      });
    });

    /* 外观开关 */
    P.$$('[data-pref]', body).forEach(function (el) {
      el.addEventListener('click', function () {
        var key = el.dataset.pref;
        var now = el.getAttribute('aria-checked') === 'true';
        if (key === 'theme') P.prefs.set('theme', now ? 'light' : 'dark');
        else if (key === 'contrast') P.prefs.set('contrast', now ? 'auto' : 'more');
        else P.prefs.set(key, now ? 'auto' : 'reduced');
        el.setAttribute('aria-checked', String(!now));
      });
    });
    var reset = body.querySelector('[data-pref-reset]');
    if (reset) reset.addEventListener('click', function () {
      ['theme', 'motion', 'transparency', 'contrast'].forEach(function (k) { P.prefs.set(k, 'auto'); });
      P.ui.toast('已恢复为跟随系统偏好', { icon: 'undo' });
      body.innerHTML = settings();
      mountBody(body, 'settings');
    });
  }

  /* 决策落定：原路退出 + 收拢高度，不留残影 */
  function settle(face, approved, approval) {
    var wrap = face.parentElement;
    P.ui.toast((approved ? '已批准：' : '已驳回：') + (approval ? approval.label : ''), {
      icon: approved ? 'check' : 'x'
    });
    var h = wrap.offsetHeight;
    var s = new P.Spring(h, {
      damping: 1, response: 0.34, restDelta: 0.5, restSpeed: 2,
      onUpdate: function (v) {
        wrap.style.height = P.round(v, 2) + 'px';
        wrap.style.opacity = String(P.clamp(v / h, 0, 1));
      },
      onComplete: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    });
    wrap.style.overflow = 'hidden';
    s.to(0);
  }
})();
