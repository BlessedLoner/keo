import { describe, expect, it } from 'vitest';
import { denoise, fft } from '../src/shared/denoise';

const rms = (x: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
};
const db = (a: number, b: number) => 20 * Math.log10(a / b);

describe('Noise removal', () => {
  it('the FFT goes there and back', () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 5));
    const im = new Float64Array(64);
    const orig = re.slice();
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i]!, 9));
  });

  it('takes the hiss out of the pauses and keeps the voice', () => {
    const rate = 48000;
    let seed = 1;
    const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.06;
    // 1 s of hiss, 1 s of a "voice" (a tone) with the same hiss, 1 s of hiss.
    const x = Float32Array.from({ length: rate * 3 }, (_, i) => noise() + (i >= rate && i < rate * 2 ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate) : 0));
    const y = denoise(x);
    // The pause: much quieter.
    expect(db(rms(x, 2000, rate - 2000), rms(y, 2000, rate - 2000))).toBeGreaterThan(12);
    // The voice: about as loud as it was.
    expect(Math.abs(db(rms(x, rate + 4000, rate * 2 - 4000), rms(y, rate + 4000, rate * 2 - 4000)))).toBeLessThan(1.5);
    expect(y.length).toBe(x.length);
  });

  it('leaves very short sound alone', () => {
    const x = Float32Array.of(0.1, 0.2, 0.3);
    expect([...denoise(x)]).toEqual([...x]);
  });
});
