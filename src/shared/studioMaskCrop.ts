/**
 * Keo Studio — editing a layer's cut-out mask and crop by hand on the preview. All positions are in
 * the layer's own frame (as the engine draws masks): fractions of its box, before the layer's turn.
 */
import type { Crop, Cut } from './studio';

export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Degrees. */
  rotation: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A point on screen (canvas pixels) in the layer's frame: u, v as fractions of its box from its middle. */
export function toLayer(b: Box, px: number, py: number): { u: number; v: number } {
  const a = (-b.rotation * Math.PI) / 180;
  const dx = px - b.cx;
  const dy = py - b.cy;
  return { u: (dx * Math.cos(a) - dy * Math.sin(a)) / Math.max(1, b.w), v: (dx * Math.sin(a) + dy * Math.cos(a)) / Math.max(1, b.h) };
}

/** A new mask, centred (a shape picked from the toolbar). */
export function newCut(shape: Cut['shape']): Cut {
  return { shape, x: 0, y: 0, w: shape === 'mirror' ? 1 : 0.6, h: shape === 'mirror' ? 0.35 : 0.6, angle: 0, feather: 0, invert: false };
}

/** The mask dragged by (du, dv) (fractions of the box). */
export function moveCut(c: Cut, du: number, dv: number): Cut {
  return { ...c, x: r3(clamp(c.x + du, -1, 1)), y: r3(clamp(c.y + dv, -1, 1)) };
}

/**
 * The mask resized so its corner is under the pointer (u, v in the layer's frame), measured along
 * the mask's own turn; keep: the same proportions as before.
 */
export function sizeCut(c: Cut, b: Box, u: number, v: number, keep = false): Cut {
  const a = (-c.angle * Math.PI) / 180;
  const dx = (u - c.x) * b.w;
  const dy = (v - c.y) * b.h;
  const rx = Math.abs(dx * Math.cos(a) - dy * Math.sin(a));
  const ry = Math.abs(dx * Math.sin(a) + dy * Math.cos(a));
  let w = clamp((2 * rx) / Math.max(1, b.w), 0.02, 3);
  let h = clamp((2 * ry) / Math.max(1, b.h), 0.02, 3);
  if (keep) {
    const k = Math.max(w / c.w, h / c.h);
    w = clamp(c.w * k, 0.02, 3);
    h = clamp(c.h * k, 0.02, 3);
  }
  return { ...c, w: r3(w), h: r3(h) };
}

/** The mask turned so its handle (above its middle) points at the pointer; snaps to straight within 4°, Shift: 15° steps. */
export function turnCut(c: Cut, b: Box, u: number, v: number, steps = false): Cut {
  const dx = (u - c.x) * b.w;
  const dy = (v - c.y) * b.h;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (steps) deg = Math.round(deg / 15) * 15;
  else {
    const r = ((deg % 90) + 90) % 90;
    if (r < 4 || r > 86) deg = Math.round(deg / 90) * 90;
  }
  return { ...c, angle: Math.round((((deg + 540) % 360) - 180) * 10) / 10 };
}

/** The soft edge from a drag (pixels down: softer). */
export function featherCut(c: Cut, start: number, dy: number): Cut {
  return { ...c, feather: r3(clamp(start + dy / 120, 0, 1)) };
}

/**
 * The crop after an edge (or corner) of the visible picture is dragged by (du, dv) — fractions of
 * the visible box. The visible part is (1 − left − right) of the whole, so the drag is scaled back
 * to the whole picture. Each side stays within 0–0.45, at least a tenth of the picture is left.
 */
export function dragCrop(c0: Crop, edges: string, du: number, dv: number): Crop {
  const c = { ...c0 };
  const keptW = 1 - c0.left - c0.right;
  const keptH = 1 - c0.top - c0.bottom;
  if (edges.includes('l')) c.left = c0.left + du * keptW;
  if (edges.includes('r')) c.right = c0.right - du * keptW;
  if (edges.includes('t')) c.top = c0.top + dv * keptH;
  if (edges.includes('b')) c.bottom = c0.bottom - dv * keptH;
  for (const k of ['left', 'right', 'top', 'bottom'] as const) c[k] = clamp(c[k], 0, 0.45);
  // At least a tenth of the picture stays.
  if (c.left + c.right > 0.9) {
    if (edges.includes('l')) c.left = 0.9 - c.right;
    else c.right = 0.9 - c.left;
  }
  if (c.top + c.bottom > 0.9) {
    if (edges.includes('t')) c.top = 0.9 - c.bottom;
    else c.bottom = 0.9 - c.top;
  }
  return { left: r3(c.left), right: r3(c.right), top: r3(c.top), bottom: r3(c.bottom) };
}
