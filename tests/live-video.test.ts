import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Logger } from '../src/main/logging/logger';
import { locateFfmpeg, ProcessRunner } from '../src/main/video/ffmpeg';
import { VideoStudio } from '../src/main/video/studio';
import { tempDir } from './helpers';

/**
 * Manual check with the real ffmpeg (nothing is downloaded; it must already be on PATH or given
 * as KEO_LIVE_VIDEO=<path to ffmpeg.exe>). Makes a few seconds of test pictures and tones with
 * ffmpeg itself, then analyses, plans, previews and renders a tiny video and checks it.
 *   KEO_LIVE_VIDEO=1 npx vitest run tests/live-video.test.ts
 */
const tools = process.env.KEO_LIVE_VIDEO ? locateFfmpeg(process.env.KEO_LIVE_VIDEO === '1' ? null : process.env.KEO_LIVE_VIDEO) : null;

it.runIf(!!tools)(
  'renders a tiny video with the real ffmpeg',
  async () => {
    const dir = tempDir('keo-live-video-');
    const clips = path.join(dir, 'clips');
    fs.mkdirSync(clips);
    const make = (out: string, src: string, tone: number, seconds: number) =>
      execFileSync(tools!.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`, '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', out]);
    make(path.join(clips, 'a.mp4'), 'testsrc', 440, 4);
    make(path.join(clips, 'b.mp4'), 'testsrc2', 660, 4);
    // A "template" with two hard cuts: three different sources joined.
    const parts = ['smptebars', 'testsrc', 'rgbtestsrc'].map((s, i) => {
      const f = path.join(dir, `t${i}.mp4`);
      make(f, s, 300 + i * 100, 1.5);
      return f;
    });
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    const template = path.join(dir, 'template.mp4');
    execFileSync(tools!.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', template]);

    const runner = new ProcessRunner(tools!);
    const studio = new VideoStudio({
      runner: () => ({ runner, key: tools!.ffmpeg }),
      workRoot: () => path.join(dir, 'work'),
      outputRoot: () => path.join(dir, 'out'),
      visionBlocked: () => 'not used in this check',
      askVision: async () => '',
      transcribeBlocked: () => 'not used in this check',
      transcribe: async () => [],
      sent: () => undefined,
      changed: () => undefined,
      log: new Logger(null),
    });
    const signal = AbortSignal.timeout(170_000);
    const { template: t } = await studio.analyzeTemplate(template, { conversationId: null, useVision: false, signal });
    expect(t.shots.length).toBeGreaterThanOrEqual(2);
    await studio.analyzeClips(clips, { conversationId: null, transcribe: false, look: false, signal });
    const p = await studio.plan({ conversationId: null, signal, hook: 'Keo live check', aspect: '9:16' });
    await studio.previewSettled(p.id);
    expect(studio.view()!.status).toBe('ready');
    studio.direct([{ op: 'captions', enabled: false }, { op: 'transition', kind: 'fade' }], { conversationId: null });
    await studio.previewSettled(p.id);
    const out = await studio.renderFinal({ conversationId: null, signal });
    const v = await studio.verify(out.file, out, signal);
    expect(v.detail).toMatch(/1080×1920, with sound/);
    expect(v.ok).toBe(true);
    console.log('LIVE video:', v.detail, out.file);
  },
  180_000,
);
