/* ==========================================================================
   motion.js — 招牌特效原语
   这一层是「看得见的 Apple」：英雄过渡、液态玻璃高光、橡皮筋滚动、
   动态岛、弹簧列表重排、挤压与拉伸。
   全部复用 core.js 的弹簧，所以同样可中断、同样能带速度重定向。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;

  /* ------------------------------------------------------------ 英雄过渡 -- */
  /* 来源元素的矩形 → 目标元素的矩形。几何、圆角、内容交叉淡入由同一个弹簧驱动，
     所以它是「长成」目标，而不是「淡出再淡入」。传 container 就在容器内做（用于演示台）。 */
  P.hero = function (opts) {
    var source = opts.sourceEl;
    var container = opts.container || null;
    var base = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
    var s = source.getBoundingClientRect();
    var sRect = { left: s.left - base.left, top: s.top - base.top, width: s.width, height: s.height };

    var clone = source.cloneNode(true);
    clone.classList.add('hero-clone');
    if (container) clone.classList.add('is-contained');
    clone.style.width = sRect.width + 'px';
    clone.style.height = sRect.height + 'px';
    clone.style.transform = 'translate3d(' + sRect.left + 'px,' + sRect.top + 'px,0)';
    (container || document.body).appendChild(clone);

    if (opts.swap) opts.swap();

    var target = container ? container.querySelector(opts.targetSelector) : document.querySelector(opts.targetSelector);
    if (!target) { if (clone.parentNode) clone.parentNode.removeChild(clone); return null; }
    var tr = target.getBoundingClientRect();
    var tRect = { left: tr.left - base.left, top: tr.top - base.top, width: tr.width, height: tr.height };
    var prevOpacity = target.style.opacity;
    target.style.opacity = '0';
    target.style.willChange = 'opacity';

    var sx = tRect.width / Math.max(1, sRect.width);
    var sy = tRect.height / Math.max(1, sRect.height);
    var m = P.motion({ p: 0 });
    m.on(function (v) {
      var p = v.p;
      clone.style.transform = 'translate3d(' +
        P.round(P.lerp(sRect.left, tRect.left, p), 2) + 'px,' +
        P.round(P.lerp(sRect.top, tRect.top, p), 2) + 'px,0) scale(' +
        P.round(P.lerp(1, sx, p), 4) + ',' + P.round(P.lerp(1, sy, p), 4) + ')';
      clone.style.borderRadius = P.round(P.lerp(14, 22, p), 2) + 'px';
      clone.style.opacity = String(1 - P.clamp((p - 0.5) / 0.4, 0, 1));
      target.style.opacity = String(P.clamp((p - 0.28) / 0.5, 0, 1));
    });
    m.to({ p: 1 }, {
      damping: 1, response: opts.response || 0.5,
      onComplete: function () {
        target.style.opacity = prevOpacity || '1';
        target.style.willChange = '';
        if (clone.parentNode) clone.parentNode.removeChild(clone);
        if (opts.onDone) opts.onDone();
      }
    });
    return m;
  };

  /* ------------------------------------------------------- 橡皮筋滚动 -- */
  /* 到边界还继续滚：跟手但越来越沉，松手带速度弹回。不是硬停。 */
  P.elasticScroll = function (el, opts) {
    if (!el || el.__elastic) return null;
    opts = opts || {};
    var inner = document.createElement('div');
    inner.className = 'elastic-inner';
    while (el.firstChild) inner.appendChild(el.firstChild);
    el.appendChild(inner);
    el.classList.add('elastic');
    el.__elastic = true;

    var raw = 0, y = 0, timer = 0, spring = null;
    var limit = opts.limit || 260;

    function paint() { inner.style.transform = y ? 'translate3d(0,' + P.round(y, 2) + 'px,0)' : ''; }
    function settle(velocity) {
      if (spring) spring.stop();
      spring = new P.Spring(y, {
        damping: 0.8, response: 0.42, restDelta: 0.4, restSpeed: 3,
        onUpdate: function (v) { y = v; paint(); }
      });
      spring.to(0, velocity);
    }
    function push(delta) {
      if (spring) { spring.stop(); spring = null; }
      if (raw && ((raw > 0 && delta < 0) || (raw < 0 && delta > 0))) raw = 0;
      raw += delta;
      y = raw > 0 ? P.rubberband(raw, limit) : -P.rubberband(-raw, limit);
      paint();
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { raw = 0; settle(0); }, opts.hold || 110);
    }
    el.addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;
      var atTop = el.scrollTop <= 0;
      var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if (atTop && e.deltaY < 0) { e.preventDefault(); push(-Math.abs(e.deltaY)); }
      else if (atBottom && e.deltaY > 0) { e.preventDefault(); push(Math.abs(e.deltaY)); }
    }, { passive: false });

    return {
      inner: inner,
      /* 给演示台用：程序化地推一把，再自动弹回 */
      nudge: function (delta) { push(delta); return { release: function () { window.clearTimeout(timer); raw = 0; settle(0); } }; }
    };
  };

  /* ------------------------------------------------------------ 动态岛 -- */
  /* 一个会「长大」的胶囊：内容换了，宽度用弹簧长过去，不是跳变。 */
  P.island = function (host, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'island';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="island-body"></span>';
    host.appendChild(el);
    var body = el.querySelector('.island-body');
    var w = new P.Spring(opts.from || 0, {
      damping: 1, response: 0.42, restDelta: 0.5, restSpeed: 3,
      onUpdate: function (v) { el.style.width = P.round(Math.max(0, v), 2) + 'px'; }
    });
    var handle = {
      el: el,
      set: function (html, o) {
        o = o || {};
        body.innerHTML = html;
        if (o.tone) el.dataset.tone = o.tone; else delete el.dataset.tone;
        var cur = el.style.width;
        el.style.width = 'auto';
        var target = el.offsetWidth;
        el.style.width = cur || '0px';
        if (o.instant) w.jump(target); else w.to(target);
        if (o.sheen) P.glass.sheen(el);
      }
    };
    return handle;
  };

  /* -------------------------------------------------- 弹簧列表重排 -- */
  /* 拖起一行：它 1:1 跟手，其余行用弹簧让位；松手按投影决定落点，然后落定并提交顺序。 */
  P.reorder = function (list, opts) {
    opts = opts || {};
    var items = Array.prototype.slice.call(list.children);
    if (items.length < 2) return null;
    var active = null, fromIndex = 0, toIndex = 0, dy = 0, h = 40;
    var shifts = items.map(function () { return 0; });
    var springs = items.map(function () { return null; });
    items.forEach(function (it) { it.style.position = 'relative'; it.style.willChange = 'transform'; });

    function paint() {
      items.forEach(function (it, i) {
        if (it === active) return;
        it.style.transform = shifts[i] ? 'translate3d(0,' + P.round(shifts[i], 2) + 'px,0)' : '';
      });
    }
    function springTo(i, value) {
      if (!springs[i]) {
        springs[i] = new P.Spring(shifts[i], {
          damping: 0.85, response: 0.32, restDelta: 0.4, restSpeed: 2,
          onUpdate: function (v) { shifts[i] = v; paint(); }
        });
      }
      springs[i].to(value);
    }
    function gap(i) {
      var shift = 0;
      if (fromIndex < toIndex && i > fromIndex && i <= toIndex) shift = -h;
      else if (fromIndex > toIndex && i >= toIndex && i < fromIndex) shift = h;
      springTo(i, shift);
    }
    function indexFromProjection(projected) {
      return P.clamp(Math.round(projected / h) + fromIndex, 0, items.length - 1);
    }

    items.forEach(function (it, i) {
      P.drag(it, {
        axis: 'y',
        threshold: 4,
        cursor: 'grabbing',
        canStart: function (e) { return !(e.target.closest && e.target.closest('button, a, input, select')); },
        onStart: function () {
          active = it; fromIndex = i; toIndex = i; dy = 0;
          h = items.length > 1 ? Math.abs(items[1].offsetTop - items[0].offsetTop) : it.offsetHeight;
          it.classList.add('is-lifted');
        },
        onMove: function (s) {
          dy = s.dy;
          it.style.transform = 'translate3d(0,' + P.round(dy, 2) + 'px,0) scale(1.02)';
          var next = indexFromProjection(dy);
          if (next !== toIndex) { toIndex = next; gap(i); }
        },
        onEnd: function (s) {
          var projected = dy + P.project(s.vy, 0.998);
          toIndex = indexFromProjection(projected);
          gap(i);
          var settle = new P.Spring(dy, {
            damping: 1, response: 0.34, restDelta: 0.5, restSpeed: 2,
            onUpdate: function (v) { it.style.transform = 'translate3d(0,' + P.round(v, 2) + 'px,0) scale(1.02)'; },
            onComplete: function () {
              it.classList.remove('is-lifted');
              it.style.transform = '';
              if (toIndex !== fromIndex) {
                var ref = items[toIndex];
                if (toIndex > fromIndex) list.insertBefore(it, ref.nextSibling);
                else list.insertBefore(it, ref);
              }
              items.forEach(function (x, k) {
                shifts[k] = 0;
                x.style.transform = '';
                if (springs[k]) springs[k].jump(0);
              });
              active = null;
              if (opts.onCommit) opts.onCommit(toIndex, fromIndex);
            }
          });
          settle.to((toIndex - fromIndex) * h, s.vy);
        }
      });
    });
    return { items: items };
  };

  /* ------------------------------------------------------ 挤压与拉伸 -- */
  /* 高速时沿运动方向拉长、垂直方向压扁：比一道硬边更能读出「很快」。 */
  P.stretch = function (velocity, opts) {
    opts = opts || {};
    var k = P.clamp(Math.abs(velocity) / (opts.divisor || 9000), 0, opts.max || 0.14);
    return { sx: 1 + k, sy: 1 - k * (opts.cross || 0.5) };
  };

  /* 落地的挤压：先压扁再弹回，damping < 1 才有那一下回弹 */
  P.squash = function (el, opts) {
    opts = opts || {};
    var m = P.motion({ sx: opts.sx || 1.35, sy: opts.sy || 0.65 });
    m.on(function (v) {
      el.style.transform = 'scale(' + P.round(v.sx, 4) + ',' + P.round(v.sy, 4) + ')';
    });
    m.set({ sx: opts.sx || 1.35, sy: opts.sy || 0.65 });
    m.to({ sx: 1, sy: 1 }, { damping: 0.55, response: 0.34 });
    return m;
  };
})();
