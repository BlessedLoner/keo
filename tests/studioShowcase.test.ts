import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset, type MediaClip } from '../src/shared/studio';
import { showcaseOps, SHOWCASE_TRACKS } from '../src/shared/studioShowcase';
import { motionAt } from '../src/shared/studioMotion';
import { showcaseFromTimeline } from '../src/main/studio/studioService';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const A = (id: string, kind: 'image' | 'video', w: number, h: number): Asset => ({ id, kind, path: `C:\\s\\${id}.png`, name: id, duration: kind === 'video' ? 20 : 0, width: w, height: h, hasAudio: false });

function project() {
  n = 0;
  return { ...newProject({ name: 'Promo', rand, format: 'vertical' }), assets: [A('as_editor01', 'image', 1600, 900), A('as_aivideo1', 'image', 1600, 900), A('as_clipvid1', 'video', 1080, 1920)] };
}

describe('Screen showcase', () => {
  it('flies each screen in as a turning glass panel, with its headline, a floating clip and the backdrop under everything', () => {
    const p0 = project();
    const r = showcaseOps(p0 as never, [
      { screen: 'as_editor01', headline: 'Edit like a pro', narration: '', seconds: 4 },
      { screen: 'as_aivideo1', headline: 'Real AI video', kicker: 'FROM ONE PROMPT', narration: '', clip: 'as_clipvid1', seconds: 5 },
    ], { end: { line: 'Follow for more', handle: '@keo.ai' } });
    expect(r.starts).toEqual([0, 4]);
    expect(r.duration).toBe(11.8);
    const p = applyEdits(p0 as never, r.ops, { rand }).project;
    // The backdrop is the bottom track (drawn first), the screens above it.
    expect(p.tracks[0]!.name).toBe(SHOWCASE_TRACKS.back);
    const screens = p.tracks.find((t) => t.name === SHOWCASE_TRACKS.screens)!.clips as MediaClip[];
    expect(screens).toHaveLength(2);
    expect(screens[0]!.glass).toBe(true);
    // Turned away as it arrives, almost square once it settles, the next one from the other side.
    const at = (c: MediaClip, t: number) => motionAt(c, t, 1920);
    expect(at(screens[0]!, 0.05).tiltY).toBeGreaterThan(40);
    expect(Math.abs(at(screens[0]!, 1.2).tiltY)).toBeLessThan(18);
    expect(at(screens[1]!, 4.05).tiltY).toBeLessThan(-40);
    expect(p.tracks.find((t) => t.name === SHOWCASE_TRACKS.floating)!.clips).toHaveLength(1);
    const titles = p.tracks.find((t) => t.name === SHOWCASE_TRACKS.titles)!.clips;
    expect(titles.map((c) => (c.type === 'motion' ? c.text : ''))).toEqual(['Edit like a pro', 'Real AI video', 'Follow for more']);
    // Made again: its own tracks are replaced, not doubled.
    const again = applyEdits(p, showcaseOps(p, [{ screen: 'as_editor01', headline: 'Again', narration: '', seconds: 4 }]).ops, { rand }).project;
    expect(again.tracks.filter((t) => t.name === SHOWCASE_TRACKS.screens)).toHaveLength(1);
    expect(again.tracks.find((t) => t.name === SHOWCASE_TRACKS.screens)!.clips).toHaveLength(1);
  });

  it('a track can be sent to the bottom or the top by its name', () => {
    const p0 = applyEdits(project() as never, [{ op: 'add_track', kind: 'text', name: 'Top words' }], { rand }).project;
    const p = applyEdits(p0, [{ op: 'set_track', trackName: 'Top words', position: 'bottom' }], { rand }).project;
    expect(p.tracks[0]!.name).toBe('Top words');
    expect(() => applyEdits(p, [{ op: 'set_track', trackName: 'Nope', position: 'top' }], { rand })).toThrow(/no track/);
  });
});

describe('Editing a showcase after it is made', () => {
  function made() {
    const p0 = project();
    const r = showcaseOps(p0 as never, [
      { screen: 'as_editor01', headline: 'Edit like a pro', kicker: 'KEO STUDIO', narration: '', seconds: 4 },
      { screen: 'as_aivideo1', headline: 'Real AI video', narration: '', clip: 'as_clipvid1', seconds: 5 },
    ]);
    return applyEdits(
      p0 as never,
      [
        ...r.ops,
        {
          op: 'add_captions',
          replace: true,
          lines: [
            { text: 'Meet Keo your studio', start: 0.6, end: 2.2, words: [{ text: 'Meet', start: 0.6, end: 0.9 }, { text: 'Keo', start: 0.9, end: 1.3 }, { text: 'your', start: 1.3, end: 1.6 }, { text: 'studio', start: 1.6, end: 2.2 }] },
            { text: 'Real video from a prompt', start: 4.6, end: 6.4 },
          ],
        },
      ],
      { rand },
    ).project;
  }

  it('restyles every caption in one op, and leaves the other tracks alone', () => {
    const p = made();
    const r = applyEdits(p, [{ op: 'set_all', trackName: 'captions', style: { sizePct: 6, color: '#FFD400' }, transform: { y: 0.8 } }], { rand });
    const caps = r.project.tracks.find((t) => t.name === 'Captions')!.clips;
    expect(caps.every((c) => c.type === 'text' && c.style.sizePct === 6 && c.style.color === '#FFD400' && c.transform.y === 0.8)).toBe(true);
    expect(r.changes).toEqual(['Changed all 2 clips on Captions.']);
    // Several tracks at once, only one kind of clip.
    const r2 = applyEdits(p, [{ op: 'set_all', trackName: ['Screens', 'Floating clips'], only: 'media', glass: false }], { rand });
    expect(r2.project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media').every((c) => c.type === 'media' && !c.glass)).toBe(true);
    expect(() => applyEdits(p, [{ op: 'set_all', trackName: 'Subtitles', style: { sizePct: 6 } }], { rand })).toThrow(/no track Subtitles\. Tracks: .*Captions/);
  });

  it('keeps the word-by-word highlight when a caption line is reworded', () => {
    const p = made();
    const cap = p.tracks.find((t) => t.name === 'Captions')!.clips[0]!;
    const same = applyEdits(p, [{ op: 'set', clip: cap.id, text: 'Meet KEO, your studio' }], { rand }).project;
    const a = same.tracks.find((t) => t.name === 'Captions')!.clips[0]!;
    expect(a.type === 'text' && a.words?.map((w) => w.text)).toEqual(['Meet', 'KEO,', 'your', 'studio']);
    expect(a.type === 'text' && a.words?.[1]!.start).toBe(0.3);
    const longer = applyEdits(p, [{ op: 'set', clip: cap.id, text: 'Say hello to Keo your new studio' }], { rand }).project;
    const b = longer.tracks.find((t) => t.name === 'Captions')!.clips[0]!;
    expect(b.type === 'text' && b.words?.length).toBe(7);
    expect(b.type === 'text' && b.words?.at(-1)!.end).toBeCloseTo(1.6, 1);
  });

  it('reads an older showcase back from its timeline, so it can be remade', () => {
    const rec = showcaseFromTimeline(made())!;
    expect(rec.scenes).toEqual([
      { screen: 'as_editor01', headline: 'Edit like a pro', kicker: 'KEO STUDIO', narration: 'Meet Keo your studio' },
      { screen: 'as_aivideo1', headline: 'Real AI video', narration: 'Real video from a prompt', clip: 'as_clipvid1' },
    ]);
    expect(rec.look).toBe('dark');
    expect(rec.captions).toBe(true);
    expect(showcaseFromTimeline(project() as never)).toBeNull();
  });
});
