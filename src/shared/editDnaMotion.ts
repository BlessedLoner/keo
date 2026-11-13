/**
 * Edit DNA — measuring a shot's camera move from two of its frames: how much it zooms and how far
 * it pans, by searching scale and shift that make the first frame best match the second (small
 * greyscale frames, coarse search then a finer one). Also how different the frames are (motion
 * energy) and how their brightness changes. Pure maths: the same in tests and in the app.
 */

export interface MotionEstimate {
  /** The second frame's scale relative to the first (1.08: pushed in 8%). */
  zoom: number;
  /** How far the picture moved, as fractions of the width and height (positive: right, down). */
  dx: number;
  dy: number;
  /** Mean difference left after the best match (0–1): low means the move explains the change. */
  residual: number;
  /** Mean difference between the frames as they are (0–1): how much happens. */
  energy: number;
  /** Change in mean brightness (−1…1). */
  brightness: number;
}

/** Mean absolute difference (0–1) of b against a scaled by s about the centre and shifted by (tx, ty) pixels. */
function cost(a: Uint8Array, b: Uint8Array, w: number, h: number, s: number, tx: number, ty: number): number {
  let sum = 0;
  let n = 0;
  const cx = w / 2;
  const cy = h / 2;
  // Only the inner part: the borders fall outside after a zoom or a pan.
  const m = Math.round(Math.min(w, h) * 0.12);
  for (let y = m; y < h - m; y += 1) {
    const sy = Math.round((y - cy - ty) / s + cy);
    if (sy < 0 || sy >= h) continue;
    for (let x = m; x < w - m; x += 1) {
      const sx = Math.round((x - cx - tx) / s + cx);
      if (sx < 0 || sx >= w) continue;
      sum += Math.abs(b[y * w + x]! - a[sy * w + sx]!);
      n++;
    }
  }
  return n ? sum / n / 255 : 1;
}

export function estimateMotion(a: Uint8Array, b: Uint8Array, w: number, h: number): MotionEstimate {
  let meanA = 0;
  let meanB = 0;
  let energy = 0;
  for (let i = 0; i < a.length; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
    energy += Math.abs(a[i]! - b[i]!);
  }
  meanA /= a.length;
  meanB /= b.length;
  energy = energy / a.length / 255;
  // Brightness evened out so a fade does not look like movement.
  const gain = meanB > 1 ? meanA / meanB : 1;
  const bb = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bb[i] = Math.max(0, Math.min(255, Math.round(b[i]! * gain)));
  let best = { s: 1, tx: 0, ty: 0, c: cost(a, bb, w, h, 1, 0, 0) };
  const maxShift = Math.round(Math.min(w, h) * 0.15);
  // Coarse: every few pixels and a few scales.
  for (const s of [0.86, 0.9, 0.94, 0.97, 1, 1.03, 1.06, 1.1, 1.15]) {
    for (let ty = -maxShift; ty <= maxShift; ty += 2) {
      for (let tx = -maxShift; tx <= maxShift; tx += 2) {
        const c = cost(a, bb, w, h, s, tx, ty);
        if (c < best.c) best = { s, tx, ty, c };
      }
    }
  }
  // Fine: around the best.
  const coarse = best;
  for (let ds = -0.02; ds <= 0.02001; ds += 0.005) {
    for (let ty = coarse.ty - 2; ty <= coarse.ty + 2; ty++) {
      for (let tx = coarse.tx - 2; tx <= coarse.tx + 2; tx++) {
        const s = coarse.s + ds;
        const c = cost(a, bb, w, h, s, tx, ty);
        if (c < best.c) best = { s, tx, ty, c };
      }
    }
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { zoom: r(best.s), dx: r(best.tx / w), dy: r(best.ty / h), residual: r(best.c), energy: r(energy), brightness: r((meanB - meanA) / 255) };
}

/** Brightness (0–1) of a 64-bin colour fingerprint (2 bits per channel, as Studio's signatures). */
export function signatureBrightness(sig: number[]): number {
  let v = 0;
  for (let i = 0; i < 64; i++) {
    const r = (i >> 4) & 3;
    const g = (i >> 2) & 3;
    const b = i & 3;
    v += (sig[i] ?? 0) * ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 3);
  }
  return v;
}

function distance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < 64; i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d / 2;
}

/**
 * What kind of change happens at a cut, from fingerprints sampled evenly across it (oldest first):
 * a hard cut jumps in one step; a dissolve moves gradually through mixes of both; a flash goes
 * through white, a dip through black. Returns the kind and how sure the measurement is (0–1).
 */
export function classifyTransition(sigs: number[][], stepSeconds: number): { kind: 'cut' | 'crossfade' | 'flash' | 'dip'; seconds: number; confidence: number } {
  if (sigs.length < 3) return { kind: 'cut', seconds: 0, confidence: 0.3 };
  const steps = sigs.slice(1).map((s, i) => distance(sigs[i]!, s));
  const total = distance(sigs[0]!, sigs.at(-1)!);
  const biggest = Math.max(...steps);
  const light = sigs.map(signatureBrightness);
  const ends = (light[0]! + light.at(-1)!) / 2;
  const peak = Math.max(...light);
  const low = Math.min(...light);
  if (peak > ends + 0.25 && peak > 0.75) return { kind: 'flash', seconds: Math.round(stepSeconds * steps.filter((d) => d > total * 0.15).length * 100) / 100 || 0.3, confidence: 0.7 };
  if (low < ends - 0.2 && low < 0.12) return { kind: 'dip', seconds: Math.round(stepSeconds * steps.filter((d) => d > total * 0.12).length * 100) / 100 || 0.5, confidence: 0.7 };
  // Gradual: no single step carries most of the change, and several steps carry some.
  // (a long, even dissolve moves only a small share per step, so the bar is low)
  const moving = steps.filter((d) => d > total * 0.05).length;
  if (total > 0.2 && biggest < total * 0.55 && moving >= 3) return { kind: 'crossfade', seconds: Math.round(moving * stepSeconds * 100) / 100, confidence: Math.min(0.9, 0.5 + moving * 0.05) };
  return { kind: 'cut', seconds: 0, confidence: biggest > total * 0.7 ? 0.9 : 0.6 };
}
