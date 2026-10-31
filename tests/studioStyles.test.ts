import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset, type MediaClip, type Project, type TextClip } from '../src/shared/studio';
import { guessEmphasis, styleOps, StyleError } from '../src/shared/studioStyles';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const vid: Asset = { id: 'as_video001', kind: 'video', path: 'C:/v/pod.mp4', name: 'pod.mp4', duration: 20, width: 720, height: 1280, hasAudio: true };
const words = 'So today we talk about discipline and why consistency beats motivation every single time you show up'
  .split(' ')
  .map((text, i) => ({ text, start: i * 0.9, end: i * 0.9 + 0.6 }));

function podcast(): Project {
  n = 0;
  return applyEdits({ ...newProject({ name: 'P', rand }), width: 720, height: 1280, assets: [vid] }, [{ op: 'add_media', assetId: vid.id, start: 0 }], { rand }).project;
}
const all = (p: Project) => p.tracks.flatMap((t) => t.clips);
const texts = (p: Project) => all(p).filter((c): c is TextClip => c.type === 'text');

describe('Keo styles', () => {
  it('guesses strong words, not filler, spaced out', () => {
    const g = guessEmphasis(words, 3);
    expect(g).toContain('discipline');
    expect(g).not.toContain('about');
    expect(g.length).toBeLessThanOrEqual(6);
  });

  it('podcast-frame: rounded frame, mixed-font headline, words on time, end card after the video', () => {
    const p = podcast();
    const ops = styleOps(p, 'podcast-frame', { words, emphasis: ['discipline', 'consistency'], headline: 'Discipline beats motivation', headlineEmphasis: 'motivation', endText: 'Follow for more', handle: '@me', flip: true });
    const out = applyEdits(p, ops, { rand }).project;
    const v = all(out).find((c) => c.type === 'media') as MediaClip;
    expect(v.mask?.shape).toBe('rounded');
    expect(v.flipX).toBe(true);
    expect(out.loudness).toBe('social');
    const t = texts(out);
    expect(t[0]!.marks?.[0]).toMatchObject({ font: 'Instrument Serif', italic: true });
    const pops = t.filter((c) => c.text === 'DISCIPLINE' || c.text === 'CONSISTENCY');
    expect(pops.map((c) => c.start)).toEqual([words[5]!.start, words[8]!.start]);
    const card = t.at(-1)!;
    expect(card.start).toBe(20);
    expect(card.text).toBe('Follow for more\n@me');
  });

  it('doc-serif: black and white, captions with key words in red serif italic, lists that build', () => {
    const p = podcast();
    const lines = [
      { text: 'So today we talk', start: 0, end: 3.5 },
      { text: 'about discipline and why', start: 3.6, end: 7 },
    ];
    const ops = styleOps(p, 'doc-serif', { words, lines, emphasis: ['discipline'], lists: [{ at: 8, title: 'Three rules', items: ['Show up', 'Stay', 'Repeat'] }] });
    const out = applyEdits(p, ops, { rand }).project;
    const v = all(out).find((c) => c.type === 'media') as MediaClip;
    expect(v.color?.saturation).toBe(-1);
    const caps = out.tracks.find((t) => t.name === 'Captions')!.clips as TextClip[];
    expect(caps).toHaveLength(2);
    expect(caps[0]!.marks).toBeUndefined();
    expect(caps[1]!.marks).toEqual([{ from: 1, to: 2, font: 'Instrument Serif', italic: true, weight: 'normal', color: '#E53935', scale: 1.3 }]);
    const items = texts(out).filter((c) => /^\d\. /.test(c.text));
    expect(items.map((c) => c.start)).toEqual([8.7, 9.4, 10.1]);
    // They leave together.
    expect(new Set(items.map((c) => Math.round((c.start + c.duration) * 100)))).toHaveLength(1);
  });

  it('needs the talking video first', () => {
    n = 0;
    expect(() => styleOps(newProject({ name: 'E', rand }), 'doc-serif', { words: [] })).toThrow(StyleError);
  });
});
