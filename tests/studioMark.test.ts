import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset } from '../src/shared/studio';
import { layerLabel } from '../src/shared/studioMarkLabel';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

/** Marking on the preview: the layers under the marks are named the way the user sees them. */
describe('Marking what should change', () => {
  it('names captions, motion graphics, cutaway pictures and videos the way the user sees them', () => {
    n = 0;
    const assets: Asset[] = [
      { id: 'as_podcast1', kind: 'video', path: 'C:\\s\\talk.mp4', name: 'My podcast.mp4', duration: 20, width: 1920, height: 1080, hasAudio: true },
      { id: 'as_studio01', kind: 'image', path: 'C:\\s\\studio.png', name: 'studio.png', duration: 0, width: 1600, height: 900, hasAudio: false },
    ];
    const p0 = { ...newProject({ name: 'Podcast', rand, format: 'landscape' }), assets };
    const p = applyEdits(p0 as never, [
      { op: 'add_media', assetId: 'as_podcast1', start: 0, duration: 20 },
      { op: 'add_media', assetId: 'as_studio01', start: 2, duration: 3, trackName: 'Cutaways' },
      { op: 'add_text', text: 'so I built a video editor that edits for you', start: 0, duration: 3, trackName: 'Captions' },
      { op: 'add_motion', piece: 'headline', text: 'Keo Studio', start: 1, duration: 2, place: 'auto' },
    ], { rand }).project;
    const clips = p.tracks.flatMap((t) => t.clips);
    const id = (pred: (c: (typeof clips)[number]) => boolean) => clips.find(pred)!.id;
    expect(layerLabel(p, id((c) => c.type === 'text'))).toMatch(/^Caption “so I built a video editor .*…”$/);
    expect(layerLabel(p, id((c) => c.type === 'motion'))).toBe('Headline “Keo Studio”');
    expect(layerLabel(p, id((c) => c.type === 'media' && c.assetId === 'as_studio01'))).toBe('Picture “studio.png” (Cutaways)');
    expect(layerLabel(p, id((c) => c.type === 'media' && c.assetId === 'as_podcast1'))).toBe('Video “My podcast.mp4”');
    expect(layerLabel(p, 'nope')).toBe('a layer');
  });
});
