/**
 * Colour LUTs (.cube files, the format editors and cameras share): a 3D table that maps every colour
 * to a graded one. Read here so Keo checks a file when it is imported and the picture engine uses
 * the same numbers in the preview and the export.
 */

export interface Lut {
  /** Points along each side of the cube (2–64). */
  size: number;
  /** size³ colours, red changing fastest, then green, then blue; each 0–1. */
  data: Float32Array;
}

/** The name a LUT is kept under (made from its file name). */
export const LUT_NAME = /^[a-z0-9][a-z0-9 _-]{0,47}$/;

export function lutNameOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  return LUT_NAME.test(base) ? base : 'my look';
}

/** Reads a .cube file; throws with a plain reason when it is not one Keo can use. */
export function parseCube(text: string): Lut {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') continue;
    if (key === 'LUT_1D_SIZE') throw new Error('This is a 1D LUT; Keo uses 3D LUTs (.cube files with LUT_3D_SIZE).');
    if (key === 'LUT_3D_SIZE') {
      size = Number(parts[1]);
      continue;
    }
    if (key === 'DOMAIN_MIN') {
      min = parts.slice(1, 4).map(Number);
      continue;
    }
    if (key === 'DOMAIN_MAX') {
      max = parts.slice(1, 4).map(Number);
      continue;
    }
    if (/^[A-Z_]+$/.test(key)) continue;
    if (parts.length < 3) continue;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (![r, g, b].every(Number.isFinite)) throw new Error('The file has a line that is not three numbers.');
    values.push(r, g, b);
  }
  if (!Number.isInteger(size) || size < 2 || size > 64) throw new Error('The file does not say its size (LUT_3D_SIZE between 2 and 64).');
  if (values.length !== size * size * size * 3) throw new Error(`The file should have ${size ** 3} colours but has ${values.length / 3}.`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    const span = (max[c] ?? 1) - (min[c] ?? 0) || 1;
    data[i] = Math.max(0, Math.min(1, (values[i]! - (min[c] ?? 0)) / span));
  }
  return { size, data };
}

/** A tone curve as 256 levels (0–1) through its points, smooth and never turning back on itself. */
export function curveTable(points: Array<[number, number]>): Float32Array {
  const pts = [...points].map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (pts[0]![0] > 0) pts.unshift([0, pts[0]![1]]);
  if (pts.at(-1)![0] < 1) pts.push([1, pts.at(-1)![1]]);
  const n = pts.length;
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1]![1] - pts[i]![1]) / Math.max(1e-6, pts[i + 1]![0] - pts[i]![0]));
  m.push(d[0] ?? 0);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2] ?? 0);
  // Monotone (Fritsch–Carlson): no overshoot between points.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  const out = new Float32Array(256);
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    while (k < n - 2 && x > pts[k + 1]![0]) k++;
    const [x0, y0] = pts[k]!;
    const [x1, y1] = pts[k + 1]!;
    const h = Math.max(1e-6, x1 - x0);
    const t = Math.max(0, Math.min(1, (x - x0) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[k]! + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[k + 1]!;
    out[i] = Math.max(0, Math.min(1, y));
  }
  return out;
}
