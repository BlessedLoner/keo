import { describe, expect, it } from 'vitest';
import { buildPalette, lzw, paletteMapper, wavStereo, writeGif } from '../src/shared/gif';

/** A plain GIF LZW decoder (the reference reading of the format), to check Keo's encoder. */
function unLzw(blocks: Uint8Array, minCode = 8): number[] {
  const data: number[] = [];
  for (let i = 0; blocks[i]! > 0; i += blocks[i]! + 1) data.push(...blocks.subarray(i + 1, i + 1 + blocks[i]!));
  const clear = 1 << minCode;
  const end = clear + 1;
  let size = minCode + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: end + 1 }, (_, i) => [i]);
    size = minCode + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  const read = () => {
    let code = 0;
    for (let b = 0; b < size; b++, bitPos++) code |= ((data[bitPos >> 3]! >> (bitPos & 7)) & 1) << b;
    return code;
  };
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else entry = [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = entry;
  }
  return out;
}

describe('GIF writer', () => {
  it('compresses so a standard decoder reads the same pixels back (also past 4096 codes)', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    for (const n of [1, 7, 300, 40000]) {
      // Half noise, half runs: both new codes and long matches.
      const px = Uint8Array.from({ length: n }, (_, i) => (i % 1000 < 500 ? rnd() : (i >> 6) & 255));
      expect(unLzw(lzw(px))).toEqual([...px]);
    }
  });

  it('builds a palette that keeps distinct colours apart', () => {
    const red = Uint8Array.from({ length: 400 }, (_, i) => [255, 0, 0, 255][i % 4]!);
    const blue = Uint8Array.from({ length: 400 }, (_, i) => [0, 0, 255, 255][i % 4]!);
    const pal = buildPalette([red, blue], 4);
    const map = paletteMapper(pal);
    const r = map(red.subarray(0, 4))[0]!;
    const b = map(blue.subarray(0, 4))[0]!;
    expect([pal[r * 3], pal[r * 3 + 2]]).toEqual([255, 0]);
    expect([pal[b * 3], pal[b * 3 + 2]]).toEqual([0, 255]);
  });

  it('writes a looping GIF89a with every frame', () => {
    const pal = new Uint8Array(768);
    const gif = writeGif(2, 2, pal, [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(3, 2, 1, 0)], 7);
    expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif.at(-1)).toBe(0x3b);
    expect(new TextDecoder().decode(gif).split('NETSCAPE2.0')).toHaveLength(2);
    expect([...gif].filter((b, i) => b === 0x2c && gif[i - 1] === 0 && gif[i - 8] === 0x21)).toHaveLength(2);
  });

  it('writes a stereo WAV', () => {
    const w = wavStereo(Float32Array.of(0, 1), Float32Array.of(-1, 0.5), 48000);
    const v = new DataView(w.buffer);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, -32767, 32767, 16384]);
  });
});
