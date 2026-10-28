/** 16 kHz mono: quiet noise with loud "speech" (a 220 Hz tone) in the given seconds. */
export function speechLike(seconds: number, voiced: Array<[number, number]>, rate = 16000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / rate;
    const noise = ((seed / 0x7fffffff) * 2 - 1) * 60;
    const on = voiced.some(([a, b]) => t >= a && t < b);
    out[i] = Math.round(noise + (on ? Math.sin(2 * Math.PI * 220 * t) * 9000 : 0));
  }
  return out;
}
