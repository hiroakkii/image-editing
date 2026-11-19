// 書き込み（文字・吹き出し・矢印・枠・スタンプ）の描画と当たり判定。
// 座標はすべて画像のピクセル座標。x, y は部品の中心、rot は回転（ラジアン）。

export const FONTS = {
  gothic: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif',
  mincho: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif',
  maru: '"Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "Kosugi Maru", "Noto Sans JP", sans-serif',
};
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export const STAMPS = ['❗', '❓', '‼️', '⭐', '❤️', '👍', '👉', '👆', '✅', '❌', '⚠️', '💡', '😊', '😂', '😢', '😡', '🎉', '🔥', '💦', '✨'];

const LH = 1.35; // 行間（文字サイズに対する倍率）

// 行頭に来ないようにする文字（簡易禁則）
const NO_START = '、。，．,.!?！？)）]］」』】〉》ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…‥';
// 縦書きで90°回転させる文字
const ROTATE_V = 'ー－-—―‐〜～…‥：:;；=＝()（）[]［］{}｛｝「」『』【】〈〉《》<>＜＞';
// 縦書きで右上に寄せる文字
const PUNCT_V = '、。，．,.';
const SMALL_V = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ';

export function fontStr(o, size = o.size) {
  return `${o.bold ? 700 : 400} ${size}px ${FONTS[o.font] || FONTS.gothic}`;
}

let measureCtx = null;
function measurer() {
  return (measureCtx ||= document.createElement('canvas').getContext('2d'));
}

/**
 * 文字の配置を計算する。
 * 横書き: maxW を超えると折り返す。縦書き: maxH を超えると次の列（左）へ送る。
 */
export function layoutText(o, maxW = 0, maxH = 0) {
  const g = measurer();
  g.font = fontStr(o);
  const s = o.size;
  const paras = String(o.text ?? '').split('\n');
  if (!o.vertical) {
    const lines = [];
    for (const para of paras) {
      if (!maxW) { lines.push(para); continue; }
      let line = '';
      for (const ch of para) {
        if (line && g.measureText(line + ch).width > maxW && !NO_START.includes(ch)) {
          lines.push(line);
          line = ch;
        } else line += ch;
      }
      lines.push(line);
    }
    const widths = lines.map((l) => g.measureText(l).width);
    return { vertical: false, lines, widths, w: Math.max(s * 0.6, ...widths), h: lines.length * s * LH };
  }
  const per = maxH ? Math.max(1, Math.floor(maxH / s)) : Infinity;
  const cols = [];
  for (const para of paras) {
    let col = [];
    for (const ch of para) {
      if (col.length >= per && !NO_START.includes(ch)) { cols.push(col); col = []; }
      col.push(ch);
    }
    cols.push(col);
  }
  const maxLen = Math.max(1, ...cols.map((c) => c.length));
  return { vertical: true, cols, w: cols.length * s * LH, h: maxLen * s };
}

function drawLayout(g, o, L) {
  const s = o.size;
  g.font = fontStr(o);
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.miterLimit = 2;
  const align = o.align || 'center';
  const passes = [];
  if (o.outline) passes.push('stroke');
  passes.push('fill');

  for (const pass of passes) {
    if (pass === 'stroke') {
      g.strokeStyle = o.outline;
      g.lineWidth = s * 0.22;
    } else g.fillStyle = o.color;
    const put = (t, x, y) => (pass === 'stroke' ? g.strokeText(t, x, y) : g.fillText(t, x, y));

    if (!L.vertical) {
      const top = -L.h / 2;
      g.textAlign = align === 'start' ? 'left' : align === 'end' ? 'right' : 'center';
      const x = align === 'start' ? -L.w / 2 : align === 'end' ? L.w / 2 : 0;
      L.lines.forEach((line, i) => put(line, x, top + (i + 0.5) * s * LH));
      continue;
    }
    g.textAlign = 'center';
    const right = L.w / 2;
    L.cols.forEach((col, i) => {
      const cx = right - (i + 0.5) * s * LH;
      const colH = col.length * s;
      const top = align === 'start' ? -L.h / 2 : align === 'end' ? L.h / 2 - colH : -colH / 2;
      col.forEach((ch, j) => {
        const cy = top + (j + 0.5) * s;
        if (ROTATE_V.includes(ch)) {
          g.save();
          g.translate(cx, cy);
          g.rotate(Math.PI / 2);
          put(ch, 0, 0);
          g.restore();
        } else if (PUNCT_V.includes(ch)) put(ch, cx + s * 0.55, cy - s * 0.5);
        else if (SMALL_V.includes(ch)) put(ch, cx + s * 0.1, cy - s * 0.1);
        else put(ch, cx, cy);
      });
    });
  }
}

/* ---------------- 吹き出し ---------------- */

function rand(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRectPath(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function bodyPath(g, o) {
  const { w, h } = o;
  const rx = w / 2, ry = h / 2;
  g.beginPath();
  switch (o.shape) {
    case 'rect':
      g.rect(-rx, -ry, w, h);
      break;
    case 'ellipse':
      g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      break;
    case 'shout': {
      const r = rand(o.seed || 1);
      const n = Math.max(10, Math.min(26, Math.round((w + h) / (Math.min(w, h) * 0.16))));
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2 + 0.15;
        const k = i % 2 ? 0.78 + r() * 0.06 : 1.0 + r() * 0.1;
        const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      break;
    }
    case 'thought': {
      const n = Math.max(8, Math.min(18, Math.round((w + h) / (Math.min(w, h) * 0.26))));
      const pt = (a, k) => [Math.cos(a) * rx * k, Math.sin(a) * ry * k];
      const [x0, y0] = pt(0, 0.9);
      g.moveTo(x0, y0);
      for (let i = 0; i < n; i++) {
        const a1 = ((i + 1) / n) * Math.PI * 2, am = ((i + 0.5) / n) * Math.PI * 2;
        const [cx, cy] = pt(am, 1.16);
        const [x, y] = pt(a1, 0.9);
        g.quadraticCurveTo(cx, cy, x, y);
      }
      g.closePath();
      break;
    }
    default:
      roundRectPath(g, -rx, -ry, w, h, Math.min(w, h) * 0.22);
  }
}

/** しっぽ。描けないとき（先端が吹き出しの中など）は false */
function tailPath(g, o) {
  const t = o.tail;
  if (!t) return false;
  const len = Math.hypot(t.x, t.y);
  if (len < 1) return false;
  const ux = t.x / len, uy = t.y / len;
  const rx = o.w / 2, ry = o.h / 2;
  const edge = 1 / Math.sqrt((ux / rx) ** 2 + (uy / ry) ** 2); // 楕円の縁までの距離
  const base = Math.min(o.w, o.h) * 0.24;
  g.beginPath();
  if (o.shape === 'thought') {
    if (len <= edge * 0.95) return false;
    const n = 3;
    for (let k = 0; k < n; k++) {
      const d = edge + (len - edge) * ((k + 0.6) / n);
      const r = base * 0.42 * (1 - k * 0.27);
      g.moveTo(ux * d + r, uy * d);
      g.arc(ux * d, uy * d, r, 0, Math.PI * 2);
    }
    return true;
  }
  if (len <= edge * 0.6) return false;
  const px = -uy, py = ux;
  const c = edge * 0.5;
  g.moveTo(ux * c + (px * base) / 2, uy * c + (py * base) / 2);
  g.lineTo(t.x, t.y);
  g.lineTo(ux * c - (px * base) / 2, uy * c - (py * base) / 2);
  g.closePath();
  return true;
}

/** 吹き出しの中で文字を置ける範囲 */
function innerBox(o) {
  const round = ['ellipse', 'thought', 'shout'].includes(o.shape);
  const f = o.shape === 'shout' ? 0.62 : round ? 0.72 : 1;
  const pad = o.size * 0.5;
  return { w: Math.max(o.size, o.w * f - pad * 2), h: Math.max(o.size, o.h * f - pad * 2) };
}

function drawBubble(g, o) {
  g.lineJoin = 'round';
  if (o.lineWidth > 0) {
    // 線→塗りの順に描き、本体としっぽの境目の線を塗りで隠す（線は外側の半分が残るので2倍の太さで描く）
    g.lineWidth = o.lineWidth * 2;
    g.strokeStyle = o.line;
    bodyPath(g, o);
    g.stroke();
    if (tailPath(g, o)) g.stroke();
  }
  g.fillStyle = o.fill;
  bodyPath(g, o);
  g.fill();
  if (tailPath(g, o)) g.fill();
  const ib = innerBox(o);
  const L = layoutText(o, o.vertical ? 0 : ib.w, o.vertical ? ib.h : 0);
  drawLayout(g, o, L);
}

/** 文字が収まるよう吹き出しを広げる（横書きは縦に、縦書きは横に伸ばす。縮めはしない） */
export function fitBubble(o) {
  const round = ['ellipse', 'thought', 'shout'].includes(o.shape);
  const f = o.shape === 'shout' ? 0.62 : round ? 0.72 : 1;
  const pad = o.size * 0.5;
  const ib = innerBox(o);
  const L = layoutText(o, o.vertical ? 0 : ib.w, o.vertical ? ib.h : 0);
  if (!o.vertical && L.h > ib.h) {
    const nh = Math.ceil((L.h + pad * 2) / f);
    if (o.tail) o.tail.y += Math.sign(o.tail.y) * (nh - o.h) / 2;
    o.h = nh;
  } else if (o.vertical && L.w > ib.w) {
    const nw = Math.ceil((L.w + pad * 2) / f);
    if (o.tail) o.tail.x += Math.sign(o.tail.x) * (nw - o.w) / 2;
    o.w = nw;
  }
}

/* ---------------- 描画 ---------------- */

function drawArrow(g, o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const head = Math.max(o.width * 3.2, 8);
  g.strokeStyle = o.color;
  g.fillStyle = o.color;
  g.lineWidth = o.width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const a = o.double ? head * 0.7 : 0, b = head * 0.7;
  g.beginPath();
  g.moveTo(o.x1 + ux * a, o.y1 + uy * a);
  g.lineTo(o.x2 - ux * b, o.y2 - uy * b);
  g.stroke();
  const tip = (x, y, sx, sy) => {
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - sx * head + px * head * 0.55, y - sy * head + py * head * 0.55);
    g.lineTo(x - sx * head - px * head * 0.55, y - sy * head - py * head * 0.55);
    g.closePath();
    g.fill();
  };
  tip(o.x2, o.y2, ux, uy);
  if (o.double) tip(o.x1, o.y1, -ux, -uy);
}

function drawFrame(g, o) {
  g.strokeStyle = o.color;
  g.lineWidth = o.width;
  g.lineJoin = 'round';
  g.beginPath();
  if (o.shape === 'ellipse') g.ellipse(0, 0, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
  else if (o.shape === 'round') roundRectPath(g, -o.w / 2, -o.h / 2, o.w, o.h, Math.min(o.w, o.h) * 0.2);
  else g.rect(-o.w / 2, -o.h / 2, o.w, o.h);
  g.stroke();
}

function drawStamp(g, o) {
  g.font = `${o.size}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#000';
  g.fillText(o.char, 0, 0);
}

export function drawAnno(g, o) {
  g.save();
  if (o.type === 'arrow') drawArrow(g, o);
  else {
    g.translate(o.x, o.y);
    g.rotate(o.rot || 0);
    if (o.type === 'text') drawLayout(g, o, layoutText(o));
    else if (o.type === 'bubble') drawBubble(g, o);
    else if (o.type === 'frame') drawFrame(g, o);
    else if (o.type === 'stamp') drawStamp(g, o);
  }
  g.restore();
}

export function drawAnnos(g, annos) {
  for (const o of annos) drawAnno(g, o);
}

/* ---------------- 形・当たり判定・ハンドル ---------------- */

/** 回転前の外枠の大きさ */
export function boxSize(o) {
  if (o.type === 'text') {
    const L = layoutText(o);
    const pad = o.outline ? o.size * 0.15 : 0;
    return { w: L.w + pad * 2, h: L.h + pad * 2 };
  }
  if (o.type === 'stamp') return { w: o.size * 1.15, h: o.size * 1.15 };
  return { w: o.w, h: o.h };
}

export function toLocal(o, x, y) {
  const c = Math.cos(-(o.rot || 0)), s = Math.sin(-(o.rot || 0));
  const dx = x - o.x, dy = y - o.y;
  return [dx * c - dy * s, dx * s + dy * c];
}

export function toWorld(o, lx, ly) {
  const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
  return [o.x + lx * c - ly * s, o.y + lx * s + ly * c];
}

function distToSeg(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export function hitAnno(o, x, y, tol) {
  if (o.type === 'arrow') return distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= o.width / 2 + tol;
  const [lx, ly] = toLocal(o, x, y);
  const { w, h } = boxSize(o);
  if (Math.abs(lx) <= w / 2 + tol && Math.abs(ly) <= h / 2 + tol) return true;
  if (o.type === 'bubble' && o.tail) return distToSeg(lx, ly, 0, 0, o.tail.x, o.tail.y) <= tol;
  return false;
}

/** 選択中に表示するハンドル（画像座標）。rotGap は回転ハンドルまでの距離 */
export function annoHandles(o, rotGap) {
  if (o.type === 'arrow') return [{ kind: 'end1', x: o.x1, y: o.y1 }, { kind: 'end2', x: o.x2, y: o.y2 }];
  const { w, h } = boxSize(o);
  const hs = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const [x, y] = toWorld(o, (sx * w) / 2, (sy * h) / 2);
    hs.push({ kind: 'resize', x, y });
  }
  const [rx, ry] = toWorld(o, 0, -h / 2 - rotGap);
  const [tx, ty] = toWorld(o, 0, -h / 2);
  hs.push({ kind: 'rotate', x: rx, y: ry, from: [tx, ty] });
  if (o.type === 'bubble' && o.tail) {
    const [x, y] = toWorld(o, o.tail.x, o.tail.y);
    hs.push({ kind: 'tail', x, y });
  }
  return hs;
}

/** 選択枠（回転した四角形）の4隅 */
export function annoOutline(o) {
  if (o.type === 'arrow') return null;
  const { w, h } = boxSize(o);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toWorld(o, (sx * w) / 2, (sy * h) / 2));
}

/** 別サイズの画像へコピーするときの拡大縮小 */
export function scaleAnno(o, kx, ky) {
  const a = structuredClone(o);
  const k = (kx + ky) / 2;
  if (a.type === 'arrow') {
    a.x1 *= kx; a.x2 *= kx; a.y1 *= ky; a.y2 *= ky;
    a.width = Math.max(1, a.width * k);
    return a;
  }
  a.x *= kx; a.y *= ky;
  if ('w' in a) { a.w *= kx; a.h *= ky; }
  if (a.size) a.size = Math.max(4, a.size * k);
  if (a.width) a.width = Math.max(1, a.width * k);
  if (a.lineWidth) a.lineWidth = Math.max(1, a.lineWidth * k);
  if (a.tail) { a.tail.x *= kx; a.tail.y *= ky; }
  return a;
}

/** 新しい部品。c は配置する中心、base は画像の短辺 */
export function createAnno(type, c, base, extra = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  const r = (v) => Math.max(1, Math.round(v));
  const common = { id, x: c[0], y: c[1], rot: 0 };
  switch (type) {
    case 'text':
      return { ...common, type, text: 'テキスト', font: 'gothic', size: r(base * 0.07), color: '#ffffff', outline: '#000000', bold: true, vertical: false, align: 'center', ...extra };
    case 'bubble':
      return {
        ...common, type, shape: 'round', w: r(base * 0.5), h: r(base * 0.3), tail: { x: -base * 0.1, y: base * 0.3 },
        fill: '#ffffff', line: '#000000', lineWidth: r(base * 0.006),
        text: 'テキスト', font: 'gothic', size: r(base * 0.05), color: '#000000', outline: null, bold: false, vertical: false, align: 'center',
        seed: (Math.random() * 1e9) | 0, ...extra,
      };
    case 'arrow':
      return { id, type, x1: c[0] - base * 0.15, y1: c[1] + base * 0.1, x2: c[0] + base * 0.15, y2: c[1] - base * 0.1, color: '#ff3b30', width: r(base * 0.014), double: false, ...extra };
    case 'frame':
      return { ...common, type, shape: 'ellipse', w: r(base * 0.4), h: r(base * 0.25), color: '#ff3b30', width: r(base * 0.012), ...extra };
    case 'stamp':
      return { ...common, type, char: STAMPS[0], size: r(base * 0.12), ...extra };
  }
  return null;
}
