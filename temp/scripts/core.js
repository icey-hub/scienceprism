/* ==========================================================================
   core.js — 交互底座
   把 Apple《Designing Fluid Interfaces》的四件事做成可复用代码：
     1) 弹簧（damping + response），可中断、带速度重定向；
     2) 指针 1:1 跟手（Pointer Events + setPointerCapture + 抓取偏移）；
     3) 释放速度 → 动量投影 → 决定落点；
     4) 越界橡皮筋，而不是硬停。
   零依赖，classic script，file:// 直接可跑。
   ========================================================================== */
(function () {
  'use strict';

  var P = (window.Prism = window.Prism || {});
  P.views = P.views || {};

  /* ---------------------------------------------------------------- 数学 -- */
  P.clamp = function (v, min, max) { return Math.min(max, Math.max(min, v)); };
  P.lerp = function (a, b, t) { return a + (b - a) * t; };
  P.round = function (v, p) { var k = Math.pow(10, p == null ? 2 : p); return Math.round(v * k) / k; };

  /* Apple 的投影：v 是 px/s，decelerationRate 0.998 ≈ 系统滚动手感
     （不是教科书里的 v²/2a，而是指数衰减形式） */
  P.project = function (v, decel) {
    var d = decel == null ? 0.998 : decel;
    return (v / 1000) * d / (1 - d);
  };

  /* 越界越多，跟手越少：读起来是「还有阻力」而不是「卡住了」 */
  P.rubberband = function (overshoot, dimension, constant) {
    var c = constant == null ? 0.55 : constant;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  };

  /* --------------------------------------------------------------- 调度器 -- */
  /* timeScale 用来「慢放」：Apple 建议逐帧回看动效，把 dt 整体缩放即可 */
  P.timeScale = 1;
  P.setTimeScale = function (v) { P.timeScale = v; };

  var raf = {
    items: [],
    running: false,
    id: 0,
    last: 0,
    add: function (item) { if (this.items.indexOf(item) < 0) this.items.push(item); this.start(); },
    remove: function (item) {
      var i = this.items.indexOf(item);
      if (i >= 0) this.items.splice(i, 1);
      if (!this.items.length) this.stop();
    },
    start: function () {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      this.id = requestAnimationFrame(raf.tick);
    },
    stop: function () { this.running = false; if (this.id) cancelAnimationFrame(this.id); this.id = 0; },
    tick: function (now) {
      var dt = Math.min(0.064, (now - raf.last) / 1000) * P.timeScale;
      raf.last = now;
      var snapshot = raf.items.slice();
      for (var i = 0; i < snapshot.length; i++) snapshot[i].step(dt);
      if (raf.items.length) raf.id = requestAnimationFrame(raf.tick);
      else raf.running = false;
    }
  };
  P.raf = raf;

  /* --------------------------------------------------------------- 弹簧 -- */
  /* 一个标量弹簧。damping = 1 临界阻尼（不过冲）；< 1 才允许回弹。
     response 是「到达目标快慢」的秒数，不是时长——弹簧没有固定时长。 */
  function Spring(value, opts) {
    opts = opts || {};
    this.value = value;
    this.target = value;
    this.velocity = opts.velocity || 0;
    this.damping = opts.damping == null ? 1 : opts.damping;
    this.response = opts.response == null ? 0.4 : opts.response;
    this.restDelta = opts.restDelta == null ? 0.01 : opts.restDelta;
    this.restSpeed = opts.restSpeed == null ? 0.1 : opts.restSpeed;
    this.onUpdate = opts.onUpdate || null;
    this.onComplete = opts.onComplete || null;
    this.done = true;
  }
  Spring.prototype.to = function (target, velocity) {
    this.target = target;
    /* 关键：重定向时默认沿用当前速度，避免反向出现「撞墙」的速度断点 */
    if (velocity != null) this.velocity = velocity;
    this.done = false;
    raf.add(this);
    return this;
  };
  Spring.prototype.jump = function (value, velocity) {
    this.value = value; this.target = value;
    this.velocity = velocity == null ? 0 : velocity;
    this.done = true;
    raf.remove(this);
    if (this.onUpdate) this.onUpdate(this.value, this);
    return this;
  };
  Spring.prototype.stop = function () { this.jump(this.value, this.velocity); };
  Spring.prototype.step = function (dt) {
    var sub = 1 / 240;                       /* 固定子步长，避免大 dt 把弹簧炸掉 */
    var remaining = dt;
    var omega = (2 * Math.PI) / this.response;
    var stiffness = omega * omega;
    var drag = (4 * Math.PI * this.damping) / this.response;
    while (remaining > 1e-6) {
      var h = Math.min(sub, remaining);
      remaining -= h;
      var a = -stiffness * (this.value - this.target) - drag * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < this.restDelta && Math.abs(this.velocity) < this.restSpeed) {
      this.value = this.target;
      this.velocity = 0;
      this.done = true;
      raf.remove(this);
      if (this.onUpdate) this.onUpdate(this.value, this);
      if (this.onComplete) this.onComplete(this);
      return;
    }
    if (this.onUpdate) this.onUpdate(this.value, this);
  };
  P.Spring = Spring;

  /* 常用参数（对照 Apple 给出的出厂值） */
  P.springs = {
    move: { damping: 1, response: 0.4 },
    snappy: { damping: 1, response: 0.28 },
    gentle: { damping: 1, response: 0.52 },
    momentum: { damping: 0.8, response: 0.4 },
    sheet: { damping: 0.8, response: 0.32 },
    fade: { damping: 1, response: 0.2 }
  };

  /* ------------------------------------------------------- 多值弹簧组 -- */
  /* motion({y: 0}).to({y: 120}, {velocity: {y: 900}}) */
  function motion(initial, opts) {
    opts = opts || {};
    var springs = {};
    var values = {};
    var keys = Object.keys(initial);
    for (var i = 0; i < keys.length; i++) values[keys[i]] = initial[keys[i]];
    var listeners = [];
    var waiting = null;
    var pendingComplete = null;

    function emit() {
      for (var i = 0; i < listeners.length; i++) listeners[i](values, ctl);
      if (waiting && waiting.every(function (k) { return !springs[k] || springs[k].done; })) {
        waiting = null;
        var cb = pendingComplete;
        pendingComplete = null;
        if (cb) cb(values);
      }
    }
    function setValue(key, v) {
      values[key] = v;
      if (springs[key]) springs[key].jump(v);
      else springs[key] = new Spring(v, {});
    }
    var ctl = {
      values: values,
      on: function (fn) { listeners.push(fn); return ctl; },
      to: function (targets, options) {
        options = options || {};
        var reduced = P.prefs.effective().motion === 'reduced';
        var next = [];
        Object.keys(targets).forEach(function (key) {
          var target = targets[key];
          /* 降低动效：位移/缩放直接到位，只保留淡入淡出（无弹性、无位移） */
          if (reduced && key !== 'opacity') {
            setValue(key, target);
            next.push(key);
            return;
          }
          var preset = P.springs[options.preset || opts.preset] || null;
          var spring = springs[key];
          if (!spring) spring = springs[key] = new Spring(values[key] == null ? target : values[key], {});
          /* onUpdate 每次都补上：弹簧可能先被 set() 创建过，那时还没有渲染回调 */
          spring.onUpdate = (function (k) { return function (v) { values[k] = v; emit(); }; })(key);
          spring.damping = options.damping != null ? options.damping
            : (opts.damping != null ? opts.damping : (preset ? preset.damping : 1));
          spring.response = options.response != null ? options.response
            : (opts.response != null ? opts.response : (preset ? preset.response : 0.4));
          if (reduced && key === 'opacity') { spring.damping = 1; spring.response = 0.16; }
          var v = options.velocity ? options.velocity[key] : undefined;
          spring.to(target, v);
          next.push(key);
        });
        waiting = next;
        pendingComplete = options.onComplete || null;
        if (reduced) emit();   /* 全是直接赋值时也要渲染一次 */
        return ctl;
      },
      set: function (targets) { Object.keys(targets).forEach(function (k) { setValue(k, targets[k]); }); emit(); return ctl; },
      stop: function () { Object.keys(springs).forEach(function (k) { springs[k].stop(); }); waiting = null; pendingComplete = null; return ctl; },
      isDone: function () { return Object.keys(springs).every(function (k) { return springs[k].done; }); }
    };
    return ctl;
  }
  P.motion = motion;

  /* --------------------------------------------------------------- 手势 -- */
  function velocityOf(hist) {
    if (hist.length < 2) return { x: 0, y: 0 };
    var last = hist[hist.length - 1];
    var first = hist[0];
    var dt = (last.t - first.t) / 1000;
    if (dt <= 0.001) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
  P.velocityOf = velocityOf;

  /* 指针 1:1 跟手。opts:
     axis 'x'|'y'|'both'，threshold 起手迟滞（默认 0），
     onStart/onMove/onEnd/onTap/onDown，cursor 拖动时改光标 */
  P.drag = function (el, opts) {
    opts = opts || {};
    var axis = opts.axis || 'both';
    var threshold = opts.threshold || 0;
    var active = false, started = false, pid = null, sx = 0, sy = 0, hist = [];
    var prevSelect = '';

    function down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (opts.canStart && opts.canStart(e) === false) return;
      active = true; started = false; pid = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      hist = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      if (opts.onDown) opts.onDown(e);
    }
    function move(e) {
      if (!active || e.pointerId !== pid) return;
      var now = performance.now();
      hist.push({ t: now, x: e.clientX, y: e.clientY });
      while (hist.length > 2 && now - hist[0].t > 110) hist.shift();
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!started) {
        var dist = axis === 'x' ? Math.abs(dx) : axis === 'y' ? Math.abs(dy) : Math.sqrt(dx * dx + dy * dy);
        if (dist < threshold) return;
        started = true;
        prevSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        if (opts.cursor) document.body.style.cursor = opts.cursor;
        el.classList.add('is-dragging');
        if (opts.onStart) opts.onStart({ dx: dx, dy: dy, event: e });
      }
      var v = velocityOf(hist);
      if (opts.onMove) opts.onMove({ dx: dx, dy: dy, x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, event: e });
      if (e.cancelable) e.preventDefault();
    }
    function up(e) {
      if (!active || e.pointerId !== pid) return;
      active = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(pid); } catch (_) {}
      el.classList.remove('is-dragging');
      document.body.style.userSelect = prevSelect;
      if (opts.cursor) document.body.style.cursor = '';
      var v = velocityOf(hist);
      if (started) {
        if (opts.onEnd) opts.onEnd({ x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, event: e });
      } else if (opts.onTap) {
        opts.onTap(e);
      }
    }
    el.addEventListener('pointerdown', down);
    return function destroy() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  };

  /* 按压反馈：pointer-down 立刻给状态；拖出 10px 就取消；松手在界内才提交 */
  P.pressable = function (el, opts) {
    opts = opts || {};
    var HYST = 10;
    var pid = null, sx = 0, sy = 0;
    function down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      el.classList.add('is-pressed');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      if (opts.onDown) opts.onDown(e);
    }
    function move(e) {
      if (e.pointerId !== pid) return;
      if (Math.sqrt((e.clientX - sx) * (e.clientX - sx) + (e.clientY - sy) * (e.clientY - sy)) > HYST) el.classList.remove('is-pressed');
    }
    function up(e) {
      if (e.pointerId !== pid) return;
      pid = null;
      el.classList.remove('is-pressed');
      var r = el.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) { if (opts.onCommit) opts.onCommit(e); }
      else if (opts.onCancel) opts.onCancel(e);
    }
    function cancel(e) { if (e.pointerId !== pid) return; pid = null; el.classList.remove('is-pressed'); if (opts.onCancel) opts.onCancel(e); }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };

  /* --------------------------------------------------------------- 偏好 -- */
  var MQ = {
    theme: '(prefers-color-scheme: dark)',
    motion: '(prefers-reduced-motion: reduce)',
    transparency: '(prefers-reduced-transparency: reduce)',
    contrast: '(prefers-contrast: more)'
  };
  var media = {}, override = {}, prefListeners = [];

  function effective() {
    return {
      theme: override.theme || (media.theme ? 'dark' : 'light'),
      motion: override.motion || (media.motion ? 'reduced' : 'full'),
      transparency: override.transparency || (media.transparency ? 'reduced' : 'full'),
      contrast: override.contrast || (media.contrast ? 'more' : 'normal')
    };
  }
  function applyPrefs() {
    var e = effective();
    var d = document.documentElement;
    d.dataset.theme = e.theme;
    d.dataset.motion = e.motion;
    d.dataset.transparency = e.transparency;
    d.dataset.contrast = e.contrast;
    for (var i = 0; i < prefListeners.length; i++) prefListeners[i](e);
  }
  P.prefs = {
    effective: effective,
    /* 系统本身是否开了这个偏好（用来区分「系统让我降级」和「我自己切的」） */
    media: function (key) { return !!media[key]; },
    set: function (key, value) {
      if (value === 'auto') delete override[key];
      else override[key] = value;
      applyPrefs();
    },
    override: function (key) { return override[key] || 'auto'; },
    onChange: function (fn) { prefListeners.push(fn); return fn; },
    init: function () {
      Object.keys(MQ).forEach(function (key) {
        var mq = window.matchMedia ? window.matchMedia(MQ[key]) : null;
        if (!mq) return;
        media[key] = mq.matches;
        var handler = function (e) { media[key] = e.matches; applyPrefs(); };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
      });
      applyPrefs();
    }
  };

  /* ------------------------------------------------------------- DOM 工具 -- */
  P.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  P.$ = function (sel, root) { return (root || document).querySelector(sel); };
  P.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  P.mount = function (el, html) { el.innerHTML = html; return el; };
  P.on = function (root, selector, type, handler) {
    root.addEventListener(type, function (e) {
      var target = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (target && root.contains(target)) handler(e, target);
    });
  };
  P.h = function (tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  };
  P.id = function (prefix) { return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 9); };

  /* 时间 / 数字 */
  P.fmtTime = function (iso) {
    var d = new Date(iso);
    var diff = Math.max(0, Date.now() - d.getTime());
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  };
  P.fmtNum = function (n) { return Number(n).toLocaleString('zh-CN'); };

  /* 触觉 / 声音反馈：与视觉同帧触发（模态反馈的「和谐」原则） */
  P.tick = function (kind) {
    try {
      if (navigator.vibrate) navigator.vibrate(kind === 'commit' ? [8, 24, 12] : 8);
    } catch (_) {}
    try {
      if (!P.audio) P.audio = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = P.audio;
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(kind === 'commit' ? 660 : 420, t);
      if (kind === 'commit') osc.frequency.exponentialRampToValueAtTime(990, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.05 : 0.035, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'commit' ? 0.16 : 0.09));
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.2);
    } catch (_) {}
  };
})();
