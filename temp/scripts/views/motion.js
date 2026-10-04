/* ==========================================================================
   views/motion.js — 特效巡演（#/motion）
   十个招牌动效，每个都能自动播放、单独重播，也能慢放逐帧看。
   这里的目的很直接：不用猜「哪里能动」，进来就能看见。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var timers = [];

  function later(fn, ms) { var id = window.setTimeout(fn, ms); timers.push(id); return id; }
  function clearTimers() { timers.forEach(window.clearTimeout); timers = []; }

  var CARDS = [
    {
      key: 'hero', n: '01', en: 'Matched geometry', title: '英雄过渡',
      desc: '点一张卡片，它「长成」目标位置：几何、圆角、内容交叉淡入由同一个弹簧驱动，所以中途抓住也不会跳。',
      stage: 'tall'
    },
    {
      key: 'retarget', n: '02', en: 'Interruptible + velocity handoff', title: '中途改主意',
      desc: '元素飞向右边时把它改到左边：它从「当前屏幕上的值」出发并带走原速度，不会先飞完再回头。'
    },
    {
      key: 'sheet', n: '03', en: 'Interruptible sheet', title: '可打断抽屉',
      desc: '抽屉升到一半被反向抓住，直接沿原路退回；拖动时还会沿运动方向轻微拉伸。'
    },
    {
      key: 'projection', n: '04', en: 'Momentum projection', title: '动量投影',
      desc: '落点不是「离释放点最近的格子」，而是先按释放速度投影出静止点，再吸附到最近的一格。'
    },
    {
      key: 'scroll', n: '05', en: 'Rubber-banding', title: '橡皮筋滚动',
      desc: '到边界还继续滚：跟手但越来越沉，松手带速度弹回。硬停会读成「卡住」，渐阻才读成「没有更多了」。'
    },
    {
      key: 'squash', n: '06', en: 'Squash & stretch', title: '挤压与拉伸',
      desc: '落地瞬间沿运动方向压扁再弹回，物体才有重量。过冲只在有动量时出现。'
    },
    {
      key: 'stretch', n: '07', en: 'Speed reads as stretch', title: '速度即拉伸',
      desc: '高速时沿运动方向拉长、垂直方向压扁。比一道硬边更快，也更好看。'
    },
    {
      key: 'glass', n: '08', en: 'Liquid glass', title: '液态玻璃',
      desc: '高光跟着指针走（镜面反射）+ 材料到位时被光扫过 + 指针位置决定 3D 视差。'
    },
    {
      key: 'island', n: '09', en: 'Dynamic Island', title: '动态岛',
      desc: '内容换了，宽度用弹簧长过去，不是跳变；状态色跟着语义一起过渡。'
    },
    {
      key: 'reorder', n: '10', en: 'Spring reorder', title: '弹簧列表重排',
      desc: '拖起一行：它 1:1 跟手，其余行用弹簧让位；松手按投影决定插到哪一格，落定后才提交顺序。'
    }
  ];

  var DEMOS = {};

  /* ------------------------------------------------------------ 01 英雄 -- */
  DEMOS.hero = function (stage) {
    var source = stage.querySelector('[data-hero-source]');
    var target = stage.querySelector('[data-hero-target]');
    return {
      play: function () {
        target.style.opacity = '0';
        source.style.opacity = '0';
        P.hero({
          sourceEl: source, container: stage, targetSelector: '[data-hero-target]',
          response: 0.62,
          onDone: function () { target.style.opacity = '1'; source.style.opacity = '1'; }
        });
      }
    };
  };

  /* --------------------------------------------------------- 02 中途改向 -- */
  DEMOS.retarget = function (stage) {
    var token = stage.querySelector('[data-token]');
    var right = true;
    var spring = new P.Spring(0, {
      damping: 1, response: 0.42, restDelta: 0.5, restSpeed: 2,
      onUpdate: function (v, sp) {
        var st = P.stretch(sp.velocity, { divisor: 7000, max: 0.18 });
        token.style.transform = 'translate3d(' + P.round(v, 2) + 'px,0,0) scaleX(' + P.round(st.sx, 4) + ') scaleY(' + P.round(st.sy, 4) + ')';
      }
    });
    function far() { return stage.offsetWidth - token.offsetWidth - 18; }
    return {
      play: function () {
        spring.jump(0);
        spring.to(far(), 0);
        later(function () { spring.to(0, spring.velocity); }, 300);
        later(function () { spring.to(far() * 0.5, spring.velocity); }, 1000);
      },
      tap: function () { spring.to(right ? 0 : far(), spring.velocity); right = !right; }
    };
  };

  /* --------------------------------------------------------- 03 可打断抽屉 -- */
  DEMOS.sheet = function (stage) {
    var sheet = stage.querySelector('[data-sheet]');
    var h = 132;
    var spring = new P.Spring(h, {
      damping: 0.8, response: 0.34, restDelta: 0.4, restSpeed: 2,
      onUpdate: function (v, sp) {
        var st = P.stretch(sp.velocity, { divisor: 14000, max: 0.08 });
        sheet.style.transform = 'translate3d(0,' + P.round(v, 2) + 'px,0) scale(' +
          P.round(1 - (st.sx - 1) * 0.5, 4) + ',' + P.round(st.sx, 4) + ')';
      }
    });
    P.drag(sheet.querySelector('[data-grab]'), {
      axis: 'y',
      threshold: 2,
      cursor: 'grabbing',
      canStart: function () { spring.stop(); return true; },
      onDown: function () { spring.stop(); },
      onMove: function (s) { spring.jump(P.clamp(s.dy, 0, h * 1.6)); },
      onEnd: function (s) { spring.to(s.vy > 500 ? h : 0, s.vy); }
    });
    return {
      play: function () {
        spring.jump(h);
        spring.to(0);
        /* 升到一半被反向抓住：从当前值继续，不回跳 */
        later(function () { spring.to(h, spring.velocity); }, 300);
        later(function () { spring.to(0, spring.velocity); }, 1000);
      }
    };
  };

  /* ------------------------------------------------------------ 04 投影 -- */
  DEMOS.projection = function (stage) {
    var token = stage.querySelector('[data-token]');
    var slots = [];
    function layout() {
      P.$$('.play-slot', stage).forEach(function (s) { s.remove(); });
      slots = [];
      var pad = 14, size = 56;
      var usable = stage.offsetWidth - pad * 2 - size;
      for (var i = 0; i < 5; i++) {
        var x = pad + (usable * i) / 4;
        slots.push(x);
        var el = P.h('div', { class: 'play-slot' });
        el.style.left = x + 'px';
        stage.appendChild(el);
      }
    }
    layout();
    var proj = P.motion({ x: 0 });
    proj.on(function (v, ctl) {
      token.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)';
    });
    proj.set({ x: 0 });
    var base = 0;
    P.drag(token, {
      axis: 'x', threshold: 2, cursor: 'grabbing',
      onStart: function () { proj.stop(); base = proj.values.x; },
      onMove: function (s) {
        var raw = base + s.dx;
        var max = slots[slots.length - 1] || 0;
        if (raw < 0) raw = -P.rubberband(-raw, 160);
        if (raw > max) raw = max + P.rubberband(raw - max, 160);
        proj.set({ x: raw });
      },
      onEnd: function (s) {
        var projected = proj.values.x + P.project(s.vx, 0.998);
        var best = slots[0];
        slots.forEach(function (x) { if (Math.abs(x - projected) < Math.abs(best - projected)) best = x; });
        proj.to({ x: best }, { damping: 0.8, response: 0.34, velocity: { x: s.vx } });
      }
    });
    return {
      play: function () {
        proj.stop();
        proj.set({ x: 0 });
        later(function () {
          proj.to({ x: slots[slots.length - 1] }, { damping: 0.8, response: 0.4, velocity: { x: 2100 } });
        }, 60);
      },
      layout: layout
    };
  };

  /* -------------------------------------------------------- 05 橡皮筋 -- */
  DEMOS.scroll = function (stage) {
    var box = stage.querySelector('[data-scroll]');
    var el = P.elasticScroll(box, { limit: 130 });
    return {
      play: function () {
        box.scrollTop = box.scrollHeight;
        later(function () {
          var h = el.nudge(90);
          later(function () { h.release(); }, 320);
        }, 80);
      }
    };
  };

  /* ------------------------------------------------------ 06 挤压拉伸 -- */
  DEMOS.squash = function (stage) {
    var drop = stage.querySelector('[data-drop]');
    var token = stage.querySelector('[data-token]');
    var m = P.motion({ y: -120 });
    m.on(function (v) { drop.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0)'; });
    return {
      play: function () {
        token.style.transform = 'scale(1,1)';
        m.set({ y: -120 });
        m.to({ y: 0 }, {
          damping: 0.72, response: 0.5,
          onComplete: function () { P.squash(token, { sx: 1.42, sy: 0.58 }); }
        });
      }
    };
  };

  /* -------------------------------------------------------- 07 速度拉伸 -- */
  DEMOS.stretch = function (stage) {
    var token = stage.querySelector('[data-token]');
    var spring = new P.Spring(0, {
      damping: 0.8, response: 0.44, restDelta: 0.5, restSpeed: 2,
      onUpdate: function (v, sp) {
        var st = P.stretch(sp.velocity, { divisor: 5200, max: 0.26 });
        token.style.transform = 'translate3d(' + P.round(v, 2) + 'px,0,0) scaleX(' + P.round(st.sx, 4) + ') scaleY(' + P.round(st.sy, 4) + ')';
      }
    });
    function far() { return stage.offsetWidth - token.offsetWidth - 18; }
    return {
      play: function () {
        spring.jump(0);
        spring.to(far(), 1500);
        later(function () { spring.to(0, 1500); }, 1300);
      }
    };
  };

  /* -------------------------------------------------------- 08 液态玻璃 -- */
  DEMOS.glass = function (stage) {
    var mat = stage.querySelector('[data-mat]');
    P.glass.tilt(mat, { max: 10, lift: 18 });
    return {
      play: function () {
        P.glass.sheen(mat);
        later(function () { P.glass.sheen(mat); }, 700);
      }
    };
  };

  /* ---------------------------------------------------------- 09 动态岛 -- */
  DEMOS.island = function (stage) {
    var row = stage.querySelector('[data-island-row]');
    var island = P.island(row, { from: 96 });
    island.set('<i class="dot"></i>Harness 已连接', { instant: true });
    return {
      play: function () {
        island.set('<span class="spin">◌</span>编译中 · 38%', { tone: 'busy' });
        later(function () { island.set('<span class="spin">◌</span>编译中 · 92%', { tone: 'busy' }); }, 520);
        later(function () { island.set(P.icon('check', 13) + '编译成功 · 12.4s', { tone: 'ok', sheen: true }); }, 1100);
        later(function () { island.set('<i class="dot"></i>Harness 已连接'); }, 2400);
      }
    };
  };

  /* ------------------------------------------------------ 10 列表重排 -- */
  DEMOS.reorder = function (stage) {
    var list = stage.querySelector('[data-list]');
    P.reorder(list, {
      onCommit: function (to, from) {
        P.ui.toast('顺序已更新：第 ' + (from + 1) + ' 行 → 第 ' + (to + 1) + ' 行', { icon: 'list' });
      }
    });
    function synth(type, el, y, id) {
      var r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'mouse',
        isPrimary: true, buttons: 1, clientX: r.left + r.width / 2, clientY: y
      }));
    }
    return {
      play: function () {
        var first = list.children[0];
        if (!first) return;
        var r = first.getBoundingClientRect();
        var h = list.children[1] ? Math.abs(list.children[1].getBoundingClientRect().top - r.top) : 40;
        synth('pointerdown', first, r.top + 12, 41);
        later(function () { synth('pointermove', first, r.top + 12 + h * 0.6, 41); }, 120);
        later(function () { synth('pointermove', first, r.top + 12 + h * 1.6, 41); }, 260);
        later(function () { synth('pointermove', first, r.top + 12 + h * 2.4, 41); }, 400);
        later(function () { synth('pointerup', first, r.top + 12 + h * 2.4, 41); }, 520);
      }
    };
  };

  /* ------------------------------------------------------------- 渲染 -- */
  function cardHTML(c) {
    return '<section class="mo-card" data-demo="' + c.key + '">' +
      '<div class="mo-head"><div>' +
      '<span class="t-overline">' + c.n + ' · ' + c.en + '</span>' +
      '<h3 class="t-title3">' + c.title + '</h3>' +
      '<p>' + c.desc + '</p></div>' +
      '<button class="btn sm" type="button" data-play="' + c.key + '">' + P.icon('play', 13) + '重播</button>' +
      '</div>' +
      '<div class="mo-stage' + (c.stage === 'tall' ? ' tall' : '') + '" data-stage="' + c.key + '">' + stageHTML(c.key) + '</div>' +
      '</section>';
  }

  function stageHTML(key) {
    if (key === 'hero') {
      return '<div class="mo-mini-target" data-hero-target>' + P.icon('flask', 15) + '<span>可验证的长上下文检索</span></div>' +
        '<button class="mo-mini-card" type="button" data-hero-source>' +
        '<span class="pp-kicker">研究项目 · 62%</span>' +
        '<strong>可验证的长上下文检索</strong></button>' +
        '<span class="mo-hint">卡片 → 标题区，几何连续</span>';
    }
    if (key === 'retarget') {
      return '<div class="mo-throw-line"></div>' +
        '<div class="play-token" data-token style="top:74px;left:18px;width:56px;height:56px">↔</div>' +
        '<span class="mo-hint">点击舞台可随时改目标</span>';
    }
    if (key === 'sheet') {
      return '<div class="mo-sheet" data-sheet>' +
        '<div class="mo-grab" data-grab></div>' +
        '<strong class="t-callout">运行上下文</strong>' +
        '<p>向上滑出、向下拖回；动画进行到一半也能抓住反向。</p>' +
        '<p class="t-caption t-dim" style="margin-top:6px">拖动时沿运动方向轻微拉伸</p></div>' +
        '<span class="mo-hint">抓手可拖</span>';
    }
    if (key === 'projection') {
      return '<div class="play-token" data-token style="top:76px;left:14px;width:56px;height:56px">拖我</div>' +
        '<span class="mo-hint">松手速度决定跨几格</span>';
    }
    if (key === 'scroll') {
      var lines = '';
      for (var i = 0; i < 12; i++) lines += '<div class="mo-line"></div>';
      return '<div class="mo-scroll" data-scroll>' + lines + '</div><span class="mo-hint">滚到底继续滚</span>';
    }
    if (key === 'squash') {
      return '<div class="mo-drop" data-drop><div class="play-token" data-token style="width:64px;height:64px">落</div></div>' +
        '<div class="mo-pad"></div><span class="mo-hint">落地那一帧压扁，再弹回</span>';
    }
    if (key === 'stretch') {
      return '<div class="mo-throw-line"></div>' +
        '<div class="play-token" data-token style="top:76px;left:18px;width:56px;height:56px">→</div>' +
        '<span class="mo-hint">越快越长</span>';
    }
    if (key === 'glass') {
      return '<div class="mo-glass">' +
        '<span class="mo-glass-bg"></span>' +
        '<span class="mo-glass-mat specular tilts" data-mat></span>' +
        '<span>把指针移到这块玻璃上</span></div>';
    }
    if (key === 'island') {
      return '<div class="row" style="position:absolute;inset:0;align-items:center;justify-content:center" data-island-row></div>' +
        '<span class="mo-hint">宽度用弹簧长过去</span>';
    }
    return '<div class="mo-list" data-list>' +
      ['引言与动机', '相关工作', '方法：快照化检索', '实验设置', '结果与消融'].map(function (t, i) {
        return '<div class="row-item"><span class="badge">' + (i + 1) + '</span><span class="grow t-callout">' + t + '</span>' +
          P.icon('more', 15) + '</div>';
      }).join('') + '</div><span class="mo-hint">拖起任意一行</span>';
  }

  P.views.motion = {
    render: function () {
      return '<div class="page-scroll scroll" data-page>' +
        '<div class="page-wrap">' +
        '<div class="page-head"><div class="ph-copy">' +
        '<span class="t-overline">Motion Lab</span>' +
        '<h2 class="t-title1">十个招牌动效，进来就能看见</h2>' +
        '<p class="t-callout">左边这一栏不是「演示动画」，而是这套界面真正在用的原语：' +
        '产品页里的分栏、抽屉、审批行、阶段切换，用的就是下面这几个弹簧。</p>' +
        '</div></div>' +

        '<div class="mo-toolbar">' +
        '<button class="btn primary" type="button" data-all>' + P.icon('play', 14) + '全部重播</button>' +
        '<button class="btn ghost" type="button" data-loop-toggle aria-pressed="false">' + P.icon('undo', 14) + '循环播放</button>' +
        '<button class="btn ghost" type="button" data-slow aria-pressed="false">' + P.icon('waveform', 14) + '慢放 0.25×</button>' +
        '<span class="chrome-spacer"></span>' +
        '<span class="t-caption t-dim">当前动效偏好：<b data-pref-state></b></span>' +
        '</div>' +

        '<div class="mo-grid">' + CARDS.map(cardHTML).join('') + '</div>' +

        '<p class="t-caption t-dim">慢放用的是全局时间缩放（把每帧 dt 乘 0.25），' +
        '所以弹簧的参数不变、手感不变，只是走得慢——Apple 建议这样逐帧回看动效。</p>' +
        '</div></div>';
    },

    mount: function (root) {
      clearTimers();
      P.setTimeScale(1);
      var demos = {};
      var loop = false;
      var loopTimer = 0;

      P.$$('.mo-card', root).forEach(function (card) {
        var key = card.dataset.demo;
        var stage = card.querySelector('[data-stage]');
        if (!DEMOS[key] || !stage) return;
        demos[key] = DEMOS[key](stage);
        card.querySelector('[data-play]').addEventListener('click', function () { demos[key].play(); });
      });

      /* 点击舞台：能改目标的那个 demo 真的改目标 */
      var retarget = root.querySelector('[data-stage="retarget"]');
      if (retarget) retarget.addEventListener('click', function () { if (demos.retarget.tap) demos.retarget.tap(); });

      function playAll() {
        var i = 0;
        Object.keys(demos).forEach(function (key) {
          later(function () { demos[key].play(); }, i * 160);
          i++;
        });
        if (loop) {
          window.clearTimeout(loopTimer);
          loopTimer = window.setTimeout(playAll, 6200);
          timers.push(loopTimer);
        }
      }

      root.querySelector('[data-all]').addEventListener('click', playAll);

      var loopBtn = root.querySelector('[data-loop-toggle]');
      loopBtn.addEventListener('click', function () {
        loop = !loop;
        loopBtn.setAttribute('aria-pressed', String(loop));
        loopBtn.classList.toggle('is-on', loop);
        if (loop) playAll(); else window.clearTimeout(loopTimer);
      });

      var slowBtn = root.querySelector('[data-slow]');
      slowBtn.addEventListener('click', function () {
        var slow = slowBtn.getAttribute('aria-pressed') !== 'true';
        slowBtn.setAttribute('aria-pressed', String(slow));
        slowBtn.classList.toggle('is-on', slow);
        P.setTimeScale(slow ? 0.25 : 1);
      });

      var state = root.querySelector('[data-pref-state]');
      function paintPref() {
        var e = P.prefs.effective();
        state.textContent = e.motion === 'reduced'
          ? '降低动效（位移已替换为淡入）'
          : '完整动效' + (P.prefs.media('motion') ? '（系统开着「减弱动态效果」，这里已手动覆盖）' : '');
      }
      paintPref();
      P.prefs.onChange(paintPref);

      var resize = function () { if (demos.projection && demos.projection.layout) demos.projection.layout(); };
      window.addEventListener('resize', resize);

      /* 进页面就自动放一遍：不用猜哪里能动 */
      later(playAll, 420);
    }
  };
})();
