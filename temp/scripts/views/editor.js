/* ==========================================================================
   views/editor.js — 论文编辑器（对应 EditorPage 的三栏工作台）
   设计点：
     · 顶部工具条与左右栏都是玻璃层，正文从它们下面滚过去，不用 1px 分割线
     · 两根分栏条 1:1 跟手、越界橡皮筋、双击复位、方向键可达
     · 「编译」把进度环画在按钮自己身上（因果明确），完成后 PDF 是「材料化」而不是淡入
     · 助手提议的 Patch 必须按住才接受：安全来自成本，不是弹窗
   ========================================================================== */
(function () {
  'use strict';
  var P = window.Prism;
  var d = P.data;

  var TOOLS = [
    { id: 'assistant', label: '助手', icon: 'bot' },
    { id: 'research', label: '研究流程', icon: 'flask' },
    { id: 'files', label: '文件', icon: 'folder' },
    { id: 'review', label: '评审', icon: 'check' }
  ];

  var SIDE_HEADS = {
    assistant: ['助手', 'Patch 需要你确认后才会写盘'],
    research: ['研究流程', '当前阶段：筛选论文'],
    files: ['项目文件', 'paper/ · figures/ · configs/'],
    review: ['写作检查', '主张、引用、术语与编译']
  };

  function chatHTML() {
    return '<div class="chat">' + d.chat.map(function (m, i) {
      var last = i === d.chat.length - 1;
      var inner = P.esc(m.text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
      var card = (m.patch && last) ? patchHTML() : '';
      return '<div class="msg ' + m.role + '">' +
        '<span class="msg-role">' + (m.role === 'user' ? '你' : '助手') + '</span>' +
        '<div class="msg-body">' + inner + '</div>' + card + '</div>';
    }).join('') + '</div>';
  }

  function patchHTML() {
    var p = d.patch;
    return '<div class="patch-card" data-patch style="margin-top:8px">' +
      '<div class="panel-head" style="padding:9px 12px">' +
      '<div class="row gap2">' + P.icon('file-text', 15) + '<span class="t-caption t-mono">' + P.esc(p.file) + '</span></div>' +
      '<span class="badge warn"><i class="dot"></i>待确认</span></div>' +
      '<div class="patch-diff" style="padding:6px 0">' + p.lines.map(function (l) {
        return '<span class="' + l.t + '">' + P.esc(l.v) + '</span>';
      }).join('') + '</div>' +
      '<div class="panel-foot" style="padding:9px 12px">' +
      '<button class="btn sm quiet" type="button" data-patch-reject>拒绝</button>' +
      '<button class="hold-btn" type="button" data-patch-hold style="height:30px;padding:0 12px">' +
      '<span class="hold-fill"></span><span data-patch-label>按住接受</span></button>' +
      '</div></div>';
  }

  function sideBody(tool) {
    if (tool === 'assistant') {
      return chatHTML() +
        '<div class="row gap2" style="margin-top:var(--s4)">' +
        '<input class="input grow" placeholder="描述你要改的地方…" data-chat-input>' +
        '<button class="icon-btn" type="button" data-chat-send aria-label="发送">' + P.icon('arrow-right', 17) + '</button>' +
        '</div>' +
        '<p class="t-caption t-dim" style="margin-top:8px">演示：发送后会有一次流式回复，并附上待确认 Patch。</p>';
    }
    if (tool === 'research') {
      return '<div class="stack sm">' + d.stages.map(function (s) {
        return '<button class="row-item" type="button" data-go="#/research/' + s.id + '">' +
          '<span class="si-index" style="width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--mat-fill);font-size:10px;font-family:var(--font-mono)">' +
          String(s.index).padStart(2, '0') + '</span>' +
          '<div class="grow"><div class="row-title">' + s.label + '</div>' +
          '<div class="row-sub">' + s.desc + '</div></div>' +
          (s.id === 'selection' ? '<span class="badge accent">当前</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    }
    if (tool === 'files') {
      var tree = [
        ['paper/main.tex', 'file', 0], ['paper/sections/method.tex', 'file', 1], ['paper/sections/experiments.tex', 'file', 1],
        ['figures/arch.svg', 'image', 0], ['figures/results.svg', 'image', 0],
        ['configs/filter.yaml', 'file', 0], ['refs.bib', 'file', 0]
      ];
      return '<div class="stack sm">' + tree.map(function (f) {
        var active = f[0] === d.manuscript.file;
        return '<button class="row-item' + (active ? '' : '') + '" type="button" style="padding-left:' + (11 + f[2] * 16) + 'px">' +
          P.icon(f[1], 15) + '<span class="row-title grow t-mono" style="font-size:12.5px">' + f[0] + '</span>' +
          (active ? '<span class="badge accent">已打开</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="stack sm">' +
      [['引用完整性', true, '已识别 42 个引用'], ['术语一致性', false, '1 组变体冲突'],
        ['编译结果', false, '1 次失败：缺少 figures/arch.pdf'], ['AI 检查', true, '7 条检查结果可回查']].map(function (c) {
        return '<div class="row-item">' + P.icon(c[1] ? 'check' : 'x', 15) +
          '<div class="grow"><div class="row-title">' + c[0] + '</div><div class="row-sub">' + c[2] + '</div></div>' +
          '<span class="badge ' + (c[1] ? 'ok' : 'warn') + '">' + (c[1] ? '通过' : '需处理') + '</span></div>';
      }).join('') + '</div>';
  }

  function codeHTML() {
    return '<div class="code-gutter">' + d.manuscript.lines.map(function (l) { return '<div>' + l.n + '</div>'; }).join('') + '</div>' +
      '<div class="code-body">' + d.manuscript.lines.map(function (l) {
        return '<div class="code-line' + (l.n === d.manuscript.hl ? ' hl' : '') + '">' + (l.html || '&nbsp;') + '</div>';
      }).join('') + '</div>';
  }

  function paperHTML() {
    return '<div class="paper-page" data-paper-page>' +
      '<div class="pp-head"><h1>Snapshot-Verified Retrieval for Long-Context Question Answering</h1>' +
      '<div class="pp-authors">Y. Zhang · C. Bell · L. Chen — SciencePrism Lab</div></div>' +
      '<div class="pp-abs"><b>Abstract.</b> We study whether retrieval decisions in long-context pipelines can be made verifiable. ' +
      'We freeze every intermediate retrieval state into an immutable snapshot and gate claims on evidence sufficiency before writing. ' +
      'On SciRet-Long v2.3, citation recall improves from 0.62 to 0.81 (±0.02) while human review cost drops 38%.</div>' +
      '<h2>3. Method</h2>' +
      '<p>We cast retrieval as a sequence of snapshots so that every citation can be traced back to the exact decision that produced it. ' +
      'Each snapshot records the query, the retrieved spans, and the selection rationale, and is never mutated afterwards.</p>' +
      '<div class="pp-eq">L<sub>svr</sub> = Σ<sub>k=1..K</sub> λ<sub>k</sub> ‖ s<sub>k</sub> − ŝ<sub>k</sub> ‖²<sub>2</sub></div>' +
      '<div class="pp-fig"><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
      '<div class="pp-cap">Figure 1. Snapshot-verified retrieval. The gate blocks a claim when evidence sufficiency falls below τ = 0.7.</div>' +
      '<h2>4. Experiments</h2>' +
      '<p>Five seeds across three length regimes (32k / 128k / 512k) with 95% confidence intervals. Baselines: Dense-RAG, ' +
      'Sparse-BM25 with reranking, and long-context prompting.</p>' +
      '</div>';
  }

  P.views.editor = {
    render: function () {
      return '<div class="chrome mat-chrome">' +
        '<div class="chrome-title">' +
        '<button class="btn ghost sm" type="button" data-file-menu>' + P.icon('file-text', 14) + d.manuscript.file + P.icon('chevron-down', 13) + '</button>' +
        '<button class="btn ghost sm" type="button" data-engine-menu>Tectonic' + P.icon('chevron-down', 13) + '</button>' +
        '</div>' +
        '<span class="chrome-spacer"></span>' +
        '<span class="row" data-island-host></span>' +
        '<button class="icon-btn" type="button" data-save aria-label="保存">' + P.icon('save', 17) + '</button>' +
        '<button class="btn primary" type="button" data-compile>' +
        '<span data-compile-label>' + P.icon('play', 14) + '编译</span></button>' +
        '<button class="icon-btn" type="button" data-theme aria-label="切换外观">' + P.icon('moon', 17) + '</button>' +
        '</div>' +

        '<div class="editor" data-editor>' +
        '<div class="ed-toolrail">' + TOOLS.map(function (t, i) {
          return '<button class="rail-item' + (i === 0 ? ' is-active' : '') + '" type="button" data-tool="' + t.id + '" data-tip="' + t.label + '" data-tip-align="right" aria-label="' + t.label + '">' +
            P.icon(t.icon, 18) + '</button>';
        }).join('') + '</div>' +

        '<div class="splitter" data-split="side"></div>' +
        '<aside class="ed-side mat-panel">' +
        '<div class="ed-side-head"><span class="t-overline" data-side-kicker>Assistant</span>' +
        '<div class="t-headline" style="margin-top:2px" data-side-title>' + SIDE_HEADS.assistant[0] + '</div>' +
        '<p class="t-caption t-muted" style="margin-top:2px" data-side-desc>' + SIDE_HEADS.assistant[1] + '</p></div>' +
        '<div class="ed-side-body scroll" data-side-body>' + sideBody('assistant') + '</div>' +
        '</aside>' +

        '<div class="splitter" data-split="center"></div>' +
        '<div class="ed-center">' +
        '<div class="ed-toolbar">' +
        ['Section', 'Subsection', 'Itemize', 'Equation', 'Figure', 'Table', 'Cite', 'Ref', 'Label'].map(function (b, i) {
          return (i === 3 || i === 6 ? '<span class="tb-sep"></span>' : '') +
            '<button class="toolbar-btn" type="button" data-snippet="' + b + '">' + b + '</button>';
        }).join('') +
        '<span class="chrome-spacer"></span>' +
        '<button class="toolbar-btn" type="button" data-font="-1">A−</button>' +
        '<button class="toolbar-btn" type="button" data-font="1">A+</button>' +
        '</div>' +
        '<div class="breadcrumb"><span>可验证的长上下文检索</span><span class="crumb-sep">›</span>' +
        '<span>paper</span><span class="crumb-sep">›</span><span>main.tex</span>' +
        '<span class="crumb-sep">›</span><span class="t-muted">' + d.manuscript.section + '</span></div>' +
        '<div class="code-wrap scroll" data-code>' + codeHTML() + '</div>' +
        '</div>' +

        '<div class="splitter" data-split="pdf"></div>' +
        '<div class="pdf-pane mat-panel">' +
        '<div class="pdf-toolbar">' +
        '<button class="icon-btn sm" type="button" data-zoom="-1" aria-label="缩小">−</button>' +
        '<span class="t-caption t-num t-muted" data-zoom-label style="width:44px;text-align:center">100%</span>' +
        '<button class="icon-btn sm" type="button" data-zoom="1" aria-label="放大">+</button>' +
        '<span class="chrome-spacer"></span>' +
        '<span class="t-caption t-dim">1 / 9</span>' +
        '<button class="icon-btn sm" type="button" data-diff aria-label="查看 Diff">' + P.icon('layers', 16) + '</button>' +
        '</div>' +
        '<div class="pdf-scroll scroll" data-pdf>' + paperHTML() + '</div>' +
        '</div>' +
        '</div>' +

        '<div class="stage-foot">' +
        '<div class="row gap3"><span class="t-caption t-dim" data-status>编译：Tectonic · 引擎未初始化</span></div>' +
        '<div class="row gap2"><span class="badge" data-word-count>1,284 词</span>' +
        '<span class="badge ok"><i class="dot"></i>引用完整</span>' +
        '<span class="badge warn"><i class="dot"></i>术语 1 处冲突</span></div>' +
        '</div>';
    },

    mount: function (root) {
      var editor = root.querySelector('[data-editor]');
      var sideBodyEl = root.querySelector('[data-side-body]');
      var sideW = 330, pdfW = 420;

      /* --- 分栏条：1:1 跟手 + 越界橡皮筋 + 双击复位 --- */
      function band(raw, min, max, dim) {
        if (raw < min) return min - P.rubberband(min - raw, dim);
        if (raw > max) return max + P.rubberband(raw - max, dim);
        return raw;
      }
      P.ui.splitter(root.querySelector('[data-split="side"]'), {
        label: '调整助手栏宽度',
        get: function () { return sideW; },
        limit: function (raw) { return band(raw, 236, 420, 200); },
        set: function (v) { sideW = v; editor.style.setProperty('--side-w', P.round(v, 2) + 'px'); },
        reset: function () { sideW = 330; editor.style.setProperty('--side-w', '330px'); }
      });
      P.ui.splitter(root.querySelector('[data-split="center"]'), {
        label: '调整编辑器宽度',
        get: function () { return pdfW; },
        limit: function (raw) { return band(raw, 300, 660, 240); },
        set: function (v) { pdfW = v; editor.style.setProperty('--pdf-w', P.round(v, 2) + 'px'); },
        reset: function () { pdfW = 420; editor.style.setProperty('--pdf-w', '420px'); }
      });
      editor.style.setProperty('--side-w', sideW + 'px');
      editor.style.setProperty('--pdf-w', pdfW + 'px');

      /* --- 左侧工具切换 --- */
      function selectTool(id) {
        P.$$('[data-tool]', root).forEach(function (b) { b.classList.toggle('is-active', b.dataset.tool === id); });
        root.querySelector('[data-side-kicker]').textContent = { assistant: 'Assistant', research: 'Research', files: 'Files', review: 'Review' }[id];
        root.querySelector('[data-side-title]').textContent = SIDE_HEADS[id][0];
        root.querySelector('[data-side-desc]').textContent = SIDE_HEADS[id][1];
        sideBodyEl.innerHTML = sideBody(id);
        sideBodyEl.classList.remove('view-enter'); void sideBodyEl.offsetWidth; sideBodyEl.classList.add('view-enter');
        mountSide(id);
      }
      P.on(root, '[data-tool]', 'click', function (e, el) { selectTool(el.dataset.tool); });

      /* --- 助手：发送 + 流式回复 + Patch --- */
      function mountSide(id) {
        if (id !== 'assistant') return;
        var input = sideBodyEl.querySelector('[data-chat-input]');
        var send = sideBodyEl.querySelector('[data-chat-send]');
        if (!input) return;
        function submit() {
          var text = input.value.trim();
          if (!text) return;
          input.value = '';
          var chat = sideBodyEl.querySelector('.chat');
          chat.insertAdjacentHTML('beforeend',
            '<div class="msg user"><span class="msg-role">你</span><div class="msg-body">' + P.esc(text) + '</div></div>');
          var pending = P.h('div', { class: 'msg assistant', html: '<span class="msg-role">助手</span><div class="msg-body" data-stream><span class="pulse-dot">正在读取项目上下文…</span></div>' });
          chat.appendChild(pending);
          pending.scrollIntoView({ block: 'end', behavior: 'smooth' });
          var reply = '已定位到 paper/sections/method.tex。我建议把 τ 的取值写成超参并补一句来源，这样审稿人能复现这个门限。需要你确认这次修改。';
          window.setTimeout(function () {
            var target = pending.querySelector('[data-stream]');
            var i = 0;
            var timer = window.setInterval(function () {
              i += 2;
              target.textContent = reply.slice(0, i);
              if (i >= reply.length) {
                window.clearInterval(timer);
                pending.insertAdjacentHTML('beforeend', patchHTML());
                mountPatch();
              }
            }, 22);
          }, 500);
        }
        send.addEventListener('click', submit);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        mountPatch();
      }

      function mountPatch() {
        var card = sideBodyEl.querySelector('[data-patch]');
        if (!card || card.__wired) return;
        card.__wired = true;
        var label = card.querySelector('[data-patch-label]');
        P.ui.holdButton(card.querySelector('[data-patch-hold]'), {
          duration: 800,
          onComplete: function () {
            label.textContent = '已接受';
            P.ui.toast('已应用 Patch：' + d.patch.file + '（可撤销）', { icon: 'check' });
            card.querySelector('.badge').className = 'badge ok';
            card.querySelector('.badge').innerHTML = '<i class="dot"></i>已应用';
          },
          onCancel: function () { label.textContent = '按住接受'; }
        });
        card.querySelector('[data-patch-reject]').addEventListener('click', function () {
          card.style.transition = 'opacity 180ms ease';
          card.style.opacity = '0';
          window.setTimeout(function () { card.innerHTML = '<div class="panel-body t-caption t-dim">已拒绝这次修改，AI 不会写入任何文件。</div>'; card.style.opacity = '1'; }, 200);
          P.ui.toast('已拒绝 Patch，未写入任何文件', { icon: 'x' });
        });
      }

      /* --- 编译：动态岛把进度环长在自己身上，完成后材料化 PDF --- */
      var island = P.island(root.querySelector('[data-island-host]'), { from: 0 });
      island.set('<i class="dot"></i>Harness 已连接', { instant: true });
      var compileBtn = root.querySelector('[data-compile]');
      var compileLabel = root.querySelector('[data-compile-label]');
      var status = root.querySelector('[data-status]');
      var compiling = false;
      compileBtn.addEventListener('click', function () {
        if (compiling) return;
        compiling = true;
        compileBtn.setAttribute('disabled', '');
        compileLabel.innerHTML = P.ui.ringHTML(0, 16, 2.5) + '<span>编译中</span>';
        var ring = compileLabel.querySelector('.ring');
        var paper = root.querySelector('[data-paper-page]');
        paper.classList.add('is-building');
        island.set(P.ui.ringHTML(0, 14, 2.5) + '<span data-pct>编译中 · 0%</span>', { tone: 'busy' });
        var islandRing = island.el.querySelector('.ring');
        var islandPct = island.el.querySelector('[data-pct]');
        var start = performance.now();
        (function tick(now) {
          var t = P.clamp((now - start) / 1400, 0, 1);
          P.ui.setRing(ring, t);
          P.ui.setRing(islandRing, t);
          if (islandPct) islandPct.textContent = '编译中 · ' + Math.round(t * 100) + '%';
          if (t < 1) { requestAnimationFrame(tick); return; }
          compiling = false;
          compileBtn.removeAttribute('disabled');
          compileLabel.innerHTML = P.icon('play', 14) + '重新编译';
          status.textContent = '编译：Tectonic · 成功（12.4 秒）';
          paper.classList.remove('is-building');
          var m = P.motion({ opacity: 0.4, scale: 0.985 });
          m.on(function (v) { paper.style.opacity = P.round(v.opacity, 3); paper.style.transform = 'scale(' + P.round(v.scale, 4) + ')'; });
          m.set({ opacity: 0.4, scale: 0.985 });
          m.to({ opacity: 1, scale: 1 }, { preset: 'snappy' });
          island.set(P.icon('check', 13) + '编译成功 · 12.4s', { tone: 'ok', sheen: true });
          window.setTimeout(function () { island.set('<i class="dot"></i>Harness 已连接'); }, 4200);
          P.ui.toast('编译成功：main.pdf 已更新（9 页）', { icon: 'check' });
        })(performance.now());
      });

      /* --- 点 PDF 页面：从小图长成一块大面板（关闭时沿原路缩回） --- */
      var pageEl = root.querySelector('[data-paper-page]');
      if (pageEl) {
        pageEl.addEventListener('click', function () {
          P.ui.zoom(pageEl, {
            label: '论文预览',
            html: paperHTML() +
              '<div class="row between gap3" style="position:absolute;left:0;right:0;bottom:0;padding:10px 14px;' +
              'background:linear-gradient(transparent, rgba(0,0,0,.06))">' +
              '<span class="t-caption t-dim">拖动面板或按 Esc 关闭</span>' +
              '<span class="badge accent">1 / 9</span></div>'
          });
        });
      }

      /* --- 保存指示：动态岛把状态「长」出来，而不是每次操作都弹 toast --- */
      root.querySelector('[data-save]').addEventListener('click', function () {
        island.set('<span class="spin">◌</span>保存中…', { tone: 'busy' });
        window.setTimeout(function () {
          island.set(P.icon('check', 13) + '已保存', { tone: 'ok' });
          P.ui.toast('已保存 paper/main.tex');
          window.setTimeout(function () { island.set('<i class="dot"></i>Harness 已连接'); }, 3000);
        }, 620);
      });
      P.$$('[data-snippet]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          island.set(P.icon('plus', 13) + '已插入 ' + b.dataset.snippet);
          P.ui.toast('已插入片段：' + b.dataset.snippet, { icon: 'plus' });
        });
      });
      P.$$('[data-font]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          var body = root.querySelector('.code-body');
          var size = parseFloat(body.style.fontSize || '12.5');
          body.style.fontSize = P.clamp(size + Number(b.dataset.font), 10, 18) + 'px';
          root.querySelector('.code-gutter').style.fontSize = body.style.fontSize;
        });
      });

      /* --- PDF 缩放 --- */
      var zoom = 100;
      function applyZoom() {
        root.querySelector('[data-zoom-label]').textContent = zoom + '%';
        var page = root.querySelector('[data-paper-page]');
        page.style.transform = 'scale(' + (zoom / 100) + ')';
        page.style.transformOrigin = 'top center';
      }
      P.$$('[data-zoom]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          zoom = P.clamp(zoom + Number(b.dataset.zoom) * 10, 60, 180);
          applyZoom();
        });
      });

      /* --- 下拉菜单：从触发元素长出来 --- */
      root.querySelector('[data-file-menu]').addEventListener('click', function (e) {
        P.ui.popover(e.currentTarget, ['paper/main.tex', 'paper/sections/method.tex', 'refs.bib', 'figures/arch.svg'].map(function (f) {
          return '<button class="popover-item" type="button" data-go="' + (f === 'paper/main.tex' ? '#/editor' : '#/editor') + '">' +
            P.icon('file-text', 15) + '<span>' + f + '</span></button>';
        }).join(''), { onMount: function (pop, close) { pop.addEventListener('click', close); } });
      });
      root.querySelector('[data-engine-menu]').addEventListener('click', function (e) {
        P.ui.popover(e.currentTarget, ['Tectonic', 'pdfLaTeX', 'XeLaTeX', 'LuaLaTeX'].map(function (n, i) {
          return '<button class="popover-item" type="button"><span>' + n + '</span>' + (i === 0 ? '<span class="k">当前</span>' : '') + '</button>';
        }).join(''), { onMount: function (pop, close) { pop.addEventListener('click', function () { close(); P.ui.toast('编译引擎：' + 'Tectonic'); }); } });
      });
      root.querySelector('[data-theme]').addEventListener('click', function () {
        P.prefs.set('theme', P.prefs.effective().theme === 'dark' ? 'light' : 'dark');
      });
      root.querySelector('[data-diff]').addEventListener('click', function () {
        P.ui.sheet({
          side: 'bottom',
          title: '待确认 Diff',
          desc: 'Harness 提议修改 2 个文件。接受后才会写入项目。',
          body: '<div class="patch-card" style="box-shadow:none;border:0.5px solid var(--line)">' +
            '<div class="panel-head" style="padding:9px 12px"><span class="t-caption t-mono">' + d.patch.file + '</span></div>' +
            '<div class="patch-diff" style="padding:6px 0">' + d.patch.lines.map(function (l) {
              return '<span class="' + l.t + '">' + P.esc(l.v) + '</span>';
            }).join('') + '</div></div>',
          footer: '<button class="btn quiet" type="button" data-close>关闭</button>' +
            '<button class="btn primary" type="button" data-go="#/project/p-01?tab=approvals">去审批收件箱</button>',
          onMount: function (panel, close) {
            var c = panel.querySelector('[data-close]');
            if (c) c.addEventListener('click', close);
          }
        });
      });

      mountSide('assistant');
      applyZoom();
    }
  };
})();
