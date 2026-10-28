import type { MotionState } from '@shared/studioMotion';

/** Canvas helpers for layer motion (the maths is in @shared/studioMotion). */

/** Positions the canvas at the layer's centre with its rotation and scale. */
export function placeLayer(ctx: CanvasRenderingContext2D, m: MotionState, W: number, H: number): void {
  ctx.translate(m.x * W, m.y * H);
  if (m.rotation) ctx.rotate((m.rotation * Math.PI) / 180);
  ctx.scale(m.scaleX, m.scaleY);
}

/** Clips drawing to the part of a w×h layer (centred at 0,0) a wipe or iris shows. */
export function clipReveal(ctx: CanvasRenderingContext2D, m: MotionState, w: number, h: number): void {
  const r = m.reveal;
  if (!r || r.p >= 1) return;
  const p = Math.max(0, r.p);
  ctx.beginPath();
  if (r.kind === 'iris') ctx.arc(0, 0, (Math.hypot(w, h) / 2) * p, 0, Math.PI * 2);
  else if (r.kind === 'wipe-right') ctx.rect(-w / 2, -h / 2, w * p, h);
  else if (r.kind === 'wipe-left') ctx.rect(w / 2 - w * p, -h / 2, w * p, h);
  else if (r.kind === 'wipe-down') ctx.rect(-w / 2, -h / 2, w, h * p);
  else ctx.rect(-w / 2, h / 2 - h * p, w, h * p);
  ctx.clip();
}
