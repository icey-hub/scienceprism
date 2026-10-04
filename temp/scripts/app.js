/* ==========================================================================
   app.js — 应用骨架与路由
   骨架只做三件事：渲染持久左栏、按 hash 换视图、把全局手势/快捷键接上。
   视图切换用交叉淡入 + 6px 上浮（导航不是空间移动）；只有「卡片 → 目标」
   这种有空间连续性的跳转才用英雄过渡。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var d = P.data;

  var START_NAV = [
    { id: 'start', label: '快速开始', icon: 'clock', hash: '#/' },
    { id: 'projects', label: '所有项目', icon: 'folder', hash: '#/project/p-01' },
    { id: 'motion', label: '特效巡演', icon: 'sparkles', hash: '#/motion' },
    { id: 'design', label: '设计说明', icon: 'sliders', hash: '#/design' }
  ];
  var PROJECT_NAV = [
    { id: 'research', label: '研究', icon: 'flask', hash: '#/research/selection' },
    { id: 'library', label: '资料', icon: 'book', hash: '#/project/p-01?tab=library' },
    { id: 'writing', label: '文稿', icon: 'file-text', hash: '#/editor' },
    { id: 'overview', label: '项目概览', icon: 'grid', hash: '#/project/p-01' },
    { id: 'activity', label: '任务与审批', icon: 'activity', hash: '#/project/p-01?tab=approvals', count: String(d.project.approvals.length) },
    { id: 'motion', label: '特效巡演', icon: 'sparkles', hash: '#/motion' },
    { id: 'design', label: '设计说明', icon: 'sliders', hash: '#/design' }
  ];

  var refs = null;
  var appEl = document.getElementById('app');
  var skipNextHash = false;

  /* ------------------------------------------------------------- 左栏 -- */
  function railHTML(context) {
    var items = context === 'start' ? START_NAV : PROJECT_NAV;
    var sub = context === 'start'
      ? '<div class="rail-project-name">工作区</div><div class="rail-project-sub">' + d.projects.length + ' 个项目 · 1 个进行中</div>'
      : '<div class="rail-project-name">' + P.esc(d.project.name) + '</div>' +
        '<div class="rail-project-sub">' + d.project.progress.percent + '% · ' + d.project.progress.completed + '/' + d.project.progress.total + ' 阶段</div>';
    return '<aside class="rail mat-rail"><div class="rail-inner">' +
      '<a class="rail-brand" href="#/"><span class="brand-mark"></span><span class="brand-name">SciencePrism</span></a>' +
      '<div class="rail-project">' + sub + '</div>' +
      '<nav class="rail-nav" data-rail-nav aria-label="主导航">' +
      '<span class="rail-selection" aria-hidden="true"></span>' +
      items.map(function (it) {
        return '<a class="rail-item" href="' + it.hash + '" data-nav="' + it.id + '">' +
          P.icon(it.icon, 17) + '<span class="rail-label">' + it.label + '</span>' +
          (it.count ? '<span class="rail-item-count badge warn">' + it.count + '</span>' : '') + '</a>';
      }).join('') +
      '</nav>' +
      '<div class="rail-foot">' +
      '<button class="rail-item" type="button" data-act="theme">' + P.icon('moon', 17) +
      '<span class="rail-label">切换外观</span></button>' +
      '<button class="rail-item" type="button" data-act="palette">' + P.icon('search', 17) +
      '<span class="rail-label">快速操作</span><span class="rail-item-count kbd">⌘K</span></button>' +
      '<button class="rail-item" type="button" data-act="rail">' + P.icon('panel-left', 17) +
      '<span class="rail-label">收起侧栏</span></button>' +
      '</div></div></aside>';
  }

  function buildShell(context) {
    appEl.innerHTML = '<div class="shell">' + railHTML(context) +
      '<div class="main"><div class="view-host" id="view"></div></div></div>';
    refs = {
      context: context,
      shell: appEl.querySelector('.shell'),
      nav: appEl.querySelector('[data-rail-nav]'),
      viewHost: appEl.querySelector('#view'),
      railOpen: true,
      selection: null
    };
    refs.selection = P.ui.railSelection(refs.nav);
  }

  function setActiveNav(id) {
    P.$$('.rail-item', refs.nav).forEach(function (el) { el.classList.toggle('is-active', el.dataset.nav === id); });
    if (refs.selection) refs.selection.place(true);
  }

  function setRail(open, animate) {
    refs.railOpen = open;
    var shell = refs.shell;
    var reduced = P.prefs.effective().motion === 'reduced';
    function paint(w) {
      shell.style.setProperty('--rail-w', P.round(w, 1) + 'px');
      if (open && w > 140) shell.classList.remove('rail-thin');
    }
    if (!animate || reduced) {
      shell.classList.toggle('rail-thin', !open);
      shell.style.setProperty('--rail-w', (open ? 244 : 62) + 'px');
    } else {
      if (!open) shell.classList.add('rail-thin');
      var s = new P.Spring(open ? 62 : 244, {
        damping: 1, response: 0.34, restDelta: 0.5, restSpeed: 2, onUpdate: paint
      });
      s.to(open ? 244 : 62);
    }
    window.setTimeout(function () { if (refs.selection) refs.selection.place(false); }, animate ? 380 : 0);
  }

  /* ------------------------------------------------------------- 路由 -- */
  function parseHash() {
    var raw = (location.hash || '#/').slice(1);
    var query = {};
    var qi = raw.indexOf('?');
    if (qi >= 0) {
      raw.slice(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        query[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
      });
      raw = raw.slice(0, qi);
    }
    return { parts: raw.split('/').filter(Boolean), query: query };
  }

  function navForTab(tab) {
    if (tab === 'library' || tab === 'evidence') return 'library';
    if (tab === 'tasks' || tab === 'approvals' || tab === 'runs') return 'activity';
    if (tab === 'settings') return 'settings';
    return 'overview';
  }

  function resolve() {
    var r = parseHash();
    var head = r.parts[0];
    if (head === 'motion') return { view: 'motion', context: 'project', nav: 'motion', title: '特效巡演' };
    if (head === 'design') return { view: 'design', context: 'project', nav: 'design', title: '设计说明' };
    if (head === 'editor') return { view: 'editor', context: 'project', nav: 'writing', title: '论文编辑器' };
    if (head === 'research') return { view: 'research', context: 'project', nav: 'research', stage: r.parts[1] || 'direction', title: '研究工作区' };
    if (head === 'project') return { view: 'cockpit', context: 'project', nav: navForTab(r.query.tab), tab: r.query.tab || 'overview', title: '项目控制室' };
    return { view: 'start', context: 'start', nav: 'start', title: '开始工作区' };
  }

  /* 给新渲染出来的表面贴上液态玻璃高光；卡片加 3D 视差 */
  function decorate(route) {
    P.$$('.panel, .chrome, .tile, .mo-card, .mo-toolbar, .rail').forEach(function (el) {
      el.classList.add('specular');
    });
    if (route.view === 'start') {
      P.$$('.doc-card').forEach(function (el) { P.glass.tilt(el, { max: 6, lift: 8 }); });
    }
  }

  function render() {
    var route = resolve();
    if (!refs || refs.context !== route.context) buildShell(route.context);
    setActiveNav(route.nav);
    var view = P.views[route.view];
    if (!view) return;
    var host = refs.viewHost;
    host.innerHTML = view.render(route);
    if (!P.app.skipEnter) {
      host.classList.remove('view-enter');
      void host.offsetWidth;
      host.classList.add('view-enter');
    } else {
      host.classList.remove('view-enter');
    }
    if (view.mount) view.mount(host, route);
    decorate(route);
    /* 工具条被光扫过一次：材料「到位」的感觉 */
    var chrome = host.querySelector('.chrome');
    if (chrome && !P.app.skipEnter) P.glass.sheen(chrome);
    document.title = 'SciencePrism · ' + route.title;
  }

  function pushHash(hash) {
    try { history.pushState(null, '', hash); }
    catch (err) { skipNextHash = true; location.hash = hash; }
  }

  /* 单一导航入口：可选英雄过渡（几何连续的跳转才用） */
  function go(hash, opts) {
    opts = opts || {};
    if (location.hash === hash) { render(); return; }
    P.ui.closePopover();
    P.ui.closeTopSheet();
    P.ui.closeZoom();
    if (opts.hero && opts.sourceEl && !opts.sourceEl.__heroBusy) {
      opts.sourceEl.__heroBusy = true;
      P.app.skipEnter = true;
      P.hero({
        sourceEl: opts.sourceEl,
        targetSelector: opts.hero,
        swap: function () { pushHash(hash); render(); },
        onDone: function () { P.app.skipEnter = false; }
      });
      return;
    }
    pushHash(hash);
    render();
  }

  P.app = { render: render, rerender: render, resolve: resolve, go: go, pushHash: pushHash, motionNotice: motionNotice };

  /* --------------------------------------------------------- 全局交互 -- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var goEl = t.closest('[data-go]');
    if (goEl) {
      e.preventDefault();
      go(goEl.getAttribute('data-go'), {
        hero: goEl.getAttribute('data-hero'),
        sourceEl: goEl.getAttribute('data-hero') ? (goEl.querySelector('.paper-preview') || goEl) : null
      });
      return;
    }

    if (t.closest('[data-notice-fix]')) {
      P.prefs.set('motion', 'full');
      P.ui.toast('已临时开启完整动效（本次会话有效）', { icon: 'sparkles' });
      var n = document.querySelector('.notice');
      if (n) n.remove();
      delete document.documentElement.dataset.notice;
      return;
    }
    if (t.closest('[data-notice-close]')) {
      var el = document.querySelector('.notice');
      if (el) el.remove();
      delete document.documentElement.dataset.notice;
      return;
    }

    var act = t.closest('[data-act]');
    if (!act) return;
    var name = act.dataset.act;
    if (name === 'theme') {
      P.prefs.set('theme', P.prefs.effective().theme === 'dark' ? 'light' : 'dark');
      P.ui.toast('外观：' + (P.prefs.effective().theme === 'dark' ? '深色' : '浅色'), { icon: 'moon' });
    } else if (name === 'palette') {
      P.ui.palette(d.commands);
    } else if (name === 'rail') {
      setRail(!refs.railOpen, true);
      act.querySelector('.rail-label').textContent = refs.railOpen ? '收起侧栏' : '展开侧栏';
    }
  });

  window.addEventListener('hashchange', function () {
    if (skipNextHash) { skipNextHash = false; return; }
    render();
  });
  window.addEventListener('popstate', function () { render(); });
  window.addEventListener('resize', function () { if (refs && refs.selection) refs.selection.place(false); });

  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      P.ui.palette(d.commands);
      return;
    }
    if (mod && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      P.prefs.set('theme', P.prefs.effective().theme === 'dark' ? 'light' : 'dark');
      return;
    }
    if (mod && e.key >= '1' && e.key <= '6') {
      e.preventDefault();
      var map = { '1': '#/', '2': '#/project/p-01', '3': '#/research/selection', '4': '#/editor', '5': '#/motion', '6': '#/design' };
      go(map[e.key]);
    }
  });

  /* 主题按钮的图标跟着状态走 */
  P.prefs.onChange(function () {
    if (!refs) return;
    var btn = refs.nav.parentElement.querySelector('[data-act="theme"]');
    if (btn) {
      var dark = P.prefs.effective().theme === 'dark';
      btn.innerHTML = P.icon(dark ? 'sun' : 'moon', 17) + '<span class="rail-label">切换外观</span>';
    }
  });

  /* ------------------------------------------------- 为什么「看不到特效」 -- */
  /* 系统开了「减弱动态效果」时，界面会按规范把位移全部降级成淡入 —— 那是正确行为，
     但会让人以为没有动效。这里明说，并给一个「本次会话覆盖」的入口。 */
  function motionNotice() {
    if (!P.prefs.media('motion')) return;
    if (P.prefs.override('motion') === 'full') return;
    if (document.querySelector('.notice')) return;
    var el = P.h('div', {
      class: 'notice', role: 'status',
      html: '<span class="badge warn">' + P.icon('waveform', 12) + '系统偏好</span>' +
        '<div class="grow"><strong>检测到系统开启了「减弱动态效果」</strong>' +
        '<p>按规范，这套界面已把所有位移降级为交叉淡入 —— 所以看起来「没有特效」。' +
        '这是刻意行为，不是坏了。想看完整动效可以临时覆盖。</p></div>' +
        '<button class="btn" type="button" data-notice-fix>临时预览完整动效</button>' +
        '<button class="icon-btn sm" type="button" data-notice-close aria-label="关闭">' + P.icon('x', 15) + '</button>'
    });
    document.body.appendChild(el);
    document.documentElement.dataset.notice = 'on';
  }

  /* --------------------------------------------------------------- 启动 -- */
  P.prefs.init();
  P.glass.init();
  render();
  motionNotice();
  window.setTimeout(function () {
    P.ui.toast('按 ⌘K 打开快速操作；想看动效直接进「特效巡演」', { icon: 'sparkles', duration: 4200 });
  }, 700);
})();
