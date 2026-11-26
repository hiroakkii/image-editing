import { computePatch, distToOutline, hitInside, resample, selBounds, tracePath } from './effects.js';
import {
  BUBBLE_STYLES, BUILTIN_PRESETS, STAMPS, STYLE_DEFAULTS, annoHandles, annoOutline, applyPreset, createAnno, drawAnnos,
  drawPresetThumb, fitBubble, hitAnno, presetFromBubble, scaleAnno, shapeParams, toLocal,
} from './annotate.js';

const $ = (id) => document.getElementById(id);

// iPhone の Safari が扱えるキャンバスの上限（約1677万ピクセル）
const IOS_MAX_PIXELS = 16_777_216;
const JPEG_QUALITY = 0.95;

// 一度に読み込める量（メーターで表示し、超える分は読み込まない）
const MAX_IMAGES = 50;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
// まとめて保存のとき、共有メニューに一度に渡す量
const BATCH_FILES = 10;
const BATCH_BYTES = 50 * 1024 * 1024;

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
  images: [], // { id, file, format, W, H, colorSpace, thumb, ops, annos, undo, redo, version, savedVersion }
  cur: -1,
  mode: 'hide', // 'hide'（隠す） | 'write'（書き込む）
  annoSel: null, // 選択中の書き込みの id
  cropAspect: 'free', // トリミングの比率
  sortOrder: 'name', // 一覧の並び順：'name'（名前順）| 'name-desc'（名前の逆順）| 'added'（選んだ順）
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
};

loadPrefs();

/* =========================================================
 * キャンバス
 * ======================================================= */

function makeCanvas(w, h, colorSpace = state.colorSpace) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c._cs = colorSpace;
  return c;
}

function ctx2d(c) {
  return c.getContext('2d', { colorSpace: c._cs || state.colorSpace, willReadFrequently: true });
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

  // 作業台の上に置いた紙のように、画像の下へ薄い影を付ける
  // トリミングしてある画像は、隠す・書き込む画面では切り抜いた範囲だけを表示する
  const cim = curImage();
  const clip = state.mode !== 'crop' && cim?.crop ? cim.crop : null;
  const vr = clip || { x: 0, y: 0, w: state.W, h: state.H };
  const ir = [Math.round((tx + vr.x * s) * dpr), Math.round((ty + vr.y * s) * dpr), Math.round(vr.w * s * dpr), Math.round(vr.h * s * dpr)];
  g.save();
  g.shadowColor = 'rgba(20, 30, 50, 0.22)';
  g.shadowBlur = 14 * dpr;
  g.shadowOffsetY = 3 * dpr;
  g.fillStyle = '#fff';
  g.fillRect(...ir);
  g.restore();
  // 透明部分の市松模様（画面座標）
  checker ||= makeChecker();
  g.fillStyle = checker;
  g.fillRect(...ir);

  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
  g.imageSmoothingEnabled = s < 2;
  g.imageSmoothingQuality = 'high';
  if (clip) {
    g.save();
    g.beginPath();
    g.rect(clip.x, clip.y, clip.w, clip.h);
    g.clip();
  }
  g.drawImage(state.work, 0, 0);
  if (state.preview && state.mode === 'hide') g.drawImage(state.preview.canvas, state.preview.x, state.preview.y);
  const annos = curAnnos();
  if (annos.length) drawAnnos(g, annos);
  if (clip) g.restore();
  if (state.mode === 'crop') drawCropOverlay(g, s);
  if (state.mode === 'write') {
    const o = selectedAnno();
    if (o) drawAnnoSelection(g, o, s);
  }

  // 選択範囲
  const drawing = gesture?.type === 'lasso';
  const sel = state.mode !== 'hide' ? null : drawing ? { type: 'lasso', pts: gesture.pts } : state.sel;
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
      g.fillStyle = 'rgba(61,72,184,0.14)';
      g.fill();
    }
    g.lineWidth = lw * 2;
    g.setLineDash([]);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.stroke();
    g.lineWidth = lw;
    g.setLineDash([6 / s, 4 / s]);
    g.strokeStyle = MODE_COLORS.hide;
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
      g.strokeStyle = MODE_COLORS.hide;
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
  const im = curImage();
  const crop = state.mode === 'crop';
  // トリミング画面では画像全体を、左右の「前へ・次へ」と大きさの表示に重ならない余白をとって表示する
  const r = !crop && im?.crop ? im.crop : { x: 0, y: 0, w: state.W, h: state.H };
  // 左右の「前へ・次へ」（幅44px）と枠の辺の間を24px以上あける
  const s = Math.min((w - (crop ? 136 : 24)) / r.w, (h - (crop ? 76 : 24)) / r.h, 8);
  state.view = { s, tx: (w - r.w * s) / 2 - r.x * s, ty: (h - r.h * s) / 2 - r.y * s + (crop ? 14 : 0) };
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
  setStageBusy(true);

  if (pointers.size === 2) {
    // 2本目の指: 描きかけを取り消してピンチ操作へ
    if (gesture?.restore !== undefined) {
      state.sel = gesture.restore;
      if (state.sel) schedulePreview();
    }
    if (gesture?.snap && gesture.changed) {
      curImage().annos = gesture.snap.annos; // 書き込みの移動などを取り消す
      curImage().crop = gesture.snap.crop; // トリミングの変更も取り消す
      syncProps();
      syncCropPanel();
    }
    const { mid, dist } = pinchInfo();
    gesture = { type: 'pinch', mid, dist, view: { ...state.view } };
    requestDraw();
    return;
  }
  if (pointers.size > 2) return;

  const [sx, sy] = localPos(e);
  const p = toImage(sx, sy);
  const forcePan = spaceDown || e.button === 1 || e.button === 2;
  if (state.mode === 'write' && !forcePan) {
    writePointerDown(p, sx, sy);
    return;
  }
  if (state.mode === 'crop' && !forcePan) {
    cropPointerDown(p);
    return;
  }
  const tool = forcePan ? 'pan' : state.tool;

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
    case 'c-move':
    case 'c-resize':
    case 'c-new':
      cropPointerMove(toImage(sx, sy));
      break;
    case 'a-move':
    case 'a-resize':
    case 'a-rotate':
    case 'a-tail':
    case 'a-end1':
    case 'a-end2':
      writePointerMove(toImage(sx, sy));
      break;
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
  if (!pointers.size) setStageBusy(false);
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (pointers.size === 0) gesture = null;
    return; // 1本残っていても描画は始めない
  }
  const g = gesture;
  gesture = null;
  if (g.type.startsWith('c-')) {
    if (g.changed && JSON.stringify(curImage().crop) !== JSON.stringify(g.snap.crop)) {
      pushHistory(curImage(), g.snap);
      markChanged();
    }
    syncCropPanel();
    return;
  }
  if (g.type.startsWith('a-')) {
    if (g.changed) {
      pushHistory(curImage(), g.snap);
      markChanged();
      syncProps();
    }
    requestDraw();
    return;
  }
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
  if (e.target.closest?.('input, textarea, select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); }
  else if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepImage(e.key === 'ArrowLeft' ? -1 : 1); }
  else if (state.mode === 'write') {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteAnno(); }
    else if (e.key === 'Escape') { state.annoSel = null; syncProps(); requestDraw(); }
  }
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
  pushHistory();
  if (p) ctx2d(state.work).putImageData(p.data, p.x, p.y);
  state.ops.push(op);
  state.sel = null;
  markChanged();
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

/* =========================================================
 * 元に戻す（隠す・書き込むの共通の履歴）
 * ======================================================= */

function snapshot(im) {
  return { ops: im.ops.slice(), annos: structuredClone(im.annos), crop: im.crop ? { ...im.crop } : null };
}

function pushHistory(im = curImage(), snap = im && snapshot(im)) {
  if (!im) return;
  im.undo.push(snap);
  if (im.undo.length > 200) im.undo.shift();
  im.redo.length = 0;
  lastEdit = null;
}

function restoreSnapshot(im, snap) {
  const opsChanged = snap.ops.length !== im.ops.length || snap.ops.some((o, i) => o !== im.ops[i]);
  im.ops.length = 0;
  im.ops.push(...snap.ops);
  im.annos = snap.annos;
  im.crop = snap.crop ?? null;
  if (opsChanged && im === curImage()) rebuild();
  if (im === curImage()) syncCropPanel();
  if (!im.annos.some((a) => a.id === state.annoSel)) state.annoSel = null;
}

function undo() {
  const im = curImage();
  if (!im?.undo.length) return;
  im.redo.push(snapshot(im));
  restoreSnapshot(im, im.undo.pop());
  lastEdit = null;
  markChanged();
  syncProps();
  schedulePreview();
  requestDraw();
}

function redo() {
  const im = curImage();
  if (!im?.redo.length) return;
  im.undo.push(snapshot(im));
  restoreSnapshot(im, im.redo.pop());
  lastEdit = null;
  markChanged();
  syncProps();
  schedulePreview();
  requestDraw();
}

/* =========================================================
 * 書き込む（文字・吹き出し・矢印・枠・スタンプ）
 * ======================================================= */

const ROT_GAP = 30;
const MODE_COLORS = { hide: '#3d48b8', write: '#0e8a85', crop: '#a16207' }; // style.css の配色と合わせる // 回転ハンドルまでの距離（画面上 px）
const PALETTE = ['#000000', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ff2d55'];

const curAnnos = () => curImage()?.annos ?? [];
const selectedAnno = () => curAnnos().find((a) => a.id === state.annoSel) || null;

// 続けて同じ項目を変えたときは「元に戻す」1回分にまとめる
let lastEdit = null;
function editAnno(key, fn) {
  const o = selectedAnno();
  if (!o) return;
  const now = Date.now();
  if (!lastEdit || lastEdit.key !== key || lastEdit.id !== o.id || now - lastEdit.t > 1500) pushHistory();
  fn(o);
  if (o.type === 'bubble' && ['text', 'size', 'font', 'bold', 'vertical', 'shape', 'style', 'n', 'depth', 'preset'].includes(key)) fitBubble(o);
  lastEdit = { key, id: o.id, t: now };
  markChanged();
  requestDraw();
}

function addAnno(type) {
  const im = curImage();
  if (!im) return;
  const { w, h } = viewSize();
  const base = Math.min(im.W, im.H);
  const c = toImage(w / 2, h / 2);
  const off = (im.annos.length % 5) * base * 0.04; // 続けて追加しても重ならないよう少しずらす
  const x = Math.min(im.W * 0.9, Math.max(im.W * 0.1, c[0] + off));
  const y = Math.min(im.H * 0.9, Math.max(im.H * 0.1, c[1] + off));
  const o = createAnno(type, [x, y], base);
  pushHistory();
  im.annos.push(o);
  state.annoSel = o.id;
  propTab = 'text';
  markChanged();
  syncProps();
  requestDraw();
  if (type === 'text' || type === 'bubble') {
    const t = $('pText');
    t.focus({ preventScroll: true });
    t.select();
  }
}

function writePointerDown(p, sx, sy) {
  const im = curImage();
  const s = state.view.s;
  const tol = 22 / s;
  const snap = snapshot(im);
  const o = selectedAnno();
  if (o) {
    // 一番近いハンドル。縮小表示で部品が小さいときは、部品の中心の方が近ければ移動を優先する
    const cx = o.type === 'arrow' ? (o.x1 + o.x2) / 2 : o.x, cy = o.type === 'arrow' ? (o.y1 + o.y2) / 2 : o.y;
    const dc = Math.hypot(p[0] - cx, p[1] - cy);
    let best = null, bd = Infinity;
    for (const hd of annoHandles(o, ROT_GAP / s)) {
      const d = Math.hypot(p[0] - hd.x, p[1] - hd.y);
      if (d < bd) { bd = d; best = hd; }
    }
    if (best && bd <= tol && bd < dc) {
      gesture = { type: 'a-' + best.kind, start: p, orig: structuredClone(o), snap, changed: false };
      return;
    }
  }
  for (let i = im.annos.length - 1; i >= 0; i--) {
    const a = im.annos[i];
    if (hitAnno(a, p[0], p[1], 8 / s)) {
      if (state.annoSel !== a.id) {
        state.annoSel = a.id;
        syncProps();
      }
      gesture = { type: 'a-move', start: p, orig: structuredClone(a), snap, changed: false };
      requestDraw();
      return;
    }
  }
  if (state.annoSel) {
    state.annoSel = null;
    syncProps();
  }
  gesture = { type: 'pan', start: [sx, sy], view: { ...state.view } };
  requestDraw();
}

function writePointerMove(p) {
  const o = selectedAnno();
  if (!o) return;
  const g0 = gesture.orig;
  const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
  if (!gesture.changed && Math.hypot(dx, dy) * state.view.s < 2) return; // タップでは動かさない
  gesture.changed = true;
  switch (gesture.type) {
    case 'a-move':
      if (o.type === 'arrow') Object.assign(o, { x1: g0.x1 + dx, y1: g0.y1 + dy, x2: g0.x2 + dx, y2: g0.y2 + dy });
      else Object.assign(o, { x: g0.x + dx, y: g0.y + dy });
      break;
    case 'a-end1':
      Object.assign(o, { x1: p[0], y1: p[1] });
      break;
    case 'a-end2':
      Object.assign(o, { x2: p[0], y2: p[1] });
      break;
    case 'a-rotate': {
      let a = Math.atan2(p[1] - o.y, p[0] - o.x) + Math.PI / 2;
      const q = Math.PI / 2, r = Math.round(a / q) * q;
      if (Math.abs(a - r) < 0.07) a = r; // 0°・90°…に吸い付く
      o.rot = a;
      break;
    }
    case 'a-tail': {
      const [lx, ly] = toLocal(o, p[0], p[1]);
      o.tail = { x: lx, y: ly };
      break;
    }
    case 'a-resize': {
      const [l0x, l0y] = toLocal(g0, gesture.start[0], gesture.start[1]);
      const [lx, ly] = toLocal(g0, p[0], p[1]);
      if (o.type === 'text' || o.type === 'stamp') {
        const k = Math.hypot(lx, ly) / Math.max(1, Math.hypot(l0x, l0y));
        o.size = Math.max(4, Math.round(g0.size * k));
        $('pSize').value = o.size;
      } else {
        o.w = Math.max(8, Math.round((g0.w * Math.abs(lx)) / Math.max(1, Math.abs(l0x))));
        o.h = Math.max(8, Math.round((g0.h * Math.abs(ly)) / Math.max(1, Math.abs(l0y))));
        if (g0.tail) o.tail = { x: (g0.tail.x * o.w) / g0.w, y: (g0.tail.y * o.h) / g0.h };
      }
      break;
    }
  }
}

function drawAnnoSelection(g, o, s) {
  g.save();
  const out = annoOutline(o);
  if (out) {
    g.beginPath();
    out.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.lineWidth = 3 / s;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.stroke();
    g.lineWidth = 1.5 / s;
    g.setLineDash([5 / s, 4 / s]);
    g.strokeStyle = MODE_COLORS.write;
    g.stroke();
    g.setLineDash([]);
  }
  for (const hd of annoHandles(o, ROT_GAP / s)) {
    g.lineWidth = 1.5 / s;
    g.strokeStyle = MODE_COLORS.write;
    if (hd.kind === 'rotate') {
      g.beginPath();
      g.moveTo(hd.from[0], hd.from[1]);
      g.lineTo(hd.x, hd.y);
      g.stroke();
    }
    g.beginPath();
    if (hd.kind === 'resize') {
      const r = 5 / s;
      g.rect(hd.x - r, hd.y - r, r * 2, r * 2);
      g.fillStyle = '#fff';
    } else {
      g.arc(hd.x, hd.y, (hd.kind === 'rotate' ? 7 : 6.5) / s, 0, Math.PI * 2);
      g.fillStyle = hd.kind === 'tail' ? MODE_COLORS.write : '#fff';
    }
    g.fill();
    g.stroke();
  }
  g.restore();
}

/** 保存用に、編集後の画像へ書き込みを重ねたキャンバスを作る（書き込みがなければそのまま） */
/** 保存用のキャンバス：編集後の画像に書き込みを重ね、トリミングの範囲で切り抜く（どちらもなければそのまま） */
function withAnnos(work, im) {
  if (!im.annos.length && !im.crop) return { canvas: work, temp: false };
  const r = cropOf(im);
  const c = makeCanvas(r.w, r.h, work._cs);
  const g = ctx2d(c);
  g.putImageData(ctx2d(work).getImageData(r.x, r.y, r.w, r.h), 0, 0); // 元のピクセルをそのまま写す
  if (im.annos.length) {
    g.save();
    g.translate(-r.x, -r.y);
    drawAnnos(g, im.annos);
    g.restore();
  }
  return { canvas: c, temp: true };
}

async function encodeWithAnnos(work, im) {
  const { canvas, temp } = withAnnos(work, im);
  try {
    return await encode(canvas, im.format);
  } finally {
    if (temp) releaseCanvas(canvas);
  }
}

/* ---------- 設定欄 ---------- */

const ALIGN_LABELS = {
  h: { start: '左揃え', center: '中央揃え', end: '右揃え' },
  v: { start: '上揃え', center: '中央揃え', end: '下揃え' },
};

function setPressed(id, on) {
  $(id).setAttribute('aria-pressed', String(!!on));
}

function updateWriteHint() {
  const o = state.mode === 'write' ? selectedAnno() : null;
  let t = '下のボタンで追加。部品をタップで選択、何もない所のドラッグで画面移動、2本指で拡大';
  if (o?.type === 'arrow') t = 'ドラッグで移動、両端の丸で向きと長さを変更';
  else if (o) t = 'ドラッグで移動、四隅で拡大縮小、上の丸で回転' + (o.type === 'bubble' ? '、塗りつぶした丸でしっぽ' : '');
  $('writeHint').textContent = state.work ? t : '';
}

let propTab = 'text';

function syncProps() {
  const o = state.mode === 'write' ? selectedAnno() : null;
  $('propPanel').hidden = !o;
  updateWriteHint();
  if (!o) {
    document.body.classList.remove('anno-selected');
    return;
  }
  document.body.classList.toggle('anno-selected', true);
  for (const el of $('propPanel').querySelectorAll('[data-for]')) {
    const tabOk = o.type !== 'bubble' || !el.dataset.tab || el.dataset.tab === propTab;
    el.hidden = !el.dataset.for.split(' ').includes(o.type) || !tabOk;
  }
  for (const b of $('pTabs').children) b.setAttribute('aria-checked', String(b.dataset.tab === propTab));
  if ('text' in o && document.activeElement !== $('pText')) $('pText').value = o.text;
  if (o.font) $('pFont').value = o.font;
  if (o.size) $('pSize').value = Math.round(o.size);
  setPressed('pBold', o.bold);
  setPressed('pVertical', o.vertical);
  $('pAlign').textContent = ALIGN_LABELS[o.vertical ? 'v' : 'h'][o.align || 'center'];
  for (const pal of $('propPanel').querySelectorAll('.pal')) {
    const v = o[pal.dataset.prop] ?? '';
    for (const c of pal.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c.dataset.c === v));
    const ci = pal.querySelector('input[type="color"]');
    if (v) ci.value = v;
  }
  for (const b of $('pShape').children) b.setAttribute('aria-checked', String(b.dataset.v === o.shape));
  if (o.type === 'bubble' && !$('shapeDetail').hidden) syncShapeDetail(o);
  for (const b of $('pFrameShape').children) b.setAttribute('aria-checked', String(b.dataset.v === o.shape));
  $('pLineWidth').value = Math.round(o.lineWidth ?? 0);
  $('pWidth').value = Math.round(o.width ?? 1);
  setPressed('pDouble', o.double);
  for (const b of $('pStamps').children) b.setAttribute('aria-pressed', String(b.dataset.c === o.char));
}

function buildWriteControls() {
  for (const pal of document.querySelectorAll('#propPanel .pal')) {
    const prop = pal.dataset.prop;
    const chips = [];
    if (pal.dataset.none) chips.push(Object.assign(document.createElement('button'), { type: 'button', className: 'chip none', title: 'なし' }));
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.c = c;
      b.style.background = c;
      b.setAttribute('aria-label', c);
      chips.push(b);
    }
    if (pal.dataset.none) chips[0].dataset.c = '';
    const ci = document.createElement('input');
    ci.type = 'color';
    ci.setAttribute('aria-label', '任意の色');
    pal.append(...chips, ci);
    pal.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      editAnno(prop, (o) => { o[prop] = b.dataset.c || null; });
      syncProps();
    });
    ci.addEventListener('input', () => {
      editAnno(prop, (o) => { o[prop] = ci.value; });
      syncProps();
    });
  }
  $('pStamps').append(
    ...STAMPS.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.c = c;
      b.textContent = c;
      return b;
    }),
  );
  $('pStamps').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    editAnno('char', (o) => { o.char = b.dataset.c; });
    syncProps();
  });

  $('addRow').addEventListener('click', (e) => {
    const t = e.target.closest('[data-add]')?.dataset.add;
    if (t && state.work) addAnno(t);
  });
  $('pText').addEventListener('input', (e) => editAnno('text', (o) => { o.text = e.target.value; }));
  $('pFont').addEventListener('change', (e) => editAnno('font', (o) => { o.font = e.target.value; }));
  const num = (id, key, min, fn) => {
    $(id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= min) editAnno(key, (o) => fn(o, v));
    });
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  };
  num('pSize', 'size', 4, (o, v) => { o.size = v; });
  num('pLineWidth', 'lineWidth', 0, (o, v) => { o.lineWidth = v; });
  num('pWidth', 'width', 1, (o, v) => { o.width = v; });
  $('pBold').addEventListener('click', () => { editAnno('bold', (o) => { o.bold = !o.bold; }); syncProps(); });
  $('pDouble').addEventListener('click', () => { editAnno('double', (o) => { o.double = !o.double; }); syncProps(); });
  $('pVertical').addEventListener('click', () => {
    editAnno('vertical', (o) => {
      o.vertical = !o.vertical;
      // 吹き出しは縦長／横長を入れ替える
      if (o.type === 'bubble' && (o.vertical ? o.w > o.h : o.h > o.w)) [o.w, o.h] = [o.h, o.w];
    });
    syncProps();
  });
  $('pAlign').addEventListener('click', () => {
    const next = { start: 'center', center: 'end', end: 'start' };
    editAnno('align', (o) => { o.align = next[o.align || 'center']; });
    syncProps();
  });
  for (const [id, key] of [['pShape', 'shape'], ['pFrameShape', 'shape']]) {
    $(id).addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (!v) return;
      editAnno(key, (o) => {
        o.shape = v;
        // 叫び・思考に切り替えたときは、その種類の初期値にする
        if (o.type === 'bubble' && (v === 'shout' || v === 'thought')) {
          const st = shapeParams(o).style;
          if (o.style !== st) Object.assign(o, { style: st, ...STYLE_DEFAULTS[st] });
        }
      });
      syncProps();
    });
  }
  $('pTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]')?.dataset.tab;
    if (t) { propTab = t; syncProps(); }
  });
  $('pDelete').addEventListener('click', deleteAnno);
  $('pDup').addEventListener('click', () => {
    const o = selectedAnno();
    if (!o) return;
    const im = curImage();
    const d = Math.min(im.W, im.H) * 0.03;
    const c = { ...structuredClone(o), id: Math.random().toString(36).slice(2, 10) };
    if (c.type === 'arrow') { c.x1 += d; c.y1 += d; c.x2 += d; c.y2 += d; } else { c.x += d; c.y += d; }
    pushHistory();
    im.annos.push(c);
    state.annoSel = c.id;
    markChanged();
    syncProps();
    requestDraw();
  });
  $('pFront').addEventListener('click', () => {
    const im = curImage(), o = selectedAnno();
    if (!o || im.annos.at(-1) === o) return;
    pushHistory();
    im.annos.splice(im.annos.indexOf(o), 1);
    im.annos.push(o);
    markChanged();
    requestDraw();
  });
  $('pDone').addEventListener('click', () => {
    state.annoSel = null;
    syncProps();
    requestDraw();
  });
  $('modeSeg').addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) setMode(m);
  });
}

/* =========================================================
 * 吹き出しの形の調整と登録
 * ======================================================= */

const PRESET_KEY = 'mosaic-bubble-presets';
const SHAPE_LABELS = { round: '角丸', ellipse: '楕円', rect: '四角', shout: '叫び', thought: '思考' };
let userPresets = loadPresets();

function loadPresets() {
  try {
    const a = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    return Array.isArray(a) ? a.map(sanitizePreset).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function storePresets() {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(userPresets));
    return true;
  } catch {
    toast('この端末に保存できませんでした（プライベートブラウズでは保存できません）', true);
    return false;
  }
}

/** 読み込んだ登録データを、知っている項目・正しい値だけに絞る */
function sanitizePreset(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !SHAPE_LABELS[p.shape]) return null;
  const color = (v) => (v === null || /^#[0-9a-f]{6}$/i.test(v ?? '') ? v : undefined);
  const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
  const out = {
    id: typeof p.id === 'string' ? p.id.slice(0, 20) : Math.random().toString(36).slice(2, 10),
    name: p.name.slice(0, 40),
    shape: p.shape,
    style: Object.values(BUBBLE_STYLES).flat().some((x) => x.style === p.style) ? p.style : undefined,
    n: num(p.n, 3, 80),
    depth: num(p.depth, 0, 1),
    irr: num(p.irr, 0, 1),
    seed: num(p.seed, 1, 2 ** 31),
    fill: color(p.fill),
    line: color(p.line),
    color: color(p.color),
    outline: color(p.outline),
    font: ['gothic', 'mincho', 'maru'].includes(p.font) ? p.font : undefined,
    bold: typeof p.bold === 'boolean' ? p.bold : undefined,
    vertical: typeof p.vertical === 'boolean' ? p.vertical : undefined,
    align: ['start', 'center', 'end'].includes(p.align) ? p.align : undefined,
    wR: num(p.wR, 0.01, 10),
    hR: num(p.hR, 0.01, 10),
    lineWidthR: num(p.lineWidthR, 0, 1),
    sizeR: num(p.sizeR, 0.001, 2),
    tailR: p.tailR && Number.isFinite(p.tailR.x) && Number.isFinite(p.tailR.y) ? { x: num(p.tailR.x, -10, 10), y: num(p.tailR.y, -10, 10) } : undefined,
  };
  if (out.seed) out.seed = Math.round(out.seed);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function presetLabel(o) {
  if (o.shape === 'shout' || o.shape === 'thought') {
    const sp = shapeParams(o);
    const st = BUBBLE_STYLES[o.shape].find((x) => x.style === sp.style);
    return `${SHAPE_LABELS[o.shape]}・${st.label}`;
  }
  return SHAPE_LABELS[o.shape] || '吹き出し';
}

function defaultPresetName(o) {
  const head = presetLabel(o);
  let i = 1;
  while (userPresets.some((p) => p.name === `${head}${i}`)) i++;
  return `${head}${i}`;
}

function setRange(rid, nid, min, max, v) {
  for (const id of [rid, nid]) {
    const el = $(id);
    el.min = min;
    el.max = max;
    el.value = v;
  }
}

/** 叫び・思考の調整欄を、選択中の吹き出しに合わせる */
function syncShapeDetail(o) {
  const fancy = o.shape === 'shout' || o.shape === 'thought';
  if (!fancy) {
    $('shapeDetail').hidden = true;
    return;
  }
  const sp = shapeParams(o);
  const isShout = o.shape === 'shout';
  $('pStyle').replaceChildren(
    ...BUBBLE_STYLES[o.shape].map((x) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = x.style;
      b.textContent = x.label;
      b.setAttribute('aria-checked', String(x.style === sp.style));
      return b;
    }),
  );
  $('pNLabel').textContent = isShout ? 'トゲの数' : 'ふくらみの数';
  setRange('pN', 'pNNum', isShout ? 6 : 5, isShout ? 48 : 24, sp.n);
  $('pDepthRow').hidden = sp.style === 'puffs';
  $('pDepthLabel').textContent = isShout ? 'トゲの長さ' : 'ふくらみ';
  setRange('pDepth', 'pDepthNum', 5, isShout ? 60 : 30, Math.round(sp.depth * 100));
  setRange('pIrr', 'pIrrNum', 0, 100, Math.round(sp.irr * 100));
}

function buildShapeControls() {
  $('pStyle').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    editAnno('style', (o) => Object.assign(o, { style: v, ...STYLE_DEFAULTS[v], seed: o.seed || 1 }));
    syncProps();
  });
  const pair = (rid, nid, key, conv) => {
    const set = (raw, fromRange) => {
      let v = Number(raw);
      if (!Number.isFinite(v)) return;
      v = Math.min(+$(rid).max, Math.max(+$(rid).min, Math.round(v)));
      editAnno(key, (o) => {
        Object.assign(o, shapeParams(o)); // 初期値のままの項目も記録しておく
        o[key] = conv(v);
      });
      $(fromRange ? nid : rid).value = v;
    };
    $(rid).addEventListener('input', (e) => set(e.target.value, true));
    $(nid).addEventListener('change', (e) => set(e.target.value, false));
    $(nid).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  };
  pair('pN', 'pNNum', 'n', (v) => v);
  pair('pDepth', 'pDepthNum', 'depth', (v) => v / 100);
  pair('pIrr', 'pIrrNum', 'irr', (v) => v / 100);
  $('pReseed').addEventListener('click', () => {
    editAnno('seed', (o) => {
      Object.assign(o, shapeParams(o));
      o.seed = 1 + Math.floor(Math.random() * 2 ** 30);
    });
    lastEdit = null; // 押すたびに「元に戻す」で1つ前の形へ戻れるようにする
  });

  $('pPresetBtn').addEventListener('click', openPresets);
  $('presetSaveBtn').addEventListener('click', savePreset);
  $('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); savePreset(); } });
  $('presetUser').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const p = userPresets.find((x) => x.id === del.dataset.del);
      if (p && confirm(`「${p.name}」を削除しますか？`)) {
        userPresets = userPresets.filter((x) => x !== p);
        storePresets();
        renderPresets();
      }
      return;
    }
    const it = e.target.closest('[data-id]');
    const p = it && userPresets.find((x) => x.id === it.dataset.id);
    if (p) usePreset(p);
  });
  $('presetBuiltin').addEventListener('click', (e) => {
    const it = e.target.closest('[data-index]');
    if (it) usePreset({ ...BUILTIN_PRESETS[+it.dataset.index], builtin: true });
  });
  $('presetExportBtn').addEventListener('click', exportPresets);
  $('presetImportBtn').addEventListener('click', () => $('presetFile').click());
  $('presetFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importPresets(await f.text());
  });
}

function openPresets() {
  const o = selectedAnno();
  if (!o || o.type !== 'bubble') return;
  $('presetName').value = defaultPresetName(o);
  renderPresets();
  $('presetDlg').showModal();
}

function presetItem(p, attrs, deletable) {
  const b = document.createElement('div');
  b.className = 'preset-item';
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  for (const [k, v] of Object.entries(attrs)) b.dataset[k] = v;
  const c = document.createElement('canvas');
  c.width = 120 * 2;
  c.height = 84 * 2;
  drawPresetThumb(c, p);
  const span = document.createElement('span');
  span.textContent = p.name;
  b.append(c, span);
  if (deletable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'del';
    x.dataset.del = p.id;
    x.textContent = '×';
    x.setAttribute('aria-label', `${p.name} を削除`);
    b.append(x);
  }
  return b;
}

function renderPresets() {
  $('presetUser').replaceChildren(...userPresets.map((p) => presetItem(p, { id: p.id }, true)));
  $('presetEmpty').hidden = userPresets.length > 0;
  $('presetExportBtn').disabled = userPresets.length === 0;
  if (!$('presetBuiltin').children.length) {
    $('presetBuiltin').replaceChildren(...BUILTIN_PRESETS.map((p, i) => presetItem({ ...p, builtin: true }, { index: i }, false)));
  }
}

function savePreset() {
  const o = selectedAnno();
  if (!o || o.type !== 'bubble') return;
  const name = $('presetName').value.trim().slice(0, 40);
  if (!name) {
    toast('名前を入れてください', true);
    return;
  }
  const im = curImage();
  const p = sanitizePreset({ ...presetFromBubble(o, Math.min(im.W, im.H)), name, id: Math.random().toString(36).slice(2, 10) });
  const same = userPresets.findIndex((x) => x.name === name);
  if (same >= 0) {
    if (!confirm(`「${name}」はすでにあります。上書きしますか？`)) return;
    userPresets[same] = p;
  } else userPresets.push(p);
  if (storePresets()) {
    renderPresets();
    $('presetName').value = defaultPresetName(o);
    toast(`「${name}」を登録しました`);
  }
}

function usePreset(p) {
  const o = selectedAnno();
  if (!o || o.type !== 'bubble') return;
  const im = curImage();
  editAnno('preset', (a) => applyPreset(a, p, Math.min(im.W, im.H)));
  lastEdit = null;
  syncProps();
  $('presetDlg').close();
  toast(`「${p.name}」を当てはめました`);
}

async function exportPresets() {
  const json = JSON.stringify({ app: 'mosaic-edit', kind: 'bubble-presets', version: 1, presets: userPresets }, null, 2);
  const file = new File([json], '吹き出し登録.json', { type: 'application/json' });
  if (canShareFiles([file])) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  downloadFile(file);
}

function importPresets(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    toast('読み込めませんでした（形式が違います）', true);
    return;
  }
  const list = (Array.isArray(data) ? data : data?.presets || []).map(sanitizePreset).filter(Boolean);
  if (!list.length) {
    toast('読み込める吹き出しがありませんでした', true);
    return;
  }
  for (const p of list) {
    p.id = Math.random().toString(36).slice(2, 10);
    let name = p.name, i = 2;
    while (userPresets.some((x) => x.name === name)) name = `${p.name}（${i++}）`;
    p.name = name;
    userPresets.push(p);
  }
  if (storePresets()) {
    renderPresets();
    toast(`${list.length}件を読み込みました`);
  }
}

function deleteAnno() {
  const im = curImage(), o = selectedAnno();
  if (!o) return;
  pushHistory();
  im.annos.splice(im.annos.indexOf(o), 1);
  state.annoSel = null;
  markChanged();
  syncProps();
  requestDraw();
}

function setMode(m) {
  if (state.mode === m) return;
  const wasCrop = state.mode === 'crop';
  state.mode = m;
  if (m === 'write') clearPreview();
  else if (m === 'crop') {
    clearPreview();
    state.annoSel = null;
  } else {
    state.annoSel = null;
    schedulePreview();
  }
  syncProps();
  syncCropPanel();
  updateUI();
  if (wasCrop || m === 'crop') fit(); // 表示する範囲が変わるので合わせ直す
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

async function decodeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error();
    return img;
  } catch {
    throw new Error(`${file.name || '画像'}：この形式はこのブラウザでは開けません`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** キャンバスのメモリをすぐに解放する（iPhone の Safari 対策） */
function releaseCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

// 数字は数として比べる（IMG_2 → IMG_10 の順）。大文字・小文字、全角・半角の違いは区別しない
const nameCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** 一覧を並び順の設定に合わせて並べ替える（表示中の画像はそのまま） */
function sortImages() {
  const cur = curImage();
  const dir = state.sortOrder === 'name-desc' ? -1 : 1;
  state.images.sort((a, b) =>
    state.sortOrder === 'added' ? a.id - b.id : dir * (nameCollator.compare(a.file.name, b.file.name) || a.id - b.id),
  );
  state.cur = cur ? state.images.indexOf(cur) : -1;
}

function totalBytes() {
  return state.images.reduce((s, im) => s + im.file.size, 0);
}

let nextId = 1;
let adding = false;

/** 画像を一覧に追加する（上限を超える分は読み込まない） */
async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length || adding) return;
  adding = true;
  let skipped = 0, failed = 0, added = 0, big = 0;
  let bytes = totalBytes();
  const firstNew = state.images.length;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (state.images.length >= MAX_IMAGES || bytes + file.size > MAX_TOTAL_BYTES) { skipped++; continue; }
      toast(`読み込み中… ${i + 1} / ${files.length}`, false, 60_000);
      try {
        const img = await decodeFile(file);
        const W = img.naturalWidth, H = img.naturalHeight;
        const colorSpace = (await detectP3(file)) && supportsP3() ? 'display-p3' : 'srgb';
        const k = Math.min(1, 160 / Math.max(W, H));
        const tc = makeCanvas(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)), 'srgb');
        const tg = tc.getContext('2d');
        tg.imageSmoothingQuality = 'high';
        tg.drawImage(img, 0, 0, tc.width, tc.height);
        const tb = await toBlob(tc, 'image/jpeg', 0.7);
        releaseCanvas(tc);
        if (W * H > IOS_MAX_PIXELS) big++;
        state.images.push({
          id: nextId++, file, format: detectFormat(file), W, H, colorSpace,
          thumb: tb ? URL.createObjectURL(tb) : '',
          ops: [], annos: [], undo: [], redo: [], version: 0, savedVersion: 0,
        });
        bytes += file.size;
        added++;
        renderStrip();
      } catch (err) {
        failed++;
        console.warn(err);
      }
    }
  } finally {
    adding = false;
  }
  const msgs = [];
  if (added) msgs.push(`${added}枚を読み込みました`);
  if (failed) msgs.push(`${failed}枚は開けませんでした`);
  if (skipped) msgs.push(`上限（${MAX_IMAGES}枚・${formatBytes(MAX_TOTAL_BYTES)}）を超えるため ${skipped}枚は読み込みませんでした`);
  if (big) msgs.push(`${big}枚はとても大きいため、iPhoneでは正しく処理できない場合があります`);
  toast(msgs.join('。') || '読み込める画像がありませんでした', !!(failed || skipped || big || !added), (failed || skipped || big) ? 6000 : 2500);
  // 並び順に入れ直し、追加した中で一番前に来た画像を表示する
  const newOnes = state.images.slice(firstNew);
  sortImages();
  if (added) await selectImage(Math.min(...newOnes.map((im) => state.images.indexOf(im))));
  renderStrip();
  updateUI();
}

let selecting = 0;

/** 一覧の i 枚目を編集対象にする。選択中の範囲はそのまま引き継ぐ */
async function selectImage(i) {
  const im = state.images[i];
  if (!im) return;
  const token = ++selecting;
  try {
    const img = await decodeFile(im.file);
    if (token !== selecting) return;
    const prevBase = state.base, prevWork = state.work;
    const base = makeCanvas(im.W, im.H, im.colorSpace);
    const bctx = ctx2d(base);
    if (!bctx) throw new Error('画像が大きすぎて処理できません');
    bctx.drawImage(img, 0, 0);
    const work = makeCanvas(im.W, im.H, im.colorSpace);
    if (!ctx2d(work)) throw new Error('画像が大きすぎて処理できません');
    Object.assign(state, {
      cur: i, file: im.file, format: im.format, W: im.W, H: im.H, colorSpace: im.colorSpace,
      base, work, ops: im.ops, preview: null, annoSel: null,
    });
    rebuild();
    if (prevBase !== base) { releaseCanvas(prevBase); releaseCanvas(prevWork); }
    $('fileName').textContent = im.file.name || '名称未設定';
    $('fileMeta').textContent = `${im.W} × ${im.H} px ・ ${formatLabel(im.format.kind)} ・ ${formatBytes(im.file.size)}${im.colorSpace === 'display-p3' ? ' ・ P3' : ''}`;
    $('empty').hidden = true;
    $('zoomCtl').hidden = false;
    fit();
    renderStrip();
    syncProps();
    syncCropPanel();
    updateUI();
    schedulePreview();
  } catch (err) {
    toast(err.message || String(err), true);
  }
}

/** 一覧から外す */
/** 一覧から外す（1枚） */
function removeImage(i) {
  const im = state.images[i];
  if (!im) return;
  if (isUnsaved(im) && !confirm(`${im.file.name} は保存していない編集があります。一覧から外しますか？`)) return;
  removeImages([im]);
}

/** 一覧からまとめて外す。表示中の画像が外れたときは、近くの画像を表示する */
function removeImages(list) {
  if (!list.length) return;
  const cur = curImage();
  const curIndex = state.cur;
  for (const im of list) if (im.thumb) URL.revokeObjectURL(im.thumb);
  state.images = state.images.filter((im) => !list.includes(im));
  if (!state.images.length) {
    releaseCanvas(state.base);
    releaseCanvas(state.work);
    Object.assign(state, { cur: -1, file: null, format: null, base: null, work: null, ops: [], sel: null, preview: null, annoSel: null });
    syncProps();
    $('fileName').textContent = '画像未選択';
    $('fileMeta').textContent = '';
    $('empty').hidden = false;
    $('zoomCtl').hidden = true;
    renderStrip();
    updateUI();
    requestDraw();
    return;
  }
  if (list.includes(cur)) selectImage(Math.min(curIndex, state.images.length - 1));
  else {
    state.cur = state.images.indexOf(cur);
    renderStrip();
  }
}

function removeSaved() {
  const list = state.images.filter((im) => isEdited(im) && !isUnsaved(im));
  if (!list.length) return;
  if (!confirm(`保存済みの${list.length}枚を一覧から外しますか？（保存したファイルは消えません）`)) return;
  removeImages(list);
  toast(`${list.length}枚を一覧から外しました`);
}

function removeAll() {
  const n = state.images.length;
  if (!n) return;
  const unsaved = state.images.filter(isUnsaved).length;
  const msg = unsaved
    ? `保存していない編集がある画像が${unsaved}枚あります。${n}枚すべてを一覧から外しますか？（外した編集は元に戻せません）`
    : `${n}枚すべてを一覧から外しますか？（保存したファイルは消えません）`;
  if (!confirm(msg)) return;
  removeImages([...state.images]);
  toast(`${n}枚を一覧から外しました`);
}

function formatLabel(kind) {
  return { png: 'PNG', jpeg: 'JPEG', heic: 'HEIC', webp: 'WebP', other: '画像' }[kind];
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

/* =========================================================
 * 一覧（サムネイル）
 * ======================================================= */

const curImage = () => state.images[state.cur];
const isEdited = (im) => im.ops.length > 0 || im.annos.length > 0 || !!im.crop;
const isUnsaved = (im) => isEdited(im) && im.version !== im.savedVersion;

function markChanged() {
  const im = curImage();
  if (im) im.version++;
  renderStrip();
  $('undoBtn').disabled = !im?.undo.length;
  $('redoBtn').disabled = !im?.redo.length;
}

/** サムネイルの下に出す短い名前。全角文字は半角2文字分として、末尾を残して縮める */
function shortName(base, max = 6) {
  const w = (ch) => (/[\u0000-\u00ff]/.test(ch) ? 1 : 2);
  const chars = [...base];
  if (chars.reduce((n, ch) => n + w(ch), 0) <= max) return base;
  let tail = '', n = 0;
  for (let i = chars.length - 1; i >= 0 && n + w(chars[i]) <= max - 1; i--) {
    tail = chars[i] + tail;
    n += w(chars[i]);
  }
  return '…' + tail;
}

function renderStrip() {
  const n = state.images.length;
  if (!n) state.stripOpen = false;
  if (n < 2) $('edgePrev').hidden = $('edgeNext').hidden = true;
  $('strip').hidden = !state.stripOpen;
  $('fileInfoBtn').disabled = n === 0;
  $('fileInfoBtn').setAttribute('aria-expanded', String(!!state.stripOpen));
  $('fileCount').hidden = n === 0;
  $('fileCount').textContent = `${state.cur + 1}/${n}枚`;
  if (!n) return;
  const thumbs = $('thumbs');
  thumbs.replaceChildren(
    ...state.images.map((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb' + (i === state.cur ? ' active' : '');
      b.dataset.index = i;
      b.title = im.file.name;
      b.setAttribute('aria-label', `${i + 1}枚目 ${im.file.name}`);
      if (im.thumb) {
        const img = document.createElement('img');
        img.src = im.thumb;
        img.alt = '';
        b.append(img);
      }
      const badge = document.createElement('span');
      badge.className = 'badge ' + (isUnsaved(im) ? 'edited' : isEdited(im) ? 'saved' : '');
      b.append(badge);
      // ファイル名の末尾（番号の部分が見えるように、長い名前は前を省く）
      const base = im.format.baseName;
      const cap = document.createElement('span');
      cap.className = 'thumb-name';
      cap.textContent = shortName(base);
      b.append(cap);
      if (i === state.cur) {
        const x = document.createElement('span');
        x.className = 'remove';
        x.dataset.remove = i;
        x.setAttribute('aria-label', '一覧から外す');
        x.textContent = '×';
        b.append(x);
      }
      return b;
    }),
  );
  thumbs.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const bytes = totalBytes();
  const ratio = Math.max(n / MAX_IMAGES, bytes / MAX_TOTAL_BYTES);
  $('meterBar').style.width = `${Math.min(100, ratio * 100)}%`;
  $('meter').classList.toggle('high', ratio >= 0.8);
  const mb = (v) => (v / 1048576).toFixed(v < 10 * 1048576 ? 1 : 0);
  $('meterText').textContent = `${n}/${MAX_IMAGES}枚・${mb(bytes)}/${mb(MAX_TOTAL_BYTES)}MB`;
  $('stripCount').textContent = `${state.cur + 1} / ${n}`;
  $('edgePrev').hidden = n < 2 || state.cur <= 0;
  $('edgeNext').hidden = n < 2 || state.cur >= n - 1;
  $('prevBtn').disabled = state.cur <= 0;
  $('nextBtn').disabled = state.cur >= n - 1;
  const edited = state.images.filter(isEdited).length;
  $('batchBtn').disabled = edited === 0;
  $('batchBtn').textContent = edited ? `まとめて保存（${edited}）` : 'まとめて保存';
  $('copyBtn').disabled = !(n > 1 && curImage() && isEdited(curImage()));
  const savedCount = state.images.filter((im) => isEdited(im) && !isUnsaved(im)).length;
  $('removeSavedBtn').disabled = savedCount === 0;
  $('removeSavedBtn').textContent = savedCount ? `保存済みを外す（${savedCount}）` : '保存済みを外す';
}

/* =========================================================
 * 他の画像にも適用
 * ======================================================= */

/** 編集手順を別サイズの画像用に、縦横の比率で位置を合わせる */
function scaleOp(op, kx, ky) {
  const o = structuredClone(op);
  const s = o.sel;
  if (s.type === 'lasso') s.pts = s.pts.map(([x, y]) => [x * kx, y * ky]);
  else Object.assign(s, { x: Math.round(s.x * kx), y: Math.round(s.y * ky), w: Math.round(s.w * kx), h: Math.round(s.h * ky) });
  if (o.effect !== 'fill') o.strength = Math.max(1, Math.round(o.strength * (kx + ky) / 2));
  return o;
}

function openCopy() {
  const src = curImage();
  if (!src || !isEdited(src)) return;
  const list = $('copyList');
  list.replaceChildren(
    ...state.images.map((im, i) => {
      if (i === state.cur) return '';
      const same = im.W === src.W && im.H === src.H;
      const li = document.createElement('label');
      li.className = 'copy-item';
      li.innerHTML = `<input type="checkbox" value="${i}" ${same ? 'checked' : ''}>
        <img alt="" src="${im.thumb}"><span><b></b><small>${im.W} × ${im.H}${same ? '' : '（サイズ違い：比率で位置を合わせます）'}</small></span>`;
      li.querySelector('b').textContent = im.file.name;
      return li;
    }),
  );
  $('copySummary').textContent = '表示中の画像の編集を、選んだ画像の同じ位置に追加します。';
  $('copyOpsN').textContent = `（${src.ops.length}件）`;
  $('copyAnnosN').textContent = `（${src.annos.length}件）`;
  $('copyOps').checked = src.ops.length > 0;
  $('copyOps').disabled = !src.ops.length;
  $('copyAnnos').checked = src.annos.length > 0;
  $('copyAnnos').disabled = !src.annos.length;
  $('copyCropN').textContent = src.crop ? `（${src.crop.w} × ${src.crop.h}）` : '（なし）';
  $('copyCrop').checked = !!src.crop;
  $('copyCrop').disabled = !src.crop;
  updateCopyCount();
  $('copyDlg').showModal();
}

function updateCopyCount() {
  const n = $('copyList').querySelectorAll('input:checked').length;
  $('copyApplyBtn').disabled = n === 0 || !($('copyOps').checked || $('copyAnnos').checked || $('copyCrop').checked);
  $('copyApplyBtn').textContent = `${n}枚に適用`;
}

function applyCopy() {
  const src = curImage();
  const targets = [...$('copyList').querySelectorAll('input:checked')].map((c) => state.images[+c.value]);
  for (const im of targets) {
    const kx = im.W / src.W, ky = im.H / src.H;
    const same = kx === 1 && ky === 1;
    pushHistory(im);
    if ($('copyOps').checked) for (const op of src.ops) im.ops.push(same ? structuredClone(op) : scaleOp(op, kx, ky));
    if ($('copyAnnos').checked) {
      for (const a of src.annos) im.annos.push({ ...(same ? structuredClone(a) : scaleAnno(a, kx, ky)), id: Math.random().toString(36).slice(2, 10) });
    }
    if ($('copyCrop').checked && src.crop) {
      const c = src.crop;
      setCrop(im, { x: c.x * kx, y: c.y * ky, w: c.w * kx, h: c.h * ky });
    }
    im.version++;
  }
  $('copyDlg').close();
  renderStrip();
  toast(`${targets.length}枚に適用しました。ずれた画像は開いて「元に戻す」で取り消せます`);
}

/* =========================================================
 * 保存
 * ======================================================= */

function toBlob(canvas, mime, q) {
  return new Promise((res) => canvas.toBlob(res, mime, q));
}

/** 元の形式で書き出す。対応していない形式は近い形式に切り替える */
async function encode(canvas, format) {
  const plans = {
    png: [['image/png']],
    jpeg: [['image/jpeg', JPEG_QUALITY]],
    heic: [['image/heic', JPEG_QUALITY], ['image/jpeg', JPEG_QUALITY]],
    webp: [['image/webp', JPEG_QUALITY], ['image/png']],
    other: [['image/png']],
  }[format.kind];
  for (const [mime, q] of plans) {
    const blob = await toBlob(canvas, mime, q);
    if (blob && blob.type === mime) return { blob, mime };
  }
  throw new Error('画像の書き出しに失敗しました');
}

function extFor(mime, f) {
  const keep = (list, fallback) => (list.includes(f.ext) ? f.rawExt : fallback);
  switch (mime) {
    case 'image/png': return keep(['png'], 'png');
    case 'image/jpeg': return keep(['jpg', 'jpeg', 'jpe', 'jfif'], 'jpg');
    case 'image/heic': return keep(['heic', 'heif', 'hif'], 'heic');
    case 'image/webp': return keep(['webp'], 'webp');
  }
  return 'png';
}

const kindOfMime = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/heic': 'heic', 'image/webp': 'webp' })[mime];

function sanitizeName(s) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
}

/** 表示していない画像を、元ファイルと編集手順から書き出す */
async function renderAndEncode(im) {
  if (im === curImage() && state.work) return encodeWithAnnos(state.work, im);
  const img = await decodeFile(im.file);
  const c = makeCanvas(im.W, im.H, im.colorSpace);
  const g = ctx2d(c);
  if (!g) throw new Error(`${im.file.name}：画像が大きすぎて処理できません`);
  g.drawImage(img, 0, 0);
  const mk = (w, h) => makeCanvas(w, h, im.colorSpace);
  for (const op of im.ops) {
    const p = computePatch(g, im.W, im.H, op, mk);
    if (p) g.putImageData(p.data, p.x, p.y);
  }
  const out = withAnnos(c, im);
  try {
    return await encode(out.canvas, im.format);
  } finally {
    if (out.temp) releaseCanvas(out.canvas);
    releaseCanvas(c);
  }
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const canShareFiles = (files) => !!navigator.canShare?.({ files });

/* ---------- 1枚ずつ保存 ---------- */

let saveResult = null;

async function openSave() {
  if (!state.work) return;
  if (state.sel && !confirm('選択中の範囲はまだ適用されていません。このまま保存しますか？')) return;
  const dlg = $('saveDlg');
  $('nameInput').value = state.format.baseName;
  $('shareBtn').disabled = true;
  $('downloadBtn').disabled = true;
  $('formatNote').innerHTML = '<li>書き出し中…</li>';
  saveResult = null;
  dlg.showModal();
  try {
    saveResult = { ...(await encodeWithAnnos(state.work, curImage())), im: curImage(), version: curImage().version };
  } catch (err) {
    $('formatNote').innerHTML = `<li class="warn">${err.message}</li>`;
    return;
  }
  const { blob, mime } = saveResult;
  $('extLabel').textContent = '.' + extFor(mime, state.format);
  $('formatNote').innerHTML = formatNotes(state.format, mime, `${cropOf(curImage()).w} × ${cropOf(curImage()).h} px ・ ${formatBytes(blob.size)}${curImage().crop ? '（トリミング後）' : ''}`);
  $('shareBtn').disabled = false;
  $('downloadBtn').disabled = false;
  $('shareBtn').hidden = !canShareFiles([new File([blob], 'x.' + extFor(mime, state.format), { type: mime })]);
}

function formatNotes(format, mime, extra) {
  const notes = [];
  const outKind = kindOfMime(mime);
  if (outKind !== format.kind) {
    notes.push(`<li class="warn">このブラウザは${formatLabel(format.kind)}で保存できないため、${formatLabel(outKind)}で保存します（拡張子も変わります）</li>`);
  }
  if (mime === 'image/png') notes.push('<li>PNG：劣化なし（可逆）で保存します</li>');
  else notes.push(`<li>${formatLabel(outKind)}：品質 ${Math.round(JPEG_QUALITY * 100)}% で保存します</li>`);
  notes.push('<li>撮影日時・位置情報などのメタデータは削除されます</li>');
  if (extra) notes.push(`<li>${extra}</li>`);
  return notes.join('');
}

function outputFile() {
  const { blob, mime, im } = saveResult;
  const base = sanitizeName($('nameInput').value) || im.format.baseName || 'image';
  return new File([blob], `${base}.${extFor(mime, im.format)}`, { type: mime, lastModified: Date.now() });
}

function markSaved(im, version) {
  if (im.version === version) im.savedVersion = version;
  renderStrip();
}

$('shareBtn').addEventListener('click', async () => {
  if (!saveResult) return;
  const file = outputFile();
  try {
    await navigator.share({ files: [file] });
    markSaved(saveResult.im, saveResult.version);
    $('saveDlg').close();
    toast('保存しました');
  } catch (err) {
    if (err.name !== 'AbortError') toast('共有メニューを開けませんでした。ダウンロードをお試しください', true);
  }
});

$('downloadBtn').addEventListener('click', () => {
  if (!saveResult) return;
  const file = outputFile();
  downloadFile(file);
  markSaved(saveResult.im, saveResult.version);
  $('saveDlg').close();
  toast(`${file.name} をダウンロードしました`);
});

$('resetNameBtn').addEventListener('click', () => {
  $('nameInput').value = state.format.baseName;
});

/* ---------- まとめて保存（自動で数回に分ける） ---------- */

const batch = { queue: [], group: null, preparing: false, done: 0, total: 0, token: 0 };

function batchTargets() {
  const includeSaved = $('includeSaved').checked;
  return state.images.filter((im) => isEdited(im) && (includeSaved || isUnsaved(im)));
}

function openBatch() {
  if (state.sel && !confirm('選択中の範囲はまだ適用されていません。このまま保存しますか？')) return;
  const savedCount = state.images.filter((im) => isEdited(im) && !isUnsaved(im)).length;
  $('includeSavedRow').hidden = savedCount === 0;
  $('includeSaved').checked = false;
  $('batchDlg').showModal();
  startBatch();
}

function startBatch() {
  batch.token++;
  batch.queue = batchTargets();
  batch.total = batch.queue.length;
  batch.done = 0;
  batch.group = null;
  prepareGroup();
}

/** 次の1回分（最大 BATCH_FILES 枚・BATCH_BYTES まで）を書き出す */
async function prepareGroup() {
  const token = batch.token;
  batch.group = null;
  batch.preparing = true;
  renderBatch();
  const items = [];
  let bytes = 0;
  try {
    while (batch.queue.length && items.length < BATCH_FILES && bytes < BATCH_BYTES) {
      const im = batch.queue[0];
      $('batchStatus').textContent = `書き出し中… ${batch.done + items.length + 1} / ${batch.total}枚目`;
      const version = im.version;
      const { blob, mime } = await renderAndEncode(im);
      if (token !== batch.token) return;
      if (items.length && bytes + blob.size > BATCH_BYTES) break; // 次の回へ回す
      batch.queue.shift();
      const file = new File([blob], `${im.format.baseName}.${extFor(mime, im.format)}`, { type: mime, lastModified: Date.now() });
      items.push({ im, version, file, changed: kindOfMime(mime) !== im.format.kind });
      bytes += blob.size;
    }
  } catch (err) {
    if (token !== batch.token) return;
    batch.preparing = false;
    $('batchStatus').textContent = err.message || String(err);
    renderBatch(true);
    return;
  }
  if (token !== batch.token) return;
  batch.preparing = false;
  batch.group = { items, bytes };
  renderBatch();
}

function renderBatch(failed = false) {
  const g = batch.group;
  const remainingAfter = batch.queue.length;
  const rounds = g ? 1 + Math.ceil(remainingAfter / BATCH_FILES) : 0;
  $('batchSummary').textContent = batch.total
    ? `編集した画像 ${batch.total}枚を保存します。一度に渡す量を抑えるため、最大${BATCH_FILES}枚（${formatBytes(BATCH_BYTES)}）ずつに分けて保存します。`
    : '保存する画像はありません。';
  $('batchProgress').style.width = batch.total ? `${(batch.done / batch.total) * 100}%` : '0';
  const share = $('batchShareBtn'), dl = $('batchDownloadBtn');
  if (failed || !batch.total) {
    share.disabled = dl.disabled = true;
    return;
  }
  if (!g) {
    share.disabled = dl.disabled = true;
    share.textContent = '準備中…';
    return;
  }
  if (!g.items.length) {
    $('batchStatus').textContent = `${batch.done}枚すべて保存しました`;
    share.disabled = dl.disabled = true;
    share.textContent = '完了';
    return;
  }
  const first = batch.done + 1, last = batch.done + g.items.length;
  const changed = g.items.filter((x) => x.changed).length;
  $('batchStatus').textContent =
    `${first}〜${last}枚目（${g.items.length}枚・${formatBytes(g.bytes)}）の準備ができました` +
    (rounds > 1 ? `。このあと残り約${rounds - 1}回です` : '') +
    (changed ? `。${changed}枚は元の形式で保存できないため形式が変わります` : '');
  const ok = canShareFiles(g.items.map((x) => x.file));
  share.hidden = !ok;
  share.disabled = false;
  dl.disabled = false;
  share.textContent = `写真・ファイルに保存（${first}〜${last}枚目）`;
}

function finishGroup(g) {
  if (batch.group !== g) return;
  for (const x of g.items) markSaved(x.im, x.version);
  batch.done += g.items.length;
  if (batch.queue.length) prepareGroup();
  else {
    batch.group = { items: [], bytes: 0 };
    renderBatch();
    toast(`${batch.done}枚を保存しました`);
  }
}

let batchBusy = false;
async function runGroup(action) {
  const g = batch.group;
  if (!g?.items.length || batchBusy) return;
  batchBusy = true;
  $('batchShareBtn').disabled = $('batchDownloadBtn').disabled = true;
  try {
    if (await action(g)) finishGroup(g);
    else renderBatch();
  } finally {
    batchBusy = false;
  }
}

$('batchShareBtn').addEventListener('click', () =>
  runGroup(async (g) => {
    try {
      await navigator.share({ files: g.items.map((x) => x.file) });
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') toast('共有メニューを開けませんでした。枚数が多すぎる可能性があります', true);
      return false;
    }
  }),
);

$('batchDownloadBtn').addEventListener('click', () =>
  runGroup(async (g) => {
    for (const x of g.items) {
      downloadFile(x.file);
      await new Promise((r) => setTimeout(r, 400));
    }
    return true;
  }),
);

$('includeSaved').addEventListener('change', startBatch);
$('batchDlg').addEventListener('close', () => { batch.token++; batch.group = null; batch.queue = []; });

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
  $('stage').dataset.tool = state.mode === 'hide' ? state.tool : state.mode;
  document.body.dataset.mode = state.mode;
  for (const b of $('modeSeg').children) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  $('hidePanel').hidden = state.mode !== 'hide';
  $('writePanel').hidden = state.mode !== 'write';
  $('cropPanel').hidden = state.mode !== 'crop';
  for (const b of $('addRow').children) b.disabled = !state.work;
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
  $('undoBtn').disabled = !curImage()?.undo.length;
  $('redoBtn').disabled = !curImage()?.redo.length;
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
  addFiles(e.target.files);
  e.target.value = '';
});
$('applyBtn').addEventListener('click', applySel);
$('clearSelBtn').addEventListener('click', clearSel);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('saveBtn').addEventListener('click', openSave);
$('fitBtn').addEventListener('click', fit);
$('thumbs').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { removeImage(+rm.dataset.remove); return; }
  const t = e.target.closest('[data-index]');
  if (t && +t.dataset.index !== state.cur) selectImage(+t.dataset.index);
});
/* ---------- 画面の左右の「前へ・次へ」 ---------- */

/** なぞる・ピンチなどの操作中は、左右のボタンを反応させない（誤タップ防止） */
function setStageBusy(on) {
  $('stage').classList.toggle('busy', on);
}

let stepping = false;
async function stepImage(d) {
  const i = state.cur + d;
  if (stepping || i < 0 || i >= state.images.length) return;
  stepping = true; // 読み込み中に続けて押されても、1枚ずつ進む
  try {
    await selectImage(i);
  } finally {
    stepping = false;
  }
  const im = curImage();
  if (im) toast(`${state.cur + 1}/${state.images.length}　${im.file.name}`, false, 1400);
}

for (const [id, d] of [['edgePrev', -1], ['edgeNext', 1]]) {
  const b = $(id);
  let start = null;
  // 指を置いて、ほとんど動かさずに離したときだけ切り替える（ボタンから始めたドラッグでは切り替えない）
  b.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { b.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
  });
  b.addEventListener('pointerup', (e) => {
    const s0 = start;
    start = null;
    if (!s0 || s0.id !== e.pointerId) return;
    const r = b.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < 12) stepImage(d);
  });
  b.addEventListener('pointercancel', () => { start = null; });
  b.addEventListener('click', (e) => {
    // キーボード操作（Enter・スペース）のときだけ click で切り替える
    if (e.detail === 0) stepImage(d);
  });
}

$('fileInfoBtn').addEventListener('click', () => {
  state.stripOpen = !state.stripOpen;
  renderStrip();
});
// 画像に触れたら一覧を閉じる
view.addEventListener('pointerdown', () => {
  if (state.stripOpen) { state.stripOpen = false; renderStrip(); }
}, true);
$('prevBtn').addEventListener('click', () => state.cur > 0 && selectImage(state.cur - 1));
$('nextBtn').addEventListener('click', () => state.cur < state.images.length - 1 && selectImage(state.cur + 1));
$('copyBtn').addEventListener('click', openCopy);
$('removeSavedBtn').addEventListener('click', removeSaved);
$('sortSelect').value = state.sortOrder;
$('sortSelect').addEventListener('change', (e) => {
  state.sortOrder = e.target.value;
  savePrefs();
  sortImages();
  renderStrip();
});
$('removeAllBtn').addEventListener('click', removeAll);
$('copyList').addEventListener('change', updateCopyCount);
$('copyOps').addEventListener('change', updateCopyCount);
$('copyAnnos').addEventListener('change', updateCopyCount);
$('copyCrop').addEventListener('change', updateCopyCount);
$('copyAllBtn').addEventListener('click', () => {
  const boxes = [...$('copyList').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  for (const b of boxes) b.checked = !all;
  updateCopyCount();
});
$('copyApplyBtn').addEventListener('click', applyCopy);
$('batchBtn').addEventListener('click', openBatch);
$('oneBtn').addEventListener('click', () => {
  const { w, h } = viewSize();
  zoomTo(1 / dpr, w / 2, h / 2);
});

// パソコンではドラッグ＆ドロップでも開ける
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

window.addEventListener('beforeunload', (e) => {
  if (state.images.some(isUnsaved)) e.preventDefault();
});

let toastTimer = 0;
function toast(msg, isError = false, duration = isError ? 5000 : 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('mosaic-prefs') || '{}');
    if (p.tool in HINTS) state.tool = p.tool;
    if (p.effect in EFFECTS) state.effect = p.effect;
    if (p.strength) Object.assign(state.strength, p.strength);
    if (/^#[0-9a-f]{6}$/i.test(p.color || '')) state.color = p.color;
    if (['name', 'name-desc', 'added'].includes(p.sortOrder)) state.sortOrder = p.sortOrder;
    if (['free', 'orig', '1:1', '4:3', '3:4', '16:9', '9:16', '4:5'].includes(p.cropAspect)) state.cropAspect = p.cropAspect;
  } catch { /* 無視 */ }
}

function savePrefs() {
  try {
    localStorage.setItem('mosaic-prefs', JSON.stringify({
      tool: state.tool, effect: state.effect, strength: state.strength, color: state.color, sortOrder: state.sortOrder, cropAspect: state.cropAspect,
    }));
  } catch { /* 無視 */ }
}

/* =========================================================
 * トリミング
 * 元の画像は切り落とさず、範囲（画像の座標）だけを記録する。保存するときに切り抜く。
 * ======================================================= */

const CROP_MIN = 8; // これより小さくはしない（px）
const ASPECTS = { free: null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '4:5': 4 / 5 };

/** トリミングの範囲（未設定なら画像全体） */
function cropOf(im) {
  return im?.crop || { x: 0, y: 0, w: im?.W || 0, h: im?.H || 0 };
}

function cropRatio() {
  if (state.cropAspect === 'orig') return state.W / state.H;
  return ASPECTS[state.cropAspect] ?? null;
}

/** 範囲を整数にそろえ、画像の中に収める。画像全体と同じなら「なし」にする */
function setCrop(im, r) {
  let w = Math.max(CROP_MIN, Math.min(im.W, Math.round(r.w)));
  let h = Math.max(CROP_MIN, Math.min(im.H, Math.round(r.h)));
  const x = Math.max(0, Math.min(im.W - w, Math.round(r.x)));
  const y = Math.max(0, Math.min(im.H - h, Math.round(r.y)));
  im.crop = x === 0 && y === 0 && w === im.W && h === im.H ? null : { x, y, w, h };
}

/** 範囲が変わるときだけ「元に戻す」の履歴を残して変更する */
function changeCrop(im, r) {
  const before = JSON.stringify(im.crop);
  const snap = snapshot(im);
  setCrop(im, r);
  if (JSON.stringify(im.crop) === before) return false;
  pushHistory(im, snap);
  markChanged();
  return true;
}

/** 角（と、比率が自由なときは辺の中央）のハンドル */
function cropHandles(c) {
  const hs = [];
  for (const ex of [-1, 0, 1]) {
    for (const ey of [-1, 0, 1]) {
      if (!ex && !ey) continue;
      if ((!ex || !ey) && cropRatio()) continue; // 比率を固定しているときは角だけ
      hs.push({ ex, ey, x: c.x + ((ex + 1) / 2) * c.w, y: c.y + ((ey + 1) / 2) * c.h });
    }
  }
  return hs;
}

function cropPointerDown(p) {
  const im = curImage();
  const s = state.view.s;
  const c = cropOf(im);
  const snap = snapshot(im);
  const dc = Math.hypot(p[0] - (c.x + c.w / 2), p[1] - (c.y + c.h / 2));
  let best = null, bd = Infinity;
  for (const hd of cropHandles(c)) {
    const d = Math.hypot(p[0] - hd.x, p[1] - hd.y);
    if (d < bd) { bd = d; best = hd; }
  }
  // 枠が小さいときは、ハンドルより中心の方が近ければ移動を優先する
  if (best && bd <= 24 / s && bd < dc) {
    gesture = { type: 'c-resize', ex: best.ex, ey: best.ey, orig: { ...c }, start: p, snap, changed: false };
  } else if (p[0] >= c.x && p[0] <= c.x + c.w && p[1] >= c.y && p[1] <= c.y + c.h) {
    gesture = { type: 'c-move', orig: { ...c }, start: p, snap, changed: false };
  } else {
    const q = [Math.max(0, Math.min(state.W, p[0])), Math.max(0, Math.min(state.H, p[1]))];
    gesture = { type: 'c-new', orig: { ...c }, start: q, snap, changed: false };
  }
}

/** 固定した角 (ax, ay) から向き (sx, sy) へ、比率を保って画像に収まる範囲を作る */
function ratioRect(ax, ay, sx, sy, w, h, ratio) {
  let w2 = Math.max(w, h * ratio), h2 = w2 / ratio;
  const maxW = sx > 0 ? state.W - ax : ax, maxH = sy > 0 ? state.H - ay : ay;
  if (w2 > maxW) { w2 = maxW; h2 = w2 / ratio; }
  if (h2 > maxH) { h2 = maxH; w2 = h2 * ratio; }
  return { x: sx > 0 ? ax : ax - w2, y: sy > 0 ? ay : ay - h2, w: w2, h: h2 };
}

function cropPointerMove(p) {
  const im = curImage();
  const g0 = gesture.orig;
  const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
  if (!gesture.changed && Math.hypot(dx, dy) * state.view.s < 3) return; // タップでは変えない
  gesture.changed = true;
  const ratio = cropRatio();
  const W = state.W, H = state.H;
  if (gesture.type === 'c-move') {
    setCrop(im, { ...g0, x: g0.x + dx, y: g0.y + dy });
  } else if (gesture.type === 'c-new') {
    const [ax, ay] = gesture.start;
    const qx = Math.max(0, Math.min(W, p[0])), qy = Math.max(0, Math.min(H, p[1]));
    const sx = qx >= ax ? 1 : -1, sy = qy >= ay ? 1 : -1;
    const r = ratio
      ? ratioRect(ax, ay, sx, sy, Math.abs(qx - ax), Math.abs(qy - ay), ratio)
      : { x: Math.min(ax, qx), y: Math.min(ay, qy), w: Math.abs(qx - ax), h: Math.abs(qy - ay) };
    setCrop(im, r);
  } else {
    const { ex, ey } = gesture;
    if (ratio) {
      const ax = ex > 0 ? g0.x : g0.x + g0.w, ay = ey > 0 ? g0.y : g0.y + g0.h;
      const qx = Math.max(0, Math.min(W, p[0])), qy = Math.max(0, Math.min(H, p[1]));
      setCrop(im, ratioRect(ax, ay, ex, ey, Math.max(0, (qx - ax) * ex), Math.max(0, (qy - ay) * ey), ratio));
    } else {
      let l = g0.x, t = g0.y, r = g0.x + g0.w, b = g0.y + g0.h;
      if (ex < 0) l = Math.max(0, Math.min(r - CROP_MIN, p[0]));
      if (ex > 0) r = Math.min(W, Math.max(l + CROP_MIN, p[0]));
      if (ey < 0) t = Math.max(0, Math.min(b - CROP_MIN, p[1]));
      if (ey > 0) b = Math.min(H, Math.max(t + CROP_MIN, p[1]));
      setCrop(im, { x: l, y: t, w: r - l, h: b - t });
    }
  }
  syncCropPanel();
}

function drawCropOverlay(g, s) {
  const im = curImage();
  if (!im) return;
  const c = cropOf(im);
  g.save();
  // 範囲の外を暗くする
  g.beginPath();
  g.rect(0, 0, state.W, state.H);
  g.rect(c.x, c.y, c.w, c.h);
  g.fillStyle = 'rgba(30, 34, 51, 0.58)';
  g.fill('evenodd');
  // 三分割の線
  g.beginPath();
  for (const k of [1, 2]) {
    g.moveTo(c.x + (c.w * k) / 3, c.y);
    g.lineTo(c.x + (c.w * k) / 3, c.y + c.h);
    g.moveTo(c.x, c.y + (c.h * k) / 3);
    g.lineTo(c.x + c.w, c.y + (c.h * k) / 3);
  }
  g.lineWidth = 1 / s;
  g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  g.stroke();
  // 枠
  g.lineWidth = 2 / s;
  g.strokeStyle = '#fff';
  g.strokeRect(c.x, c.y, c.w, c.h);
  // ハンドル（角はL字、辺は短い棒）
  const L = 18 / s, T = 4 / s;
  g.fillStyle = '#fff';
  g.strokeStyle = MODE_COLORS.crop;
  g.lineWidth = 1 / s;
  for (const hd of cropHandles(c)) {
    g.beginPath();
    if (hd.ex && hd.ey) {
      const x = hd.x - (hd.ex > 0 ? T : 0), y = hd.y - (hd.ey > 0 ? T : 0);
      const hx = hd.ex > 0 ? hd.x - L : hd.x, vy = hd.ey > 0 ? hd.y - L : hd.y;
      g.rect(hx, y, L, T);
      g.rect(x, vy, T, L);
    } else if (hd.ex) {
      g.rect(hd.x - T / 2, hd.y - L / 2, T, L);
    } else {
      g.rect(hd.x - L / 2, hd.y - T / 2, L, T);
    }
    g.fill();
    g.stroke();
  }
  g.restore();

  // 枠の上に、トリミング後の大きさを表示する（画面座標）
  const { tx, ty } = state.view;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const text = `${c.w} × ${c.h} px`;
  g.font = `700 ${13 * dpr}px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
  const tw = g.measureText(text).width;
  const pw = tw + 20 * dpr, ph = 26 * dpr;
  const cx = (tx + (c.x + c.w / 2) * s) * dpr;
  let py = (ty + c.y * s) * dpr - ph - 8 * dpr;
  if (py < 6 * dpr) py = (ty + c.y * s) * dpr + 8 * dpr; // 上に入らないときは枠の内側に
  const px = Math.max(6 * dpr, Math.min(view.width - pw - 6 * dpr, cx - pw / 2));
  g.fillStyle = MODE_COLORS.crop;
  g.beginPath();
  if (g.roundRect) g.roundRect(px, py, pw, ph, ph / 2);
  else g.rect(px, py, pw, ph);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, px + pw / 2, py + ph / 2 + dpr);
  g.restore();
}

function syncCropPanel() {
  const im = curImage();
  const c = cropOf(im);
  $('cropSize').textContent = im ? `${c.w} × ${c.h} px` : '—';
  $('cropOrig').textContent = im ? `元の大きさ ${im.W} × ${im.H} px` : '';
  for (const [id, v] of [['cropW', c.w], ['cropH', c.h]]) {
    $(id).max = id === 'cropW' ? im?.W || 0 : im?.H || 0;
    if (document.activeElement !== $(id)) $(id).value = im ? v : '';
  }
  for (const b of $('cropAspect').children) b.setAttribute('aria-checked', String(b.dataset.v === state.cropAspect));
  $('cropResetBtn').disabled = !im?.crop;
  requestDraw();
}

/** 比率を選んだら、今の範囲の中心を保ったまま、その比率で収まる一番大きな範囲にする */
function setCropAspect(v) {
  state.cropAspect = v;
  savePrefs();
  const im = curImage();
  const ratio = cropRatio();
  if (im && ratio) {
    const c = cropOf(im);
    let w = c.w, h = w / ratio;
    if (h > c.h) { h = c.h; w = h * ratio; }
    changeCrop(im, { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h });
  }
  syncCropPanel();
}

/** 幅・高さを数値で指定する（中心を保つ。比率を固定しているときはもう一方も合わせる） */
function setCropSize(which, value) {
  const im = curImage();
  if (!im || !Number.isFinite(value) || value < CROP_MIN) return;
  const c = cropOf(im);
  const ratio = cropRatio();
  let w = c.w, h = c.h;
  if (which === 'w') { w = Math.min(im.W, value); if (ratio) h = w / ratio; }
  else { h = Math.min(im.H, value); if (ratio) w = h * ratio; }
  if (ratio && w > im.W) { w = im.W; h = w / ratio; }
  if (ratio && h > im.H) { h = im.H; w = h * ratio; }
  changeCrop(im, { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h });
  syncCropPanel();
}

$('cropAspect').addEventListener('click', (e) => {
  const v = e.target.closest('[data-v]')?.dataset.v;
  if (v) setCropAspect(v);
});
for (const [id, which] of [['cropW', 'w'], ['cropH', 'h']]) {
  $(id).addEventListener('change', (e) => setCropSize(which, Math.round(Number(e.target.value))));
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
}
$('cropResetBtn').addEventListener('click', () => {
  const im = curImage();
  if (!im?.crop) return;
  pushHistory();
  im.crop = null;
  markChanged();
  syncCropPanel();
});

buildWriteControls();
buildShapeControls();
syncCropPanel();
syncProps();
updateUI();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用
window.__app = { state, applySel, undo, redo, fit, selectImage, setMode, curImage };
