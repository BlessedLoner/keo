import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateFfmpeg, probe, ProcessRunner } from '../src/main/video/ffmpeg';
import { AnimateSpec } from '../src/main/pictures/animate';
import { EditOp } from '../src/main/pictures/edit';
import { PictureStudio } from '../src/main/pictures/studio';

/**
 * Real ffmpeg on this PC, local only (nothing is sent anywhere):
 * KEO_LIVE_PICTURES=<ffmpeg.exe> [KEO_LIVE_PICTURE=<a picture>] npx vitest run tests/live-pictures.test.ts
 * Writes into a temporary folder and prints where.
 */
const ffmpeg = process.env.KEO_LIVE_PICTURES;

describe.skipIf(!ffmpeg)('live: pictures with ffmpeg', () => {
  it('adds text beside a picture, then animates it (MP4 and GIF)', async () => {
    const tools = locateFfmpeg(ffmpeg!, '', fs.existsSync)!;
    const runner = new ProcessRunner(tools);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-live-pictures-'));
    const studio = new PictureStudio({ runner: () => runner, outputRoot: () => out, fontsDir: 'C:\\Windows\\Fonts', workRoot: path.join(out, 'work'), ai: () => null });
    const signal = new AbortController().signal;
    let src = process.env.KEO_LIVE_PICTURE;
    if (!src) {
      src = path.join(out, 'test.png');
      await runner.ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=600x600:d=1', '-frames:v', '1', src], { signal });
    }
    const ops = [
      { op: 'extend', right: 1.1, color: '#000000' },
      { op: 'text', text: 'KEO AI', x: 0.74, y: 0.5, size: 0.16, font: 'Segoe UI Black', color: '#f2f4ff', glow: '#4a7dff' },
      { op: 'round_corners', radius: 0.06 },
    ].map((o) => EditOp.parse(o));
    const still = await studio.edit(src, ops, { name: 'Logo with text', format: 'png' }, signal);
    const s = await probe(runner, still.path, signal);
    const mp4 = await studio.animate(still.path, AnimateSpec.parse({ motion: 'float', seconds: 4, format: 'mp4' }), { name: 'Logo float' }, signal);
    const src2 = await studio.edit(src, [EditOp.parse({ op: 'extend', right: 1.1, color: '#000000' })], { name: 'Logo room', format: 'png' }, signal);
    const anim = await studio.animate(
      src2.path,
      AnimateSpec.parse({ motion: 'pulse', seconds: 4, format: 'mp4', text: { text: 'KEO AI', x: 0.74, y: 0.5, size: 0.16, font: 'Segoe UI Black', glow: '#4a7dff', entrance: 'slide_left' } }),
      { name: 'Logo text slides in' },
      signal,
    );
    const gif = await studio.animate(still.path, AnimateSpec.parse({ motion: 'zoom', seconds: 3, format: 'gif' }), { name: 'Logo zoom' }, signal);
    const m = await probe(runner, anim.path, signal);
    console.log(`out: ${out}\nstill ${s.width}x${s.height}\nfloat ${mp4.path}\nslide ${anim.path} ${m.width}x${m.height} ${m.durationSec}s ${m.videoCodec}\ngif ${gif.path} ${fs.statSync(gif.path).size} bytes`);
    expect(s.width).toBeGreaterThan(s.height);
    expect(m.videoCodec).toBe('h264');
    expect(m.durationSec).toBeGreaterThan(3.5);
    expect(fs.statSync(gif.path).size).toBeGreaterThan(1000);
  }, 240000);
});
