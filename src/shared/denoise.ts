/**
 * Background noise removal (spectral noise reduction): the sound is cut into short overlapping
 * slices, each turned into frequencies; the steady noise (hum, hiss, fans, room tone) is measured
 * from the quietest slices, and each frequency is turned down by how much of it is that noise.
 * Pure code, the same everywhere; voices keep their own sound.
 */

const SIZE = 1024;
const HOP = SIZE / 4;

/** In-place radix-2 FFT of re/im (length a power of two); inverse divides by n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n;
    im[i] = im[i]! / n;
  }
}

/**
 * The samples with steady background noise turned down. strength 0..1 (how much is taken out;
 * 0.8 is natural, 1 is the most), never below `floorDb` per frequency (so it never sounds hollow).
 */
export function denoise(input: Float32Array, o: { strength?: number; floorDb?: number } = {}): Float32Array {
  const strength = Math.max(0, Math.min(1, o.strength ?? 0.8));
  const floor = Math.pow(10, (o.floorDb ?? -24) / 20);
  const n = input.length;
  if (n < SIZE * 2 || strength === 0) return input.slice();
  const win = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE);
  const frames = Math.floor((n - SIZE) / HOP) + 1;
  const bins = SIZE / 2 + 1;
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  const spectrum = (f: number) => {
    const at = f * HOP;
    for (let i = 0; i < SIZE; i++) {
      re[i] = input[at + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
  };
  // The noise: the average spectrum of the quietest tenth of the slices (found by their loudness).
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * HOP, end = i + SIZE; i < end; i++) e += input[i]! * input[i]!;
    energy[f] = e;
  }
  const quiet = Array.from({ length: frames }, (_, i) => i)
    .sort((x, y) => energy[x]! - energy[y]!)
    .slice(0, Math.max(1, Math.floor(frames / 10)));
  const noise = new Float64Array(bins);
  for (const f of quiet) {
    spectrum(f);
    for (let k = 0; k < bins; k++) noise[k] = noise[k]! + Math.hypot(re[k]!, im[k]!) / quiet.length;
  }
  // Each frequency turned down by its share of noise (over-subtracted a little), smoothed over time.
  const over = 1 + strength;
  const prev = new Float64Array(bins).fill(1);
  const out = new Float64Array(n);
  const norm = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    spectrum(f);
    for (let k = 0; k < bins; k++) {
      const g = Math.max(floor, 1 - (over * strength * noise[k]!) / Math.max(1e-12, Math.hypot(re[k]!, im[k]!)));
      // Gains rise fast (words start cleanly) and fall slowly (no fluttering "musical noise").
      const smooth = g > prev[k]! ? g : 0.6 * prev[k]! + 0.4 * g;
      prev[k] = smooth;
      re[k] = re[k]! * smooth;
      im[k] = im[k]! * smooth;
      if (k > 0 && k < SIZE / 2) {
        re[SIZE - k] = re[k]!;
        im[SIZE - k] = -im[k]!;
      }
    }
    fft(re, im, true);
    const at = f * HOP;
    for (let i = 0; i < SIZE; i++) {
      out[at + i] = out[at + i]! + re[i]! * win[i]!;
      norm[at + i] = norm[at + i]! + win[i]! * win[i]!;
    }
  }
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = norm[i]! > 1e-6 ? out[i]! / norm[i]! : input[i]!;
  return result;
}
