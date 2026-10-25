/** Size and type of a PNG, JPEG or GIF picture, read from its header (null for anything else). */
export interface ImageInfo {
  ext: 'png' | 'jpeg' | 'gif';
  width: number;
  height: number;
}

export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 10 && b.toString('ascii', 0, 4) === 'GIF8') return { ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT C4, JPG C8, DAC CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Fits w×h inside maxW×maxH, keeping the shape. */
export function fit(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const s = Math.min(maxW / w, maxH / h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}
