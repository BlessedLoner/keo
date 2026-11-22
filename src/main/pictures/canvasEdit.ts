import type { EditOp } from './edit';

/**
 * Picture editing without ffmpeg: the same operations as the ffmpeg editor (edit.ts), drawn on a
 * canvas in a hidden, offline Chromium page. Used when the video tools are not set up, so adding
 * text to a photo, cropping or putting a logo on it never needs a download first. The page gets the
 * pictures as data URLs and gives back the finished picture as a data URL; it loads nothing else.
 */

/** Windows font names (as the ffmpeg editor offers them) → CSS family, weight and style. */
export const CANVAS_FONTS: Record<string, { family: string; weight: number; style?: 'italic' }> = {
  'Segoe UI': { family: 'Segoe UI', weight: 400 },
  'Segoe UI Bold': { family: 'Segoe UI', weight: 700 },
  'Segoe UI Semibold': { family: 'Segoe UI', weight: 600 },
  'Segoe UI Black': { family: 'Segoe UI', weight: 900 },
  'Segoe UI Light': { family: 'Segoe UI', weight: 300 },
  Bahnschrift: { family: 'Bahnschrift', weight: 400 },
  Arial: { family: 'Arial', weight: 400 },
  'Arial Bold': { family: 'Arial', weight: 700 },
  Impact: { family: 'Impact', weight: 400 },
  Georgia: { family: 'Georgia', weight: 400 },
  'Georgia Bold': { family: 'Georgia', weight: 700 },
  Consolas: { family: 'Consolas', weight: 400 },
  Calibri: { family: 'Calibri', weight: 400 },
  'Calibri Bold': { family: 'Calibri', weight: 700 },
  Verdana: { family: 'Verdana', weight: 400 },
  'Trebuchet MS': { family: 'Trebuchet MS', weight: 400 },
  'Times New Roman': { family: 'Times New Roman', weight: 400 },
  'Comic Sans MS': { family: 'Comic Sans MS', weight: 400 },
  'Segoe Script': { family: 'Segoe Script', weight: 400 },
  'Segoe Print': { family: 'Segoe Print', weight: 700 },
};

export interface CanvasJob {
  /** The picture, as a data URL. */
  src: string;
  /** Pictures laid over it (overlay operations), by their path, as data URLs. */
  overlays: Record<string, string>;
  ops: EditOp[];
  format: 'png' | 'jpg';
  fonts: typeof CANVAS_FONTS;
}

/**
 * The page's code: `keoCanvasEdit(job)` resolves to { dataUrl, width, height }. Kept as a string so
 * it runs in the sandboxed page (no access to Keo); it mirrors edit.ts's sizes and positions.
 */
export const CANVAS_EDIT_JS = String.raw`
window.keoCanvasEdit = async function (job) {
  const load = (url) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('The picture could not be read.')); i.src = url; });
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const floorEven = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const img = await load(job.src);
  let cur = make(img.naturalWidth, img.naturalHeight);
  cur.getContext('2d').drawImage(img, 0, 0);
  const pixels = (c, fn) => { const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height); fn(d.data, c.width, c.height); x.putImageData(d, 0, 0); };
  const filtered = (filter) => { const n = make(cur.width, cur.height); const x = n.getContext('2d'); x.filter = filter; x.drawImage(cur, 0, 0); return n; };
  for (const op of job.ops) {
    const W = cur.width, H = cur.height;
    if (op.op === 'crop') {
      const x = Math.min(Math.max(0, Math.round(op.x * W)), W - 2), y = Math.min(Math.max(0, Math.round(op.y * H)), H - 2);
      const w = Math.min(floorEven(op.width * W), floorEven(W - x)), h = Math.min(floorEven(op.height * H), floorEven(H - y));
      const n = make(w, h); n.getContext('2d').drawImage(cur, x, y, w, h, 0, 0, w, h); cur = n;
    } else if (op.op === 'resize') {
      const w = op.width ?? (op.height ? Math.round((W * op.height) / H) : W), h = op.height ?? (op.width ? Math.round((H * op.width) / W) : H);
      const n = make(even(w), even(h)); const x = n.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, n.width, n.height); cur = n;
    } else if (op.op === 'extend' || op.op === 'square' || op.op === 'border') {
      let w, h, dx, dy;
      if (op.op === 'extend') { w = even(W * (1 + op.left + op.right)); h = even(H * (1 + op.top + op.bottom)); dx = Math.round(W * op.left); dy = Math.round(H * op.top); }
      else if (op.op === 'square') { const m = even(Math.max(W, H)); w = m; h = m; dx = Math.round((m - W) / 2); dy = Math.round((m - H) / 2); }
      else { w = W + op.width * 2; h = H + op.width * 2; dx = op.width; dy = op.width; }
      const n = make(w, h); const x = n.getContext('2d'); x.fillStyle = op.color; x.fillRect(0, 0, w, h); x.drawImage(cur, dx, dy); cur = n;
    } else if (op.op === 'rotate') {
      const a = ((op.degrees % 360) + 360) % 360, r = (a * Math.PI) / 180;
      let w = W, h = H;
      if (a === 90 || a === 270) { w = H; h = W; } else if (a !== 0 && a !== 180) { w = even(Math.abs(W * Math.cos(r)) + Math.abs(H * Math.sin(r))); h = even(Math.abs(W * Math.sin(r)) + Math.abs(H * Math.cos(r))); }
      const n = make(w, h); const x = n.getContext('2d'); x.translate(w / 2, h / 2); x.rotate(r); x.drawImage(cur, -W / 2, -H / 2); cur = n;
    } else if (op.op === 'flip') {
      const n = make(W, H); const x = n.getContext('2d');
      if (op.direction === 'horizontal') { x.translate(W, 0); x.scale(-1, 1); } else { x.translate(0, H); x.scale(1, -1); }
      x.drawImage(cur, 0, 0); cur = n;
    } else if (op.op === 'adjust') {
      cur = filtered('brightness(' + Math.max(0, 1 + op.brightness) + ') contrast(' + op.contrast + ') saturate(' + op.saturation + ')');
      if (op.gamma && op.gamma !== 1) { const g = 1 / op.gamma; pixels(cur, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 * Math.pow(d[i] / 255, g); d[i + 1] = 255 * Math.pow(d[i + 1] / 255, g); d[i + 2] = 255 * Math.pow(d[i + 2] / 255, g); } }); }
    } else if (op.op === 'grayscale') {
      cur = filtered('grayscale(1)');
    } else if (op.op === 'blur') {
      cur = filtered('blur(' + op.radius + 'px)');
    } else if (op.op === 'sharpen') {
      const src = cur.getContext('2d').getImageData(0, 0, W, H).data.slice();
      const k = op.amount;
      pixels(cur, (d, w, h) => {
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const v = src[i + c] * (1 + 4 * k) - k * (src[i + c - 4] + src[i + c + 4] + src[i + c - w * 4] + src[i + c + w * 4]);
            d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
          }
        }
      });
    } else if (op.op === 'text') {
      const x = cur.getContext('2d');
      const f = job.fonts[op.font] || { family: 'Segoe UI', weight: 700 };
      const px = Math.max(4, op.size * H);
      x.save();
      x.font = (f.style || '') + ' ' + f.weight + ' ' + px + 'px "' + f.family + '", "Segoe UI", sans-serif';
      x.textAlign = op.anchor === 'left' ? 'left' : op.anchor === 'right' ? 'right' : 'center';
      x.textBaseline = 'middle';
      x.globalAlpha = op.opacity;
      const tx = op.x * W, ty = op.y * H;
      if (op.glow) { x.shadowColor = op.glow; x.shadowBlur = px * 0.45; x.fillStyle = op.glow; x.fillText(op.text, tx, ty); x.fillText(op.text, tx, ty); x.shadowBlur = 0; }
      if (op.shadow) { x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = px * 0.12; x.shadowOffsetX = px * 0.04; x.shadowOffsetY = px * 0.05; }
      if (op.outline) { x.lineJoin = 'round'; x.lineWidth = op.outline.width * 2; x.strokeStyle = op.outline.color; x.strokeText(op.text, tx, ty); }
      x.fillStyle = op.color;
      x.fillText(op.text, tx, ty);
      x.restore();
    } else if (op.op === 'overlay') {
      const o = await load(job.overlays[op.image]);
      const w = op.width * W, h = (w * o.naturalHeight) / o.naturalWidth;
      const x = cur.getContext('2d'); x.save(); x.globalAlpha = op.opacity; x.drawImage(o, op.x * W - w / 2, op.y * H - h / 2, w, h); x.restore();
    } else if (op.op === 'round_corners') {
      const r = op.radius * Math.min(W, H);
      const n = make(W, H); const x = n.getContext('2d'); x.beginPath(); x.roundRect(0, 0, W, H, r); x.clip(); x.drawImage(cur, 0, 0); cur = n;
    }
  }
  if (job.format === 'jpg') { const n = make(cur.width, cur.height); const x = n.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, n.width, n.height); x.drawImage(cur, 0, 0); cur = n; }
  return { dataUrl: cur.toDataURL(job.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92), width: cur.width, height: cur.height };
};
`;
