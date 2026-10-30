import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guessShotKind, recipeOps, rhythm, shotsFrom, type Recipe } from '../src/shared/studioRecipe';
import { makeHarness, tempDir, type Harness } from './helpers';

/** Templates as recipes: learned from a video, made again with the user's clips. */

const spread = Array.from({ length: 64 }, () => 1 / 64);
const flat = [0.5, 0.3, ...Array.from({ length: 62 }, () => 0.2 / 62)];
const black = [0.96, ...Array.from({ length: 63 }, () => 0.04 / 63)];

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'rc_test01',
  name: 'Ad',
  source: 'ad.mp4',
  seconds: 12,
  aspect: 'vertical',
  shots: [
    { start: 0, end: 2.5, kind: 'camera' },
    { start: 2.5, end: 5, kind: 'screen' },
    { start: 5, end: 7.5, kind: 'camera' },
    { start: 7.5, end: 10, kind: 'screen' },
    { start: 10, end: 12, kind: 'end-card' },
  ],
  captions: { on: true, style: 'phrase', wordsPerLine: 3, position: 'center', uppercase: false },
  look: 'warm',
  transition: 'cut',
  endCard: { on: true, seconds: 2, text: null },
  audio: { voice: true, music: true, bpm: 100, whooshOnCuts: true, musicGenre: null },
  notes: '',
  learnedAt: '2026-10-30T00:00:00Z',
  ...over,
});

describe('Recipe maths', () => {
  it('tells camera footage, screen recordings and an end card apart by their colours', () => {
    expect(guessShotKind(spread)).toBe('camera');
    expect(guessShotKind(flat)).toBe('screen');
    expect(guessShotKind(black)).toBe('end-card');
  });

  it('turns cuts into shots and measures the rhythm (end card left out)', () => {
    const shots = shotsFrom([2.5, 5, 7.5, 10], 12, ['camera', 'screen', 'camera', 'screen', 'end-card']);
    expect(shots.map((s) => [s.start, s.end, s.kind])).toEqual([
      [0, 2.5, 'camera'],
      [2.5, 5, 'screen'],
      [5, 7.5, 'camera'],
      [7.5, 10, 'screen'],
      [10, 12, 'end-card'],
    ]);
    expect(rhythm({ shots })).toMatchObject({ median: 2.5, min: 2.5, max: 2.5, cutsPerMinute: 24 });
  });

  it('lays the cutaways over the talking clip at the template’s rhythm, with captions and an end card', () => {
    const words = Array.from({ length: 9 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.8 }));
    const { ops, cutawayStarts } = recipeOps(recipe(), { main: { clip: 'cl_main1', start: 0, duration: 10 }, cutaways: [{ assetId: 'as_scr001', duration: 30, kind: 'video' }], words, endText: 'keo.app' });
    // Screen shots of the pattern become cutaways, taken one after another from the recording.
    const adds = ops.filter((o) => o.op === 'add_media');
    expect(adds.map((o) => (o.op === 'add_media' ? [o.start, o.duration, o.in, o.trackName] : null))).toEqual([
      [2.5, 2.5, 0, 'B-roll'],
      [7.5, 2.5, 2.5, 'B-roll'],
    ]);
    expect(cutawayStarts).toEqual([2.5, 7.5]);
    const caps = ops.find((o) => o.op === 'add_captions');
    expect(caps?.op === 'add_captions' && caps.lines.map((l) => l.text)).toEqual(['w0 w1 w2', 'w3 w4 w5', 'w6 w7 w8']);
    expect(caps?.op === 'add_captions' && caps.transform?.y).toBe(0.5);
    // The end card after the voice: black, with the text.
    expect(ops.filter((o) => (o.op === 'add_shape' || o.op === 'add_text') && o.start === 10)).toHaveLength(2);
  });

  it('without cutaways the camera stays; without words no captions', () => {
    const { ops } = recipeOps(recipe({ endCard: { on: false, seconds: 0, text: null } }), { main: { clip: 'cl_main1', start: 0, duration: 6 }, cutaways: [], words: [], endText: null });
    expect(ops).toEqual([]);
  });
});

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('Learning and using a template', () => {
  it('learns a template’s shots from its frames and makes its edit with the user’s clips', async () => {
    const dir = tempDir('keo-recipe-');
    const files = ['ad.mp4', 'me talking.mp4', 'screen.mp4'].map((n) => {
      const f = path.join(dir, n);
      fs.writeFileSync(f, 'x');
      return f;
    });
    // The template cuts at 2.5, 5, 7.5 and 10 s: camera, screen, camera, screen, end card.
    const cuts = [2.5, 5, 7.5, 10];
    h = makeHarness({
      dir: path.join(dir, 'profile'),
      deps: {
        studioProbe: async (f) => ({ kind: 'video', duration: f.includes('ad') ? 12 : 20, width: 1080, height: 1920, hasAudio: !f.includes('screen') }),
        studioJob: (jobId, job) =>
          setTimeout(() => {
            const s = h!.services.studio;
            if (job.kind !== 'signatures') return s.jobDone(jobId, null, 'no sound in this test');
            s.jobDone(
              jobId,
              job.times.map((t) => {
                const shot = [0, ...cuts].filter((c) => c <= t + 1e-6).length - 1;
                return [spread, flat, spread, flat, black][shot]!;
              }),
              null,
            );
          }, 2),
      },
    });
    const s = h.services.studio;
    const p = s.create('Promo', 'vertical');
    const [ad, me, screen] = (await s.importFiles(p.id, files)).added;
    // Shot detection itself is checked elsewhere: here the template's cuts are known.
    s['learn'](p.id, ad!.id, { scenes: cuts });
    const r = await s.learnTemplate(p.id, ad!.id, { seen: { look: 'warm', endCard: { text: 'heyclicky.com' } } });
    expect(r.shots.map((x) => x.kind)).toEqual(['camera', 'screen', 'camera', 'screen', 'end-card']);
    expect([r.endCard.on, r.endCard.seconds, r.endCard.text, r.look]).toEqual([true, 2, 'heyclicky.com', 'warm']);
    expect(s.recipes().map((x) => x.name)).toEqual(['ad']);
    s.edit(p.id, [{ op: 'add_media', assetId: me!.id, start: 0, duration: 10 }]);
    expect(r.audio.whooshOnCuts).toBe(false);
    const out = await s.applyTemplate(p.id, r.id, { endText: 'keo.app', whooshes: true });
    expect(out.cutaways).toBe(2);
    const now = s.get(p.id);
    const broll = now.tracks.find((t) => t.name === 'B-roll')!.clips;
    expect(broll.map((c) => [c.start, c.duration])).toEqual([
      [2.5, 2.5],
      [7.5, 2.5],
    ]);
    expect(broll.every((c) => c.type === 'media' && c.assetId === screen!.id && c.color?.temperature)).toBe(true);
    expect(now.tracks.find((t) => t.name === 'End card')!.clips[0]!.start).toBe(10);
    // Whooshes into each cutaway when asked (Keo's own), no music in the library yet.
    expect(now.tracks.find((t) => t.name === 'Effects')!.clips.map((c) => c.start)).toEqual([2.35, 7.35]);
    expect(out.music).toBeNull();
    // The template had no voice (no sound here), so it has no captions to ask for.
    expect([r.captions.on, out.needsWords]).toEqual([false, false]);
  });
});

describe('Shot kinds of dark screens', () => {
  it('a dark-mode screen recording is a screen, not an end card', () => {
    const dark = [0.82, ...Array.from({ length: 62 }, () => 0), 0.18];
    expect(guessShotKind(dark)).toBe('screen');
  });
});
