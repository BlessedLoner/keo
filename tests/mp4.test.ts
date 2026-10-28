import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyBefore, Mp4Reader, Mp4Writer } from '../src/main/studio/mp4';
import { tempDir } from './helpers';

// An avcC for H.264 Constrained Baseline 5.1 (profile 66, compat 0xE0, level 51) with a tiny SPS/PPS.
const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);
// AudioSpecificConfig: AAC-LC, 48 kHz, stereo.
const ASC = Buffer.from([0x11, 0x90]);

describe('Keo Studio MP4 files', () => {
  it('writes H.264 + AAC that it (and players) can read back exactly', () => {
    const file = path.join(tempDir(), 'out.mp4');
    const w = new Mp4Writer(file, { width: 1080, height: 1920, avcC: AVCC }, { codec: 'aac', sampleRate: 48000, channels: 2, config: ASC });
    const fps = 30;
    for (let i = 0; i < 90; i++) {
      w.writeVideo(Buffer.alloc(100 + i, i), (i * 1e6) / fps, 1e6 / fps, i % 30 === 0);
      if (i % 2 === 0) w.writeAudio(Buffer.alloc(20, 7), (i / 2) * 21333, 21333);
    }
    const r = w.finish();
    expect(r).toMatchObject({ videoFrames: 90, audioPackets: 45 });
    expect(r.durationSec).toBeCloseTo(3, 2);

    const m = Mp4Reader.open(file)!;
    expect(m).toBeTruthy();
    const v = m.video()!;
    expect(v).toMatchObject({ kind: 'video', format: 'avc1', codec: 'avc1.42e033', width: 1080, height: 1920 });
    expect(v.description).toEqual(AVCC);
    expect(v.samples).toHaveLength(90);
    expect(v.samples[45]!.time).toBeCloseTo(1.5, 3);
    expect(v.samples[45]!.size).toBe(145);
    expect(v.samples.filter((s) => s.key).map((s) => Math.round(s.time))).toEqual([0, 1, 2]);
    expect(m.sample(v.samples[10]!)).toEqual(Buffer.alloc(110, 10));
    expect(keyBefore(v, 1.7)).toBe(30);
    const a = m.audio()!;
    expect(a).toMatchObject({ kind: 'audio', format: 'mp4a', codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 });
    expect(a.description).toEqual(ASC);
    expect(a.samples).toHaveLength(45);
    m.close();
  });

  it('writes Opus sound too, and reads its OpusHead back for decoding', () => {
    const file = path.join(tempDir(), 'opus.mp4');
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = 2;
    head.writeUInt16LE(312, 10);
    head.writeUInt32LE(48000, 12);
    const w = new Mp4Writer(file, { width: 640, height: 360, avcC: AVCC }, { codec: 'opus', sampleRate: 48000, channels: 2, config: head });
    w.writeVideo(Buffer.alloc(10), 0, 33333, true);
    w.writeAudio(Buffer.alloc(10), 0, 20000);
    w.finish();
    const a = Mp4Reader.open(file)!.audio()!;
    expect(a).toMatchObject({ format: 'Opus', codec: 'opus', channels: 2 });
    expect(a.description!.toString('latin1', 0, 8)).toBe('OpusHead');
    expect(a.description!.readUInt16LE(10)).toBe(312);
  });

  it('refuses files that are not MP4/MOV, and cancelling leaves no half file', () => {
    const dir = tempDir();
    const junk = path.join(dir, 'x.mp4');
    fs.writeFileSync(junk, 'not a video at all');
    expect(Mp4Reader.open(junk)).toBeNull();
    const file = path.join(dir, 'cancel.mp4');
    const w = new Mp4Writer(file, { width: 16, height: 16, avcC: AVCC }, null);
    w.writeVideo(Buffer.alloc(5), 0, 40000, true);
    w.abort();
    expect(fs.existsSync(file)).toBe(false);
  });
});
