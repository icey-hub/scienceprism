/* ==========================================================================
   glass.js — 液态玻璃与空间感
   1) 高光跟着指针走（镜面反射），玻璃才像一块「材料」而不是一层半透明色；
   2) 一次性扫光（sheen）：材料到位时被光扫过；
   3) 卡片 3D 视差（tvOS 那种）：指针在卡片上的位置决定倾斜与高光位移。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var root = document.documentElement;
  var activeSpec = null;

  function onMove(e) {
    root.style.setProperty('--mx', e.clientX + 'px');
    root.style.setProperty('--my', e.clientY + 'px');
    var el = e.target && e.target.closest ? e.target.closest('.specular') : null;
    if (el !== activeSpec) {
      if (activeSpec) { activeSpec.style.removeProperty('--sx'); activeSpec.style.removeProperty('--sy'); }
      activeSpec = el;
    }
    if (el) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--sx', P.round(e.clientX - r.left, 1) + 'px');
      el.style.setProperty('--sy', P.round(e.clientY - r.top, 1) + 'px');
    }
  }

  P.glass = {
    init: function () {
      document.addEventListener('pointermove', onMove, { passive: true });
    },
    /* 扫光：材料「到位」的那一刻被光扫过 */
    sheen: function (el) {
      if (!el) return;
      el.classList.remove('is-sheen');
      void el.offsetWidth;
      el.classList.add('is-sheen');
    },
    /* 3D 视差：指针在卡片内的位置 → 倾斜 + 高光位移 */
    tilt: function (el, opts) {
      opts = opts || {};
      var max = opts.max || 7;
      var m = P.motion({ rx: 0, ry: 0, z: 0 });
      m.on(function (v) {
        el.style.transform = 'perspective(900px) rotateX(' + P.round(v.rx, 3) + 'deg) rotateY(' +
          P.round(v.ry, 3) + 'deg) translateZ(' + P.round(v.z, 2) + 'px)';
        el.style.setProperty('--tilt-x', P.round(v.ry * 1.6, 1) + 'px');
        el.style.setProperty('--tilt-y', P.round(-v.rx * 1.6, 1) + 'px');
      });
      el.classList.add('tilts');
      el.classList.add('specular');
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var nx = (e.clientX - r.left) / r.width * 2 - 1;
        var ny = (e.clientY - r.top) / r.height * 2 - 1;
        el.style.setProperty('--sx', P.round(e.clientX - r.left, 1) + 'px');
        el.style.setProperty('--sy', P.round(e.clientY - r.top, 1) + 'px');
        m.to({ rx: -ny * max, ry: nx * max, z: opts.lift || 10 }, { damping: 1, response: 0.28 });
      });
      el.addEventListener('pointerleave', function () {
        m.to({ rx: 0, ry: 0, z: 0 }, { damping: 0.75, response: 0.42 });
      });
      return m;
    }
  };
})();
