import { type Asset, type MediaClip } from './studio';

/**
 * Motion tracking and stabilising, on small grey copies of a video's frames (pure code, so it is
 * the same everywhere and can be tested): following a patch of the picture from frame to frame,
 * and measuring how the whole picture shakes.
 */

/** A grey picture: one byte per pixel, w × h. */
export interface Gray {
  w: number;
  h: number;
  px: Uint8Array;
}

/** A patch cut out of a grey picture (clamped at its edges). */
export function cut(g: Gray, x: number, y: number, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const sy = Math.max(0, Math.min(g.h - 1, Math.round(y + j)));
    for (let i = 0; i < w; i++) out[j * w + i] = g.px[sy * g.w + Math.max(0, Math.min(g.w - 1, Math.round(x + i)))]!;
  }
  return { w, h, px: out };
}

/** How different a patch is from the picture with its top-left at (x, y): the mean of the pixel differences (sampled). */
function sad(g: Gray, t: Gray, x: number, y: number, step: number, cap: number): number {
  let sum = 0;
  let n = 0;
  for (let j = 0; j < t.h; j += step) {
    const gy = y + j;
    if (gy < 0 || gy >= g.h) continue;
    for (let i = 0; i < t.w; i += step) {
      const gx = x + i;
      if (gx < 0 || gx >= g.w) continue;
      sum += Math.abs(g.px[gy * g.w + gx]! - t.px[j * t.w + i]!);
      n++;
    }
    if (n && sum / n > cap) return Infinity;
  }
  return n ? sum / n : Infinity;
}

/**
 * Where the patch `t` is in `g`, searching `radius` pixels around (x, y) (its top-left): coarse
 * steps first, then pixel by pixel around the best. score: the mean grey difference (0: the same).
 */
export function findPatch(g: Gray, t: Gray, x: number, y: number, radius: number): { x: number; y: number; score: number } {
  let best = { x: Math.round(x), y: Math.round(y), score: Infinity };
  const coarse = Math.max(1, Math.floor(radius / 6));
  const sample = Math.max(1, Math.floor(Math.min(t.w, t.h) / 16));
  for (let dy = -radius; dy <= radius; dy += coarse)
    for (let dx = -radius; dx <= radius; dx += coarse) {
      const s = sad(g, t, Math.round(x + dx), Math.round(y + dy), sample, best.score);
      if (s < best.score) best = { x: Math.round(x + dx), y: Math.round(y + dy), score: s };
    }
  const around = best;
  for (let dy = -coarse; dy <= coarse; dy++)
    for (let dx = -coarse; dx <= coarse; dx++) {
      const s = sad(g, t, around.x + dx, around.y + dy, 1, best.score);
      if (s < best.score) best = { x: around.x + dx, y: around.y + dy, score: s };
    }
  return best;
}

/**
 * Follows a box (top-left x, y and size, in pixels of the grey frames) through the frames: its
 * centre in each, as fractions of the frame. The look it follows updates slowly (turns and light
 * changes), and a frame where it is lost keeps the last good place.
 */
export function trackBox(frames: Gray[], box: { x: number; y: number; w: number; h: number }): Array<{ x: number; y: number; lost: boolean }> {
  if (!frames.length) return [];
  const step = boxTracker(frames[0]!, box);
  return [step(null), ...frames.slice(1).map((g) => step(g))];
}

/** The same, a frame at a time (for long videos): call with each next frame (null: the first frame's place). */
export function boxTracker(first: Gray, box: { x: number; y: number; w: number; h: number }): (g: Gray | null) => { x: number; y: number; lost: boolean } {
  const w = Math.max(6, Math.round(box.w));
  const h = Math.max(6, Math.round(box.h));
  let tmpl = cut(first, box.x, box.y, w, h);
  let at = { x: box.x, y: box.y };
  const radius = Math.max(6, Math.round(Math.max(w, h) * 0.6));
  return (g) => {
    if (!g) return { x: (at.x + w / 2) / first.w, y: (at.y + h / 2) / first.h, lost: false };
    const f = findPatch(g, tmpl, at.x, at.y, radius);
    const lost = !Number.isFinite(f.score) || f.score > 45;
    if (!lost) {
      at = { x: f.x, y: f.y };
      // The look moves a little toward what is seen now.
      const now = cut(g, at.x, at.y, w, h);
      const next = new Uint8Array(tmpl.px.length);
      for (let k = 0; k < next.length; k++) next[k] = Math.round(tmpl.px[k]! * 0.85 + now.px[k]! * 0.15);
      tmpl = { w, h, px: next };
    }
    return { x: (at.x + w / 2) / g.w, y: (at.y + h / 2) / g.h, lost };
  };
}

/**
 * How far the whole picture moved from one frame to the next (pixels): the middle of the earlier
 * frame found in the later one.
 */
export function frameShift(prev: Gray, cur: Gray, radius: number): { dx: number; dy: number } {
  const w = Math.round(prev.w * 0.6);
  const h = Math.round(prev.h * 0.6);
  const x = Math.round((prev.w - w) / 2);
  const y = Math.round((prev.h - h) / 2);
  const f = findPatch(cur, cut(prev, x, y, w, h), x, y, radius);
  return { dx: f.x - x, dy: f.y - y };
}

/** A path smoothed by a moving average over `half` points each side (the ends use what they have). */
export function smooth(values: number[], half: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k]!;
      n++;
    }
    return sum / n;
  });
}

/**
 * Where a point of the video's own picture (fractions of its width and height) shows in the
 * project frame (fractions), for a video clip placed by its fit, position and scale, and back.
 */
export function videoPlacement(c: MediaClip, a: Asset, W: number, H: number) {
  const w = a.width || W;
  const h = a.height || H;
  const k = (c.fit === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h)) * c.transform.scale;
  const dw = w * k;
  const dh = h * k;
  const left = c.transform.x * W - dw / 2;
  const top = c.transform.y * H - dh / 2;
  return {
    toFrame: (sx: number, sy: number) => ({ x: (left + sx * dw) / W, y: (top + sy * dh) / H }),
    toVideo: (fx: number, fy: number) => ({ x: (fx * W - left) / dw, y: (fy * H - top) / dh }),
    /** One pixel of the video, as a fraction of the frame's width and height. */
    scaleX: dw / w / W,
    scaleY: dh / h / H,
  };
}
