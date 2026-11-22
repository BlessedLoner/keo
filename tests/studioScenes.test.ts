import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaClip } from '../src/shared/studio';
import { refineCut, sceneCandidates, sceneSplitTimes, signatureDistance } from '../src/shared/studioScenes';
import { Mp4Writer } from '../src/main/studio/mp4';
import { makeHarness, tempDir, type Harness } from './helpers';

const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);

/** Finding shot changes inside a video (fake render window: nothing is decoded). */

const RED = [1, ...new Array<number>(63).fill(0)];
const BLUE = [...new Array<number>(63).fill(0), 1];
/** A little noise, like a moving camera. */
const wobble = (sig: number[], k: number) => sig.map((v, i) => (i === 0 || i === 63 ? v * (1 - k) : i === 1 ? k : v));

describe('Shot detection maths', () => {
  it('measures fingerprints from 0 (same) to 1 (nothing in common)', () => {
    expect(signatureDistance(RED, RED)).toBe(0);
    expect(signatureDistance(RED, BLUE)).toBe(1);
  });

  it('finds the hard cut and ignores movement', () => {
    const times = Array.from({ length: 20 }, (_, i) => i * 0.25);
    const sigs = times.map((t, i) => wobble(t < 2.6 ? RED : BLUE, (i % 3) * 0.05));
    const c = sceneCandidates(times, sigs);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ from: 2.5, to: 2.75 });
    expect(sceneCandidates(times, times.map((_, i) => wobble(RED, (i % 3) * 0.05)))).toEqual([]);
  });

  it('picks the first frame of the new shot', () => {
    const fine = [2.5, 2.533, 2.567, 2.6, 2.633];
    expect(refineCut(fine, [RED, RED, RED, BLUE, BLUE])).toBe(2.6);
  });

  it('maps a cut in the video to the timeline, at speed too', () => {
    const c = MediaClip.parse({ id: 'cl_aaaa', type: 'media', assetId: 'as_aaaa', start: 10, duration: 4, in: 1, speed: 2 });
    // Video second 5 is 4 s into the clip's source, 2 s at double speed.
    expect(sceneSplitTimes(c, [0.5, 5, 9.05, 20])).toEqual([12]);
  });
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('Split at shot changes', () => {
  it('splits each video clip where its shot changes, keeps the result, one undo', async () => {
    const dir = tempDir('keo-scenes-');
    const file = path.join(dir, 'talk.mp4');
    fs.writeFileSync(file, 'x');
    let jobs = 0;
    h = makeHarness({
      dir: path.join(dir, 'profile'),
      deps: {
        studioProbe: async () => ({ kind: 'video', duration: 8, width: 1080, height: 1920, hasAudio: true }),
        studioJob: (jobId, job) =>
          setTimeout(() => {
            jobs++;
            if (job.kind !== 'signatures') return h!.services.studio.jobDone(jobId, null, 'not in this test');
            h!.services.studio.jobDone(jobId, job.times.map((t) => (t < 3.1 ? RED : BLUE)), null);
          }, 2),
      },
    });
    const s = h.services.studio;
    const p = s.create('Shots', 'vertical');
    const a = (await s.importFiles(p.id, [file])).added[0]!;
    s.edit(p.id, [{ op: 'add_media', assetId: a.id, start: 0, duration: 7, in: 1 }]);
    const r = await s.splitScenes(p.id);
    expect(r.splits).toBe(1);
    const clips = s.get(p.id).tracks[0]!.clips as MediaClip[];
    // Video second ~3.1 is 2.1 s into the clip (it starts 1 s into the video).
    expect(clips).toHaveLength(2);
    expect(clips[1]!.start).toBeCloseTo(2.1, 1);
    expect(s.get(p.id).assets[0]!.scenes).toHaveLength(1);
    // Found once: asking again decodes nothing.
    const before = jobs;
    await s.detectScenes(p.id, a.id);
    expect(jobs).toBe(before);
    s.undoEdit(p.id);
    expect(s.get(p.id).tracks[0]!.clips).toHaveLength(1);
  });
});

describe('Shot detection edge cases', () => {
  it('falls back to the coarse sample when no single frame stands out', () => {
    expect(refineCut([1, 1.1, 1.2], [RED, RED, RED])).toBe(1.2);
  });
});

describe('Reverse', () => {
  it('makes a reversed copy once, uses it, and reversing again goes back to the original', async () => {
    const dir = tempDir('keo-reverse-');
    const file = path.join(dir, 'run.mp4');
    const still = path.join(dir, 'still.png');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(still, 'x');
    const exports: MediaClip[] = [];
    h = makeHarness({
      dir: path.join(dir, 'profile'),
      deps: {
        studioProbe: async (f) => (f.endsWith('.png') ? { kind: 'image', duration: 0, width: 1080, height: 1920, hasAudio: false } : { kind: 'video', duration: f.includes('reversed') ? 3 : 10, width: 1080, height: 1920, hasAudio: true }),
        studioJob: (jobId, job) =>
          setTimeout(() => {
            if (job.kind !== 'export') return h!.services.studio.jobDone(jobId, null, 'not in this test');
            // The render window would draw the short-lived project backwards into Keo's own folder.
            const tmp = JSON.parse(fs.readFileSync(path.join(h!.dir, 'studio', `${job.projectId}.json`), 'utf8'));
            const c = tmp.tracks[0].clips[0] as MediaClip;
            exports.push(c);
            const out = path.join(h!.dir, 'studio', 'made', `reversed-${c.assetId}-${Math.round(c.in * 1000)}-${Math.round(c.duration * 1000)}.mp4`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, 'x');
            h!.services.studio.jobDone(jobId, { file: out, durationSec: 3, frames: 90, bytes: 1 }, null);
          }, 2),
      },
    });
    const s = h.services.studio;
    const p = s.create('Rewind', 'vertical');
    const [vid, pic] = (await s.importFiles(p.id, [file, still])).added;
    s.edit(p.id, [
      { op: 'add_media', assetId: vid!.id, start: 0, duration: 3, in: 1 },
      { op: 'add_media', assetId: pic!.id, start: 3, duration: 2 },
    ]);
    const clipId = s.get(p.id).tracks[0]!.clips[0]!.id;
    await s.reverseClip(p.id, clipId);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ reversed: true, in: 1, duration: 3 });
    let now = s.get(p.id);
    const c = now.tracks[0]!.clips[0] as MediaClip;
    const copy = now.assets.find((a) => a.id === c.assetId)!;
    expect(copy).toMatchObject({ name: 'run.mp4 (reversed)', reverseOf: { assetId: vid!.id, in: 1 } });
    expect(c).toMatchObject({ start: 0, duration: 3, in: 0 });
    // The short-lived project is gone.
    expect(fs.readdirSync(path.join(h.dir, 'studio')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    // Again: forwards, from the original.
    await s.reverseClip(p.id, clipId);
    now = s.get(p.id);
    expect(now.tracks[0]!.clips[0]).toMatchObject({ assetId: vid!.id, in: 1 });
    // And once more: the reversed copy is used again, nothing is made twice.
    await s.reverseClip(p.id, clipId);
    expect(exports).toHaveLength(1);
    await expect(s.reverseClip(p.id, s.get(p.id).tracks[0]!.clips[1]!.id)).rejects.toThrow(/Only videos/);
  });
});

describe('Remove background noise', () => {
  it('a video keeps its picture, its sound goes clean on its own track, one undo', async () => {
    const dir = tempDir('keo-clean-');
    const file = path.join(dir, 'vlog.mp4');
    fs.writeFileSync(file, 'x');
    const jobs: string[] = [];
    h = makeHarness({
      dir: path.join(dir, 'profile'),
      deps: {
        studioProbe: async (f) => (f.endsWith('.wav') ? { kind: 'audio', duration: 10, width: 0, height: 0, hasAudio: true } : { kind: 'video', duration: 10, width: 1080, height: 1920, hasAudio: true }),
        studioJob: (jobId, job) =>
          setTimeout(() => {
            jobs.push(job.kind);
            if (job.kind !== 'denoise') return h!.services.studio.jobDone(jobId, null, 'not in this test');
            h!.services.studio.jobDone(jobId, { base64: Buffer.from('RIFF....WAVE').toString('base64'), seconds: 10 }, null);
          }, 2),
      },
    });
    const s = h.services.studio;
    const p = s.create('Clean', 'vertical');
    const vid = (await s.importFiles(p.id, [file])).added[0]!;
    s.edit(p.id, [{ op: 'add_media', assetId: vid.id, start: 2, duration: 4, in: 3 }]);
    const id = s.get(p.id).tracks[0]!.clips[0]!.id;
    s.edit(p.id, [{ op: 'set', clip: id, fadeIn: 0.5, voice: true, eq: 'voice' }]);
    await s.cleanSound(p.id, id);
    const now = s.get(p.id);
    expect((now.tracks[0]!.clips[0] as MediaClip).volume).toBe(0);
    const clean = now.tracks.find((t) => t.name === 'Voice (clean)')!.clips[0]!;
    expect(clean).toMatchObject({ type: 'audio', start: 2, duration: 4, in: 3, fadeIn: 0.5, voice: true, eq: { low: -4, mid: 3, high: 2 } });
    expect(now.assets.find((a) => a.cleanOf === vid.id)?.name).toBe('vlog.mp4 (clean sound)');
    // Cleaning the same file again uses the copy already made.
    s.undoEdit(p.id);
    expect((s.get(p.id).tracks[0]!.clips[0] as MediaClip).volume).toBe(1);
    expect(s.get(p.id).tracks.find((t) => t.name === 'Voice (clean)')?.clips.length ?? 0).toBe(0);
    await s.cleanSound(p.id, id);
    expect(jobs.filter((k) => k === 'denoise')).toHaveLength(1);
  });
});

describe('Smooth preview copies', () => {
  it('makes a light copy of each big video once; only the preview gets it', async () => {
    const dir = tempDir('keo-proxy-');
    const big = path.join(dir, 'drone-4k.mp4');
    const small = path.join(dir, 'phone.mp4');
    fs.writeFileSync(big, 'x');
    fs.writeFileSync(small, 'x');
    const sizes: Array<{ width: number; height: number }> = [];
    h = makeHarness({
      dir: path.join(dir, 'profile'),
      deps: {
        studioProbe: async (f) => ({ kind: 'video', duration: 6, width: f.includes('4k') ? 3840 : 1080, height: f.includes('4k') ? 2160 : 1920, hasAudio: true }),
        studioJob: (jobId, job) =>
          setTimeout(() => {
            if (job.kind !== 'export') return h!.services.studio.jobDone(jobId, null, 'not in this test');
            sizes.push({ width: job.size!.width, height: job.size!.height });
            // Like the render window: a real 6-second video where the export writes (its temporary name).
            const out = (h!.services.studio as unknown as { exportTargets: Map<string, string> }).exportTargets.get(job.exportId)!;
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const w = new Mp4Writer(out, { width: job.size!.width, height: job.size!.height, avcC: AVCC }, null);
            for (let i = 0; i < 150; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / 25, 1e6 / 25, i % 25 === 0);
            w.finish();
            h!.services.studio.jobDone(jobId, { file: out, durationSec: 6, frames: 150, bytes: 1 }, null);
          }, 2),
      },
    });
    const s = h.services.studio;
    s.strongPc = () => false; // the copy size of an ordinary laptop
    const p = s.create('Drone', 'landscape');
    const [b, sm] = (await s.importFiles(p.id, [big, small])).added;
    // The 4K video gets its copy by itself after import, in the background.
    for (let k = 0; k < 300 && (s.previewCopying(p.id).length || !sizes.length); k++) await new Promise((r) => setTimeout(r, 10));
    expect(s.previewCopying(p.id)).toEqual([]);
    expect(sizes).toEqual([{ width: 960, height: 540 }]);
    expect(s.assetFile(p.id, b!.id, true)).toMatch(/preview-as_.*\.mp4$/);
    expect(s.assetFile(p.id, b!.id)).toBe(big);
    expect(s.assetFile(p.id, sm!.id, true)).toBe(small);
    // Made once.
    expect((await s.makePreviewCopies(p.id)).made).toBe(0);
    expect(sizes).toHaveLength(1);
  });
});

describe('Long video to shorts', () => {
  it('makes each moment its own vertical project and leaves the long video alone', async () => {
    const dir = tempDir('keo-shorts-');
    const file = path.join(dir, 'podcast.mp4');
    fs.writeFileSync(file, 'x');
    h = makeHarness({ dir: path.join(dir, 'profile'), deps: { studioProbe: async () => ({ kind: 'video', duration: 20, width: 1920, height: 1080, hasAudio: true }) } });
    const s = h.services.studio;
    const p = s.create('Podcast 12', 'landscape');
    const vid = (await s.importFiles(p.id, [file])).added[0]!;
    s.edit(p.id, [
      { op: 'add_media', assetId: vid.id, start: 0 },
      { op: 'add_text', text: 'Caption at 3 s', start: 3, duration: 2 },
      { op: 'add_text', text: 'Caption at 15 s', start: 15, duration: 2 },
    ]);
    const made = s.makeShorts(p.id, [{ from: 2, to: 8, title: 'The best part' }, { from: 14, to: 18 }]);
    expect(made.map((m) => [m.name, m.seconds])).toEqual([
      ['Podcast 12 — short 1: The best part', 6],
      ['Podcast 12 — short 2', 4],
    ]);
    const one = s.get(made[0]!.projectId);
    expect([one.width, one.height]).toEqual([1080, 1920]);
    const clip = one.tracks.find((t) => t.kind === 'video')!.clips[0] as MediaClip;
    expect(clip).toMatchObject({ start: 0, duration: 6, in: 2, fit: 'contain', backdrop: 'blur' });
    const texts = one.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips).map((c) => (c as { text: string }).text);
    expect(texts.sort()).toEqual(['Caption at 3 s', 'The best part']);
    // The long video is as it was, and a short starts with nothing to undo.
    expect(s.get(p.id).width).toBe(1920);
    expect(s.get(p.id).tracks.find((t) => t.kind === 'video')!.clips[0]!.duration).toBe(20);
    expect(s.canUndo(made[0]!.projectId).undo).toBe(false);
    expect(() => s.makeShorts(p.id, [{ from: 19.5, to: 30 }])).toThrow(/shorter than a second/);
  });
});
