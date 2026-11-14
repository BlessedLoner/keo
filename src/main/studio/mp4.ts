import fs from 'node:fs';

/**
 * Keo Studio's own MP4 reading and writing (ISO base media: .mp4, .mov, .m4a), so exports need no
 * ffmpeg: the Studio window decodes and encodes with the PC's own (hardware) video codecs, and this
 * file only moves compressed samples in and out of the container.
 *
 *  - Mp4Reader: the sample table of each track (where every frame is, its time, key frames) and the
 *    codec description WebCodecs needs to decode it.
 *  - Mp4Writer: H.264 video and AAC or Opus audio into a standard MP4 (moov at the end).
 */

// ---------------------------------------------------------------- reading

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Presentation time and duration, in seconds. */
  time: number;
  duration: number;
  key: boolean;
}

export interface Mp4Track {
  id: number;
  kind: 'video' | 'audio' | 'other';
  /** The sample entry's type: avc1, avc3, hvc1, hev1, mp4a, Opus… */
  format: string;
  /** The codec string for WebCodecs (null: Keo cannot decode this one itself). */
  codec: string | null;
  /** avcC / hvcC (video), AudioSpecificConfig (AAC) or OpusHead (Opus): WebCodecs' "description". */
  description: Buffer | null;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  /** Degrees clockwise the picture is turned when it plays (phones store upright video lying down). */
  rotation: 0 | 90 | 180 | 270;
  sampleRate: number;
  channels: number;
  samples: Mp4Sample[];
}

interface Box {
  type: string;
  start: number;
  /** Where the box's content starts and ends. */
  data: number;
  end: number;
}

function boxesIn(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let data = at + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      data = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, data, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, b: Box, type: string, skip = 0) => boxesIn(buf, b.data + skip, b.end).find((x) => x.type === type) ?? null;
const path = (buf: Buffer, b: Box, ...types: string[]) => {
  let cur: Box | null = b;
  for (const t of types) cur = cur ? child(buf, cur, t) : null;
  return cur;
};

/** The top-level boxes of a file (reading only box headers, not the media). */
function topBoxes(fd: number, size: number): Box[] {
  const out: Box[] = [];
  const head = Buffer.alloc(16);
  let at = 0;
  while (at + 8 <= size) {
    fs.readSync(fd, head, 0, 16, at);
    let len = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let data = at + 8;
    if (len === 1) {
      len = Number(head.readBigUInt64BE(8));
      data = at + 16;
    } else if (len === 0) len = size - at;
    if (len < 8) break;
    out.push({ type, start: at, data, end: Math.min(at + len, size) });
    at += len;
  }
  return out;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** WebCodecs' codec string for an hvcC (ISO/IEC 14496-15 E.3). */
function hevcCodec(format: string, c: Buffer): string {
  const profileSpace = c[1]! >> 6;
  const tier = (c[1]! >> 5) & 1;
  const profile = c[1]! & 0x1f;
  const compat = c.readUInt32BE(2);
  let reversed = 0;
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i);
  const level = c[12]!;
  const constraints = [...c.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return [format, `${['', 'A', 'B', 'C'][profileSpace]}${profile}`, (reversed >>> 0).toString(16), `${tier ? 'H' : 'L'}${level}`, ...constraints.map((b) => b.toString(16))].join('.');
}

function parseTrack(buf: Buffer, trak: Box): Mp4Track | null {
  const tkhd = child(buf, trak, 'tkhd');
  const mdia = child(buf, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const id = buf[tkhd.data] === 1 ? buf.readUInt32BE(tkhd.data + 20) : buf.readUInt32BE(tkhd.data + 12);
  // The display matrix (a, b of its first row tell the turn).
  const m = tkhd.data + (buf[tkhd.data] === 1 ? 52 : 40);
  const ma = m + 8 <= tkhd.end ? buf.readInt32BE(m) : 65536;
  const mb = m + 8 <= tkhd.end ? buf.readInt32BE(m + 4) : 0;
  const turn = (((Math.round((Math.atan2(mb, ma) * 180) / Math.PI / 90) * 90) % 360) + 360) % 360;
  const rotation = (turn === 90 || turn === 180 || turn === 270 ? turn : 0) as Mp4Track['rotation'];
  const mdhd = child(buf, mdia, 'mdhd');
  const hdlr = child(buf, mdia, 'hdlr');
  const stbl = path(buf, mdia, 'minf', 'stbl');
  if (!mdhd || !hdlr || !stbl) return null;
  const v1 = buf[mdhd.data] === 1;
  const timescale = buf.readUInt32BE(mdhd.data + (v1 ? 20 : 12));
  const mdDuration = v1 ? Number(buf.readBigUInt64BE(mdhd.data + 24)) : buf.readUInt32BE(mdhd.data + 16);
  const handler = buf.toString('latin1', hdlr.data + 8, hdlr.data + 12);
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';

  // The first sample description.
  const stsd = child(buf, stbl, 'stsd');
  const entry = stsd ? boxesIn(buf, stsd.data + 8, stsd.end)[0] : undefined;
  const format = entry?.type ?? '';
  let codec: string | null = null;
  let description: Buffer | null = null;
  let width = 0;
  let height = 0;
  let sampleRate = 0;
  let channels = 0;
  if (entry && kind === 'video') {
    width = buf.readUInt16BE(entry.data + 24);
    height = buf.readUInt16BE(entry.data + 26);
    const inner = boxesIn(buf, entry.data + 78, entry.end);
    const avcC = inner.find((b) => b.type === 'avcC');
    const hvcC = inner.find((b) => b.type === 'hvcC');
    if (avcC && (format === 'avc1' || format === 'avc3')) {
      description = Buffer.from(buf.subarray(avcC.data, avcC.end));
      codec = `${format}.${hex2(description[1]!)}${hex2(description[2]!)}${hex2(description[3]!)}`;
    } else if (hvcC && (format === 'hvc1' || format === 'hev1')) {
      description = Buffer.from(buf.subarray(hvcC.data, hvcC.end));
      codec = hevcCodec(format, description);
    }
  } else if (entry && kind === 'audio') {
    channels = buf.readUInt16BE(entry.data + 16);
    sampleRate = buf.readUInt32BE(entry.data + 24) >>> 16;
    const qtVersion = buf.readUInt16BE(entry.data + 8);
    const skip = qtVersion === 1 ? 16 : qtVersion === 2 ? 36 : 0;
    const inner = boxesIn(buf, entry.data + 28 + skip, entry.end);
    if (format === 'mp4a') {
      const esds = inner.find((b) => b.type === 'esds') ?? (inner.find((b) => b.type === 'wave') ? boxesIn(buf, inner.find((b) => b.type === 'wave')!.data, inner.find((b) => b.type === 'wave')!.end).find((b) => b.type === 'esds') : undefined);
      const asc = esds ? audioSpecificConfig(buf.subarray(esds.data + 4, esds.end)) : null;
      if (asc) {
        description = asc;
        const objectType = asc[0]! >> 3;
        codec = `mp4a.40.${objectType || 2}`;
      }
    } else if (format === 'Opus') {
      const dOps = inner.find((b) => b.type === 'dOps');
      if (dOps) {
        description = opusHeadFromDOps(buf.subarray(dOps.data, dOps.end));
        codec = 'opus';
      }
    }
  }

  // The sample table.
  const read = (type: string) => child(buf, stbl, type);
  const stts = read('stts');
  const ctts = read('ctts');
  const stss = read('stss');
  const stsc = read('stsc');
  const stsz = read('stsz');
  const stco = read('stco') ?? read('co64');
  if (!stts || !stsc || !stsz || !stco) return null;
  const count = buf.readUInt32BE(stsz.data + 8);
  const fixed = buf.readUInt32BE(stsz.data + 4);
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || buf.readUInt32BE(stsz.data + 12 + i * 4);
  const chunkCount = buf.readUInt32BE(stco.data + 4);
  const wide = stco.type === 'co64';
  const chunkOffset = (i: number) => (wide ? Number(buf.readBigUInt64BE(stco.data + 8 + i * 8)) : buf.readUInt32BE(stco.data + 8 + i * 4));
  const stscEntries = buf.readUInt32BE(stsc.data + 4);
  const offsets = new Array<number>(count);
  let s = 0;
  for (let e = 0; e < stscEntries; e++) {
    const first = buf.readUInt32BE(stsc.data + 8 + e * 12) - 1;
    const per = buf.readUInt32BE(stsc.data + 12 + e * 12);
    const next = e + 1 < stscEntries ? buf.readUInt32BE(stsc.data + 8 + (e + 1) * 12) - 1 : chunkCount;
    for (let c = first; c < next && s < count; c++) {
      let at = chunkOffset(c);
      for (let k = 0; k < per && s < count; k++) {
        offsets[s] = at;
        at += sizes[s]!;
        s++;
      }
    }
  }
  const dts = new Array<number>(count);
  const durs = new Array<number>(count);
  {
    let i = 0;
    let t = 0;
    const n = buf.readUInt32BE(stts.data + 4);
    for (let e = 0; e < n; e++) {
      const c = buf.readUInt32BE(stts.data + 8 + e * 8);
      const d = buf.readUInt32BE(stts.data + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) {
        dts[i] = t;
        durs[i] = d;
        t += d;
      }
    }
  }
  const offsetCts = new Array<number>(count).fill(0);
  if (ctts) {
    const signed = buf[ctts.data] === 1;
    let i = 0;
    const n = buf.readUInt32BE(ctts.data + 4);
    for (let e = 0; e < n; e++) {
      const c = buf.readUInt32BE(ctts.data + 8 + e * 8);
      const o = signed ? buf.readInt32BE(ctts.data + 12 + e * 8) : buf.readUInt32BE(ctts.data + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) offsetCts[i] = o;
    }
  }
  const keys = new Set<number>();
  if (stss) {
    const n = buf.readUInt32BE(stss.data + 4);
    for (let e = 0; e < n; e++) keys.add(buf.readUInt32BE(stss.data + 8 + e * 4) - 1);
  }
  // An edit list that starts later in the media (common in phone videos) shifts the times.
  let shift = 0;
  const elst = path(buf, trak, 'edts', 'elst');
  if (elst) {
    const v = buf[elst.data];
    const n = buf.readUInt32BE(elst.data + 4);
    for (let e = 0; e < n; e++) {
      const mediaTime = v === 1 ? Number(buf.readBigInt64BE(elst.data + 8 + e * 20 + 8)) : buf.readInt32BE(elst.data + 8 + e * 12 + 4);
      if (mediaTime >= 0) {
        shift = mediaTime;
        break;
      }
    }
  }
  const samples: Mp4Sample[] = new Array(count);
  for (let i = 0; i < count; i++) samples[i] = { offset: offsets[i]!, size: sizes[i]!, time: (dts[i]! + offsetCts[i]! - shift) / timescale, duration: durs[i]! / timescale, key: stss ? keys.has(i) : true };
  return { id, kind, format, codec, description, timescale, duration: mdDuration / timescale, width, height, rotation, sampleRate, channels, samples };
}

/** The DecoderSpecificInfo (AudioSpecificConfig) inside an esds' ES descriptor. */
function audioSpecificConfig(es: Buffer): Buffer | null {
  let at = 0;
  const len = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = es[at++]!;
      n = (n << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return n;
  };
  while (at < es.length) {
    const tag = es[at++]!;
    const size = len();
    if (tag === 0x03) {
      const flags = es[at + 2]!;
      at += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + es[at + 3]! : 0) + (flags & 0x20 ? 2 : 0);
    } else if (tag === 0x04) at += 13;
    else if (tag === 0x05) return Buffer.from(es.subarray(at, at + size));
    else at += size;
  }
  return null;
}

/** dOps (big-endian, in MP4) to OpusHead (little-endian, what WebCodecs takes). */
function opusHeadFromDOps(d: Buffer): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = d[1]!;
  head.writeUInt16LE(d.readUInt16BE(2), 10);
  head.writeUInt32LE(d.readUInt32BE(4), 12);
  head.writeInt16LE(d.readInt16BE(8), 16);
  head[18] = d[10] ?? 0;
  return head;
}

export class Mp4Reader {
  private constructor(
    private readonly fd: number,
    readonly tracks: Mp4Track[],
  ) {}

  /** Opens a file and reads its sample tables (null: not an MP4/MOV Keo can read). */
  static open(file: string): Mp4Reader | null {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const moov = topBoxes(fd, size).find((b) => b.type === 'moov');
      if (!moov || moov.end - moov.start > 400 * 1024 * 1024) throw new Error('no moov');
      const buf = Buffer.alloc(moov.end - moov.start);
      fs.readSync(fd, buf, 0, buf.length, moov.start);
      const root: Box = { type: 'moov', start: 0, data: moov.data - moov.start, end: buf.length };
      const tracks = boxesIn(buf, root.data, root.end)
        .filter((b) => b.type === 'trak')
        .map((t) => parseTrack(buf, t))
        .filter((t): t is Mp4Track => !!t);
      return new Mp4Reader(fd, tracks);
    } catch {
      fs.closeSync(fd);
      return null;
    }
  }

  video(): Mp4Track | null {
    return this.tracks.find((t) => t.kind === 'video' && t.samples.length > 0) ?? null;
  }

  audio(): Mp4Track | null {
    return this.tracks.find((t) => t.kind === 'audio' && t.samples.length > 0) ?? null;
  }

  sample(s: Mp4Sample): Buffer {
    const b = Buffer.alloc(s.size);
    fs.readSync(this.fd, b, 0, s.size, s.offset);
    return b;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/** The index of the key frame at or before `time` (in decode order), to start decoding from. */
export function keyBefore(t: Mp4Track, time: number): number {
  let best = 0;
  for (let i = 0; i < t.samples.length; i++) {
    const s = t.samples[i]!;
    if (s.key && s.time <= time + 1e-6) best = i;
    if (s.time > time + 2) break;
  }
  return best;
}

// ---------------------------------------------------------------- writing

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const str = (s: string) => Buffer.from(s, 'latin1');
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), str(type), body]);
};
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts);
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export interface WriterVideo {
  width: number;
  height: number;
  /** H.264 (the default) or H.265 / HEVC. */
  codec?: 'h264' | 'h265';
  /** The avcC record — or the hvcC record for H.265 (WebCodecs' decoderConfig.description). */
  avcC: Buffer;
}
export interface WriterAudio {
  codec: 'aac' | 'opus';
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig (AAC) or OpusHead (Opus). */
  config: Buffer;
}

interface Written {
  offset: number;
  size: number;
  /** Presentation time in microseconds. */
  time: number;
  key: boolean;
  /** Which video description (stream settings) the frame uses: a resumed export may have a second. */
  desc?: number;
}

/** Where a stopped export can carry on: its video frames so far end just before a key frame. */
export interface ResumePoint {
  /** Video frames already in the file (the next frame to encode). */
  frames: number;
  /** That next frame's time in microseconds. */
  timeUs: number;
}

/**
 * Writes an MP4: media data as it arrives, the index (moov) when it is finished. With a journal,
 * the frames written so far are noted beside the file at each key frame, so a long export that
 * stops (the renderer failed, Keo closed or crashed) can carry on from there: Mp4Writer.resume.
 */
export class Mp4Writer {
  private readonly fd: number;
  private at = 0;
  private mdatStart = 0;
  private readonly v: Written[] = [];
  private readonly a: Written[] = [];
  private lastVideoEnd = 0;
  private lastAudioEnd = 0;
  /** The stream descriptions (avcC / hvcC), the first from the start. */
  private readonly descs: Buffer[];
  /** Journal lines not saved yet (saved at the next key frame, once their frames are whole). */
  private pending: string[] = [];
  private suspended = false;

  constructor(
    private readonly file: string,
    private readonly video: WriterVideo,
    private readonly audio: WriterAudio | null,
    /** A QuickTime .mov (the same tracks, labelled for QuickTime players and editors). */
    quicktime = false,
    /** Where the journal goes (none: the export cannot be resumed). */
    private readonly journal?: string,
    resume?: { at: number; mdatStart: number; v: Written[]; a: Written[]; descs: Buffer[]; lastVideoEnd: number; lastAudioEnd: number },
  ) {
    this.descs = resume ? [...resume.descs] : [video.avcC];
    if (resume) {
      // Carry on: the file is cut back to the key frame, the frames before it are kept.
      fs.truncateSync(file, resume.at);
      this.fd = fs.openSync(file, 'r+');
      this.at = resume.at;
      this.mdatStart = resume.mdatStart;
      this.v.push(...resume.v);
      this.a.push(...resume.a);
      this.lastVideoEnd = resume.lastVideoEnd;
      this.lastAudioEnd = resume.lastAudioEnd;
      return;
    }
    this.fd = fs.openSync(file, 'w');
    this.put(quicktime ? box('ftyp', str('qt  '), u32(0x200), str('qt  ')) : box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str(video.codec === 'h265' ? 'hvc1' : 'avc1'), str('mp41')));
    this.mdatStart = this.at;
    // A 64-bit mdat header; its size is filled in at the end.
    this.put(Buffer.concat([u32(1), str('mdat'), u64(0)]));
    if (journal) {
      const head = { keo: 1, video: { width: video.width, height: video.height, codec: video.codec ?? 'h264' }, audio: audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, config: audio.config.toString('base64') } : null, quicktime, mdatStart: this.mdatStart };
      fs.writeFileSync(journal, `${JSON.stringify(head)}\nD ${video.avcC.toString('base64')}\n`);
    }
  }

  /** Carries on writing a stopped export from its last key frame (null: nothing to carry on from). */
  static resume(file: string, journal: string): { writer: Mp4Writer; point: ResumePoint } | null {
    let lines: string[];
    try {
      lines = fs.readFileSync(journal, 'utf8').split('\n');
    } catch {
      return null;
    }
    let head: { keo: number; video: { width: number; height: number; codec: 'h264' | 'h265' }; audio: { codec: 'aac' | 'opus'; sampleRate: number; channels: number; config: string } | null; quicktime: boolean; mdatStart: number };
    try {
      head = JSON.parse(lines[0] ?? '');
    } catch {
      return null;
    }
    if (head?.keo !== 1 || !fs.existsSync(file)) return null;
    const descs: Buffer[] = [];
    const v: Written[] = [];
    const a: Written[] = [];
    let good: { at: number; v: number; a: number; descs: number; time: number } | null = null;
    for (const line of lines.slice(1)) {
      const [k, ...f] = line.split(' ');
      if (k === 'D' && f[0]) descs.push(Buffer.from(f[0], 'base64'));
      else if ((k === 'V' || k === 'A') && f.length >= 4) {
        const w: Written = { offset: Number(f[0]), size: Number(f[1]), time: Number(f[2]), key: f[3] === '1', ...(k === 'V' ? { desc: Number(f[4] ?? 0) } : {}) };
        if (![w.offset, w.size, w.time].every(Number.isFinite)) break;
        (k === 'V' ? v : a).push(w);
      } else if (k === 'R' && f.length >= 2) good = { at: Number(f[0]), v: v.length, a: a.length, descs: descs.length, time: Number(f[1]) };
      else if (line.trim()) break;
    }
    // Only what was noted up to the last key frame is sure to be whole in the file.
    if (!good || !good.v || !descs.length) return null;
    if (fs.statSync(file).size < good.at) return null;
    const keptV = v.slice(0, good.v);
    const keptA = a.slice(0, good.a);
    const keptD = descs.slice(0, good.descs);
    const lastAudio = keptA[keptA.length - 1];
    const audioStep = keptA.length > 1 ? lastAudio!.time - keptA[keptA.length - 2]!.time : 21_333;
    const video: WriterVideo = { width: head.video.width, height: head.video.height, codec: head.video.codec, avcC: keptD[keptD.length - 1]! };
    const audio: WriterAudio | null = head.audio ? { codec: head.audio.codec, sampleRate: head.audio.sampleRate, channels: head.audio.channels, config: Buffer.from(head.audio.config, 'base64') } : null;
    const writer = new Mp4Writer(file, video, audio, head.quicktime, journal, {
      at: good.at,
      mdatStart: head.mdatStart,
      v: keptV,
      a: keptA,
      descs: keptD,
      lastVideoEnd: good.time,
      lastAudioEnd: lastAudio ? lastAudio.time + audioStep : 0,
    });
    // The journal is written again with only what is kept (a half-written end is dropped).
    const out = [lines[0]!, ...keptD.map((d) => `D ${d.toString('base64')}`), ...keptA.map((w) => `A ${w.offset} ${w.size} ${w.time} 1`), ...keptV.map((w) => `V ${w.offset} ${w.size} ${w.time} ${w.key ? 1 : 0} ${w.desc ?? 0}`), `R ${good.at} ${good.time}`];
    fs.writeFileSync(`${journal}.tmp`, `${out.join('\n')}\n`);
    fs.renameSync(`${journal}.tmp`, journal);
    return { writer, point: { frames: keptV.length, timeUs: good.time } };
  }

  /** The stream description of the frames from here on (a resumed export's encoder may describe its stream differently). */
  setVideoDescription(desc: Buffer): void {
    if (this.descs[this.descs.length - 1]!.equals(desc)) return;
    this.descs.push(desc);
    if (this.journal) this.pending.push(`D ${desc.toString('base64')}`);
  }

  private put(b: Buffer): void {
    fs.writeSync(this.fd, b, 0, b.length, this.at);
    this.at += b.length;
  }

  /** One encoded video frame (presentation time and length in microseconds). */
  writeVideo(data: Buffer, timeUs: number, durationUs: number, key: boolean): void {
    // At a key frame everything before it is whole: noted in the journal as a place to carry on from.
    if (key && this.journal && this.v.length) this.saveJournal(timeUs);
    const w: Written = { offset: this.at, size: data.length, time: timeUs, key, desc: this.descs.length - 1 };
    this.v.push(w);
    this.lastVideoEnd = Math.max(this.lastVideoEnd, timeUs + durationUs);
    this.put(data);
    if (this.journal) this.pending.push(`V ${w.offset} ${w.size} ${w.time} ${key ? 1 : 0} ${w.desc}`);
  }

  writeAudio(data: Buffer, timeUs: number, durationUs: number): void {
    const w: Written = { offset: this.at, size: data.length, time: timeUs, key: true };
    this.a.push(w);
    this.lastAudioEnd = Math.max(this.lastAudioEnd, timeUs + durationUs);
    this.put(data);
    if (this.journal) this.pending.push(`A ${w.offset} ${w.size} ${w.time} 1`);
  }

  private saveJournal(keyTimeUs: number): void {
    if (!this.journal) return;
    this.pending.push(`R ${this.at} ${keyTimeUs}`);
    fs.appendFileSync(this.journal, `${this.pending.join('\n')}\n`);
    this.pending = [];
  }

  /** Whether the journal has a place to carry on from. */
  get resumable(): boolean {
    if (!this.journal) return false;
    try {
      return /\nR \d+ \d+/.test(fs.readFileSync(this.journal, 'utf8'));
    } catch {
      return false;
    }
  }

  /** Stops writing but keeps the file and its journal, to carry on later (Mp4Writer.resume). */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* closed */
    }
  }

  /** Writes the index and closes the file. */
  finish(): { videoFrames: number; audioPackets: number; durationSec: number; bytes: number } {
    const mdatSize = this.at - this.mdatStart;
    const head = u64(mdatSize);
    fs.writeSync(this.fd, head, 0, 8, this.mdatStart + 8);
    const durationMs = Math.round(Math.max(this.lastVideoEnd, this.lastAudioEnd) / 1000);
    const traks = [this.trak(1, 'video', this.v, 90000, this.lastVideoEnd)];
    if (this.audio && this.a.length) traks.push(this.trak(2, 'audio', this.a, this.audio.sampleRate, this.lastAudioEnd));
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(traks.length + 1));
    this.put(box('moov', mvhd, ...traks));
    const bytes = this.at;
    fs.closeSync(this.fd);
    if (this.journal) fs.rmSync(this.journal, { force: true });
    return { videoFrames: this.v.length, audioPackets: this.a.length, durationSec: durationMs / 1000, bytes };
  }

  /** Stops without a usable file (export cancelled or failed). */
  abort(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* closed */
    }
    fs.rmSync(this.file, { force: true });
    if (this.journal) fs.rmSync(this.journal, { force: true });
  }

  private trak(id: number, kind: 'video' | 'audio', samples: Written[], timescale: number, endUs: number): Buffer {
    const ts = (us: number) => Math.round((us * timescale) / 1e6);
    // Durations from one sample to the next (samples arrive in presentation order, no B-frames).
    const order = samples.map((s, i) => ({ s, i })).sort((x, y) => x.s.time - y.s.time);
    const deltas: number[] = new Array(samples.length);
    for (let k = 0; k < order.length; k++) {
      const here = ts(order[k]!.s.time);
      const next = k + 1 < order.length ? ts(order[k + 1]!.s.time) : ts(endUs);
      deltas[order[k]!.i] = Math.max(1, next - here);
    }
    const stts: Buffer[] = [];
    let runs = 0;
    for (let i = 0; i < deltas.length; ) {
      let j = i;
      while (j + 1 < deltas.length && deltas[j + 1] === deltas[i]) j++;
      stts.push(u32(j - i + 1), u32(deltas[i]!));
      runs++;
      i = j + 1;
    }
    const mediaDuration = ts(endUs);
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stbl = box(
      'stbl',
      kind === 'video' ? full('stsd', 0, 0, u32(this.descs.length), ...this.descs.map((d) => this.avc1(d))) : full('stsd', 0, 0, u32(1), this.audioEntry()),
      full('stts', 0, 0, u32(runs), ...stts),
      ...(kind === 'video' ? [full('stss', 0, 0, u32(keys.length), ...keys.map(u32))] : []),
      this.stsc(kind === 'video' ? samples : []),
      full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.size))),
      full('co64', 0, 0, u32(samples.length), ...samples.map((s) => u64(s.offset))),
    );
    const minf = box('minf', kind === 'video' ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box(
      'mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str(kind === 'video' ? 'vide' : 'soun'), Buffer.alloc(12), str(kind === 'video' ? 'Keo video\0' : 'Keo sound\0')),
      minf,
    );
    const w = kind === 'video' ? this.video.width : 0;
    const h = kind === 'video' ? this.video.height : 0;
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.round(endUs / 1000)), Buffer.alloc(8), u16(0), u16(kind === 'audio' ? 1 : 0), u16(kind === 'audio' ? 0x0100 : 0), u16(0), MATRIX, u32(w << 16), u32(h << 16));
    return box('trak', tkhd, mdia);
  }

  /** One sample per chunk; a new run wherever the frames change to another stream description. */
  private stsc(samples: Written[]): Buffer {
    const runs: Buffer[] = [];
    let last = -1;
    samples.forEach((s, i) => {
      const d = s.desc ?? 0;
      if (d !== last) runs.push(u32(i + 1), u32(1), u32(d + 1));
      last = d;
    });
    if (!runs.length) runs.push(u32(1), u32(1), u32(1));
    return full('stsc', 0, 0, u32(runs.length / 3), ...runs);
  }

  private avc1(desc: Buffer = this.video.avcC): Buffer {
    const name = Buffer.alloc(32);
    name[0] = 3;
    name.write('Keo', 1, 'latin1');
    const hevc = this.video.codec === 'h265';
    return box(
      hevc ? 'hvc1' : 'avc1',
      Buffer.alloc(6),
      u16(1),
      u16(0),
      u16(0),
      Buffer.alloc(12),
      u16(this.video.width),
      u16(this.video.height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      name,
      u16(0x0018),
      u16(0xffff),
      box(hevc ? 'hvcC' : 'avcC', desc),
    );
  }

  private audioEntry(): Buffer {
    const a = this.audio!;
    const common = [Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(a.channels), u16(16), u16(0), u16(0), u32((a.codec === 'opus' ? 48000 : a.sampleRate) << 16)];
    if (a.codec === 'opus') {
      const h = a.config;
      // OpusHead (little-endian) to dOps (big-endian).
      const dOps = Buffer.concat([u8(0), u8(h[9] ?? a.channels), u16(h.length >= 12 ? h.readUInt16LE(10) : 312), u32(h.length >= 16 ? h.readUInt32LE(12) : a.sampleRate), u16(h.length >= 18 ? h.readInt16LE(16) & 0xffff : 0), u8(0)]);
      return box('Opus', ...common, box('dOps', dOps));
    }
    const desc = (tag: number, body: Buffer) => Buffer.concat([u8(tag), u8(0x80), u8(0x80), u8(0x80), u8(body.length), body]);
    const dsi = desc(0x05, a.config);
    const dcd = desc(0x04, Buffer.concat([u8(0x40), u8(0x15), Buffer.from([0, 0, 0]), u32(0), u32(0), dsi]));
    const es = desc(0x03, Buffer.concat([u16(2), u8(0), dcd, desc(0x06, u8(0x02))]));
    return box('mp4a', ...common, full('esds', 0, 0, es));
  }
}
