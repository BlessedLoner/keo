/** Samples a grid of pixels; a capture where every sample is identical is treated as blank. */
export function isBlank(bitmap: Buffer, width: number, height: number): boolean {
  if (bitmap.length < width * height * 4) return true;
  const first = bitmap.readUInt32LE(0);
  const stepX = Math.max(1, Math.floor(width / 40));
  const stepY = Math.max(1, Math.floor(height / 40));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      if (bitmap.readUInt32LE((y * width + x) * 4) !== first) return false;
    }
  }
  return true;
}
