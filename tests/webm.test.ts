import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mp4Reader, Mp4Writer } from '../src/main/studio/mp4';
import { readWebm, WebmWriter } from '../src/main/studio/webm';
import { exportVideoCodec, ExportOptions } from '../src/shared/studio';
import { tempDir } from './helpers';

const opusHead = () => {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 2;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  return head;
};

describe('Keo Studio WebM and H.265 exports', () => {
  it('writes VP9 + Opus as a WebM with clusters at key frames, sound in time order, and cues', () => {
    const file = path.join(tempDir(), 'out.webm');
    const w = new WebmWriter(file, { width: 1080, height: 1920, codecId: 'V_VP9' }, { sampleRate: 48000, channels: 2, config: opusHead() });
    // The render window sends all the sound first, then the frames (as the exporter does).
    for (let i = 0; i < 300; i++) w.writeAudio(Buffer.alloc(30, 1), i * 20_000, 20_000);
    const fps = 30;
    for (let i = 0; i < 180; i++) w.writeVideo(Buffer.alloc(200 + i, i), (i * 1e6) / fps, 1e6 / fps, i % 60 === 0);
    const r = w.finish();
    expect(r).toMatchObject({ videoFrames: 180, audioPackets: 300 });
    expect(r.durationSec).toBeCloseTo(6, 1);
    expect(r.bytes).toBe(fs.statSync(file).size);

    const m = readWebm(file)!;
    expect(m).toBeTruthy();
    expect(m.tracks).toEqual([
      { number: 1, type: 1, codecId: 'V_VP9', width: 1080, height: 1920 },
      { number: 2, type: 2, codecId: 'A_OPUS' },
    ]);
    expect(m.blocks).toEqual({ 1: 180, 2: 300 });
    expect(m.keys).toBe(3);
    expect(m.cues).toBe(3);
    expect(m.durationSec).toBeCloseTo(6, 1);
    // Frames read back at their times, in order.
    expect(m.videoTimes[90]).toBe(3000);
    expect(m.videoTimes.every((t, i) => !i || t > m.videoTimes[i - 1]!)).toBe(true);
  });

  it('a long stretch without key frames still keeps each block within its cluster’s reach', () => {
    const file = path.join(tempDir(), 'long.webm');
    const w = new WebmWriter(file, { width: 64, height: 64, codecId: 'V_VP9' }, null);
    // 60 s at 10 fps with only the first frame a key frame.
    for (let i = 0; i < 600; i++) w.writeVideo(Buffer.alloc(10), i * 100_000, 100_000, i === 0);
    w.finish();
    const m = readWebm(file)!;
    expect(m.blocks[1]).toBe(600);
    expect(m.videoTimes[599]).toBe(59_900);
    expect(m.tracks).toHaveLength(1);
  });

  it('refuses files that are not WebM, and cancelling leaves no half file', () => {
    const dir = tempDir();
    const junk = path.join(dir, 'x.webm');
    fs.writeFileSync(junk, 'not a video');
    expect(readWebm(junk)).toBeNull();
    const file = path.join(dir, 'cancel.webm');
    const w = new WebmWriter(file, { width: 16, height: 16, codecId: 'V_VP9' }, null);
    w.writeVideo(Buffer.alloc(5), 0, 40_000, true);
    w.abort();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writes H.265 into MP4 as hvc1 + hvcC, which reads back with its codec string', () => {
    // An hvcC: Main profile, level 4.1 (123), no parameter sets (enough for the sample entry).
    const hvcC = Buffer.alloc(23);
    hvcC[0] = 1;
    hvcC[1] = 0x01; // profile space 0, tier 0, profile 1 (Main)
    hvcC.writeUInt32BE(0x60000000, 2); // compatibility flags 1, 2
    hvcC[6] = 0x90; // progressive, frame-only
    hvcC[12] = 123;
    const file = path.join(tempDir(), 'hevc.mp4');
    const w = new Mp4Writer(file, { width: 1920, height: 1080, codec: 'h265', avcC: hvcC }, null);
    for (let i = 0; i < 30; i++) w.writeVideo(Buffer.alloc(50), (i * 1e6) / 30, 1e6 / 30, i === 0);
    w.finish();
    const m = Mp4Reader.open(file)!;
    const v = m.video()!;
    expect(v).toMatchObject({ format: 'hvc1', codec: 'hvc1.1.6.L123.90', width: 1920, height: 1080 });
    expect(v.samples).toHaveLength(30);
    m.close();
  });

  it('picks VP9 for WebM and the chosen codec for MP4 / MOV (H.264 unless asked)', () => {
    expect(exportVideoCodec(ExportOptions.parse({ format: 'webm' }))).toBe('vp9');
    expect(exportVideoCodec(ExportOptions.parse({}))).toBe('h264');
    expect(exportVideoCodec(ExportOptions.parse({ format: 'mov', codec: 'h265' }))).toBe('h265');
  });
});
