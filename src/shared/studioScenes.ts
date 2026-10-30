import { sourceSpan, type MediaClip } from './studio';

/**
 * Finding the shots inside a video: each sampled frame is reduced to a colour fingerprint (a small
 * histogram that sums to 1); a shot changes where two neighbouring fingerprints differ much more
 * than the frames around them do.
 */

/** How different two fingerprints are: 0 (the same colours) to 1 (nothing in common). */
export function signatureDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d / 2;
}

export interface SceneOptions {
  /** A change at least this big (0..1) can be a cut. */
  threshold?: number;
  /** And this many times bigger than the usual change around it (camera moves, people moving). */
  contrast?: number;
  /** Shots shorter than this (seconds) are not split off. */
  minShot?: number;
}

/**
 * Where shots change between samples taken at `times` (sorted): for each cut, the pair of sample
 * times it lies between.
 */
export function sceneCandidates(times: number[], sigs: number[][], o: SceneOptions = {}): Array<{ from: number; to: number; strength: number }> {
  const threshold = o.threshold ?? 0.2;
  const contrast = o.contrast ?? 2.5;
  const minShot = o.minShot ?? 0.6;
  const d: number[] = [];
  for (let i = 1; i < sigs.length; i++) d.push(signatureDistance(sigs[i - 1]!, sigs[i]!));
  const out: Array<{ from: number; to: number; strength: number }> = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i]! < threshold) continue;
    // The usual change nearby: the median of the 8 differences around this one (not counting it).
    const near = d.slice(Math.max(0, i - 4), i).concat(d.slice(i + 1, i + 5)).sort((x, y) => x - y);
    const median = near.length ? near[Math.floor(near.length / 2)]! : 0;
    if (d[i]! < contrast * median) continue;
    const cut = { from: times[i]!, to: times[i + 1]!, strength: d[i]! };
    const last = out.at(-1);
    if (last && cut.to - last.to < minShot) {
      // Two cuts too close together: keep the stronger.
      if (cut.strength > last.strength) out[out.length - 1] = cut;
      continue;
    }
    if (cut.to < minShot) continue;
    out.push(cut);
  }
  return out;
}

/**
 * The first frame of the new shot, from fingerprints of every frame between a candidate's two
 * samples (the last of them is the coarse sample in the new shot, so it is the answer when no one
 * step stands out).
 */
export function refineCut(times: number[], sigs: number[][]): number {
  let best = 1;
  let most = -1;
  for (let i = 1; i < sigs.length; i++) {
    const d = signatureDistance(sigs[i - 1]!, sigs[i]!);
    if (d > most) {
      most = d;
      best = i;
    }
  }
  return most > 0.15 ? times[Math.min(best, times.length - 1)]! : times.at(-1)!;
}

/**
 * Timeline times at which a clip should be split for shot changes at `cuts` (seconds into its
 * video), only those well inside the clip.
 */
export function sceneSplitTimes(c: MediaClip, cuts: number[]): number[] {
  const out: number[] = [];
  for (const cut of cuts) {
    const into = cut - c.in;
    if (into <= 0 || into >= sourceSpan(c, c.duration)) continue;
    // The timeline time whose source time is the cut (the source moves forward steadily).
    let lo = 0;
    let hi = c.duration;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (sourceSpan(c, mid) < into) lo = mid;
      else hi = mid;
    }
    const t = c.start + hi;
    if (hi > 0.1 && hi < c.duration - 0.1) out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}
