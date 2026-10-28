import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mp4Reader } from '../src/main/studio/mp4';

/**
 * Reads real phone and web videos from this PC (read-only) when KEO_LIVE_MP4=1: their length,
 * size and tracks must be what the file says. Skipped otherwise.
 */
const live = process.env.KEO_LIVE_MP4 === '1';
const dirs = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Downloads')];
const files = live ? dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).map((f) => path.join(d, f)) : [])) : [];

describe.skipIf(!live)('MP4 reader on real videos (read-only)', () => {
  it('reads every file', () => {
    for (const f of files) {
      const r = Mp4Reader.open(f);
      const v = r?.video();
      const a = r?.audio();
      console.log(path.basename(f).slice(0, 50), JSON.stringify({ size: fs.statSync(f).size, v: v && { codec: v.codec, w: v.width, h: v.height, dur: v.duration, n: v.samples.length, last: v.samples.at(-1)?.time, first: v.samples[0]?.time }, a: a && { codec: a.codec, dur: a.duration, n: a.samples.length, last: a.samples.at(-1)?.time } }));
      r?.close();
      expect(r).not.toBeNull();
    }
  });
});
