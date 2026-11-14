/**
 * Keo Studio — writing a WebM (VP9 video, Opus sound) as the render window encodes it, and reading
 * one back to check it. WebM is Matroska: EBML elements (an id, a size, the body). Clusters start at
 * each key frame, with the sound packets that belong between frames written in time order, and Cues
 * at the end so players can seek.
 */
import fs from 'node:fs';

// ---------------------------------------------------------------- EBML

/** An element id as its bytes (ids keep their length marker, e.g. 0x1A45DFA3). */
const idBytes = (id: number) => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from(out);
};

/** A size as a variable-length integer (the smallest that fits, or exactly `len` bytes). */
function vsize(n: number, len?: number): Buffer {
  let l = len ?? 1;
  if (!len) while (n >= 2 ** (7 * l) - 1) l++;
  const b = Buffer.alloc(l);
  let v = n;
  for (let i = l - 1; i >= 0; i--) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  b[0]! |= 1 << (8 - l);
  return b;
}

const el = (id: number, ...body: Buffer[]) => {
  const data = Buffer.concat(body);
  return Buffer.concat([idBytes(id), vsize(data.length), data]);
};
/** An unsigned integer element (the fewest bytes, or exactly `len` so it can be filled in later). */
const uint = (id: number, n: number, len?: number) => {
  let l = len ?? 1;
  if (!len) while (n >= 2 ** (8 * l)) l++;
  const b = Buffer.alloc(l);
  let v = n;
  for (let i = l - 1; i >= 0; i--) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return el(id, b);
};
const float = (id: number, v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
};
const text = (id: number, s: string) => el(id, Buffer.from(s, 'utf8'));

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
} as const;

// ---------------------------------------------------------------- writing

export interface WebmVideo {
  width: number;
  height: number;
  /** V_VP9 (VP9) or V_AV1 (AV1). */
  codecId: 'V_VP9' | 'V_AV1';
  /** The codec's private data, when the encoder gives one (AV1's av1C). */
  config?: Buffer;
}
export interface WebmAudio {
  sampleRate: number;
  channels: number;
  /** OpusHead (WebCodecs' description for Opus). */
  config: Buffer;
}

/** The longest a cluster runs (its blocks' times are 16-bit milliseconds from its start). */
const CLUSTER_MS = 5000;

/** Writes a WebM: media data as it arrives (clusters at key frames), Cues and lengths at the end. */
export class WebmWriter {
  private readonly fd: number;
  private at = 0;
  /** Where the Segment's body starts (Cue and Seek positions count from here). */
  private segmentData = 0;
  private segmentSizeAt = 0;
  private durationAt = 0;
  private cuesSeekAt = 0;
  private cluster: { time: number; sizeAt: number; dataAt: number } | null = null;
  private readonly cues: Array<{ time: number; pos: number }> = [];
  /** Sound packets waiting for the video to reach their time. */
  private readonly sound: Array<{ data: Buffer; ms: number }> = [];
  private lastMs = 0;
  private videoBlocks = 0;
  private audioBlocks = 0;

  constructor(
    private readonly file: string,
    video: WebmVideo,
    private readonly audio: WebmAudio | null,
  ) {
    this.fd = fs.openSync(file, 'w');
    this.put(el(ID.EBML, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)));
    // The Segment's size is filled in at the end (8 bytes kept for it).
    this.put(idBytes(ID.Segment));
    this.segmentSizeAt = this.at;
    this.put(vsize(0, 8));
    this.segmentData = this.at;
    // Where to find Info, Tracks and Cues (Cues' place is filled in at the end).
    const infoBody = Buffer.concat([uint(ID.TimecodeScale, 1_000_000), text(ID.MuxingApp, 'Keo'), text(ID.WritingApp, 'Keo Studio')]);
    const info = el(ID.Info, infoBody, float(ID.Duration, 0));
    const tracks = el(ID.Tracks, this.videoEntry(video), ...(audio ? [this.audioEntry(audio)] : []));
    const seek = (id: number, pos: number) => el(ID.Seek, el(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, pos, 8));
    // Each Seek is the same length, so the head's length is known before the positions are.
    const headLen = el(ID.SeekHead, seek(ID.Info, 0), seek(ID.Tracks, 0), seek(ID.Cues, 0)).length;
    const head = el(ID.SeekHead, seek(ID.Info, headLen), seek(ID.Tracks, headLen + info.length), seek(ID.Cues, 0));
    this.cuesSeekAt = this.segmentData + head.length - 8;
    this.put(head);
    // Duration is the last 8 bytes of Info.
    this.durationAt = this.at + info.length - 8;
    this.put(info);
    this.put(tracks);
  }

  private videoEntry(v: WebmVideo): Buffer {
    return el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 1),
      text(ID.CodecID, v.codecId),
      ...(v.config?.length ? [el(ID.CodecPrivate, v.config)] : []),
      el(ID.Video, uint(ID.PixelWidth, v.width), uint(ID.PixelHeight, v.height)),
    );
  }

  private audioEntry(a: WebmAudio): Buffer {
    const preSkip = a.config.length >= 12 ? a.config.readUInt16LE(10) : 312;
    return el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 2),
      uint(ID.TrackUID, 2),
      uint(ID.TrackType, 2),
      text(ID.CodecID, 'A_OPUS'),
      el(ID.CodecPrivate, a.config),
      uint(ID.CodecDelay, Math.round((preSkip / 48000) * 1e9)),
      uint(ID.SeekPreRoll, 80_000_000),
      el(ID.Audio, float(ID.SamplingFrequency, a.sampleRate), uint(ID.Channels, a.channels)),
    );
  }

  private put(b: Buffer): void {
    fs.writeSync(this.fd, b, 0, b.length, this.at);
    this.at += b.length;
  }

  private patch(b: Buffer, at: number): void {
    fs.writeSync(this.fd, b, 0, b.length, at);
  }

  private closeCluster(): void {
    if (!this.cluster) return;
    this.patch(vsize(this.at - this.cluster.dataAt, 8), this.cluster.sizeAt);
    this.cluster = null;
  }

  private openCluster(ms: number, cue: boolean): void {
    this.closeCluster();
    if (cue) this.cues.push({ time: ms, pos: this.at - this.segmentData });
    this.put(idBytes(ID.Cluster));
    const sizeAt = this.at;
    this.put(vsize(0, 8));
    this.cluster = { time: ms, sizeAt, dataAt: this.at };
    this.put(uint(ID.Timecode, ms));
  }

  private block(track: number, ms: number, key: boolean, data: Buffer): void {
    if (!this.cluster || ms - this.cluster.time > CLUSTER_MS || ms < this.cluster.time) this.openCluster(Math.max(0, ms), false);
    const head = Buffer.alloc(4);
    head[0] = 0x80 | track;
    head.writeInt16BE(ms - this.cluster!.time, 1);
    head[3] = key ? 0x80 : 0;
    const body = Buffer.concat([head, data]);
    this.put(Buffer.concat([idBytes(ID.SimpleBlock), vsize(body.length), body]));
    this.lastMs = Math.max(this.lastMs, ms);
  }

  /** Sound packets up to (and including) this time, in order. */
  private flushSound(uptoMs: number): void {
    while (this.sound.length && this.sound[0]!.ms <= uptoMs) {
      const s = this.sound.shift()!;
      this.block(2, s.ms, true, s.data);
      this.audioBlocks++;
    }
  }

  /** One encoded video frame (presentation time and length in microseconds). */
  writeVideo(data: Buffer, timeUs: number, durationUs: number, key: boolean): void {
    const ms = Math.round(timeUs / 1000);
    // A new cluster at each key frame, so a player can start there.
    if (key || !this.cluster) {
      this.flushSound(ms - 1);
      this.openCluster(ms, key);
    }
    this.flushSound(ms);
    this.block(1, ms, key, data);
    this.videoBlocks++;
    this.lastMs = Math.max(this.lastMs, Math.round((timeUs + durationUs) / 1000));
  }

  writeAudio(data: Buffer, timeUs: number, durationUs: number): void {
    if (!this.audio) return;
    this.sound.push({ data, ms: Math.round(timeUs / 1000) });
    this.lastMs = Math.max(this.lastMs, Math.round((timeUs + durationUs) / 1000));
  }

  /** Writes the rest of the sound, the Cues and the lengths, and closes the file. */
  finish(): { videoFrames: number; audioPackets: number; durationSec: number; bytes: number } {
    this.flushSound(Infinity);
    this.closeCluster();
    const cuesAt = this.at - this.segmentData;
    if (this.cues.length) {
      this.put(el(ID.Cues, ...this.cues.map((c) => el(ID.CuePoint, uint(ID.CueTime, c.time), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, c.pos))))));
      const pos = Buffer.alloc(8);
      pos.writeBigUInt64BE(BigInt(cuesAt));
      this.patch(pos, this.cuesSeekAt);
    }
    const d = Buffer.alloc(8);
    d.writeDoubleBE(this.lastMs);
    this.patch(d, this.durationAt);
    this.patch(vsize(this.at - this.segmentData, 8), this.segmentSizeAt);
    const bytes = this.at;
    fs.closeSync(this.fd);
    return { videoFrames: this.videoBlocks, audioPackets: this.audioBlocks, durationSec: this.lastMs / 1000, bytes };
  }

  /** Stops without a usable file (export cancelled or failed). */
  abort(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* closed */
    }
    fs.rmSync(this.file, { force: true });
  }
}

// ---------------------------------------------------------------- reading (checks)

export interface WebmSummary {
  durationSec: number;
  tracks: Array<{ number: number; type: number; codecId: string; width?: number; height?: number }>;
  /** Blocks per track number. */
  blocks: Record<number, number>;
  /** Key frames on track 1. */
  keys: number;
  cues: number;
  /** Block times (ms) on track 1, in file order. */
  videoTimes: number[];
}

/** Reads a WebM's tracks, block counts and length (null when it is not one Keo can read). */
export function readWebm(file: string): WebmSummary | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const vint = (at: number, keepMarker: boolean): { value: number; len: number } | null => {
    const first = buf[at];
    if (first === undefined || first === 0) return null;
    let len = 1;
    while (!(first & (0x80 >> (len - 1)))) len++;
    let value = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + buf[at + i]!;
    return { value, len };
  };
  const readUint = (a: number, b: number) => {
    let v = 0;
    for (let i = a; i < b; i++) v = v * 256 + buf[i]!;
    return v;
  };
  const out: WebmSummary = { durationSec: 0, tracks: [], blocks: {}, keys: 0, cues: 0, videoTimes: [] };
  const CONTAINERS = new Set<number>([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.Cues]);
  let scale = 1_000_000;
  let track: WebmSummary['tracks'][number] | null = null;
  let clusterMs = 0;
  let sawEbml = false;
  const walk = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      const id = vint(at, true);
      if (!id) return;
      const size = vint(at + id.len, false);
      if (!size) return;
      const data = at + id.len + size.len;
      const end = Math.min(to, data + size.value);
      if (id.value === ID.EBML) sawEbml = buf.toString('latin1', data, end).includes('webm');
      if (id.value === ID.TrackEntry) {
        track = { number: 0, type: 0, codecId: '' };
        walk(data, end);
        out.tracks.push(track);
        track = null;
      } else if (CONTAINERS.has(id.value)) walk(data, end);
      else if (id.value === ID.TimecodeScale) scale = readUint(data, end);
      else if (id.value === ID.Duration) out.durationSec = ((end - data === 8 ? buf.readDoubleBE(data) : buf.readFloatBE(data)) * scale) / 1e9;
      else if (track && id.value === ID.TrackNumber) track.number = readUint(data, end);
      else if (track && id.value === ID.TrackType) track.type = readUint(data, end);
      else if (track && id.value === ID.CodecID) track.codecId = buf.toString('latin1', data, end);
      else if (track && id.value === ID.PixelWidth) track.width = readUint(data, end);
      else if (track && id.value === ID.PixelHeight) track.height = readUint(data, end);
      else if (id.value === ID.Timecode) clusterMs = readUint(data, end);
      else if (id.value === ID.CuePoint) out.cues++;
      else if (id.value === ID.SimpleBlock) {
        const n = vint(data, false);
        if (n) {
          out.blocks[n.value] = (out.blocks[n.value] ?? 0) + 1;
          if (n.value === 1) {
            out.videoTimes.push(clusterMs + buf.readInt16BE(data + n.len));
            if (buf[data + n.len + 2]! & 0x80) out.keys++;
          }
        }
      }
      at = end;
    }
  };
  walk(0, buf.length);
  return sawEbml ? out : null;
}
