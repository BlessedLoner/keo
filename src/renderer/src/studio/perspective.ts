/**
 * Real 3D for flat layers on a 2D canvas: a picture turned in space (the right side or the top
 * going away), drawn in thin strips that each get the size perspective gives them. Two passes (the
 * turn around the vertical axis, then around the horizontal one), deterministic, so the preview
 * and the export are the same frame. Used for screens floating as glass panels.
 */

const strips = 120;
let passA: OffscreenCanvas | null = null;
let passB: OffscreenCanvas | null = null;
const canvasOf = (c: OffscreenCanvas | null, w: number, h: number) => {
  if (!c || c.width < w || c.height < h) return new OffscreenCanvas(Math.max(w, c?.width ?? 0), Math.max(h, c?.height ?? 0));
  return c;
};

/** How far the eye is, as a multiple of the layer's longer side (bigger: flatter). */
const EYE = 2.4;

/**
 * Draws `src` (w×h, its middle at the context's origin) turned by tiltX/tiltY degrees.
 * Returns the turned picture's box (for a shadow or a reflection), centred on the origin.
 */
export function drawTilted(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, tiltX: number, tiltY: number): { w: number; h: number } {
  const f = EYE * Math.max(w, h);
  const ty = (tiltY * Math.PI) / 180;
  const tx = (tiltX * Math.PI) / 180;
  // Pass 1: around the vertical axis (columns get taller or shorter, closer together further away).
  const aw = Math.ceil(w * 1.15) + 4;
  const ah = Math.ceil(h * 1.6) + 4;
  passA = canvasOf(passA, aw, ah);
  const a = passA.getContext('2d')!;
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.clearRect(0, 0, passA.width, passA.height);
  a.imageSmoothingQuality = 'high';
  const colX = (u: number) => {
    const z = u * Math.sin(ty);
    return (u * Math.cos(ty) * f) / (f + z);
  };
  const colS = (u: number) => f / (f + u * Math.sin(ty));
  for (let i = 0; i < strips; i++) {
    const u0 = -w / 2 + (i * w) / strips;
    const u1 = u0 + w / strips;
    const x0 = colX(u0);
    const x1 = colX(u1);
    const s = colS((u0 + u1) / 2);
    const dh = h * s;
    a.drawImage(src, (i * w) / strips, 0, w / strips, h, aw / 2 + x0, ah / 2 - dh / 2, Math.max(0.5, x1 - x0) + 0.6, dh);
  }
  // Pass 2: around the horizontal axis (rows get wider or narrower).
  const bw = Math.ceil(aw * 1.6) + 4;
  const bh = ah;
  passB = canvasOf(passB, bw, bh);
  const b = passB.getContext('2d')!;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, passB.width, passB.height);
  b.imageSmoothingQuality = 'high';
  const rowY = (v: number) => {
    const z = -v * Math.sin(tx);
    return (v * Math.cos(tx) * f) / (f + z);
  };
  const rowS = (v: number) => f / (f - v * Math.sin(tx));
  const rows = strips;
  for (let i = 0; i < rows; i++) {
    const v0 = -ah / 2 + (i * ah) / rows;
    const v1 = v0 + ah / rows;
    const y0 = rowY(v0);
    const y1 = rowY(v1);
    const s = rowS((v0 + v1) / 2);
    const dw = aw * s;
    b.drawImage(passA, 0, (i * ah) / rows, aw, ah / rows, bw / 2 - dw / 2, bh / 2 + y0, dw, Math.max(0.5, y1 - y0) + 0.6);
  }
  ctx.drawImage(passB, 0, 0, bw, bh, -bw / 2, -bh / 2, bw, bh);
  // The turned picture's size (its widest and tallest parts).
  const ow = Math.abs(colX(w / 2) - colX(-w / 2)) * Math.max(rowS(-h / 2), rowS(h / 2));
  const oh = Math.abs(rowY(h / 2) - rowY(-h / 2)) * Math.max(colS(-w / 2), colS(w / 2));
  return { w: ow, h: oh };
}

/** A glass finish over a card drawn at the origin (w×h, corner radius r): a moving sheen and a bright edge. */
export function glassSheen(cx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, r: number, tiltY: number): void {
  cx.save();
  cx.beginPath();
  cx.roundRect(-w / 2, -h / 2, w, h, r);
  cx.clip();
  // A diagonal band of light that slides as the panel turns.
  const shift = (tiltY / 40) * w * 0.6;
  const g = cx.createLinearGradient(-w / 2 + shift, -h / 2, w / 2 + shift, h / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.20)');
  g.addColorStop(0.32, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0.03)');
  cx.fillStyle = g;
  cx.fillRect(-w / 2, -h / 2, w, h);
  cx.restore();
  // The edge catches the light.
  cx.save();
  cx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.004);
  const e = cx.createLinearGradient(0, -h / 2, 0, h / 2);
  e.addColorStop(0, 'rgba(255,255,255,0.55)');
  e.addColorStop(1, 'rgba(255,255,255,0.12)');
  cx.strokeStyle = e;
  cx.beginPath();
  cx.roundRect(-w / 2 + cx.lineWidth / 2, -h / 2 + cx.lineWidth / 2, w - cx.lineWidth, h - cx.lineWidth, Math.max(0, r - cx.lineWidth / 2));
  cx.stroke();
  cx.restore();
}
