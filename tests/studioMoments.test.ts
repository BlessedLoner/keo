import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset, type MediaClip, type Project, type TextClip } from '../src/shared/studio';
import { fitScale, momentOps, MomentNeeds } from '../src/shared/studioMoments';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const vid: Asset = { id: 'as_video001', kind: 'video', path: 'C:/v/pod.mp4', name: 'pod.mp4', duration: 30, width: 720, height: 1280, hasAudio: true };
const pic = (k: number): Asset => ({ id: `as_pic0000${k}`, kind: 'image', path: `C:/v/p${k}.jpg`, name: `p${k}.jpg`, duration: 0, width: 800, height: 800, hasAudio: false });

function podcast(): Project {
  n = 0;
  let p: Project = { ...newProject({ name: 'P', rand }), width: 720, height: 1280, assets: [vid, pic(1), pic(2)] };
  p = applyEdits(p, [{ op: 'add_media', assetId: vid.id, start: 0, in: 2 }], { rand }).project;
  const c = p.tracks.flatMap((t) => t.clips)[0]!;
  return applyEdits(p, [{ op: 'set', clip: c.id, flipX: true, mask: { shape: 'rounded', radius: 0.07 }, transform: { scale: 0.84 }, zooms: [{ at: 12, scale: 1.2, x: 0.5, y: 0.5, ease: 'cut' }] }], { rand }).project;
}
const add = (p: Project, ...a: Parameters<typeof momentOps> extends [Project, ...infer R] ? R : never) => applyEdits(p, momentOps(p, ...a), { rand }).project;
const idx = (p: Project, name: string) => p.tracks.findIndex((t) => t.name === name);

describe('Moments', () => {
  it('text-behind: the words go under a cut-out copy that matches the talking video exactly', () => {
    const out = add(podcast(), 'text-behind', { at: 10, text: 'focus' });
    const person = out.tracks[idx(out, 'Person cut-out')]!.clips[0] as MediaClip;
    expect(idx(out, 'Person cut-out')).toBe(out.tracks.length - 1);
    expect(idx(out, 'Behind text')).toBeLessThan(idx(out, 'Person cut-out'));
    expect([person.start, person.in, person.duration, person.cutout, person.flipX, person.mask?.shape, person.transform.scale]).toEqual([10, 12, 2.5, true, true, 'rounded', 0.84]);
    // The talking video's zoom at 12 s into the clip is 2 s into the copy.
    expect(person.zooms?.[0]?.at).toBe(2);
    // A second one later keeps the order.
    const again = add(out, 'text-behind', { at: 20, text: 'win' });
    expect(again.tracks[idx(again, 'Person cut-out')]!.clips).toHaveLength(2);
    expect((again.tracks[idx(again, 'Behind text')]!.clips as TextClip[]).map((c) => c.text)).toEqual(['focus', 'win']);
  });

  it('split and image-pop ask for the clips they need', () => {
    expect(() => momentOps(podcast(), 'split', { at: 3, assets: ['as_pic00001'] })).toThrow(MomentNeeds);
    expect(() => momentOps(podcast(), 'split', { at: 3 })).toThrow(/Ask the user/);
    expect(() => momentOps(podcast(), 'image-pop', { at: 3, assets: ['as_nothere1'] })).toThrow(/needs a picture or video/);
    expect(() => momentOps(podcast(), 'word-card', { at: 3 })).toThrow(/needs its words/);
  });

  it('split: two rounded cards over a plain background, with labels on top', () => {
    const out = add(podcast(), 'split', { at: 5, assets: ['as_pic00001', 'as_pic00002'], text: 'Old way|New way' });
    const cards = out.tracks[idx(out, 'Split')]!.clips as MediaClip[];
    expect(cards.map((c) => [c.start, c.mask?.shape, c.transform.y])).toEqual([
      [5, 'rounded', 0.29],
      [5.25, 'rounded', 0.71],
    ]);
    expect(idx(out, 'Split back')).toBeLessThan(idx(out, 'Split'));
    expect(idx(out, 'Split')).toBeLessThan(idx(out, 'Split labels'));
    expect((out.tracks[idx(out, 'Split labels')]!.clips as TextClip[]).map((c) => c.text)).toEqual(['Old way', 'New way']);
  });

  it('word-card and image-pop', () => {
    const card = add(podcast(), 'word-card', { at: 8, text: 'Part two' });
    expect(idx(card, 'Cards')).toBeLessThan(idx(card, 'Card words'));
    const pop = add(podcast(), 'image-pop', { at: 8, assets: ['as_pic00001'], side: 'left' });
    const c = pop.tracks[idx(pop, 'Pop-ins')]!.clips[0] as MediaClip;
    expect([c.transform.x, c.enter?.kind, c.loop?.kind]).toEqual([0.3, 'pop', 'float']);
    expect(idx(pop, 'Pop-ins')).toBe(pop.tracks.length - 1);
  });
});

describe('Moment sizing', () => {
  it('fills a box by the picture’s own shape', () => {
    const p = podcast();
    const wide: Asset = { ...pic(3), id: 'as_wide0001', width: 1600, height: 900 };
    const q = { ...p, assets: [...p.assets, wide] };
    // A square photo in a tall frame: as wide as the box allows (0.9), unless too tall.
    expect(fitScale(q, 'as_pic00001', 0.9, 0.4)).toBe(0.71);
    // A wide photo: limited by the box's width.
    expect(fitScale(q, 'as_wide0001', 0.9, 0.4)).toBe(0.9);
    // The talking video itself (tall): limited by the height.
    expect(fitScale(q, 'as_video001', 0.9, 0.4)).toBe(0.4);
  });
});

describe('Circle text and follow card', () => {
  it('circle-text: the words repeated around a full, slowly turning circle (with a round photo when given)', () => {
    const out = add(podcast(), 'circle-text', { at: 2, text: 'grow', assets: ['as_pic00001'] });
    const t = out.tracks[idx(out, 'Circle words')]!.clips[0] as TextClip;
    expect(t.style.curve).toBe(200);
    expect(t.text.startsWith('GROW • GROW')).toBe(true);
    expect(t.loop?.kind).toBe('spin');
    const photo = out.tracks[idx(out, 'Circle')]!.clips[0] as MediaClip;
    expect(photo.mask?.shape).toBe('circle');
    expect(idx(out, 'Circle')).toBeLessThan(idx(out, 'Circle words'));
  });

  it('follow-card: the handle, then each platform popping in', () => {
    const out = add(podcast(), 'follow-card', { at: 20, text: '@keo.ai', text2: 'Instagram|TikTok' });
    const words = (out.tracks[idx(out, 'Card words')]!.clips as TextClip[]).map((c) => [c.text, c.start]);
    expect(words).toEqual([
      ['@keo.ai', 20.1],
      ['Instagram', 20.45],
      ['TikTok', 20.7],
    ]);
  });
});

describe('Grid', () => {
  it('square tiles in two columns, popping in one by one, and asks for at least two pictures', () => {
    const p = podcast();
    const wide: Asset = { ...pic(3), id: 'as_wide0001', width: 1600, height: 900 };
    const q = { ...p, assets: [...p.assets, wide] };
    const out = add(q, 'grid', { at: 3, assets: ['as_pic00001', 'as_pic00002', 'as_wide0001'] });
    const tiles = out.tracks[idx(out, 'Grid')]!.clips as MediaClip[];
    expect(tiles.map((c) => c.start)).toEqual([3, 3.15, 3.3]);
    // Two side by side, the third alone in the middle of the second row.
    tiles.forEach((c, i) => expect(c.transform.x).toBeCloseTo([0.265, 0.735, 0.5][i]!, 1));
    expect(tiles[2]!.crop).toEqual({ left: 0.22, right: 0.22, top: 0, bottom: 0 });
    expect(() => momentOps(p, 'grid', { at: 3, assets: ['as_pic00001'] })).toThrow(MomentNeeds);
  });
});

describe('Sweep and new text motions', () => {
  it('sweep: the words travel across the whole screen, behind the person on the talking video', () => {
    const out = add(podcast(), 'sweep', { at: 4, text: 'never stop', direction: 'left' });
    const t = out.tracks[idx(out, 'Behind text')]!.clips[0] as TextClip;
    const xs = t.keys!.x!.map((k) => k.value);
    // Starts fully off the right edge, ends fully off the left one.
    expect(xs[0]!).toBeGreaterThan(1);
    expect(xs[1]!).toBeLessThan(0);
    expect(t.text).toBe('NEVER STOP');
    expect(out.tracks[idx(out, 'Person cut-out')]!.clips).toHaveLength(1);
    const up = add(podcast(), 'sweep', { at: 4, text: 'rise', direction: 'down' });
    const ys = (up.tracks[idx(up, 'Behind text')]!.clips[0] as TextClip).keys!.y!.map((k) => k.value);
    expect(ys[0]!).toBeLessThan(ys[1]!);
  });

  it('text takes the new entrances and exits', () => {
    const p = podcast();
    const out = applyEdits(p, [{ op: 'add_text', text: 'Fly in', start: 0, duration: 2, animIn: 'words-left', animOut: 'slide-right' }, { op: 'add_text', text: 'Spin', start: 0, duration: 2, animIn: 'spin', animOut: 'slide-up' }], { rand }).project;
    const ts = out.tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.type === 'text');
    expect(ts.map((c) => [c.animIn, c.animOut])).toEqual([
      ['words-left', 'slide-right'],
      ['spin', 'slide-up'],
    ]);
  });
});

describe('Pictures keep off the face', () => {
  it('goes in the bigger free space: below the face, or above the head when the speaker sits low', () => {
    const p = podcast();
    const place = (person: { x0: number; y0: number; x1: number; y1: number }) => {
      const out = add(p, 'image-pop', { at: 3, assets: ['as_pic00001'], person });
      return out.tracks[idx(out, 'Pop-ins')]!.clips[0] as MediaClip;
    };
    // Face at the top (0.2–0.39): the picture goes below it.
    const low = place({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 });
    expect(low.transform.y).toBeGreaterThan(0.45);
    // Speaker low in the frame (head from 0.55): the picture goes above their head.
    const high = place({ x0: 0.2, y0: 0.55, x1: 0.8, y1: 1 });
    expect(high.transform.y).toBeLessThan(0.4);
  });
});
