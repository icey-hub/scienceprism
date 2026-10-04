/* ==========================================================================
   views/start.js — 开始工作区（对应项目里的 LandingPage）
   设计点：入口卡片按压即在 pointer-down 给反馈；文稿卡片用「纸面预览」而不是
   文件图标，让内容自己承担层级。
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var d = P.data;

  function actionCard(item) {
    return '<button class="card action-card" type="button" data-go="' + item.go + '" data-act="' + item.id + '">' +
      '<span class="ac-icon">' + P.icon(item.icon, 19) + '</span>' +
      '<span class="ac-copy"><strong>' + P.esc(item.title) + '</strong><small>' + P.esc(item.sub) + '</small></span>' +
      '<span class="ac-go">' + P.icon('arrow-right', 16) + '</span>' +
      '</button>';
  }

  function docCard(p) {
    return '<button class="card doc-card" type="button" data-go="#/project/' + p.id + '" data-hero=".page-head .ph-copy" data-name="' + P.esc(p.name.toLowerCase()) + '" data-q="' + P.esc((p.question + ' ' + p.tags.join(' ')).toLowerCase()) + '">' +
      '<span class="paper-preview">' +
      '<span class="pp-kicker">研究项目 · ' + p.progress + '%</span>' +
      '<span class="pp-title">' + P.esc(p.name) + '</span>' +
      '<span class="pp-lines"><i></i><i></i><i></i></span>' +
      '<span class="pp-tags">' + p.tags.slice(0, 3).map(function (t) { return '<span class="chip">' + P.esc(t) + '</span>'; }).join('') + '</span>' +
      '</span>' +
      '<span class="doc-meta"><span class="t-caption t-dim">' + P.fmtTime(p.updatedAt) + '</span>' +
      '<span class="t-caption t-dim">' + p.progress + '%</span></span>' +
      '</button>';
  }

  P.views.start = {
    render: function () {
      return '<div class="start-scroll scroll">' +
        '<div class="start-hero">' +
        '<span class="t-overline">Workspace</span>' +
        '<h1 class="t-display" style="margin:6px 0 6px">快速开始</h1>' +
        '<p class="t-body t-muted">继续最近的文稿，或开启一项新的研究。每个阶段都由你确认后才继续。</p>' +

        '<div class="start-actions">' +
        actionCard({ id: 'blank', icon: 'file-text', title: '空白项目', sub: '从研究问题开始', go: '#/project/p-01' }) +
        actionCard({ id: 'template', icon: 'sparkles', title: '论文模板', sub: 'ACL · CVPR · ICML', go: '#/project/p-01' }) +
        actionCard({ id: 'import', icon: 'download', title: '导入', sub: 'Zip · arXiv · LaTeX', go: '#/project/p-01' }) +
        '</div>' +

        '<div class="row between gap4" style="margin-bottom:var(--s4)">' +
        '<div class="row gap2"><span class="t-overline">最近文稿</span>' +
        '<span class="badge" data-count>' + d.projects.length + '</span></div>' +
        '<div class="row gap2" style="max-width:320px;flex:1 1 auto">' +
        '<div class="input row gap2" style="padding:0 10px;height:32px">' +
        P.icon('search', 15) +
        '<input data-search type="search" placeholder="搜索项目、问题或标签" aria-label="搜索项目" ' +
        'style="border:0;background:none;outline:none;flex:1 1 auto;min-width:0;font-size:var(--t-callout-size)">' +
        '</div></div></div>' +

        '<div class="doc-grid" data-grid>' + d.projects.map(docCard).join('') + '</div>' +
        '<div class="empty hidden" data-empty><strong>没有匹配的项目</strong><span>试试项目名称、研究问题或标签。</span></div>' +

        '<p class="t-caption t-dim" style="margin-top:var(--s6)">这是设计 Demo：数据是本地夹具，不会发起任何请求。</p>' +
        '</div></div>';
    },
    mount: function (root) {
      var input = root.querySelector('[data-search]');
      var grid = root.querySelector('[data-grid]');
      var empty = root.querySelector('[data-empty]');
      var count = root.querySelector('[data-count]');
      if (!input) return;
      input.addEventListener('input', function () {
        var term = input.value.trim().toLowerCase();
        var shown = 0;
        P.$$('.doc-card', grid).forEach(function (card) {
          var hay = card.dataset.name + ' ' + card.dataset.q;
          var hit = !term || hay.indexOf(term) >= 0;
          card.classList.toggle('hidden', !hit);
          if (hit) shown++;
        });
        if (count) count.textContent = String(shown);
        empty.classList.toggle('hidden', shown > 0);
      });
    }
  };
})();
