import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaClip } from '../src/shared/studio';
import { refineCut, sceneCandidates, sceneSplitTimes, signatureDistance } from '../src/shared/studioScenes';
import { makeHarness, tempDir, type Harness } from './helpers';

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
