// 画像処理（モザイク・ぼかし・塗りつぶし）と範囲マスクによる合成。
// すべて「画像のピクセル座標」で処理する。範囲外のピクセルは一切変更しない。

/** 選択範囲の外接矩形（小数）を返す */
export function selBounds(sel) {
  if (sel.type === 'lasso') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of sel.pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
  }
  return { x0: sel.x, y0: sel.y, x1: sel.x + sel.w, y1: sel.y + sel.h };
}

/** 選択範囲のパスを ctx に作る（ox, oy だけずらす） */
export function tracePath(ctx, sel, ox = 0, oy = 0) {
  ctx.beginPath();
  if (sel.type === 'lasso') {
    const p = sel.pts;
    ctx.moveTo(p[0][0] + ox, p[0][1] + oy);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] + ox, p[i][1] + oy);
    ctx.closePath();
  } else if (sel.type === 'rect') {
    ctx.rect(sel.x + ox, sel.y + oy, sel.w, sel.h);
  } else if (sel.type === 'ellipse') {
    ctx.ellipse(sel.x + sel.w / 2 + ox, sel.y + sel.h / 2 + oy, sel.w / 2, sel.h / 2, 0, 0, Math.PI * 2);
  }
}

/** 選択範囲の内側か（図形の移動判定用） */
export function hitInside(sel, x, y) {
  if (sel.type === 'rect') return x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h;
  if (sel.type === 'ellipse') {
    const rx = sel.w / 2, ry = sel.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (x - sel.x - rx) / rx, dy = (y - sel.y - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return false;
}

/* ---------------- モザイク ---------------- */

/** n×n ブロックごとに平均色で塗る（アルファ加重平均）。グリッドは配列の左上が基準 */
export function pixelate(d, w, h, n) {
  for (let by = 0; by < h; by += n) {
    const bh = Math.min(n, h - by);
    for (let bx = 0; bx < w; bx += n) {
      const bw = Math.min(n, w - bx);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = 0; y < bh; y++) {
        let i = ((by + y) * w + bx) * 4;
        for (let x = 0; x < bw; x++, i += 4) {
          const al = d[i + 3];
          r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
        }
      }
      const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / (bw * bh);
      for (let y = 0; y < bh; y++) {
        let i = ((by + y) * w + bx) * 4;
        for (let x = 0; x < bw; x++, i += 4) {
          d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
        }
      }
    }
  }
}

/* ---------------- ぼかし（ガウスぼかしを3回のボックスぼかしで近似） ---------------- */

export function boxRadiiForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii;
}

export function blurPad(sigma) {
  return boxRadiiForGauss(sigma).reduce((s, r) => s + r, 0);
}

function boxH(src, dst, w, h, r) {
  const div = 2 * r + 1, last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[(row + (k < 0 ? 0 : k > last ? last : k)) * 4 + c];
      for (let x = 0; x < w; x++) {
        dst[(row + x) * 4 + c] = s / div;
        const a = x + r + 1, b = x - r;
        s += src[(row + (a > last ? last : a)) * 4 + c] - src[(row + (b < 0 ? 0 : b)) * 4 + c];
      }
    }
  }
}

function boxV(src, dst, w, h, r) {
  const div = 2 * r + 1, last = h - 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[((k < 0 ? 0 : k > last ? last : k) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 4 + c] = s / div;
        const a = y + r + 1, b = y - r;
        s += src[((a > last ? last : a) * w + x) * 4 + c] - src[((b < 0 ? 0 : b) * w + x) * 4 + c];
      }
    }
  }
}

export function blurRGBA(d, w, h, sigma) {
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) { hasAlpha = true; break; }
  if (hasAlpha) {
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      d[i] *= a; d[i + 1] *= a; d[i + 2] *= a;
    }
  }
  const tmp = new Uint8ClampedArray(d.length);
  for (const r of boxRadiiForGauss(sigma)) {
    if (r < 1) continue;
    boxH(d, tmp, w, h, r);
    boxV(tmp, d, w, h, r);
  }
  if (hasAlpha) {
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      const k = 255 / a;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * 編集結果の「差し替え用パッチ」を計算する。
 * 返り値の ImageData は範囲の外接矩形ぶんで、マスク外のピクセルは元の値そのまま。
 * @param {CanvasRenderingContext2D} srcCtx 現在の画像
 * @param {{sel, effect, strength, color}} op
 * @param {(w:number,h:number)=>HTMLCanvasElement} makeCanvas
 */
export function computePatch(srcCtx, W, H, op, makeCanvas) {
  const b = selBounds(op.sel);
  const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(W, Math.ceil(b.x1)), y1 = Math.min(H, Math.ceil(b.y1));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const w = x1 - x0, h = y1 - y0;

  // マスク（範囲の内側=不透明、縁はアンチエイリアス）
  const mc = makeCanvas(w, h);
  const mctx = mc.getContext('2d', { willReadFrequently: true });
  mctx.fillStyle = '#fff';
  tracePath(mctx, op.sel, -x0, -y0);
  mctx.fill('nonzero');
  const m = mctx.getImageData(0, 0, w, h).data;

  const orig = srcCtx.getImageData(x0, y0, w, h);
  const o = orig.data;

  // 効果をかけたピクセル（必要に応じて周囲も含めて計算）
  let e = null, ex = x0, ey = y0, ew = w, fill = null;
  if (op.effect === 'fill') {
    fill = hexToRgb(op.color);
  } else if (op.effect === 'mosaic') {
    const n = Math.max(1, Math.round(op.strength));
    // ブロックのグリッドは画像の左上を基準にそろえる
    ex = Math.floor(x0 / n) * n; ey = Math.floor(y0 / n) * n;
    const ex1 = Math.min(W, Math.ceil(x1 / n) * n), ey1 = Math.min(H, Math.ceil(y1 / n) * n);
    ew = ex1 - ex;
    const img = srcCtx.getImageData(ex, ey, ew, ey1 - ey);
    pixelate(img.data, ew, ey1 - ey, n);
    e = img.data;
  } else if (op.effect === 'blur') {
    const sigma = Math.max(0.5, op.strength);
    const pad = blurPad(sigma);
    ex = Math.max(0, x0 - pad); ey = Math.max(0, y0 - pad);
    const ex1 = Math.min(W, x1 + pad), ey1 = Math.min(H, y1 + pad);
    ew = ex1 - ex;
    const img = srcCtx.getImageData(ex, ey, ew, ey1 - ey);
    blurRGBA(img.data, ew, ey1 - ey, sigma);
    e = img.data;
  }

  // マスクの濃さで元画像と効果を合成
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const a = m[i + 3];
      if (a === 0) continue;
      const t = a / 255;
      if (fill) {
        o[i] += (fill[0] - o[i]) * t;
        o[i + 1] += (fill[1] - o[i + 1]) * t;
        o[i + 2] += (fill[2] - o[i + 2]) * t;
        o[i + 3] += (255 - o[i + 3]) * t;
      } else {
        const j = ((py + y0 - ey) * ew + (px + x0 - ex)) * 4;
        o[i] += (e[j] - o[i]) * t;
        o[i + 1] += (e[j + 1] - o[i + 1]) * t;
        o[i + 2] += (e[j + 2] - o[i + 2]) * t;
        o[i + 3] += (e[j + 3] - o[i + 3]) * t;
      }
    }
  }
  return { data: orig, x: x0, y: y0 };
}
