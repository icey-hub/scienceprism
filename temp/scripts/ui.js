/* ==========================================================================
   ui.js — 可复用交互原语
   每个原语都在兑现 Apple 的一条规则：
     sheet/popover → 空间一致性（从来源长出来、原路退出）
     segmented     → 提示手势方向（按住拖动时指示块跟着走）
     holdButton    → 安全（按住才提交，松手回弹）
     swipeRow      → 动量投影决定落点，而不是从释放点就近吸附
     splitter      → 1:1 跟手 + 越界橡皮筋
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var ui = (P.ui = {});

  /* ================================================================ 图标 == */
  var ICONS = {
    'arrow-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
    'arrow-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    'chevron-down': '<path d="M6.5 9.75 12 15.25l5.5-5.5"/>',
    'chevron-right': '<path d="M9.75 6.5 15.25 12l-5.5 5.5"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    search: '<circle cx="11" cy="11" r="6.25"/><path d="M15.6 15.6 20 20"/>',
    folder: '<path d="M3.5 8.25a2 2 0 0 1 2-2h3.1l1.9 2.3h7.9a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
    'file-text': '<path d="M7 3.5h6.4L18.5 8.6V20.5H7z"/><path d="M13.2 3.6v5.2h5.2M9.6 13h5.2M9.6 16.2h3.6"/>',
    sparkles: '<path d="M12 3.5l1.55 4.2 4.2 1.55-4.2 1.55L12 15l-1.55-4.2L6.25 9.25l4.2-1.55z"/><path d="M18.2 15.4l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75z"/>',
    play: '<path d="M8.5 5.8v12.4L18.5 12z" fill="currentColor" stroke="none"/>',
    save: '<path d="M5.5 4.5h9.4l3.6 3.6v11.4H5.5z"/><path d="M8.6 4.6v5h6.8v-5M8.6 15.4h6.8"/>',
    sliders: '<path d="M5 8.5h9M17.5 8.5h1.5M5 15.5h2.5M11 15.5h8"/><circle cx="15.5" cy="8.5" r="1.9"/><circle cx="9" cy="15.5" r="1.9"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4.2 12h15.6M12 4.1c2 2.2 3.1 5 3.1 7.9S14 17.7 12 19.9C10 17.7 8.9 14.9 8.9 12S10 6.3 12 4.1z"/>',
    layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M10 4.5v15M10 12h10.5"/>',
    grid: '<rect x="4" y="4.5" width="6.6" height="6.6" rx="1.8"/><rect x="13.4" y="4.5" width="6.6" height="6.6" rx="1.8"/><rect x="4" y="13.9" width="6.6" height="6.6" rx="1.8"/><rect x="13.4" y="13.9" width="6.6" height="6.6" rx="1.8"/>',
    flask: '<path d="M9.2 3.5h5.6M10.4 3.6v5.6L6 17.6A2.2 2.2 0 0 0 8 20.5h8a2.2 2.2 0 0 0 2-2.9L13.6 9.2V3.6"/><path d="M8 14.6h8"/>',
    book: '<path d="M4.5 6.2A2.2 2.2 0 0 1 6.7 4h12.8v16H6.7a2.2 2.2 0 0 1-2.2-2.2z"/><path d="M8.2 4v16"/>',
    activity: '<path d="M3.5 12.5h3.8l2.4-6.2 3.6 12.4 2.3-6.2h4.9"/>',
    bot: '<rect x="4.5" y="7.5" width="15" height="11.5" rx="3.2"/><path d="M12 4.2v3.2M8.6 12.4h.01M15.4 12.4h.01M9.6 16h4.8"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><circle cx="9" cy="10" r="1.7"/><path d="M4.5 17.5 9.6 13l3.4 3 2.6-2.3 3.9 3.6"/>',
    chart: '<path d="M4 19.5h16"/><path d="M7.2 19.5V11M12 19.5V5.5M16.8 19.5v-5.4"/>',
    shield: '<path d="M12 3.6l6.8 2.5v6c0 4.2-2.7 7.4-6.8 8.9-4.1-1.5-6.8-4.7-6.8-8.9v-6z"/><path d="M9 12.2l2.2 2.2 4-4.4"/>',
    x: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.6V12l3.1 2"/>',
    undo: '<path d="M5 9h9.5a4.5 4.5 0 0 1 0 9H9"/><path d="M8.5 5.5 5 9l3.5 3.5"/>',
    'panel-left': '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M9.5 4.5v15"/>',
    'panel-right': '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M14.5 4.5v15"/>',
    lock: '<rect x="4.8" y="10.2" width="14.4" height="9.4" rx="2.6"/><path d="M8.4 10.2V7.9a3.6 3.6 0 0 1 7.2 0v2.3"/>',
    check: '<path d="M5.5 12.6 9.8 17 18.5 7.4"/>',
    more: '<circle cx="6.2" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.8" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 3.4v2.2M12 18.4v2.2M3.4 12h2.2M18.4 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>',
    contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
    waveform: '<path d="M4 12h1.6M8.2 7v10M12 4.4v15.2M15.8 8.4v7.2M20 12h-1.4"/>',
    layers: '<path d="M12 3.8 20.2 8 12 12.2 3.8 8z"/><path d="M4.6 12.4 12 16.2l7.4-3.8M4.6 16.4 12 20.2l7.4-3.8"/>',
    download: '<path d="M12 4v10.6M8 11.4l4 4 4-4M5 19.5h14"/>',
    link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l2.6-2.6a3.5 3.5 0 0 0-5-5L11.4 7.6"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-2.6 2.6a3.5 3.5 0 0 0 5 5l1.2-1.2"/>',
    target: '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="3.4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4"/>',
    users: '<circle cx="9.4" cy="9" r="3.2"/><path d="M3.8 19.4c0-3 2.5-5.4 5.6-5.4s5.6 2.4 5.6 5.4"/><path d="M16.4 6.4a3 3 0 0 1 0 5.6M17.6 14.6c1.7.7 2.9 2.4 2.9 4.4"/>',
    bolt: '<path d="M13.4 3.5 6.8 13.2h4.6l-.8 7.3 6.6-9.7h-4.6z"/>',
    table: '<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><path d="M3.5 10h17M9.5 10v9"/>',
    list: '<path d="M5 7h14M5 12h14M5 17h9"/>',
    eye: '<path d="M2.8 12S6.4 6.4 12 6.4 21.2 12 21.2 12 17.6 17.6 12 17.6 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>'
  };

  P.icon = function (name, size, extra) {
    var d = ICONS[name] || ICONS.grid;
    var s = size || 16;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (extra ? ' class="' + extra + '"' : '') + '>' + d + '</svg>';
  };

  var layer = function () { return document.getElementById('layer-root'); };
  var app = function () { return document.getElementById('app'); };

  /* ================================================================ 提示条 == */
  var toasts = [];
  ui.toast = function (message, opts) {
    opts = opts || {};
    var root = document.getElementById('toast-root');
    var el = P.h('div', { class: 'toast', html: P.icon(opts.icon || 'check', 15) + '<span>' + P.esc(message) + '</span>' });
    root.appendChild(el);
    toasts.push(el);
    if (toasts.length > 3) removeToast(toasts.shift());
    var m = P.motion({ y: 14, opacity: 0, scale: 0.96 });
    m.on(function (v) {
      el.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0) scale(' + P.round(v.scale, 4) + ')';
      el.style.opacity = P.round(v.opacity, 3);
    });
    m.set({ y: 14, opacity: 0, scale: 0.96 });
    m.to({ y: 0, opacity: 1, scale: 1 }, { damping: 0.85, response: 0.3 });
    var timer = window.setTimeout(function () {
      m.to({ y: 8, opacity: 0, scale: 0.97 }, { response: 0.22, onComplete: function () { removeToast(el); } });
    }, opts.duration || 2600);
    el.addEventListener('click', function () { window.clearTimeout(timer); removeToast(el); });
    return el;
  };
  function removeToast(el) {
    var i = toasts.indexOf(el);
    if (i >= 0) toasts.splice(i, 1);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /* ================================================================= 抽屉 == */
  var openSheets = [];
  ui.sheet = function (opts) {
    opts = opts || {};
    var side = opts.side || 'bottom';
    var reducedTransparency = P.prefs.effective().transparency === 'reduced';
    var wrap = P.h('div', { class: 'sheet-wrap ' + side });
    var scrim = P.h('div', { class: 'scrim' });
    var panel = P.h('div', {
      class: 'sheet', role: 'dialog', 'aria-modal': 'true',
      'aria-label': opts.title || '面板'
    });
    var grab = (side === 'bottom') ? '<div class="sheet-grab" data-grab><i></i></div>' : '';
    var foot = opts.footer ? '<div class="sheet-foot">' + opts.footer + '</div>' : '';
    panel.innerHTML = grab +
      '<div class="sheet-head"><h2>' + P.esc(opts.title || '') + '</h2>' +
      (opts.desc ? '<p>' + P.esc(opts.desc) + '</p>' : '') + '</div>' +
      '<div class="sheet-body scroll">' + (opts.body || '') + '</div>' + foot;
    wrap.appendChild(scrim); wrap.appendChild(panel);
    layer().appendChild(wrap);

    var axis = side === 'bottom' ? 'y' : side === 'right' ? 'x' : side === 'left' ? 'x' : 'none';
    var size = side === 'center' ? 1 : (side === 'bottom' ? panel.offsetHeight : panel.offsetWidth);
    var pos = size;
    var base = 0;
    var closing = false;
    var scrimOn = opts.scrim !== false;

    function render(p, sp) {
      pos = p;
      /* 挤压与拉伸：沿运动方向拉长、垂直方向压扁 —— 材料被拉动，而不是整体平移 */
      var k = sp ? P.clamp(Math.abs(sp.velocity) / 16000, 0, 0.06) : 0;
      var along = 1 + k, cross = 1 - k * 0.5;
      var scale = axis === 'y' ? ' scale(' + P.round(cross, 4) + ',' + P.round(along, 4) + ')'
        : axis === 'x' ? ' scale(' + P.round(along, 4) + ',' + P.round(cross, 4) + ')' : '';
      if (side === 'bottom') panel.style.transform = 'translate3d(0,' + P.round(p, 2) + 'px,0)' + scale;
      else if (side === 'right') panel.style.transform = 'translate3d(' + P.round(p, 2) + 'px,0,0)' + scale;
      else if (side === 'left') panel.style.transform = 'translate3d(' + P.round(-p, 2) + 'px,0,0)' + scale;
      else panel.style.transform = 'translate3d(0,' + P.round(p * 10, 2) + 'px,0) scale(' + P.round(1 - p * 0.04, 4) + ')';
      var t = P.clamp(1 - p / Math.max(1, size), 0, 1);
      scrim.style.opacity = String(scrimOn ? t * 0.98 : 0);
      panel.style.opacity = side === 'center' ? String(t) : '1';
      /* 材料化：模糊与缩放一起变，读起来像「一块材料到位」而不是淡入 */
      if (!reducedTransparency) panel.style.setProperty('--sheet-blur', P.round(8 + 32 * t, 1) + 'px');
      var a = app();
      if (a) a.style.transform = 'scale(' + P.round(1 - 0.012 * t, 5) + ')';
    }

    var spring = new P.Spring(size, {
      damping: 0.8, response: 0.32, restDelta: 0.5, restSpeed: 4, onUpdate: render
    });

    function destroy() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      var a = app();
      if (a) a.style.transform = '';
      var i = openSheets.indexOf(handle);
      if (i >= 0) openSheets.splice(i, 1);
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    function dismiss(velocity) {
      if (closing) return;
      closing = true;
      spring.onComplete = destroy;
      spring.to(size, Math.max(0, velocity || 0));
    }
    function onKey(e) { if (e.key === 'Escape' && opts.dismissible !== false) dismiss(0); }

    render(size);
    spring.to(0);
    scrim.addEventListener('pointerdown', function () { if (opts.dismissible !== false) dismiss(0); });
    document.addEventListener('keydown', onKey);

    /* 拖动关闭：抓取偏移、越界橡皮筋、动量投影、可中断 */
    if (axis !== 'none' && opts.dismissible !== false) {
      P.drag(panel, {
        axis: axis,
        threshold: 2,
        cursor: axis === 'y' ? 'grabbing' : 'col-resize',
        canStart: function (e) {
          /* 只允许从抓手/头部起手，正文里要能正常选中文字 */
          return !!e.target.closest('[data-grab], .sheet-head');
        },
        onDown: function () {
          spring.stop();          /* 冻结在当前呈现值，从当前位置继续，而不是跳回目标 */
          base = pos;
        },
        onMove: function (s) {
          var delta = axis === 'y' ? s.dy : (side === 'left' ? -s.dx : s.dx);
          var raw = base + delta;
          render(raw < 0 ? -P.rubberband(-raw, size) : Math.min(raw, size));
        },
        onEnd: function (s) {
          var v = axis === 'y' ? s.vy : (side === 'left' ? -s.vx : s.vx);
          var projected = pos + P.project(v, 0.998);
          var shouldClose = projected > size * 0.35 || v > 900;
          closing = false;
          if (shouldClose) { closing = true; spring.onComplete = destroy; spring.to(size, Math.max(0, v)); }
          else spring.to(0, v);
        }
      });
    }

    var handle = {
      el: panel,
      close: function () { dismiss(0); },
      body: panel.querySelector('.sheet-body')
    };
    openSheets.push(handle);
    if (opts.onMount) opts.onMount(panel, handle);
    return handle;
  };
  ui.closeTopSheet = function () { if (openSheets.length) openSheets[openSheets.length - 1].close(); };

  /* ============================================================ 照片缩放 == */
  /* 从锚点长成一块大面板；关闭沿原路缩回锚点。可向下拖拽甩掉。
     这就是 iOS 点开一张图的那种「缩放」：进入和退出走同一条路径。 */
  var openZooms = [];
  ui.zoom = function (anchor, opts) {
    opts = opts || {};
    var wrap = P.h('div', { class: 'zoom-wrap' });
    var scrim = P.h('div', { class: 'scrim' });
    var panel = P.h('div', { class: 'zoom-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.label || '预览' });
    panel.innerHTML = opts.html || '';
    wrap.appendChild(scrim); wrap.appendChild(panel);
    layer().appendChild(wrap);

    var from = anchor.getBoundingClientRect();
    var aspect = from.width / Math.max(1, from.height);
    var h = Math.min(window.innerHeight * 0.8, Math.max(from.height * 2.2, 320));
    var w = Math.min(window.innerWidth * 0.84, h * aspect);
    h = w / aspect;
    var to = { left: (window.innerWidth - w) / 2, top: (window.innerHeight - h) / 2, width: w, height: h };
    var closing = false;

    var m = P.motion({ p: 0, dy: 0 });
    m.on(function (v) {
      var p = v.p;
      panel.style.left = P.round(P.lerp(from.left, to.left, p), 2) + 'px';
      panel.style.top = P.round(P.lerp(from.top, to.top, p) + v.dy, 2) + 'px';
      panel.style.width = P.round(P.lerp(from.width, to.width, p), 2) + 'px';
      panel.style.height = P.round(P.lerp(from.height, to.height, p), 2) + 'px';
      panel.style.borderRadius = P.round(P.lerp(3, 22, p), 2) + 'px';
      scrim.style.opacity = String(P.clamp(p, 0, 1) * 0.94);
      var a = app();
      if (a) a.style.transform = 'scale(' + P.round(1 - 0.02 * P.clamp(p, 0, 1), 5) + ')';
    });
    m.set({ p: 0, dy: 0 });
    m.to({ p: 1 }, { damping: 0.8, response: 0.44 });

    function destroy() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      var a = app();
      if (a) a.style.transform = '';
      document.removeEventListener('keydown', onKey);
      var i = openZooms.indexOf(handle);
      if (i >= 0) openZooms.splice(i, 1);
      if (opts.onClose) opts.onClose();
    }
    function close() {
      if (closing) return;
      closing = true;
      m.to({ p: 0, dy: 0 }, { damping: 0.8, response: 0.36, onComplete: destroy });
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    scrim.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    P.drag(panel, {
      axis: 'y', threshold: 6, cursor: 'grabbing',
      onStart: function () { m.stop(); },
      onMove: function (s) { m.set({ p: m.values.p, dy: Math.max(0, s.dy) }); },
      onEnd: function (s) {
        var projected = m.values.dy + P.project(s.vy, 0.998);
        if (projected > 140 || s.vy > 800) close();
        else m.to({ p: 1, dy: 0 }, { damping: 0.85, response: 0.36, velocity: { dy: s.vy } });
      }
    });
    var handle = { el: panel, close: close };
    openZooms.push(handle);
    if (opts.onMount) opts.onMount(panel, close);
    return handle;
  };
  ui.closeZoom = function () { if (openZooms.length) openZooms[openZooms.length - 1].close(); };

  /* ================================================================ 气泡 == */
  var currentPopover = null;
  ui.closePopover = function () { if (currentPopover) { currentPopover(); currentPopover = null; } };
  ui.popover = function (anchor, html, opts) {
    opts = opts || {};
    ui.closePopover();
    var pop = P.h('div', { class: 'popover', role: 'menu', html: html });
    layer().appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var below = r.bottom + 6;
    var flip = (below + h > window.innerHeight - 10) && (r.top - h - 6 > 10);
    pop.style.top = (flip ? r.top - h - 6 : below) + 'px';
    pop.style.left = P.clamp(opts.align === 'right' ? r.right - w : r.left, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
    /* 从触发它的那个角长出来，空间关系才成立 */
    pop.style.transformOrigin = (opts.align === 'right' ? 'right' : 'left') + ' ' + (flip ? 'bottom' : 'top');

    var m = P.motion({ opacity: 0, scale: 0.94, y: flip ? 4 : -4 });
    m.on(function (v) {
      pop.style.opacity = P.round(v.opacity, 3);
      pop.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0) scale(' + P.round(v.scale, 4) + ')';
    });
    m.set({ opacity: 0, scale: 0.94, y: flip ? 4 : -4 });
    m.to({ opacity: 1, scale: 1, y: 0 }, { preset: 'snappy' });

    var onDoc = function (e) { if (!pop.contains(e.target) && e.target !== anchor) ui.closePopover(); };
    var onKey = function (e) { if (e.key === 'Escape') ui.closePopover(); };
    var dispose = function () {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
    function close() {
      if (!currentPopover) return;
      dispose();
      currentPopover = null;
      m.to({ opacity: 0, scale: 0.96, y: flip ? 2 : -2 }, {
        response: 0.16,
        onComplete: function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }
      });
    }
    currentPopover = close;
    window.setTimeout(function () {
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    if (opts.onMount) opts.onMount(pop, close);
    return pop;
  };

  /* ============================================================ 分段控件 == */
  ui.segmented = function (container, config) {
    var items = config.items;
    var thumb = P.h('div', { class: 'segmented-thumb' });
    container.classList.add('segmented');
    container.setAttribute('role', 'tablist');
    container.innerHTML = '';
    container.appendChild(thumb);
    items.forEach(function (item) {
      var btn = P.h('button', {
        class: 'segmented-item', type: 'button', role: 'tab',
        'data-value': item.value,
        'aria-selected': String(item.value === config.value),
        html: (item.icon ? P.icon(item.icon, 14) : '') + '<span>' + P.esc(item.label) + '</span>'
      });
      container.appendChild(btn);
    });
    var buttons = P.$$('.segmented-item', container);
    var anim = P.motion({ x: 0, w: 0 });
    var first = true;
    anim.on(function (v) {
      thumb.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)';
      thumb.style.width = P.round(Math.max(0, v.w), 2) + 'px';
    });
    function indexOf(value) {
      for (var i = 0; i < items.length; i++) if (items[i].value === value) return i;
      return 0;
    }
    function place(index, animate) {
      var btn = buttons[index];
      if (!btn) return;
      var target = { x: btn.offsetLeft, w: btn.offsetWidth };
      if (first || animate === false) { anim.set(target); first = false; }
      /* 阻尼 0.85：指示块落定时有一点点过冲，读起来是「液体的」，不是硬切 */
      else anim.to(target, { damping: 0.85, response: 0.3 });
    }
    function select(value, opts2) {
      opts2 = opts2 || {};
      config.value = value;
      buttons.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.value === value)); });
      place(indexOf(value), opts2.animate);
      if (opts2.silent !== true && config.onChange) config.onChange(value);
    }
    container.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.segmented-item') : null;
      if (btn && container.contains(btn)) select(btn.dataset.value);
    });
    /* 按住横向拖：指示块 1:1 跟着指针走，松手才落定 —— 中间帧就在提示落点 */
    var dragging = false;
    function indexAtX(x) {
      for (var i = 0; i < buttons.length; i++) {
        var r = buttons[i].getBoundingClientRect();
        if (x >= r.left && x <= r.right) return i;
      }
      return -1;
    }
    container.addEventListener('pointerdown', function (e) {
      if (!e.target.closest || !e.target.closest('.segmented-item')) return;
      dragging = true;
      try { container.setPointerCapture(e.pointerId); } catch (_) {}
    });
    container.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var i = indexAtX(e.clientX);
      if (i >= 0) place(i, false);
    });
    container.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      var i = indexAtX(e.clientX);
      select(items[i >= 0 ? i : indexOf(config.value)].value);
    });
    requestAnimationFrame(function () { place(indexOf(config.value), false); });
    return { select: select, place: function () { place(indexOf(config.value), false); } };
  };

  /* ============================================================== 环形进度 == */
  ui.ringHTML = function (value, size, stroke) {
    var s = size || 44, w = stroke || 3.5;
    var r = (s - w) / 2;
    var c = 2 * Math.PI * r;
    return '<div class="ring" style="width:' + s + 'px;height:' + s + 'px">' +
      '<svg width="' + s + '" height="' + s + '">' +
      '<circle class="ring-track" cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" stroke-width="' + w + '"/>' +
      '<circle class="ring-fill" cx="' + s / 2 + '" cy="' + s / 2 + '" r="' + r + '" stroke-width="' + w + '" ' +
      'stroke-dasharray="' + P.round(c, 2) + '" stroke-dashoffset="' + P.round(c * (1 - P.clamp(value, 0, 1)), 2) + '"/>' +
      '</svg></div>';
  };
  ui.setRing = function (el, value) {
    if (!el) return;
    var circle = el.querySelector('.ring-fill');
    if (!circle) return;
    var r = parseFloat(circle.getAttribute('r'));
    var c = 2 * Math.PI * r;
    circle.setAttribute('stroke-dashoffset', String(P.round(c * (1 - P.clamp(value, 0, 1)), 2)));
  };

  /* ============================================================ 按住确认 == */
  /* 按住才提交，提前松手就弹回去；完成时视觉 + 触觉 + 声音同帧触发 */
  ui.holdButton = function (el, opts) {
    opts = opts || {};
    var duration = opts.duration || 900;
    var fill = el.querySelector('.hold-fill');
    var progress = 0, holding = false, last = 0, raf = 0, done = false;
    function paint() {
      if (fill) fill.style.transform = 'scaleX(' + P.round(progress, 4) + ')';
      ui.setRing(el.querySelector('.hold-ring'), progress);
    }
    function loop(now) {
      if (!holding) return;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      progress = P.clamp(progress + dt / (duration / 1000), 0, 1);
      paint();
      if (progress >= 1) { finish(); return; }
      raf = requestAnimationFrame(loop);
    }
    function start(e) {
      if (done || el.hasAttribute('disabled')) return;
      holding = true; last = performance.now();
      el.classList.add('is-holding');
      raf = requestAnimationFrame(loop);
    }
    function finish() {
      holding = false; done = true;
      cancelAnimationFrame(raf);
      progress = 1; paint();
      el.classList.remove('is-holding');
      el.classList.add('done');
      P.tick('commit');
      if (opts.onComplete) opts.onComplete();
    }
    function cancel() {
      if (!holding) return;
      holding = false;
      cancelAnimationFrame(raf);
      var back = new P.Spring(progress, {
        damping: 0.8, response: 0.28, restDelta: 0.002, restSpeed: 0.01,
        onUpdate: function (v) { progress = v; paint(); }
      });
      back.to(0);
      el.classList.remove('is-holding');
      P.tick('cancel');
      if (opts.onCancel) opts.onCancel();
    }
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      start(e);
    });
    /* 拖出按钮范围 = 取消（用坐标判断，不用 pointerleave：指针捕获下边界事件不可靠） */
    el.addEventListener('pointermove', function (e) {
      if (!holding) return;
      var r = el.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) cancel();
    });
    el.addEventListener('pointerup', function (e) {
      var r = el.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) cancel();
      else if (holding && progress < 1) cancel();
    });
    el.addEventListener('pointercancel', cancel);
    paint();
    return { reset: function () { done = false; progress = 0; el.classList.remove('done'); paint(); } };
  };

  /* ============================================================ 滑动决策 == */
  /* 释放速度 → 投影落点 → 决定批准/驳回，而不是「从释放点就近吸附」 */
  ui.swipeRow = function (face, opts) {
    opts = opts || {};
    var container = face.parentElement;
    var approve = container.querySelector('.swipe-action.approve');
    var reject = container.querySelector('.swipe-action.reject');
    var max = 132;
    var x = 0;
    var anim = P.motion({ x: 0 });
    anim.on(function (v) {
      x = v.x;
      face.style.transform = 'translate3d(' + P.round(v.x, 2) + 'px,0,0)';
      var a = P.clamp(v.x / max, 0, 1);
      var r = P.clamp(-v.x / max, 0, 1);
      if (approve) approve.style.opacity = String(a);
      if (reject) reject.style.opacity = String(r);
      container.style.background = a > 0.05 ? 'var(--ok)' : r > 0.05 ? 'var(--danger)' : '';
    });
    anim.set({ x: 0 });
    P.drag(face, {
      axis: 'x',
      threshold: 6,
      canStart: function (e) { return !opts.disabled; },
      onStart: function () { anim.stop(); },
      onMove: function (s) {
        var raw = x + (s.dx - (face.__lastDx || 0));
        face.__lastDx = s.dx;
        var limited = raw > max ? max + P.rubberband(raw - max, 220) : raw < -max ? -max - P.rubberband(-raw - max, 220) : raw;
        anim.set({ x: limited });
      },
      onEnd: function (s) {
        face.__lastDx = 0;
        var projected = x + P.project(s.vx, 0.998);
        if (projected > 104 || s.vx > 760) {
          anim.to({ x: container.offsetWidth }, { velocity: { x: s.vx }, damping: 1, response: 0.3, onComplete: function () { if (opts.onApprove) opts.onApprove(); } });
          P.tick('commit');
        } else if (projected < -104 || s.vx < -760) {
          anim.to({ x: -container.offsetWidth }, { velocity: { x: s.vx }, damping: 1, response: 0.3, onComplete: function () { if (opts.onReject) opts.onReject(); } });
          P.tick('commit');
        } else {
          anim.to({ x: 0 }, { velocity: { x: s.vx }, preset: 'momentum' });
        }
      }
    });
    return { reset: function () { anim.set({ x: 0 }); } };
  };

  /* ================================================================ 分栏 == */
  /* 1:1 跟手 + 抓取偏移 + 越界橡皮筋 + 双击复位 + 键盘可达 */
  ui.splitter = function (el, opts) {
    opts = opts || {};
    var startValue = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', opts.label || '调整栏宽');
    P.drag(el, {
      axis: 'x',
      threshold: 1,
      cursor: 'col-resize',
      onStart: function () { startValue = opts.get(); el.setAttribute('aria-valuenow', String(Math.round(startValue))); },
      onMove: function (s) {
        var raw = startValue + s.dx;              /* 尊重抓取偏移：不做任何吸附 */
        opts.set(opts.limit(raw, s.dx));
      },
      onEnd: function () { if (opts.onEnd) opts.onEnd(); }
    });
    el.addEventListener('dblclick', function () { if (opts.reset) opts.reset(); });
    el.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 48 : 12;
      if (e.key === 'ArrowLeft') { opts.set(opts.limit(opts.get() - step, -1)); e.preventDefault(); }
      if (e.key === 'ArrowRight') { opts.set(opts.limit(opts.get() + step, 1)); e.preventDefault(); }
      if (e.key === 'Home' && opts.reset) { opts.reset(); e.preventDefault(); }
      el.setAttribute('aria-valuenow', String(Math.round(opts.get())));
    });
    return el;
  };

  /* ============================================================ 数字滚动 == */
  ui.counter = function (el, to, opts) {
    opts = opts || {};
    var from = opts.from == null ? 0 : opts.from;
    var suffix = opts.suffix || '';
    var s = new P.Spring(from, {
      damping: 1, response: 0.5, restDelta: 0.01, restSpeed: 0.05,
      onUpdate: function (v) { el.textContent = Math.round(v) + suffix; }
    });
    s.to(to);
    return s;
  };

  /* ============================================================== 命令面板 == */
  ui.palette = function (commands) {
    var wrap = P.h('div', { class: 'palette-wrap' });
    var scrim = P.h('div', { class: 'scrim' });
    var box = P.h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': '快速操作' });
    box.innerHTML =
      '<div class="palette-search">' + P.icon('search', 17) +
      '<input type="text" placeholder="搜索操作、项目或阶段…" aria-label="搜索操作" autocomplete="off"></div>' +
      '<div class="palette-list scroll" role="listbox"></div>' +
      '<div class="palette-foot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> 选择</span>' +
      '<span><span class="kbd">↵</span> 执行</span><span><span class="kbd">esc</span> 关闭</span></div>';
    wrap.appendChild(scrim); wrap.appendChild(box);
    layer().appendChild(wrap);

    var input = box.querySelector('input');
    var list = box.querySelector('.palette-list');
    var filtered = commands.slice();
    var index = 0;

    function renderList() {
      if (!filtered.length) { list.innerHTML = '<div class="palette-empty">没有匹配的操作</div>'; return; }
      list.innerHTML = filtered.map(function (c, i) {
        return '<button class="palette-item" type="button" role="option" data-i="' + i + '" aria-selected="' + (i === index) + '">' +
          P.icon(c.icon || 'grid', 16) + '<span>' + P.esc(c.label) + '</span>' +
          (c.hint ? '<span class="k">' + P.esc(c.hint) + '</span>' : '') + '</button>';
      }).join('');
    }
    function filter(q) {
      var term = q.trim().toLowerCase();
      filtered = commands.filter(function (c) { return !term || c.label.toLowerCase().indexOf(term) >= 0; });
      index = 0;
      renderList();
    }
    function move(delta) {
      if (!filtered.length) return;
      index = (index + delta + filtered.length) % filtered.length;
      renderList();
      var active = list.querySelector('[aria-selected="true"]');
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }
    function run() {
      var c = filtered[index];
      if (!c) return;
      close();
      if (c.run) c.run();
    }
    function close() {
      m.to({ opacity: 0, scale: 0.98, y: -6 }, {
        response: 0.18, onComplete: function () {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          document.removeEventListener('keydown', onKey, true);
          var a = app(); if (a) a.style.transform = '';
        }
      });
      scrim.style.pointerEvents = 'none';
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(); }
    }
    var m = P.motion({ opacity: 0, scale: 0.965, y: -8 });
    m.on(function (v) {
      box.style.opacity = P.round(v.opacity, 3);
      box.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0) scale(' + P.round(v.scale, 4) + ')';
      scrim.style.opacity = P.round(v.opacity * 0.96, 3);
      var a = app(); if (a) a.style.transform = 'scale(' + P.round(1 - 0.012 * v.opacity, 5) + ')';
    });
    m.set({ opacity: 0, scale: 0.965, y: -8 });
    m.to({ opacity: 1, scale: 1, y: 0 }, { preset: 'snappy' });
    input.addEventListener('input', function () { filter(input.value); });
    list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.palette-item') : null;
      if (!btn) return;
      index = Number(btn.dataset.i);
      run();
    });
    scrim.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey, true);
    window.setTimeout(function () { input.focus(); }, 30);
    renderList();
    return { close: close };
  };

  /* ========================================================== 左栏选中块 == */
  /* 选中块自己在导航里找 .is-active，所以路由切换只需要换 class，不用重建 */
  ui.railSelection = function (navEl) {
    var sel = navEl.querySelector('.rail-selection');
    if (!sel) return null;
    var anim = P.motion({ y: 0, h: 34 });
    anim.on(function (v) {
      sel.style.transform = 'translate3d(0,' + P.round(v.y, 2) + 'px,0)';
      sel.style.height = P.round(v.h, 2) + 'px';
    });
    function place(animate) {
      var activeEl = navEl.querySelector('.rail-item.is-active');
      if (!activeEl) return;
      var target = { y: activeEl.offsetTop, h: activeEl.offsetHeight };
      /* 0.85 阻尼：选中块落定时轻微过冲，读起来像液滴 */
      if (animate === false) anim.set(target); else anim.to(target, { damping: 0.85, response: 0.32 });
    }
    place(false);
    return { place: place, el: sel };
  };

  /* ======================================================== 人工审批抽屉 == */
  ui.approvalSheet = function (approval) {
    var list = P.data.project.approvals;
    var item = approval || list[0];
    var handle = ui.sheet({
      side: 'bottom',
      title: '人工确认',
      desc: 'AI 可以提议，但不能替你决定。按住按钮 0.9 秒才会提交。',
      body:
        '<div class="stack">' +
        '<div class="card flat">' +
        '<div class="row between gap3"><div><span class="t-overline">待确认事项</span>' +
        '<div class="t-headline" style="margin-top:4px">' + P.esc(item.label) + '</div></div>' +
        '<span class="badge warn"><i class="dot"></i>等待人工决定</span></div>' +
        '<p class="t-callout t-muted" style="margin-top:8px">' + P.esc(item.note) + '</p>' +
        '</div>' +
        '<div class="card flat"><div class="row between gap3">' +
        '<div><strong class="t-callout">本次将收窄的能力</strong>' +
        '<p class="t-caption t-muted" style="margin-top:2px">project.read · patch.propose（不含 experiment.execute）</p></div>' +
        P.icon('lock', 18) + '</div></div>' +
        '<p class="t-caption t-dim">确认后写入项目约束，并记录 actor = human 与时间戳；不可撤销但可重新发起。</p>' +
        '</div>',
      footer:
        '<button class="btn quiet" data-cancel type="button">稍后再说</button>' +
        '<button class="hold-btn" data-hold type="button">' +
        '<span class="hold-fill"></span>' +
        '<span class="hold-ring" style="width:18px;height:18px;display:grid;place-items:center">' + P.icon('check', 15) + '</span>' +
        '<span data-hold-label>按住确认</span>' +
        '</button>'
    });
    var btn = handle.el.querySelector('[data-hold]');
    var label = handle.el.querySelector('[data-hold-label]');
    ui.holdButton(btn, {
      duration: 900,
      onComplete: function () {
        label.textContent = '已确认';
        ui.toast('已记录人工确认：' + item.label, { icon: 'shield' });
        window.setTimeout(function () { handle.close(); }, 420);
      },
      onCancel: function () { label.textContent = '按住确认'; }
    });
    var cancel = handle.el.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('click', function () { handle.close(); });
    return handle;
  };
})();
