#!/usr/bin/env node
/**
 * check-figure-style.mjs — 论文插图风格门禁（零依赖，纯 Node）。
 *
 * 校验对象：SVG 插图。规则来自 pic/01-figure-style-guide.md 与
 * pic/03-palette-and-typography.md 的硬性条目。
 *
 * 用法:
 *   node pic/check/check-figure-style.mjs <a.svg> [b.svg ...]
 *   node pic/check/check-figure-style.mjs --json <a.svg>
 *
 * 退出码: 0 = 全部通过；1 = 有不合格项；2 = 用法/文件类型错误
 *
 * 设计原则：每条规则都对应一个可复现的解析，不做模糊判断。
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('用法: node pic/check/check-figure-style.mjs [--json] <figure.svg> [...]');
  process.exit(2);
}

// ---- 阈值（与规范文档一一对应）----
const MIN_FONT_PT = 7;        // 01 §规则15：投稿 PDF 实际渲染 ≥7pt
const MIN_STROKE = 0.35;      // 03 §1.3：网格线下限
const MAX_STROKE = 2.0;       // 03 §1.3：强调边框上限
const MAX_CATEGORICAL = 8;    // 03 §1.2：分类色 ≤8
const FORBIDDEN_GRADIENT = /(jet|rainbow|hsv|turbo)/i; // 01 §规则12
const GENERIC_FALLBACK = /(sans-serif|serif|monospace|cursive|fantasy|system-ui)/i;

/** 解析 #rgb / #rrggbb / rgb() 为 [r,g,b] */
function parseColor(c) {
  c = c.trim().toLowerCase();
  let m = c.match(/^#([0-9a-f]{3})$/);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = c.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m) return [+m[1], +m[2], +m[3]].map((v) => Math.round(v));
  return null;
}

/** 灰色/黑/白视为中性色，不占分类色额度 */
function isNeutral([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx - mn <= 24; // 通道极差小 → 灰阶
}

// ============================================================================
//  重叠/遮挡检测
//  为什么需要：字号、线宽、配色都合规的图，仍然可能"元素压在一起"。
//  这类问题只能靠渲染后肉眼看，极易漏 —— 所以在这里做成可执行检查。
// ============================================================================

/** 估算单个字符宽度（em） */
function charWidth(ch, bold) {
  const k = bold ? 1.06 : 1;
  if (/[A-Z]/.test(ch)) return 0.68 * k;
  if (/[0-9]/.test(ch)) return 0.556 * k;
  if (ch === ' ') return 0.278;
  if (/[a-z]/.test(ch)) return 0.53 * k;
  if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) return 1.0; // CJK 全角
  if (/[.,:;!'|]/.test(ch)) return 0.28;
  return 0.5 * k;
}

/** 解析 font-size 为「用户单位」（pt → ×4/3） */
function fontSizeUnits(raw) {
  const m = String(raw || '8').match(/([0-9.]+)\s*(pt|px)?/);
  if (!m) return 10.67;
  const v = parseFloat(m[1]);
  return m[2] === 'pt' || !m[2] ? v * 4 / 3 : v;
}

/** 收集所有 <text> 的包围盒（含 rotate 变换） */
function textBoxes(svg) {
  const boxes = [];
  // 必须继承父 <g> 的属性：图里刻度标签常写成
  //   <g font-size="7pt" text-anchor="end"><text x=.. y=..>10¹</text></g>
  // 只看 <text> 自身属性会拿到错误字号与锚点，产生大量假重叠（踩过）。
  const stack = [];
  const tagRe = /<(\/?)g\b([^>]*?)(\/?)>|<text\b([^>]*?)>|<\/text>/g;
  let m;
  while ((m = tagRe.exec(svg)) !== null) {
    if (m[0] === '</text>') continue;
    if (m[4] === undefined) {                 // <g> / </g>
      if (m[1] === '/') { stack.pop(); continue; }
      if (m[3] === '/') continue;             // 自闭合 <g/>
      stack.push(m[2] || '');
      continue;
    }
    const attrs = m[4] || '';
    const end = svg.indexOf('</text>', m.index);
    if (end < 0) continue;
    const raw = svg.slice(m.index + m[0].length, end)
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!raw) continue;
    const merged = {};
    for (const g of stack) for (const a of g.matchAll(/([\w:-]+)="([^"]*)"/g)) merged[a[1]] = a[2];
    for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) merged[a[1]] = a[2];
    const x = parseFloat(merged.x ?? '0');
    const y = parseFloat(merged.y ?? '0');
    const fs = fontSizeUnits(merged['font-size']);
    const bold = /bold|[6-9]00/.test(merged['font-weight'] || '');
    const anchor = merged['text-anchor'] || 'start';
    const w = [...raw].reduce((a, ch) => a + charWidth(ch, bold), 0) * fs;
    const hAsc = fs * 0.80;
    const hDesc = fs * 0.24;

    let x0, x1, y0, y1;
    if (anchor === 'middle') { x0 = x - w / 2; x1 = x + w / 2; }
    else if (anchor === 'end') { x0 = x - w; x1 = x; }
    else { x0 = x; x1 = x + w; }
    y0 = y - hAsc; y1 = y + hDesc;

    // rotate(a cx cy) → 绕点旋转包围盒
    const rot = (merged.transform || '').match(/rotate\(\s*([-\d.]+)(?:\s+([-\d.]+)\s+([-\d.]+))?\s*\)/);
    if (rot) {
      const a = parseFloat(rot[1]) * Math.PI / 180;
      const cx = rot[2] !== undefined ? parseFloat(rot[2]) : x;
      const cy = rot[3] !== undefined ? parseFloat(rot[3]) : y;
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([px, py]) => {
        const dx = px - cx, dy = py - cy;
        return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
      });
      x0 = Math.min(...pts.map((p) => p[0])); x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1])); y1 = Math.max(...pts.map((p) => p[1]));
    }
    boxes.push({ text: raw.slice(0, 34), x0, y0, x1, y1, fs });
  }
  return boxes;
}

/** 线段集合（用于「文字压线」检测） */
function lineSegments(svg) {
  const segs = [];
  for (const m of svg.matchAll(/<line\b([^>]*)>/g)) {
    const a = m[1];
    const g = (k) => { const x = a.match(new RegExp(`\\b${k}="([-\\d.]+)"`)); return x ? parseFloat(x[1]) : null; };
    const [x1, y1, x2, y2] = [g('x1'), g('y1'), g('x2'), g('y2')];
    if ([x1, y1, x2, y2].every((v) => v !== null)) segs.push({ x1, y1, x2, y2 });
  }
  return segs;
}

/** 线段是否穿过矩形内部（把线当细长矩形求交，用参数化裁剪） */
function segHitsRect(s, r, tol = 1) {
  const rx0 = r.x0 - tol, rx1 = r.x1 + tol, ry0 = r.y0 - tol, ry1 = r.y1 + tol;
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, s.x1 - rx0) && clip(dx, rx1 - s.x1) && clip(-dy, s.y1 - ry0) && clip(dy, ry1 - s.y1);
}

const rectArea = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};

/** 线段落在矩形内部那一段的**长度**（Liang-Barsky 裁剪） */
function segInsideLen(s, r) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!(clip(-dx, s.x1 - r.x0) && clip(dx, r.x1 - s.x1) && clip(-dy, s.y1 - r.y0) && clip(dy, r.y1 - s.y1))) return 0;
  return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
}

/**
 * 按**文档顺序**收集图形元素 —— 顺序即 z 序（后画的在上层）。
 * 只取 rect / circle / polygon / line：path 多为曲线与图标，外接矩形误差太大，不参与几何遮挡判定。
 */
function elementsInOrder(svg) {
  const els = [];
  const re = /<(rect|circle|polygon|line)\b([^>]*?)\/?>/g;
  let m, i = 0;
  while ((m = re.exec(svg)) !== null) {
    const tag = m[1], a = m[2];
    const g = (k, d = null) => { const x = a.match(new RegExp(`\\b${k}="([-\\d.]+)"`)); return x ? parseFloat(x[1]) : d; };
    const fill = (a.match(/\bfill="([^"]*)"/) || [, null])[1];
    const stroke = (a.match(/\bstroke="([^"]*)"/) || [, null])[1];
    if (tag === 'rect') {
      const x = g('x', 0), y = g('y', 0), w = g('width', 0), h = g('height', 0);
      els.push({ i: i++, tag, x0: x, y0: y, x1: x + w, y1: y + h, fill, stroke });
    } else if (tag === 'circle') {
      const cx = g('cx', 0), cy = g('cy', 0), r = g('r', 0);
      els.push({ i: i++, tag, x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, fill, stroke });
    } else if (tag === 'polygon') {
      const pts = ((a.match(/\bpoints="([^"]*)"/) || [, ''])[1] || '').trim().split(/\s+/)
        .map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (!pts.length) continue;
      els.push({
        i: i++, tag, pts, fill, stroke,
        x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])),
        x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])),
      });
    } else {
      els.push({ i: i++, tag, x1: g('x1', 0), y1: g('y1', 0), x2: g('x2', 0), y2: g('y2', 0), stroke, fill: null });
    }
  }
  return els;
}

/** 矩形向内收缩（比例） */
function shrinkRect(r, rx, ry) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  return { x0: r.x0 + w * rx, x1: r.x1 - w * rx, y0: r.y0 + h * ry, y1: r.y1 - h * ry };
}

/** 重叠检测主函数 */
function findOverlaps(svg, canvasW, canvasH) {
  const errors = [];
  // 关键：先剥掉 XML 注释与 <defs>。
  // 生成器顶部注释里常写 `<text>` / `<path>` 等字样，不剥会把注释当正文解析出幽灵文字（踩过）。
  const clean = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<defs[\s\S]*?<\/defs>/g, '');
  const boxes = textBoxes(clean);
  const segs = lineSegments(clean);

  // 8.1 文字之间互相遮挡
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ov = rectArea(a, b);
      if (ov <= 0) continue;
      const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
      const ratio = ov / small;
      // 只报「实质性遮挡」：重叠超过较小文字面积的 30%
      if (ratio > 0.30) {
        errors.push(`文字重叠 ${(ratio * 100).toFixed(0)}%：「${a.text}」×「${b.text}」`);
      }
    }
  }

  // 8.2 文字压线（对文字盒内缩后再判，避免「刻度标签蹭到 1px 网格线」这类不可见擦碰误报）
  const inset = (b, rx, ry) => ({
    x0: b.x0 + (b.x1 - b.x0) * rx, x1: b.x1 - (b.x1 - b.x0) * rx,
    y0: b.y0 + (b.y1 - b.y0) * ry, y1: b.y1 - (b.y1 - b.y0) * ry,
  });
  for (const b of boxes) {
    const core = inset(b, 0.12, 0.22);
    if (core.x1 <= core.x0 || core.y1 <= core.y0) continue;
    for (const s of segs) {
      if (segHitsRect(s, core, 0)) {
        errors.push(`文字压线：「${b.text}」被直线 (${s.x1.toFixed(0)},${s.y1.toFixed(0)})→(${s.x2.toFixed(0)},${s.y2.toFixed(0)}) 穿过`);
        break;
      }
    }
  }

  // 8.3 越出画布
  if (canvasW && canvasH) {
    for (const b of boxes) {
      if (b.x0 < -2 || b.y0 < -2 || b.x1 > canvasW + 2 || b.y1 > canvasH + 2) {
        errors.push(`文字越界：「${b.text}」bbox(${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}) 超出画布 ${canvasW}×${canvasH}`);
      }
    }
  }

  // 8.4 线条穿入图形（线画在图形上层，且**从外部扎进**实心图形超过阈值）
  //     两条排除规则，缺一不可（都是踩出来的）：
  //       ① 只查「画在图形之后」的线 —— 后画的才在上层，才可能挡住图形；
  //       ② **两端都在图形内**的线不算缺陷 —— 那是图形自身的内容（如卡片里的节点连线）；
  //          只有「从外部扎进来」或「横穿而过」才算。
  //       ③ 跳过 fill="none" 的图形 —— 那是面板框，框内画网格线是正常的。
  const els = elementsInOrder(clean);
  const canvasArea = (canvasW || 1) * (canvasH || 1);
  const PENETRATION = Math.max(4, (canvasW || 1000) * 0.006); // 穿透阈值：随画布缩放

  const inside = (p, r, m) => p[0] >= r.x0 - m && p[0] <= r.x1 + m && p[1] >= r.y0 - m && p[1] <= r.y1 + m;

  for (const ln of els) {
    if (ln.tag !== 'line') continue;
    const A = [ln.x1, ln.y1], B = [ln.x2, ln.y2];
    for (const sh of els) {
      if (sh.i >= ln.i) continue;                       // 图形必须在线的下层
      if (!sh.fill || sh.fill === 'none') continue;     // 只看实心图形
      const w = sh.x1 - sh.x0, h = sh.y1 - sh.y0;
      const area = w * h;
      if (area <= 0 || area > canvasArea * 0.5) continue;      // 跳过整图背景
      // 跳过箭头本身：小多边形几乎都是 arrowhead，线终点落在它上面是正常的
      if (sh.tag === 'polygon' && Math.min(w, h) < (canvasW || 1000) * 0.03) continue;
      const m = Math.max(2, w * 0.03);
      const aIn = inside(A, sh, m), bIn = inside(B, sh, m);
      if (aIn && bIn) continue;                         // 图形自身的内容（如卡片里的节点连线）
      // 多边形用外接矩形近似，多收一点，压掉误报
      const k = sh.tag === 'polygon' ? 0.28 : 0.06;
      const inner = shrinkRect(sh, k, k);
      if (inner.x1 <= inner.x0 || inner.y1 <= inner.y0) continue;
      const len = segInsideLen(ln, inner);
      if (len <= PENETRATION) continue;
      // 只是从「大容器」边缘擦过（一端在容器内）不算缺陷；扎进「小图形」才算
      if ((aIn || bIn) && len <= Math.min(w, h) * 0.25) continue;
      errors.push(
        `线条穿入图形 ${len.toFixed(0)} 单位：线 (${ln.x1.toFixed(0)},${ln.y1.toFixed(0)})→(${ln.x2.toFixed(0)},${ln.y2.toFixed(0)}) ` +
        `扎进 ${sh.tag}(${sh.x0.toFixed(0)},${sh.y0.toFixed(0)},${sh.x1.toFixed(0)},${sh.y1.toFixed(0)})`,
      );
    }
  }

  // 8.5 图形被完全遮挡（后画的实心图形把先画的整个盖住 → 等于白画）
  //     只查 rect / polygon 这类「结构块」；circle 是数据标记，均值点压住散点是正常的。
  for (const under of els) {
    if (under.tag === 'line' || under.tag === 'circle' || !under.fill || under.fill === 'none') continue;
    const ua = (under.x1 - under.x0) * (under.y1 - under.y0);
    if (ua <= 0 || ua > canvasArea * 0.5) continue;
    for (const over of els) {
      if (over.i <= under.i || over.tag === 'line' || over.tag === 'circle' || !over.fill || over.fill === 'none') continue;
      const oa = (over.x1 - over.x0) * (over.y1 - over.y0);
      if (oa < ua * 0.98) continue;                     // 覆盖者要足够大
      if (over.x0 <= under.x0 + 1 && over.y0 <= under.y0 + 1 &&
          over.x1 >= under.x1 - 1 && over.y1 >= under.y1 - 1) {
        errors.push(
          `图形被完全遮挡：${over.tag}(${over.x0.toFixed(0)},${over.y0.toFixed(0)},${over.x1.toFixed(0)},${over.y1.toFixed(0)}) ` +
          `把先画的 ${under.tag}(${under.x0.toFixed(0)},${under.y0.toFixed(0)},${under.x1.toFixed(0)},${under.y1.toFixed(0)}) 整个盖住了`,
        );
        break;
      }
    }
  }

  // 8.6 图形 × 图形：**小图形**大面积重合（≈ 同一位置画了两遍，典型是两个箭头叠在一起）
  //     判据用「小」而不是「重合比例」，因为两种正常画法的重合比例都很高：
  //       · 卡片堆叠（故意错位）→ 相邻卡重合 ~60%，但卡片尺寸大（≈116 单位）
  //       · 容器包住表格（正常嵌套）→ 重合 100%，但容器尺寸大（≈220 单位）
  //     而重复绘制的箭头只有 ~16–21 单位。所以按尺寸卡，不按比例卡。
  const SMALL = (canvasW || 1000) * 0.06;
  for (let x = 0; x < els.length; x++) {
    for (let y = x + 1; y < els.length; y++) {
      const a = els[x], b = els[y];
      if (a.tag === 'line' || b.tag === 'line') continue;
      if (a.tag === 'circle' || b.tag === 'circle') continue;   // circle 是数据标记
      if (!a.fill || a.fill === 'none' || !b.fill || b.fill === 'none') continue;
      const aW = a.x1 - a.x0, aH = a.y1 - a.y0, bW = b.x1 - b.x0, bH = b.y1 - b.y0;
      if (Math.min(aW, aH) >= SMALL || Math.min(bW, bH) >= SMALL) continue;  // 不是小图形
      const aa = aW * aH, ab = bW * bH;
      if (aa <= 0 || ab <= 0) continue;
      const o = rectArea(a, b);
      if (o <= 0) continue;
      const ratio = o / Math.min(aa, ab);
      if (ratio > 0.30) {
        errors.push(
          `小图形大面积重合 ${(ratio * 100).toFixed(0)}%：${a.tag}(${a.x0.toFixed(0)},${a.y0.toFixed(0)},${a.x1.toFixed(0)},${a.y1.toFixed(0)}) ${a.fill} ` +
          `× ${b.tag}(${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}) ${b.fill}`,
        );
      }
    }
  }

  return errors;
}

function check(file) {
  const errors = [];
  const warnings = [];
  const ext = path.extname(file).toLowerCase();

  if (ext !== '.svg') {
    return { file, errors: [`仅支持 SVG（收到 ${ext || '无扩展名'}）；位图请人工核对 DPI 与尺寸`], warnings, fatal: true };
  }
  if (!fs.existsSync(file)) {
    return { file, errors: ['文件不存在'], warnings, fatal: true };
  }

  const s = fs.readFileSync(file, 'utf8');
  if (!/<svg[\s>]/i.test(s)) {
    return { file, errors: ['不是合法的 SVG（缺少 <svg> 根元素）'], warnings, fatal: true };
  }

  // ---- 规则 0：XML 合法性（不合格 → 浏览器只会渲染错误页，图等于没画）----
  // 注释内不解析实体引用，裸 & 合法，所以先剥注释再查。
  const noComments = s.replace(/<!--[\s\S]*?-->/g, '');
  const badEntity = noComments.match(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/);
  if (badEntity) {
    errors.push(`XML 非法：出现未转义的 "&"（…${noComments.slice(Math.max(0, badEntity.index - 20), badEntity.index + 20).replace(/\n/g, ' ')}…）；该图无法被浏览器解析`);
  }

  // ---- 规则 1：字号下限 ----
  const fontSizes = [...s.matchAll(/font-size\s*[:=]\s*["']?\s*([0-9.]+)\s*(pt|px|em|rem|%)?/gi)]
    .map((m) => ({ value: parseFloat(m[1]), unit: (m[2] || 'px').toLowerCase() }));
  const ptSizes = fontSizes.filter((f) => f.unit === 'pt');
  const pxSizes = fontSizes.filter((f) => f.unit === 'px');
  const relSizes = fontSizes.filter((f) => ['em', 'rem', '%'].includes(f.unit));

  const tooSmallPt = ptSizes.filter((f) => f.value < MIN_FONT_PT);
  const tooSmallPx = pxSizes.filter((f) => f.value < MIN_FONT_PT * (96 / 72)); // 7pt ≈ 9.33px
  if (tooSmallPt.length) {
    errors.push(`字号低于 ${MIN_FONT_PT}pt：${[...new Set(tooSmallPt.map((f) => f.value + 'pt'))].join(', ')}`);
  }
  if (tooSmallPx.length) {
    errors.push(`字号低于 ${MIN_FONT_PT}pt(≈${(MIN_FONT_PT * 96 / 72).toFixed(1)}px)：${[...new Set(tooSmallPx.map((f) => f.value + 'px'))].join(', ')}`);
  }
  if (!ptSizes.length && !pxSizes.length) {
    warnings.push(relSizes.length
      ? `仅有相对字号（${[...new Set(relSizes.map((f) => f.value + f.unit))].join(', ')}），无法验证绝对下限`
      : '未找到 font-size，无法验证字号下限');
  }

  // ---- 规则 2：线宽区间 ----
  const strokes = [...s.matchAll(/stroke-width\s*[:=]\s*["']?\s*([0-9.]+)\s*(pt|px)?/gi)]
    .map((m) => parseFloat(m[1]));
  const badStrokes = strokes.filter((w) => w < MIN_STROKE || w > MAX_STROKE);
  if (badStrokes.length) {
    errors.push(`线宽超出 [${MIN_STROKE}, ${MAX_STROKE}]：${[...new Set(badStrokes)].join(', ')}`);
  }
  if (!strokes.length) warnings.push('未找到 stroke-width（可能全部继承默认值）');

  // ---- 规则 3：分类色数量 ----
  const colors = new Set();
  for (const m of s.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/gi)) {
    const c = m[1].toLowerCase();
    if (c === 'none' || c === 'currentcolor' || c.startsWith('url(')) continue;
    const rgb = parseColor(c);
    if (!rgb) continue;
    if (isNeutral(rgb)) continue;
    colors.add(c);
  }
  if (colors.size > MAX_CATEGORICAL) {
    errors.push(`非中性色 ${colors.size} 种，超过上限 ${MAX_CATEGORICAL}：${[...colors].join(' ')}`);
  }

  // ---- 规则 4：禁用色图 ----
  for (const m of s.matchAll(/<linearGradient[^>]*\sid="([^"]*)"/gi)) {
    if (FORBIDDEN_GRADIENT.test(m[1])) {
      errors.push(`使用了被禁用的色图渐变 id="${m[1]}"（jet/rainbow/hsv/turbo 不可用于连续数据）`);
    }
  }

  // ---- 规则 5：矢量图内不得内嵌位图 ----
  const embedded = [...s.matchAll(/<image[^>]*\s(?:xlink:)?href="(data:image\/[^;"]+;base64,)/gi)];
  if (embedded.length) {
    errors.push(`内嵌了 ${embedded.length} 张 base64 位图；示意图/线稿必须纯矢量（位图应单独导出为 ≥300dpi 文件）`);
  }

  // ---- 规则 6：字体回退链 ----
  const families = [...s.matchAll(/font-family\s*[:=]\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const hasText = /<text[\s>]/i.test(s);
  if (families.length) {
    const noFallback = families.filter((f) => !GENERIC_FALLBACK.test(f));
    if (noFallback.length) {
      errors.push(`font-family 缺少通用回退族：${[...new Set(noFallback)].join(' | ')}`);
    }
  } else if (hasText) {
    warnings.push('存在 <text> 但未声明 font-family，依赖宿主默认字体（可能与他人机器不一致）');
  }

  // ---- 规则 7：图内不得有图题（"Figure N" 之类的独立标题）----
  const titles = [...s.matchAll(/>\s*(Figure|Fig\.?)\s*\d+\s*[:.]/gi)];
  if (titles.length) {
    errors.push('图内出现 "Figure N:" 形式的图题；图注应写在正文，不得放进图文件');
  }

  // ---- 规则 8：元素重叠 / 遮挡 / 越界（最易漏、只能靠肉眼发现的一类）----
  const vbMatch = s.match(/viewBox="([^"]+)"/);
  let cw = 0, chh = 0;
  if (vbMatch) { const p = vbMatch[1].trim().split(/[\s,]+/).map(Number); cw = p[2]; chh = p[3]; }
  errors.push(...findOverlaps(s, cw, chh));

  return { file, errors, warnings, fatal: false };
}

const results = files.map(check);
const failed = results.filter((r) => r.errors.length);

if (asJson) {
  console.log(JSON.stringify({ results, failed: failed.length, passed: results.length - failed.length }, null, 2));
} else {
  for (const r of results) {
    const status = r.errors.length ? 'FAIL' : (r.warnings.length ? 'PASS(警告)' : 'PASS');
    console.log(`\n[${status}] ${r.file}`);
    for (const e of r.errors) console.log(`   ✗ ${e}`);
    for (const w of r.warnings) console.log(`   ⚠ ${w}`);
  }
  console.log(`\n合计 ${results.length} 个文件：通过 ${results.length - failed.length}，不合格 ${failed.length}`);
}

process.exit(failed.length ? 1 : 0);
