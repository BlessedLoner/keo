import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mp4Writer } from '../src/main/studio/mp4';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** A small real MP4 of a given size and length (frames are blank bytes; only the measurements matter). */
function clip(file: string, width: number, height: number, seconds: number): string {
  const w = new Mp4Writer(file, { width, height, avcC: AVCC }, null);
  const fps = 10;
  for (let i = 0; i < Math.round(seconds * fps); i++) w.writeVideo(Buffer.alloc(50, i), (i * 1e6) / fps, 1e6 / fps, i % fps === 0);
  w.finish();
  return file;
}

describe('AI clips are checked before they go on the timeline', () => {
  const dir = tempDir();
  const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined });

  it('a clip of the right length and size passes; a cut-short or tiny one is refused and set aside', async () => {
    expect(await s.aiClipProblem(clip(path.join(dir, 'good.mp4'), 1280, 720, 5), 5)).toBeNull();
    // Models round to their own lengths: a 5 s clip for 6 s asked is fine.
    expect(await s.aiClipProblem(clip(path.join(dir, 'rounded.mp4'), 720, 1280, 5), 6)).toBeNull();
    expect(await s.aiClipProblem(clip(path.join(dir, 'short.mp4'), 1280, 720, 1), 5)).toBe('it lasts 1.0 s instead of about 5 s');
    expect(await s.aiClipProblem(clip(path.join(dir, 'tiny.mp4'), 160, 120, 5), 5)).toBe('it is only 160×120 pixels');
    // Pictures and sounds are not videos to check here.
    fs.writeFileSync(path.join(dir, 'pic.png'), 'x');
    expect(await s.aiClipProblem(path.join(dir, 'pic.png'), 5)).toBeNull();
  });
});
