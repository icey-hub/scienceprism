/* ==========================================================================
   views/design.js — 设计说明 + 手感实验室
   把「为什么这样动」摊开给评审看：
     材料层级、排版标尺、弹簧参数、动量投影计算器、偏好开关、八条原则。
   投影计算器是最值得亲手拖的一个：它直接展示 Apple 的落点预测公式。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;

  var TYPE_ROWS = [
    ['Display', '快速开始', '34 / 1.06 / -0.024em', 't-display'],
    ['Title 1', '项目控制室', '26 / 1.14 / -0.021em', 't-title1'],
    ['Title 2', '待审批事项', '20 / 1.22 / -0.015em', 't-title2'],
    ['Title 3', 'Snapshot-Verified Retrieval', '17 / 1.28 / -0.011em', 't-title3'],
    ['Headline', '研究问题由你定义', '15 / 1.34 / -0.006em', 't-headline'],
    ['Body', 'AI 负责补充与执行建议，每一阶段由你输入并确认。', '14.5 / 1.50 / -0.002em', 't-body'],
    ['Caption', '更新于 21 分钟前 · run-9f21c4a8', '11.5 / 1.36 / +0.006em', 't-caption'],
    ['Overline', 'Run Context', '10.5 / 1.20 / +0.09em', 't-overline']
  ];

  var SPRING_ROWS = [
    ['移动 / 重排（如画中画）', '1.0', '0.4', '这里的分栏、抽屉回弹'],
    ['旋转', '0.8', '0.4', '（本 Demo 未使用）'],
    ['抽屉 / 底部面板', '0.8', '0.3', '底部抽屉、滑动的落点'],
    ['本 Demo 的默认值', '1.0', '0.28 – 0.4', '几乎所有非手势过渡']
  ];

  var PRINCIPLES = [
    ['目的', '只做四件事：开始、看项目、跑研究、写论文。其它入口一律不上首页。'],
    ['自主', '每一步都能撤销或重新发起；只有不可逆动作（跳过复现）才要一次明确确认。'],
    ['责任', 'Patch 与受控 Run 都要人工按住确认；权限只收窄，不放大。'],
    ['熟悉', '沿用项目原本的信息架构（左栏 + 六视图 + 八阶段），只改材料与手感。'],
    ['灵活', '分栏宽度、侧栏折叠、深浅色、动效/透明度/对比度全部可调。'],
    ['简洁', '不用纯色分割线切碎版面；用材料、层级和留白区分区域。'],
    ['工艺', '字距随字号变化、阴影分层、按压反馈发生在按下那一刻。'],
    ['愉悦', '反馈准时且克制：数字滚动、材料到位、确认时的轻微触感。']
  ];

  var TRY_LIST = [
    ['拖分栏', '两根分栏条 1:1 跟手，越界有橡皮筋，双击复位，方向键也能调。'],
    ['甩一下审批行', '向左或向右快速甩动，看释放速度如何决定是回弹还是落定。'],
    ['按住确认', '研究阶段的「人工确认」必须按住 0.9 秒；提前松手会回弹。'],
    ['拖抽屉', '底部抽屉可以中途抓住并反向拖回，动画不会先播完。'],
    ['拖分段控件', '项目页顶部页签按住横向拖动，指示块跟着手指走。'],
    ['按 ⌘K', '命令面板从触发处缩放出现，Esc 原路退出。']
  ];

  P.views.design = {
    render: function () {
      var e = P.prefs.effective();
      return '<div class="page-scroll scroll">' +
        '<div class="page-wrap">' +

        '<div class="page-head"><div class="ph-copy">' +
        '<span class="t-overline">Design Notes</span>' +
        '<h2 class="t-title1">这套界面为什么这样动</h2>' +
        '<p class="t-callout">依据来自 Apple 的《Designing Fluid Interfaces》与八条设计原则。' +
        '下面每一项都可以当场验证：材料、排版、弹簧参数、动量投影、偏好开关。</p>' +
        '</div><div class="row gap2">' +
        '<button class="btn ghost" type="button" data-go="#/project/p-01">回控制室</button>' +
        '<button class="btn primary" type="button" data-go="#/editor">看编辑器</button>' +
        '</div></div>' +

        /* --- 材料 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Materials</span><div class="t-headline" style="margin-top:2px">材料与层级</div></div>' +
        '<span class="t-caption t-muted">越大的面越厚：更强模糊 + 更深阴影</span></div>' +
        '<div class="panel-body"><div class="mat-grid">' +
        ['rail|左栏（最厚，结构性）', 'chrome|工具条（中等）', 'panel|面板（轻）', 'sheet|抽屉（最厚，浮在最上）', 'solid|实心底（可读性优先）'].map(function (m) {
          var parts = m.split('|');
          return '<div class="mat-demo"><span class="md-bg"></span>' +
            '<span class="md-glass ' + parts[0] + '"></span>' +
            '<span class="md-label">' + parts[1] + '</span></div>';
        }).join('') +
        '</div>' +
        '<p class="t-caption t-dim" style="margin-top:var(--s3)">' +
        '规则：半透明材料上不放另一层半透明材料（可读性会塌）；文字用更高对比与略高字重，而不是灰色。' +
        '本页的背景故意做成花哨的棱镜渐变，用来暴露「模糊是否真的在起作用」。</p>' +
        '</div></section>' +

        /* --- 排版 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Typography</span><div class="t-headline" style="margin-top:2px">排版标尺</div></div>' +
        '<span class="t-caption t-muted">字号 / 行高 / 字距 成组定义</span></div>' +
        '<div class="panel-body">' + TYPE_ROWS.map(function (r) {
          return '<div class="type-row"><span class="t-overline">' + r[0] + '</span>' +
            '<span class="' + r[3] + '">' + P.esc(r[1]) + '</span>' +
            '<span class="tr-spec">' + r[2] + '</span></div>';
        }).join('') +
        '<p class="t-caption t-dim" style="margin-top:var(--s3)">' +
        '字距绝不一个值用到底：大字号收紧（-0.024em），小字号微放（+0.006em）；' +
        '行高随字号反向变化。字体用系统栈，因为光学尺寸与字距表已经在系统里调好了。</p>' +
        '</div></section>' +

        /* --- 弹簧 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Springs</span><div class="t-headline" style="margin-top:2px">弹簧参数（不是时长）</div></div>' +
        '<button class="btn" type="button" data-spring-move>' + P.icon('play', 14) + '移动一次</button></div>' +
        '<div class="panel-body">' +
        '<table class="spring-table"><thead><tr><th>交互</th><th>damping</th><th>response</th><th>用在哪里</th></tr></thead><tbody>' +
        SPRING_ROWS.map(function (r) {
          return '<tr><td>' + r[0] + '</td><td class="mono">' + r[1] + '</td><td class="mono">' + r[2] + '</td><td class="t-muted">' + r[3] + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="play-stage" data-spring-stage style="margin-top:var(--s4);height:176px">' +
        '<div class="play-lane" style="top:60px"></div><div class="play-lane" style="top:128px"></div>' +
        '<div class="play-token" data-token="damped" style="top:32px;left:14px">1.0</div>' +
        '<div class="play-token" data-token="bouncy" style="top:100px;left:14px">0.8</div>' +
        '</div>' +
        '<p class="t-caption t-dim" style="margin-top:var(--s3)">' +
        '上面 1.0（临界阻尼，不过冲）适合大多数 UI；下面 0.8 只在手势本身带了动量时才用（甩、抛、拖拽释放）。' +
        '弹簧没有固定时长：松手时的速度会被带进下一段动画，所以可以随时打断、反向。</p>' +
        '</div></section>' +

        /* --- 动量投影 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Momentum Projection</span><div class="t-headline" style="margin-top:2px">动量投影：落点由速度决定</div></div>' +
        '<span class="t-caption t-muted">拖我 → 松手</span></div>' +
        '<div class="panel-body">' +
        '<div class="play-stage" data-proj-stage>' +
        '<div class="play-token" data-proj-token style="top:34px;left:14px;width:64px;height:64px;cursor:grab">拖我</div>' +
        '</div>' +
        '<div class="readout" style="margin-top:var(--s3)">' +
        '<span>释放速度 <b data-v>0</b> px/s</span>' +
        '<span>投影落点 <b data-projected>—</b></span>' +
        '<span>吸附目标 <b data-target>第 1 格</b></span>' +
        '<span class="t-dim">project(v) = (v / 1000) · d / (1 − d)，d = 0.998</span>' +
        '</div>' +
        '<p class="t-caption t-dim" style="margin-top:var(--s3)">' +
        '关键在「不要从释放点就近吸附」：先用速度投影出一个静止点，再吸附到离投影点最近的格子，' +
        '最后把释放速度交给弹簧。轻推就回原位，快甩就会跨好几格。</p>' +
        '</div></section>' +

        /* --- 偏好 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Accessibility</span><div class="t-headline" style="margin-top:2px">偏好与可达性</div></div>' +
        '<button class="btn sm quiet" type="button" data-pref-reset>跟随系统</button></div>' +
        '<div class="panel-body">' +
        row('theme', '深色外观', '材料与文字一起换，不靠滤镜反转', e.theme === 'dark') +
        '<div class="divider"></div>' +
        row('motion', '降低动效', '位移/弹性替换为交叉淡入；弹簧不再过冲', e.motion === 'reduced') +
        row('transparency', '降低透明度', '玻璃材料变实心并去掉模糊', e.transparency === 'reduced') +
        row('contrast', '提高对比度', '实心底 + 明确边框 + 更深文字', e.contrast === 'more') +
        '<p class="t-caption t-dim" style="margin-top:var(--s3)">' +
        '这三项映射系统偏好（<code>prefers-reduced-motion</code> / <code>prefers-reduced-transparency</code> / <code>prefers-contrast</code>），' +
        '默认跟随系统，手动切换只覆盖本次会话。降低动效不等于没有反馈：颜色、透明度与状态文字仍然保留。</p>' +
        '</div></section>' +

        /* --- 原则 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Foundations</span><div class="t-headline" style="margin-top:2px">八条原则落到了哪里</div></div></div>' +
        '<div class="panel-body">' + PRINCIPLES.map(function (p, i) {
          return '<div class="principle"><span class="pr-n">' + (i + 1) + '</span>' +
            '<div class="pr-copy"><strong>' + p[0] + '</strong><p>' + p[1] + '</p></div></div>';
        }).join('') + '</div></section>' +

        /* --- 试一下 --- */
        '<section class="panel"><div class="panel-head">' +
        '<div><span class="t-overline">Try It</span><div class="t-headline" style="margin-top:2px">六个可以当场验证的手感</div></div>' +
        '<span class="kbd">⌘K</span></div>' +
        '<div class="panel-body tight">' + TRY_LIST.map(function (t) {
          return '<div class="row-item">' + P.icon('target', 16) +
            '<div class="grow"><div class="row-title">' + t[0] + '</div><div class="row-sub">' + t[1] + '</div></div></div>';
        }).join('') + '</div></section>' +

        '<p class="t-caption t-dim">这是一份静态 Demo：没有后端、没有真实编译与模型调用，数据全部是本地夹具。</p>' +
        '</div></div>';
    },

    mount: function (root) {
      /* --- 弹簧对照 --- */
      var stage = root.querySelector('[data-spring-stage]');
      var damped = root.querySelector('[data-token="damped"]');
      var bouncy = root.querySelector('[data-token="bouncy"]');
      var right = false;
      var mA = P.motion({ x: 0 }), mB = P.motion({ x: 0 });
      mA.on(function (v) { damped.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)'; });
      mB.on(function (v) { bouncy.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)'; });
      root.querySelector('[data-spring-move]').addEventListener('click', function () {
        right = !right;
        var travel = Math.max(120, stage.offsetWidth - 100);
        var target = right ? travel : 0;
        mA.to({ x: target }, { damping: 1, response: 0.4 });
        mB.to({ x: target }, { damping: 0.8, response: 0.4, velocity: { x: right ? 900 : -900 } });
      });

      /* --- 动量投影 --- */
      var projStage = root.querySelector('[data-proj-stage]');
      var token = root.querySelector('[data-proj-token]');
      var outV = root.querySelector('[data-v]');
      var outP = root.querySelector('[data-projected]');
      var outT = root.querySelector('[data-target]');
      var slots = [];
      function layout() {
        P.$$('.play-slot', projStage).forEach(function (s) { s.remove(); });
        slots = [];
        var pad = 14, size = 64;
        var usable = projStage.offsetWidth - pad * 2 - size;
        for (var i = 0; i < 5; i++) {
          var x = pad + (usable * i) / 4;
          slots.push(x);
          var el = P.h('div', { class: 'play-slot' });
          el.style.left = x + 'px';
          projStage.appendChild(el);
        }
      }
      var proj = P.motion({ x: 0 });
      proj.on(function (v) { token.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)'; });
      proj.set({ x: 0 });
      var base = 0, lastDx = 0;
      P.drag(token, {
        axis: 'x',
        threshold: 2,
        cursor: 'grabbing',
        onStart: function () { proj.stop(); base = proj.values.x; lastDx = 0; },
        onMove: function (s) {
          var raw = base + s.dx;
          lastDx = s.dx;
          var max = slots.length ? slots[slots.length - 1] : 0;
          if (raw < 0) raw = -P.rubberband(-raw, 200);
          if (raw > max) raw = max + P.rubberband(raw - max, 200);
          proj.set({ x: raw });
          outV.textContent = Math.round(s.vx);
          outP.textContent = Math.round(proj.values.x + P.project(s.vx)) + 'px';
        },
        onEnd: function (s) {
          var projected = proj.values.x + P.project(s.vx, 0.998);
          var best = slots[0], bestI = 0;
          slots.forEach(function (x, i) { if (Math.abs(x - projected) < Math.abs(best - projected)) { best = x; bestI = i; } });
          outV.textContent = Math.round(s.vx);
          outP.textContent = Math.round(projected) + 'px';
          outT.textContent = '第 ' + (bestI + 1) + ' 格';
          /* 落点由投影决定；释放速度原样交给弹簧，接缝才看不见 */
          proj.to({ x: best }, { damping: 0.8, response: 0.34, velocity: { x: s.vx } });
          P.tick('commit');
        }
      });
      layout();
      window.addEventListener('resize', layout);

      /* --- 偏好开关 --- */
      P.$$('[data-pref]', root).forEach(function (el) {
        el.addEventListener('click', function () {
          var key = el.dataset.pref;
          var now = el.getAttribute('aria-checked') === 'true';
          if (key === 'theme') P.prefs.set('theme', now ? 'light' : 'dark');
          else if (key === 'contrast') P.prefs.set('contrast', now ? 'auto' : 'more');
          else P.prefs.set(key, now ? 'auto' : 'reduced');
          el.setAttribute('aria-checked', String(!now));
        });
      });
      var reset = root.querySelector('[data-pref-reset]');
      if (reset) reset.addEventListener('click', function () {
        ['theme', 'motion', 'transparency', 'contrast'].forEach(function (k) { P.prefs.set(k, 'auto'); });
        P.ui.toast('已恢复为跟随系统偏好', { icon: 'undo' });
        P.app.rerender();
      });
    }
  };

  function row(pref, label, desc, on) {
    return '<label class="checkline" style="padding:11px 0">' +
      '<span class="grow"><span class="checkline-copy"><strong>' + label + '</strong><small>' + desc + '</small></span></span>' +
      '<button class="switch" type="button" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-pref="' + pref + '"></button>' +
      '</label>';
  }
})();
