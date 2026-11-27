import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset, type MediaClip } from '../src/shared/studio';
import { CUTAWAY_TRACK, cutawayOps, matchCutaways } from '../src/shared/studioCutaways';
import { motionAt } from '../src/shared/studioMotion';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

/** A podcast clip about Keo, with three screenshots and an AI video the speaker talks about. */
function project() {
  n = 0;
  const said = 'Hi I am Ada and today I want to show you Keo . First the Studio editor where you cut your clips . Then Builds makes a whole website for you . And this AI video was made from one prompt'.split(' ');
  const words = said.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const talk: Asset = { id: 'as_podcast1', kind: 'video', path: 'C:\\s\\talk.mp4', name: 'My podcast.mp4', duration: 20, width: 1920, height: 1080, hasAudio: true, words, wordsExact: true };
  const pic = (id: string, about: string, name: string): Asset => ({ id, kind: 'image', path: `C:\\s\\${id}.png`, name, duration: 0, width: 1600, height: 900, hasAudio: false, about });
  const assets = [
    talk,
    pic('as_studio01', 'A screen recording of a video editor with a timeline and clips', 'studio.png'),
    pic('as_builds01', 'A website builder showing a finished website', 'builds.png'),
    { id: 'as_aivideo1', kind: 'video', path: 'C:\\s\\ai.mp4', name: 'ai video.mp4', duration: 5, width: 1080, height: 1920, hasAudio: true, about: 'An AI made video of a car at sunset' } as Asset,
    pic('as_random01', 'A blue abstract pattern', 'pattern.png'),
  ];
  const p0 = { ...newProject({ name: 'Podcast', rand, format: 'landscape' }), assets };
  return applyEdits(p0 as never, [{ op: 'add_media', assetId: 'as_podcast1', start: 0, duration: 20 }], { rand }).project;
}

describe('Talk-matched cutaways', () => {
  it('finds the moment the words are about each picture, and spreads the ones that match nothing', () => {
    const p = project();
    const m = matchCutaways(p, ['as_studio01', 'as_builds01', 'as_aivideo1', 'as_random01']);
    const at = (id: string) => m.find((x) => x.asset === id)!.at;
    // "the Studio editor" is said from word 13 (6.5 s); "Builds makes a whole website" from word 22 (11 s); "this AI video" from word 31.
    expect(at('as_studio01')).toBeGreaterThanOrEqual(5.5);
    expect(at('as_studio01')).toBeLessThanOrEqual(7);
    expect(at('as_builds01')).toBeGreaterThanOrEqual(10);
    expect(at('as_builds01')).toBeLessThanOrEqual(12);
    expect(at('as_aivideo1')).toBeGreaterThan(at('as_builds01'));
    expect(m.find((x) => x.asset === 'as_random01')!.why).toMatch(/no matching words/);
  });

  it('puts each one in as a glass card that pops or slides in and leaves again, never two at once, over the talk', () => {
    const p0 = project();
    const plan = cutawayOps(p0, [
      { asset: 'as_studio01', at: 6.5, style: 'slide', side: 'right' },
      { asset: 'as_builds01', at: 8, style: 'pop' },
      { asset: 'as_aivideo1', at: 15, style: 'tilt' },
    ]);
    const p = applyEdits(p0, plan.ops, { rand }).project;
    const track = p.tracks.find((t) => t.name === CUTAWAY_TRACK)!;
    // Drawn above the talking video.
    expect(p.tracks.at(-1)!.name).toBe(CUTAWAY_TRACK);
    const cards = track.clips as MediaClip[];
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c.glass)).toBe(true);
    // The second waited for the first to leave.
    expect(cards[1]!.start).toBeGreaterThanOrEqual(cards[0]!.start + cards[0]!.duration);
    // The slide comes in from the side, sits beside the speaker, and is gone at the end.
    const m = (c: MediaClip, t: number) => motionAt(c, c.start + t, 1080);
    expect(m(cards[0]!, 0.02).x).toBeGreaterThan(1);
    expect(m(cards[0]!, 1.5).x).toBeCloseTo(0.73, 1);
    expect(m(cards[0]!, cards[0]!.duration).opacity).toBeLessThan(0.05);
    // The pop grows in from small.
    expect(m(cards[1]!, 0.02).scaleX).toBeLessThan(m(cards[1]!, 1).scaleX);
    // The talking video is untouched.
    expect(p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media' && (c as MediaClip).assetId === 'as_podcast1')).toHaveLength(1);
    // Made again: the track is replaced, not doubled.
    const again = applyEdits(p, cutawayOps(p, [{ asset: 'as_studio01', at: 3 }]).ops, { rand }).project;
    expect(again.tracks.filter((t) => t.name === CUTAWAY_TRACK)).toHaveLength(1);
    expect(again.tracks.find((t) => t.name === CUTAWAY_TRACK)!.clips).toHaveLength(1);
  });
});
