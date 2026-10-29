import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { wavOf } from '../src/main/studio/captions';
import type { MediaClip, RenderJob } from '../src/shared/studio';
import { makeHarness, tempDir, type Harness } from './helpers';

/** Cut to the beat and auto-reframe, with a fake render window and a scripted model (offline). */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 12 s of drum hits at 120 BPM (a short loud click every half second), 16 kHz mono. */
function drums(): Int16Array {
  const rate = 16000;
  const out = new Int16Array(rate * 12);
  for (let beat = 0; beat < 24; beat++) {
    const at = Math.round((0.25 + beat * 0.5) * rate);
    for (let i = 0; i < 800; i++) out[at + i] = Math.round(Math.sin(i * 0.9) * 26000 * Math.exp(-i / 200));
  }
  return out;
}

function setup(vision = '{"centres":[{"x":0.8,"y":0.5}]}') {
  const dir = tempDir('keo-beat-');
  const song = path.join(dir, 'song.mp3');
  const wide = path.join(dir, 'wide.png');
  for (const f of [song, wide]) fs.writeFileSync(f, 'x');
  const jobs: RenderJob[] = [];
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (req: ChatRequest) => reply(req.correlationId.startsWith('video_') ? vision : 'ok'),
    deps: {
      studioProbe: async (file) => (file.endsWith('.mp3') ? { kind: 'audio', duration: 12, width: 0, height: 0, hasAudio: true } : { kind: 'image', duration: 0, width: 1600, height: 900, hasAudio: false }),
      studioJob: (jobId, job) => {
        jobs.push(job);
        setTimeout(() => {
          const s = h!.services.studio;
          if (job.kind === 'asset_audio') s.jobDone(jobId, { wavBase64: wavOf(drums(), 16000).toString('base64') }, null);
          else if (job.kind === 'frames') s.jobDone(jobId, job.times.map((time) => ({ time, pngBase64: PNG_1PX })), null);
          else s.jobDone(jobId, null, 'not in this test');
        }, 5);
      },
    },
  });
  return { song, wide, jobs };
}

describe('Cut to the beat', () => {
  it('lays the clips on the music’s beats, every 2 beats', async () => {
    const f = setup();
    const s = h!.services.studio;
    const p = s.create('Montage', 'vertical');
    const added = (await s.importFiles(p.id, [f.song, f.wide])).added;
    const song = added.find((a) => a.kind === 'audio')!;
    const pic = added.find((a) => a.kind === 'image')!;
    s.edit(p.id, [{ op: 'add_audio', assetId: song.id, trackName: 'Music', start: 0 }, ...[0, 1, 2, 3].map(() => ({ op: 'add_media' as const, assetId: pic.id, start: 'end' as const, duration: 3 }))]);
    const r = await s.beatCut(p.id, { every: 2 });
    expect(r.placed).toBe(4);
    const beats = s.get(p.id).assets.find((a) => a.id === song.id)!.beats!;
    expect(beats.length).toBeGreaterThan(10);
    // Beats every half second (120 BPM), so each clip lasts about a second, back to back.
    const clips = s.get(p.id).tracks[0]!.clips as MediaClip[];
    for (let i = 0; i < 4; i++) {
      expect(clips[i]!.start).toBeCloseTo(beats[i * 2]!, 3);
      expect(clips[i]!.duration).toBeCloseTo(beats[(i + 1) * 2]! - beats[i * 2]!, 3);
      expect(clips[i]!.duration).toBeGreaterThan(0.85);
      expect(clips[i]!.duration).toBeLessThan(1.15);
    }
    // The beat is found once and kept: a second cut does not analyse again.
    const analysed = f.jobs.filter((j) => j.kind === 'asset_audio').length;
    await s.beatCut(p.id, { every: 1 });
    expect(f.jobs.filter((j) => j.kind === 'asset_audio').length).toBe(analysed);
    // One undo puts the clips back.
    s.undoEdit(p.id);
    s.undoEdit(p.id);
    expect((s.get(p.id).tracks[0]!.clips as MediaClip[]).map((c) => c.duration)).toEqual([3, 3, 3, 3]);
  });

  it('says what is missing', async () => {
    setup();
    const s = h!.services.studio;
    const p = s.create('Empty', 'vertical');
    await expect(s.beatCut(p.id)).rejects.toThrow(/no music on the timeline/);
  });
});

describe('Auto-reframe', () => {
  it('pans a wide picture in a tall frame so the subject is in the middle, never showing an edge', async () => {
    const f = setup();
    const svc = h!.services;
    const p = svc.studio.create('Reframe', 'vertical');
    const pic = (await svc.studio.importFiles(p.id, [f.wide])).added[0]!;
    const clip = svc.studio.edit(p.id, [{ op: 'add_media', assetId: pic.id, start: 0, duration: 3 }]).project.tracks[0]!.clips[0]!;
    const r = await svc.studioReframe(p.id, clip.id);
    expect(r.axis).toBe('x');
    const c = svc.studio.get(p.id).tracks[0]!.clips[0] as MediaClip;
    const x = c.keys!.x![0]!.value;
    // The subject is at 80 % of the picture's width: the picture moves left.
    expect(x).toBeLessThan(0.5);
    // A 1600×900 picture filling a 1080×1920 frame is 3413 px wide: it can move at most 1.08 frame widths either way.
    const spare = (1600 * (1920 / 900) - 1080) / 2 / 1080;
    expect(Math.abs(x - 0.5)).toBeLessThanOrEqual(spare + 1e-6);
    expect(x).toBeCloseTo(0.5 + (0.5 - 0.8) * (2 * spare + 1), 3);
  });

  it('refuses a clip that already fits', async () => {
    const f = setup();
    const svc = h!.services;
    const p = svc.studio.create('Fits', 'landscape');
    const pic = (await svc.studio.importFiles(p.id, [f.wide])).added[0]!;
    const clip = svc.studio.edit(p.id, [{ op: 'add_media', assetId: pic.id, start: 0, duration: 3 }]).project.tracks[0]!.clips[0]!;
    await expect(svc.studioReframe(p.id, clip.id)).rejects.toThrow(/already fits the frame/);
  });
});
