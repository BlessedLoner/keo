import { wavOf } from './captions';

/**
 * Keo's own sound effects, made from scratch (no files to download, nothing to license): short
 * sounds editors put on cuts, pop-ups and reveals. 48 kHz mono WAV.
 */

export const SFX = {
  whoosh: { label: 'Whoosh', seconds: 0.55 },
  pop: { label: 'Pop', seconds: 0.14 },
  click: { label: 'Click', seconds: 0.05 },
  ding: { label: 'Ding', seconds: 0.9 },
  riser: { label: 'Riser', seconds: 1.8 },
  boom: { label: 'Boom', seconds: 1.1 },
  swipe: { label: 'Swipe', seconds: 0.25 },
} as const;
export type SfxKind = keyof typeof SFX;

const RATE = 48000;

/** A seeded noise source (the same sound every time). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** One-pole low-pass, its cutoff changing over time. */
function lowpass(x: Float32Array, cutoff: (t: number) => number): Float32Array {
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(i / RATE)) / RATE);
    prev += a * (x[i]! - prev);
    y[i] = prev;
  }
  return y;
}

function render(kind: SfxKind): Float32Array {
  const n = Math.round(SFX[kind].seconds * RATE);
  const out = new Float32Array(n);
  const T = SFX[kind].seconds;
  const rnd = noise(kind.length * 7919);
  switch (kind) {
    case 'whoosh':
    case 'swipe': {
      // Air: noise swept up then down in brightness, swelling and fading.
      for (let i = 0; i < n; i++) out[i] = rnd();
      const peak = kind === 'swipe' ? 0.35 : 0.45;
      const y = lowpass(out, (t) => 300 + 5200 * Math.sin(Math.PI * Math.min(1, t / T)) ** 2);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const env = p < peak ? Math.pow(p / peak, 1.6) : Math.pow((1 - p) / (1 - peak), 2.2);
        out[i] = y[i]! * env * 2.6;
      }
      break;
    }
    case 'pop':
      // A short sine falling in pitch, with a soft click at the start.
      for (let i = 0, ph = 0; i < n; i++) {
        const t = i / RATE;
        ph += (2 * Math.PI * (900 * Math.exp(-t * 28) + 180)) / RATE;
        out[i] = Math.sin(ph) * Math.exp(-t * 32) * 0.9 + (i < 120 ? rnd() * 0.25 * (1 - i / 120) : 0);
      }
      break;
    case 'click':
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = (Math.sin(2 * Math.PI * 2400 * t) * 0.6 + rnd() * 0.4) * Math.exp(-t * 180);
      }
      break;
    case 'ding':
      // A bell: a few slightly detuned partials ringing out.
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = (Math.sin(2 * Math.PI * 1320 * t) * 0.55 + Math.sin(2 * Math.PI * 2640.5 * t) * 0.22 + Math.sin(2 * Math.PI * 3962 * t) * 0.1) * Math.exp(-t * 4.2) * Math.min(1, t * 400);
      }
      break;
    case 'riser': {
      // Rising tone and brightening noise, building to the end.
      const y = lowpass(Float32Array.from({ length: n }, () => rnd()), (t) => 200 + 7000 * (t / T) ** 2);
      for (let i = 0, ph = 0; i < n; i++) {
        const p = i / n;
        ph += (2 * Math.PI * (220 + 660 * p * p)) / RATE;
        out[i] = (Math.sin(ph) * 0.35 + y[i]! * 1.6) * Math.pow(p, 1.8) * (i > n - 600 ? (n - i) / 600 : 1);
      }
      break;
    }
    case 'boom':
      // A deep hit: a falling low sine with a burst of dark noise.
      for (let i = 0, ph = 0; i < n; i++) {
        const t = i / RATE;
        ph += (2 * Math.PI * (38 + 90 * Math.exp(-t * 9))) / RATE;
        out[i] = Math.sin(ph) * Math.exp(-t * 3.2) * Math.min(1, t * 600);
      }
      {
        const burst = lowpass(Float32Array.from({ length: n }, () => rnd()), () => 500);
        for (let i = 0; i < n; i++) out[i]! += burst[i]! * Math.exp((-i / RATE) * 14) * 1.8;
      }
      break;
  }
  // Peak at -3 dBFS.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * g;
  return out;
}

/** The effect as a 16-bit mono WAV file. */
export function sfxWav(kind: SfxKind): Buffer {
  const f = render(kind);
  const pcm = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i]! * 32767)));
  return wavOf(pcm, RATE);
}
