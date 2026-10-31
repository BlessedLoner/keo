import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { placeMoments } from '../src/shared/studioMoments';
import type { Recipe } from '../src/shared/studioRecipe';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const words = 'So the real secret to growing online is consistency and showing up every single day'
  .split(' ')
  .map((text, i) => ({ text, start: i, end: i + 0.6 }));

describe('A template’s moments on the user’s video', () => {
  it('lands at the same point of the story, on a strong word the user said', () => {
    // A 10 s template with a word moment at 5 s, on a 16 s talking video starting at 2 s.
    const r = placeMoments([{ at: 5, moment: 'text-behind' }], 10, { start: 2, duration: 16 }, words);
    // 5/10 of the way = 10 s; the strongest word near it is "consistency" (said at 8 s).
    expect(r.place).toEqual([{ moment: 'text-behind', at: 8, text: 'consistency' }]);
    expect(r.ask).toEqual([]);
  });

  it('never repeats a word, and asks for pictures instead of guessing', () => {
    const r = placeMoments(
      [
        { at: 2, moment: 'word-card' },
        { at: 2.2, moment: 'text-behind' },
        { at: 6, moment: 'image-pop', needs: 'a product photo' },
      ],
      10,
      { start: 0, duration: 16 },
      words,
    );
    expect(new Set(r.place.map((p) => p.text)).size).toBe(2);
    expect(r.ask).toEqual([{ moment: 'image-pop', at: 9.6, needs: 'a product photo' }]);
  });

  it('skips word moments when nothing was said (no transcript)', () => {
    expect(placeMoments([{ at: 1, moment: 'text-behind' }], 10, { start: 0, duration: 10 }, [])).toEqual({ place: [], ask: [], skipped: 1 });
  });

  it('a podcast template with a style and moments works without any B-roll', async () => {
    const dir = tempDir('keo-tplm-');
    const s = new StudioService({ dir: path.join(dir, 'studio'), log, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'video', duration: 20, width: 720, height: 1280, hasAudio: true }), changed: () => undefined });
    const recipe: Recipe = {
      id: 'rc_test00001',
      name: 'Podcast',
      source: 'IMG_4812.MP4',
      seconds: 30,
      aspect: 'vertical',
      shots: [{ start: 0, end: 30, kind: 'camera' }],
      captions: { on: false, style: 'none', wordsPerLine: 3, position: 'center', uppercase: false },
      look: null,
      transition: 'cut',
      endCard: { on: false, seconds: 0, text: null },
      audio: { voice: true, music: false, bpm: null, whooshOnCuts: false, musicGenre: null },
      notes: '',
      moments: [{ at: 10, moment: 'split', needs: 'before and after photos' }],
      style: 'podcast-frame',
      learnedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(dir, 'studio', 'library'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio', 'library', 'recipes.json'), JSON.stringify([recipe]));
    const file = path.join(dir, 'talk.mp4');
    fs.writeFileSync(file, 'x');
    const p = s.create('T', 'vertical');
    const vid = (await s.importFiles(p.id, [file])).added[0]!;
    s.edit(p.id, [{ op: 'add_media', assetId: vid.id, start: 0 }]);
    const r = await s.applyTemplate(p.id, recipe.id, { music: null, whooshes: false });
    const main = r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media') as { mask?: { shape: string } };
    expect(main.mask?.shape).toBe('rounded');
    expect(r.askFor).toEqual([{ moment: 'split', at: 6.67, needs: 'before and after photos' }]);
  });
});
