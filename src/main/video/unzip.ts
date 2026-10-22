import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/**
 * A small reader for ordinary .zip files (stored or deflated entries, no encryption, no zip64):
 * enough to take a few known files out of a downloaded archive without a shell or another tool.
 * Each file is written to a path the caller chooses, never to a name taken from the archive.
 */
export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  encrypted: boolean;
}

export class ZipError extends Error {}

export async function listZip(file: string): Promise<ZipEntry[]> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('The download is not a zip file.');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('The zip file is in a format Keo cannot read (zip64).');
    if (cdOffset + cdSize > size) throw new ZipError('The zip file is damaged.');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip file is damaged.');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      out.push({
        name: cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
        encrypted: (cd.readUInt16LE(p + 8) & 1) === 1,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Writes one entry to `dest`, checking its size and CRC-32 (a damaged file is removed). */
export async function extractEntry(file: string, e: ZipEntry, dest: string, signal?: AbortSignal): Promise<void> {
  if (e.encrypted) throw new ZipError(`${e.name} is encrypted.`);
  if (e.method !== 0 && e.method !== 8) throw new ZipError(`${e.name} is packed in a way Keo cannot read.`);
  const fh = await fs.promises.open(file, 'r');
  let start: number;
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, e.localOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipError('The zip file is damaged.');
    start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  let crc = 0;
  let written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      crc = zlib.crc32(chunk, crc);
      written += chunk.length;
      cb(written > e.size ? new ZipError(`${e.name} is larger than the zip file says.`) : null, chunk);
    },
  });
  if (!e.compressedSize) {
    if (e.size) throw new ZipError('The zip file is damaged.');
    fs.writeFileSync(dest, '');
    return;
  }
  const source = fs.createReadStream(file, { start, end: start + e.compressedSize - 1 });
  const stages = e.method === 8 ? [source, zlib.createInflateRaw(), check] : [source, check];
  try {
    await pipeline([...stages, fs.createWriteStream(dest)], signal ? { signal } : {});
    if (written !== e.size || crc >>> 0 !== e.crc >>> 0) throw new ZipError(`${e.name} is damaged inside the zip file.`);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
}
