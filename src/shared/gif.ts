/**
 * Keo's own animated GIF writer: one 256-colour palette for the whole animation (no colour
 * flicker between frames), built by median cut from sample frames, and LZW-compressed frames.
 * Pure code (no browser or Node APIs) so it can be tested.
 */

/** A 256-colour palette (r, g, b triples) for these pixels (RGBA), by median cut. */
export function buildPalette(samples: Uint8Array[], size = 256): Uint8Array {
  // At most ~60k pixels are looked at (every n-th one).
  const total = samples.reduce((n, s) => n + s.length / 4, 0);
  const every = Math.max(1, Math.floor(total / 60000));
  const px: number[] = [];
  let k = 0;
  for (const s of samples)
    for (let i = 0; i < s.length; i += 4, k++) if (k % every === 0) px.push((s[i]! << 16) | (s[i + 1]! << 8) | s[i + 2]!);
  if (!px.length) px.push(0);
  type Box = { colors: number[] };
  const boxes: Box[] = [{ colors: px }];
  const range = (b: Box, shift: number) => {
    let lo = 255;
    let hi = 0;
    for (const c of b.colors) {
      const v = (c >> shift) & 255;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  while (boxes.length < size) {
    // Split the box with the widest colour range, at its median.
    let best = -1;
    let bestRange = 0;
    let bestShift = 16;
    boxes.forEach((b, i) => {
      if (b.colors.length < 2) return;
      for (const shift of [16, 8, 0]) {
        const r = range(b, shift);
        if (r > bestRange) {
          bestRange = r;
          best = i;
          bestShift = shift;
        }
      }
    });
    if (best < 0) break;
    const b = boxes[best]!;
    b.colors.sort((x, y) => ((x >> bestShift) & 255) - ((y >> bestShift) & 255));
    const mid = b.colors.length >> 1;
    boxes.splice(best, 1, { colors: b.colors.slice(0, mid) }, { colors: b.colors.slice(mid) });
  }
  const pal = new Uint8Array(size * 3);
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const c of b.colors) {
      r += (c >> 16) & 255;
      g += (c >> 8) & 255;
      bl += c & 255;
    }
    const n = Math.max(1, b.colors.length);
    pal[i * 3] = Math.round(r / n);
    pal[i * 3 + 1] = Math.round(g / n);
    pal[i * 3 + 2] = Math.round(bl / n);
  });
  return pal;
}

/** Maps RGBA pixels to palette indexes (nearest colour; looked up once per 15-bit colour). */
export function paletteMapper(pal: Uint8Array): (rgba: Uint8Array) => Uint8Array {
  const cache = new Int16Array(32768).fill(-1);
  const n = pal.length / 3;
  const nearest = (r: number, g: number, b: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = pal[i * 3]! - r;
      const dg = pal[i * 3 + 1]! - g;
      const db = pal[i * 3 + 2]! - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  return (rgba) => {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      const key = ((rgba[i]! >> 3) << 10) | ((rgba[i + 1]! >> 3) << 5) | (rgba[i + 2]! >> 3);
      let v = cache[key]!;
      if (v < 0) {
        v = nearest((rgba[i]! & 0xf8) | 4, (rgba[i + 1]! & 0xf8) | 4, (rgba[i + 2]! & 0xf8) | 4);
        cache[key] = v;
      }
      out[j] = v;
    }
    return out;
  };
}

/** GIF's LZW compression of 8-bit palette indexes, as data sub-blocks. */
export function lzw(indexes: Uint8Array, minCode = 8): Uint8Array {
  const clear = 1 << minCode;
  const end = clear + 1;
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  let size = minCode + 1;
  const put = (code: number) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = end + 1;
  put(clear);
  let prefix = indexes.length ? indexes[0]! : 0;
  for (let i = 1; i < indexes.length; i++) {
    const c = indexes[i]!;
    const key = (prefix << 8) | c;
    const have = dict.get(key);
    if (have !== undefined) {
      prefix = have;
      continue;
    }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      put(clear);
      dict = new Map();
      next = end + 1;
      size = minCode + 1;
    }
    prefix = c;
  }
  if (indexes.length) put(prefix);
  put(end);
  if (bits > 0) out.push(cur & 255);
  // Sub-blocks of at most 255 bytes, then a 0 terminator.
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n, ...out.slice(i, i + n));
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

const u16 = (v: number) => [v & 255, (v >> 8) & 255];

/** The start of a looping GIF: its size and the one 256-colour palette. */
export function gifHead(width: number, height: number, pal: Uint8Array): Uint8Array {
  const table = new Uint8Array(768);
  table.set(pal.subarray(0, 768));
  // Screen: size, a global colour table of 256 entries; then loop forever (NETSCAPE2.0).
  return join([new TextEncoder().encode('GIF89a'), Uint8Array.from([...u16(width), ...u16(height), 0xf7, 0, 0]), table, Uint8Array.from([0x21, 0xff, 0x0b, ...new TextEncoder().encode('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0])]);
}

/** One frame of palette indexes, shown `delayCs` hundredths of a second. */
export function gifFrame(width: number, height: number, indexes: Uint8Array, delayCs: number): Uint8Array {
  return join([Uint8Array.from([0x21, 0xf9, 0x04, 0x00, ...u16(delayCs), 0, 0, 0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, 8]), lzw(indexes)]);
}

export const GIF_END = Uint8Array.of(0x3b);

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A looping animated GIF of palette-indexed frames, each shown `delayCs` hundredths of a second. */
export function writeGif(width: number, height: number, pal: Uint8Array, frames: Uint8Array[], delayCs: number): Uint8Array {
  return join([gifHead(width, height, pal), ...frames.map((f) => gifFrame(width, height, f, delayCs)), GIF_END]);
}

/** 16-bit PCM stereo WAV of two channels of samples (-1..1). */
export function wavStereo(left: Float32Array, right: Float32Array, rate: number): Uint8Array {
  const n = left.length;
  const out = new Uint8Array(44 + n * 4);
  const v = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32767), true);
    v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i]!)) * 32767), true);
  }
  return out;
}
