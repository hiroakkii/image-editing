import { computePatch, distToOutline, hitInside, resample, selBounds, tracePath } from './effects.js';

const $ = (id) => document.getElementById(id);

// iPhone の Safari が扱えるキャンバスの上限（約1677万ピクセル）
const IOS_MAX_PIXELS = 16_777_216;
const JPEG_QUALITY = 0.95;

const EFFECTS = {
  mosaic: { label: 'ブロックの大きさ', min: 2, max: 200, def: 16 },
  blur: { label: 'ぼかしの強さ', min: 1, max: 100, def: 12 },
  fill: null,
};

const HINTS = {
  pan: '1本指で移動、2本指で拡大・縮小',
  lasso: 'なぞって囲む。線の近くで伸縮、角で拡大縮小、内側で移動。新しく囲むときは外側から',
  rect: 'ドラッグで四角を作成。角でサイズ変更、内側で移動',
  ellipse: 'ドラッグで楕円を作成。角でサイズ変更、内側で移動',
};

const state = {
  file: null,
  format: null, // { kind, ext, baseName, origName }
  W: 0,
  H: 0,
  colorSpace: 'srgb',
  base: null, // 元画像（変更しない）
  work: null, // 編集中の画像
  ops: [],
  redo: [],
  tool: 'lasso',
  effect: 'mosaic',
  strength: { mosaic: EFFECTS.mosaic.def, blur: EFFECTS.blur.def },
  color: '#000000',
  sel: null,
  preview: null,
  view: { s: 1, tx: 0, ty: 0 },
  dirty: false,
  saveBlob: null,
};

loadPrefs();

/* =========================================================
 * キャンバス
 * ======================================================= */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c) {
  return c.getContext('2d', { colorSpace: state.colorSpace, willReadFrequently: true });
}

function supportsP3() {
  try {
    const ctx = makeCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' });
    return ctx?.getContextAttributes?.().colorSpace === 'display-p3';
  } catch {
    return false;
  }
}

const view = $('view');
const vctx = view.getContext('2d');
let dpr = window.devicePixelRatio || 1;
let checker = null;

function makeChecker() {
  const n = 8;
  const c = makeCanvas(n * 2, n * 2);
  const g = c.getContext('2d');
  g.fillStyle = '#b9bcc2';
  g.fillRect(0, 0, n * 2, n * 2);
  g.fillStyle = '#8e9299';
  g.fillRect(0, 0, n, n);
  g.fillRect(n, n, n, n);
  return vctx.createPattern(c, 'repeat');
}

function resizeView() {
  dpr = window.devicePixelRatio || 1;
  const r = view.getBoundingClientRect();
  view.width = Math.max(1, Math.round(r.width * dpr));
  view.height = Math.max(1, Math.round(r.height * dpr));
  requestDraw();
}
new ResizeObserver(resizeView).observe(view);

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function draw() {
  drawQueued = false;
  const g = vctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, view.width, view.height);
  if (!state.work) return;
  const { s, tx, ty } = state.view;

  // 透明部分の市松模様（画面座標）
  checker ||= makeChecker();
  g.fillStyle = checker;
  g.fillRect(Math.round(tx * dpr), Math.round(ty * dpr), Math.round(state.W * s * dpr), Math.round(state.H * s * dpr));

  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
  g.imageSmoothingEnabled = s < 2;
  g.imageSmoothingQuality = 'high';
  g.drawImage(state.work, 0, 0);
  if (state.preview) g.drawImage(state.preview.canvas, state.preview.x, state.preview.y);

  // 選択範囲
  const drawing = gesture?.type === 'lasso';
  const sel = drawing ? { type: 'lasso', pts: gesture.pts } : state.sel;
  if (sel && (sel.type !== 'lasso' || sel.pts.length > 1)) {
    const lw = 1.5 / s;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (drawing) {
      // なぞっている途中は、なぞった軌跡だけを表示する（始点へは結ばない）
      const p = sel.pts;
      g.beginPath();
      g.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
    } else {
      tracePath(g, sel);
      g.fillStyle = 'rgba(255,176,32,0.10)';
      g.fill();
    }
    g.lineWidth = lw * 2;
    g.setLineDash([]);
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.stroke();
    g.lineWidth = lw;
    g.setLineDash([6 / s, 4 / s]);
    g.strokeStyle = '#ffb020';
    g.stroke();
    g.setLineDash([]);

    if (sel.type === 'lasso' && !drawing) {
      // 全体の拡大・縮小用の枠
      const b = lassoBox(sel);
      g.lineWidth = 1 / s;
      g.setLineDash([3 / s, 3 / s]);
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.strokeRect(b.x, b.y, b.w, b.h);
      g.setLineDash([]);
    }
    if (gesture?.type === 'deform') {
      // 変形の影響範囲
      g.beginPath();
      g.arc(gesture.cur[0], gesture.cur[1], gesture.radius, 0, Math.PI * 2);
      g.lineWidth = 1 / s;
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.stroke();
    }
    if (!drawing && gesture?.type !== 'shape' && gesture?.type !== 'deform') {
      const hs = 9 / s;
      g.fillStyle = '#fff';
      g.strokeStyle = '#000';
      g.lineWidth = 1 / s;
      for (const [cx, cy] of corners(sel.type === 'lasso' ? lassoBox(sel) : sel)) {
        g.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
        g.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }
    }
  }
  $('zoomLabel').textContent = `${Math.round(s * 100)}%`;
}

function lassoBox(sel) {
  const b = selBounds(sel);
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

function corners(sel) {
  return [
    [sel.x, sel.y],
    [sel.x + sel.w, sel.y],
    [sel.x, sel.y + sel.h],
    [sel.x + sel.w, sel.y + sel.h],
  ];
}

/* =========================================================
 * 表示位置・拡大
 * ======================================================= */

function viewSize() {
  const r = view.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function fitScale() {
  const { w, h } = viewSize();
  return Math.min((w - 24) / state.W, (h - 24) / state.H);
}

function minScale() {
  return Math.min(fitScale() * 0.5, 1);
}
const MAX_SCALE = 40;
// 線を伸縮するときに一緒に動く範囲（画面上の半径 px）。拡大表示するほど細かく調整できる
const DEFORM_RADIUS = 60;

function fit() {
  if (!state.work) return;
  const { w, h } = viewSize();
  const s = Math.min(fitScale(), 8);
  state.view = { s, tx: (w - state.W * s) / 2, ty: (h - state.H * s) / 2 };
  requestDraw();
}

function zoomTo(s, cx, cy) {
  const v = state.view;
  s = Math.min(MAX_SCALE, Math.max(minScale(), s));
  const ix = (cx - v.tx) / v.s, iy = (cy - v.ty) / v.s;
  state.view = { s, tx: cx - ix * s, ty: cy - iy * s };
  requestDraw();
}

function toImage(sx, sy) {
  const v = state.view;
  return [(sx - v.tx) / v.s, (sy - v.ty) / v.s];
}

/* =========================================================
 * 指・マウス操作
 * ======================================================= */

const pointers = new Map();
let gesture = null;
let spaceDown = false;

function localPos(e) {
  const r = view.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return {
    mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
  };
}

view.addEventListener('pointerdown', (e) => {
  if (!state.work) return;
  e.preventDefault();
  try { view.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
  pointers.set(e.pointerId, localPos(e));

  if (pointers.size === 2) {
    // 2本目の指: 描きかけを取り消してピンチ操作へ
    if (gesture?.restore !== undefined) {
      state.sel = gesture.restore;
      if (state.sel) schedulePreview();
    }
    const { mid, dist } = pinchInfo();
    gesture = { type: 'pinch', mid, dist, view: { ...state.view } };
    requestDraw();
    return;
  }
  if (pointers.size > 2) return;

  const [sx, sy] = localPos(e);
  const p = toImage(sx, sy);
  const tool = spaceDown || e.button === 1 || e.button === 2 ? 'pan' : state.tool;

  if (tool === 'pan') {
    gesture = { type: 'pan', start: [sx, sy], view: { ...state.view } };
    return;
  }
  const sel = state.sel;
  const hr = 22 / state.view.s; // 指で触れる判定の大きさ（画面上 22px）
  const hitCorner = (box) => {
    const cs = corners(box);
    for (let k = 0; k < 4; k++) {
      if (Math.abs(p[0] - cs[k][0]) <= hr && Math.abs(p[1] - cs[k][1]) <= hr) return cs[3 - k];
    }
    return null;
  };

  if (tool === 'lasso') {
    if (sel?.type === 'lasso') {
      const restore = structuredClone(sel);
      // 四隅: 全体を拡大・縮小
      const anchor = hitCorner(lassoBox(sel));
      if (anchor) {
        gesture = { type: 'lassoScale', anchor, box: lassoBox(sel), orig: restore.pts, restore };
        clearPreview();
        return;
      }
      // 線の近く: その付近だけを伸ばす・縮める
      if (distToOutline(sel.pts, p[0], p[1]) <= hr) {
        const radius = DEFORM_RADIUS / state.view.s;
        const pts = resample(sel.pts, 3 / state.view.s);
        const weights = pts.map(([x, y]) => {
          const d = Math.hypot(x - p[0], y - p[1]) / radius;
          return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
        });
        gesture = { type: 'deform', start: p, cur: p, radius, orig: pts, weights, restore };
        clearPreview();
        return;
      }
      // 内側: 移動
      if (hitInside(sel, p[0], p[1])) {
        gesture = { type: 'lassoMove', start: p, orig: restore.pts, restore };
        clearPreview();
        return;
      }
    }
    gesture = { type: 'lasso', pts: [p], last: [sx, sy], restore: sel };
    state.sel = null;
    clearPreview();
    return;
  }
  // 四角・楕円
  if (sel && sel.type === tool) {
    const anchor = hitCorner(sel);
    if (anchor) {
      gesture = { type: 'resize', anchor, restore: { ...sel } };
      clearPreview();
      return;
    }
    if (hitInside(sel, p[0], p[1])) {
      gesture = { type: 'move', start: p, orig: { ...sel }, restore: { ...sel } };
      clearPreview();
      return;
    }
  }
  gesture = { type: 'shape', start: p, restore: state.sel };
  state.sel = null;
  clearPreview();
});

view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const pos = localPos(e);
  pointers.set(e.pointerId, pos);
  if (!gesture) return;
  const [sx, sy] = pos;

  switch (gesture.type) {
    case 'pinch': {
      if (pointers.size < 2) return;
      const { mid, dist } = pinchInfo();
      const v0 = gesture.view;
      const s = Math.min(MAX_SCALE, Math.max(minScale(), (v0.s * dist) / gesture.dist));
      const ix = (gesture.mid[0] - v0.tx) / v0.s, iy = (gesture.mid[1] - v0.ty) / v0.s;
      state.view = { s, tx: mid[0] - ix * s, ty: mid[1] - iy * s };
      break;
    }
    case 'pan': {
      const v0 = gesture.view;
      state.view = { s: v0.s, tx: v0.tx + sx - gesture.start[0], ty: v0.ty + sy - gesture.start[1] };
      break;
    }
    case 'lasso': {
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ev of evs) {
        const [x, y] = localPos(ev);
        if (Math.hypot(x - gesture.last[0], y - gesture.last[1]) >= 2) {
          gesture.pts.push(toImage(x, y));
          gesture.last = [x, y];
        }
      }
      break;
    }
    case 'shape':
    case 'resize': {
      const a = gesture.type === 'shape' ? gesture.start : gesture.anchor;
      const p = toImage(sx, sy);
      state.sel = rectFrom(a, p, gesture.type === 'shape' ? state.tool : gesture.restore.type);
      break;
    }
    case 'move': {
      const p = toImage(sx, sy);
      const o = gesture.orig;
      state.sel = { ...o, x: Math.round(o.x + p[0] - gesture.start[0]), y: Math.round(o.y + p[1] - gesture.start[1]) };
      break;
    }
    case 'lassoMove': {
      const p = toImage(sx, sy);
      const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
      state.sel = { type: 'lasso', pts: gesture.orig.map(([x, y]) => [x + dx, y + dy]) };
      break;
    }
    case 'lassoScale': {
      const b = gesture.box;
      const n = rectFrom(gesture.anchor, toImage(sx, sy), 'rect');
      const kx = b.w ? Math.max(n.w, 2) / b.w : 1, ky = b.h ? Math.max(n.h, 2) / b.h : 1;
      state.sel = {
        type: 'lasso',
        pts: gesture.orig.map(([x, y]) => [n.x + (x - b.x) * kx, n.y + (y - b.y) * ky]),
      };
      break;
    }
    case 'deform': {
      const p = toImage(sx, sy);
      const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
      const w = gesture.weights;
      gesture.cur = p;
      state.sel = { type: 'lasso', pts: gesture.orig.map(([x, y], i) => [x + dx * w[i], y + dy * w[i]]) };
      break;
    }
  }
  requestDraw();
});

function rectFrom(a, b, type) {
  const x0 = Math.round(Math.min(a[0], b[0])), y0 = Math.round(Math.min(a[1], b[1]));
  const x1 = Math.round(Math.max(a[0], b[0])), y1 = Math.round(Math.max(a[1], b[1]));
  return { type, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (pointers.size === 0) gesture = null;
    return; // 1本残っていても描画は始めない
  }
  const g = gesture;
  gesture = null;
  if (g.type === 'lasso') {
    state.sel = g.pts.length >= 3 && lassoArea(g.pts) > 4 ? { type: 'lasso', pts: g.pts } : g.restore;
  } else if (g.type === 'shape' || g.type === 'resize') {
    if (!state.sel || state.sel.w < 2 || state.sel.h < 2) state.sel = g.restore;
  }
  if (g.type !== 'pan') schedulePreview();
  requestDraw();
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);
view.addEventListener('contextmenu', (e) => e.preventDefault());

function lassoArea(pts) {
  const b = selBounds({ type: 'lasso', pts });
  return (b.x1 - b.x0) * (b.y1 - b.y0) * state.view.s * state.view.s;
}

view.addEventListener(
  'wheel',
  (e) => {
    if (!state.work) return;
    e.preventDefault();
    const [cx, cy] = localPos(e);
    if (e.shiftKey) {
      state.view.tx -= e.deltaY;
      requestDraw();
      return;
    }
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    zoomTo(state.view.s * k, cx, cy);
  },
  { passive: false },
);

// iOS Safari のページ全体の拡大を止める
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); }
  else if (e.key === 'Enter') applySel();
  else if (e.key === 'Escape') clearSel();
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

/* =========================================================
 * プレビュー・適用・元に戻す
 * ======================================================= */

function currentOp() {
  return {
    sel: structuredClone(state.sel),
    effect: state.effect,
    strength: state.effect === 'fill' ? 0 : state.strength[state.effect],
    color: state.color,
  };
}

let previewTimer = 0;
function clearPreview() {
  clearTimeout(previewTimer);
  state.preview = null;
}
function schedulePreview() {
  clearPreview();
  updateUI();
  if (!state.sel) return;
  previewTimer = setTimeout(() => {
    if (!state.sel || !state.work) return;
    const p = computePatch(ctx2d(state.work), state.W, state.H, currentOp(), makeCanvas);
    if (p) {
      const c = makeCanvas(p.data.width, p.data.height);
      ctx2d(c).putImageData(p.data, 0, 0);
      state.preview = { canvas: c, x: p.x, y: p.y, data: p.data };
    }
    requestDraw();
  }, 40);
}

function applySel() {
  if (!state.sel || !state.work) return;
  const op = currentOp();
  const p = state.preview?.data
    ? { data: state.preview.data, x: state.preview.x, y: state.preview.y }
    : computePatch(ctx2d(state.work), state.W, state.H, op, makeCanvas);
  if (p) ctx2d(state.work).putImageData(p.data, p.x, p.y);
  state.ops.push(op);
  state.redo = [];
  state.sel = null;
  state.dirty = true;
  clearPreview();
  updateUI();
  requestDraw();
}

function clearSel() {
  state.sel = null;
  clearPreview();
  updateUI();
  requestDraw();
}

function rebuild() {
  const wctx = ctx2d(state.work);
  wctx.putImageData(ctx2d(state.base).getImageData(0, 0, state.W, state.H), 0, 0);
  for (const op of state.ops) {
    const p = computePatch(wctx, state.W, state.H, op, makeCanvas);
    if (p) wctx.putImageData(p.data, p.x, p.y);
  }
}

function undo() {
  if (!state.ops.length) return;
  state.redo.push(state.ops.pop());
  rebuild();
  state.dirty = state.ops.length > 0;
  schedulePreview();
  requestDraw();
}

function redo() {
  if (!state.redo.length) return;
  const op = state.redo.pop();
  const wctx = ctx2d(state.work);
  const p = computePatch(wctx, state.W, state.H, op, makeCanvas);
  if (p) wctx.putImageData(p.data, p.x, p.y);
  state.ops.push(op);
  state.dirty = true;
  schedulePreview();
  requestDraw();
}

/* =========================================================
 * 読み込み
 * ======================================================= */

function splitName(name) {
  const m = /^(.*?)(\.([^.]+))?$/.exec(name || '');
  return { base: m[1] || 'image', ext: (m[3] || '').toLowerCase(), rawExt: m[3] || '' };
}

function detectFormat(file) {
  const { base, ext, rawExt } = splitName(file.name);
  const t = (file.type || '').toLowerCase();
  let kind = 'other';
  if (t === 'image/png' || ext === 'png') kind = 'png';
  else if (t === 'image/jpeg' || ['jpg', 'jpeg', 'jpe', 'jfif'].includes(ext)) kind = 'jpeg';
  else if (/hei[cf]/.test(t) || ['heic', 'heif', 'hif'].includes(ext)) kind = 'heic';
  else if (t === 'image/webp' || ext === 'webp') kind = 'webp';
  return { kind, baseName: base, ext, rawExt, origName: file.name || 'image' };
}

function bytesIndexOf(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf16be = (s) => Uint8Array.from([...s].flatMap((c) => [0, c.charCodeAt(0)]));

function looksP3(bytes) {
  return ['Display P3', 'DCI-P3', 'P3 D65'].some(
    (n) => bytesIndexOf(bytes, ascii(n)) >= 0 || bytesIndexOf(bytes, utf16be(n)) >= 0,
  );
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 画像が Display P3（iPhoneのスクリーンショットや写真）かどうかを調べる */
async function detectP3(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    if (!isPng) return looksP3(head);
    const dv = new DataView(head.buffer);
    let p = 8;
    while (p + 8 <= head.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(...head.subarray(p + 4, p + 8));
      if (type === 'cICP') return head[p + 8] === 12;
      if (type === 'iCCP') {
        const data = head.subarray(p + 8, p + 8 + len);
        const z = data.indexOf(0);
        return looksP3(await inflate(data.subarray(z + 2)));
      }
      if (type === 'sRGB' || type === 'IDAT') return false;
      p += 12 + len;
    }
  } catch {
    /* 判定できない場合は sRGB 扱い */
  }
  return false;
}

async function loadFile(file) {
  if (!file) return;
  if (state.dirty && !confirm('保存していない編集があります。破棄して新しい画像を開きますか？')) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('この画像形式はこのブラウザでは開けません');
    }
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('画像を読み込めませんでした');

    const p3 = (await detectP3(file)) && supportsP3();
    state.colorSpace = p3 ? 'display-p3' : 'srgb';

    const base = makeCanvas(W, H);
    const bctx = ctx2d(base);
    if (!bctx) throw new Error('画像が大きすぎて処理できません');
    bctx.drawImage(img, 0, 0);
    const work = makeCanvas(W, H);
    const wctx = ctx2d(work);
    if (!wctx) throw new Error('画像が大きすぎて処理できません');
    wctx.putImageData(bctx.getImageData(0, 0, W, H), 0, 0);

    Object.assign(state, {
      file, format: detectFormat(file), W, H, base, work,
      ops: [], redo: [], sel: null, preview: null, dirty: false,
    });
    $('fileName').textContent = file.name || '名称未設定';
    $('fileMeta').textContent = `${W} × ${H} px ・ ${formatLabel(state.format.kind)} ・ ${formatBytes(file.size)}${p3 ? ' ・ P3' : ''}`;
    $('empty').hidden = true;
    $('zoomCtl').hidden = false;
    fit();
    updateUI();
    if (W * H > IOS_MAX_PIXELS) {
      toast('画像がとても大きいため、iPhoneでは正しく処理できない場合があります', true);
    }
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatLabel(kind) {
  return { png: 'PNG', jpeg: 'JPEG', heic: 'HEIC', webp: 'WebP', other: '画像' }[kind];
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* =========================================================
 * 保存
 * ======================================================= */

function toBlob(canvas, mime, q) {
  return new Promise((res) => canvas.toBlob(res, mime, q));
}

/** 元の形式で書き出す。対応していない形式は近い形式に切り替える */
async function encode() {
  const f = state.format;
  const plans = {
    png: [['image/png']],
    jpeg: [['image/jpeg', JPEG_QUALITY]],
    heic: [['image/heic', JPEG_QUALITY], ['image/jpeg', JPEG_QUALITY]],
    webp: [['image/webp', JPEG_QUALITY], ['image/png']],
    other: [['image/png']],
  }[f.kind];
  for (const [mime, q] of plans) {
    const blob = await toBlob(state.work, mime, q);
    if (blob && blob.type === mime) return { blob, mime };
  }
  throw new Error('画像の書き出しに失敗しました');
}

function extFor(mime) {
  const f = state.format;
  const keep = (list, fallback) => (list.includes(f.ext) ? f.rawExt : fallback);
  switch (mime) {
    case 'image/png': return keep(['png'], 'png');
    case 'image/jpeg': return keep(['jpg', 'jpeg', 'jpe', 'jfif'], 'jpg');
    case 'image/heic': return keep(['heic', 'heif', 'hif'], 'heic');
    case 'image/webp': return keep(['webp'], 'webp');
  }
  return 'png';
}

function sanitizeName(s) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
}

let saveResult = null;

async function openSave() {
  if (!state.work) return;
  if (state.sel && !confirm('選択中の範囲はまだ適用されていません。このまま保存しますか？')) return;
  const dlg = $('saveDlg');
  $('nameInput').value = state.format.baseName;
  $('shareBtn').disabled = true;
  $('downloadBtn').disabled = true;
  $('formatNote').innerHTML = '<li>書き出し中…</li>';
  dlg.showModal();
  try {
    saveResult = await encode();
  } catch (err) {
    $('formatNote').innerHTML = `<li class="warn">${err.message}</li>`;
    return;
  }
  const { blob, mime } = saveResult;
  $('extLabel').textContent = '.' + extFor(mime);
  const notes = [];
  const outKind = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/heic': 'heic', 'image/webp': 'webp' }[mime];
  if (outKind !== state.format.kind) {
    notes.push(
      `<li class="warn">このブラウザは${formatLabel(state.format.kind)}で保存できないため、${formatLabel(outKind)}で保存します（拡張子も変わります）</li>`,
    );
  }
  if (mime === 'image/png') notes.push('<li>PNG：劣化なし（可逆）で保存します</li>');
  else notes.push(`<li>${formatLabel(outKind)}：品質 ${Math.round(JPEG_QUALITY * 100)}% で保存します</li>`);
  notes.push('<li>撮影日時・位置情報などのメタデータは削除されます</li>');
  notes.push(`<li>${state.W} × ${state.H} px ・ ${formatBytes(blob.size)}</li>`);
  $('formatNote').innerHTML = notes.join('');
  $('shareBtn').disabled = false;
  $('downloadBtn').disabled = false;
  $('shareBtn').hidden = !navigator.canShare?.({ files: [new File([blob], 'x.' + extFor(mime), { type: mime })] });
}

function outputFile() {
  const { blob, mime } = saveResult;
  const base = sanitizeName($('nameInput').value) || state.format.baseName || 'image';
  return new File([blob], `${base}.${extFor(mime)}`, { type: mime, lastModified: Date.now() });
}

$('shareBtn').addEventListener('click', async () => {
  if (!saveResult) return;
  const file = outputFile();
  try {
    await navigator.share({ files: [file] });
    state.dirty = false;
    $('saveDlg').close();
    toast('保存しました');
  } catch (err) {
    if (err.name !== 'AbortError') toast('共有メニューを開けませんでした。ダウンロードをお試しください', true);
  }
});

$('downloadBtn').addEventListener('click', () => {
  if (!saveResult) return;
  const file = outputFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  state.dirty = false;
  $('saveDlg').close();
  toast(`${file.name} をダウンロードしました`);
});

$('resetNameBtn').addEventListener('click', () => {
  $('nameInput').value = state.format.baseName;
});

/* =========================================================
 * UI
 * ======================================================= */

function setTool(tool) {
  state.tool = tool;
  if (state.sel && tool !== 'pan' && state.sel.type !== tool && state.sel.type !== 'lasso' && tool !== 'lasso') {
    // 四角⇔楕円は形だけ切り替える
    state.sel = { ...state.sel, type: tool };
    schedulePreview();
  }
  savePrefs();
  updateUI();
  requestDraw();
}

function setEffect(effect) {
  state.effect = effect;
  savePrefs();
  updateUI();
  schedulePreview();
}

function setStrength(v, fromRange) {
  const cfg = EFFECTS[state.effect];
  if (!cfg) return;
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return;
  v = Math.min(cfg.max, Math.max(cfg.min, v));
  state.strength[state.effect] = v;
  if (fromRange) $('strengthNum').value = v;
  else $('strengthRange').value = v;
  savePrefs();
  schedulePreview();
}

function updateUI() {
  for (const b of $('toolSeg').children) b.setAttribute('aria-checked', String(b.dataset.tool === state.tool));
  for (const b of $('effectSeg').children) b.setAttribute('aria-checked', String(b.dataset.effect === state.effect));
  $('stage').dataset.tool = state.tool;
  const cfg = EFFECTS[state.effect];
  $('strengthRow').hidden = !cfg;
  $('colorRow').hidden = !!cfg;
  if (cfg) {
    $('strengthLabel').textContent = cfg.label;
    for (const el of [$('strengthRange'), $('strengthNum')]) {
      el.min = cfg.min;
      el.max = cfg.max;
      el.value = state.strength[state.effect];
    }
  }
  $('colorInput').value = state.color;
  for (const s of document.querySelectorAll('.swatch')) s.setAttribute('aria-pressed', String(s.dataset.color === state.color));
  $('hint').textContent = state.work ? HINTS[state.tool] : '';
  $('applyBtn').disabled = !state.sel;
  $('clearSelBtn').disabled = !state.sel;
  $('undoBtn').disabled = !state.ops.length;
  $('redoBtn').disabled = !state.redo.length;
  $('saveBtn').disabled = !state.work;
}

$('toolSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (t) setTool(t);
});
$('effectSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-effect]')?.dataset.effect;
  if (t) setEffect(t);
});
$('strengthRange').addEventListener('input', (e) => setStrength(e.target.value, true));
$('strengthNum').addEventListener('change', (e) => setStrength(e.target.value, false));
$('strengthNum').addEventListener('input', (e) => {
  const cfg = EFFECTS[state.effect];
  const v = Number(e.target.value);
  if (cfg && v >= cfg.min && v <= cfg.max) setStrength(v, false);
});
$('strengthNum').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('colorInput').addEventListener('input', (e) => { state.color = e.target.value; savePrefs(); updateUI(); schedulePreview(); });
document.querySelector('.swatches').addEventListener('click', (e) => {
  const c = e.target.closest('.swatch')?.dataset.color;
  if (c) { state.color = c; savePrefs(); updateUI(); schedulePreview(); }
});

$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});
$('applyBtn').addEventListener('click', applySel);
$('clearSelBtn').addEventListener('click', clearSel);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('saveBtn').addEventListener('click', openSave);
$('fitBtn').addEventListener('click', fit);
$('oneBtn').addEventListener('click', () => {
  const { w, h } = viewSize();
  zoomTo(1 / dpr, w / 2, h / 2);
});

// パソコンではドラッグ＆ドロップでも開ける
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

let toastTimer = 0;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2500);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('mosaic-prefs') || '{}');
    if (p.tool in HINTS) state.tool = p.tool;
    if (p.effect in EFFECTS) state.effect = p.effect;
    if (p.strength) Object.assign(state.strength, p.strength);
    if (/^#[0-9a-f]{6}$/i.test(p.color || '')) state.color = p.color;
  } catch { /* 無視 */ }
}

function savePrefs() {
  try {
    localStorage.setItem('mosaic-prefs', JSON.stringify({
      tool: state.tool, effect: state.effect, strength: state.strength, color: state.color,
    }));
  } catch { /* 無視 */ }
}

updateUI();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用
window.__app = { state, applySel, undo, redo, fit };
