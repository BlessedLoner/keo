import { describe, expect, it } from 'vitest';
import { applyEdits, describeProject, findSpoken, MOTION_TRACK, newProject, Project, type Asset, type MotionClip } from '../src/shared/studio';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const w = (text: string, start: number, end: number) => ({ text, start, end });

/** A talking video (with its transcript) on the timeline from 0. */
function talking(size: { width: number; height: number } = { width: 1080, height: 1920 }): Project {
  n = 0;
  const p0 = { ...newProject({ name: 'Podcast', rand }), ...size };
  const asset: Asset = {
    id: 'as_talk0001',
    kind: 'video',
    path: 'C:\\v\\podcast.mp4',
    name: 'podcast.mp4',
    duration: 30,
    width: size.width,
    height: size.height,
    hasAudio: true,
    words: [
      w('Today', 1, 1.3), w('we', 1.35, 1.5), w('build', 1.55, 1.9), w('your', 1.95, 2.1), w('brand', 2.15, 2.6), w('in', 2.65, 2.75), w('thirty', 2.8, 3.1), w('days.', 3.15, 3.6),
      w('Views', 6, 6.3), w('went', 6.35, 6.5), w('up', 6.55, 6.7), w('87', 6.8, 7.2), w('percent.', 7.25, 7.8),
      w('First', 10, 10.3), w('pick', 10.35, 10.6), w('one', 10.65, 10.8), w('platform.', 10.85, 11.4), w('Then', 12, 12.2), w('post', 12.25, 12.5), w('every', 12.55, 12.8), w('day.', 12.85, 13.2), w('And', 14, 14.1), w('reply', 14.15, 14.5), w('to', 14.55, 14.6), w('everyone.', 14.65, 15.3),
      w('Build', 20, 20.3), w('your', 20.35, 20.5), w('brand.', 20.55, 21),
    ],
    wordsExact: true,
  };
  return applyEdits({ ...p0, assets: [asset] }, [{ op: 'add_media', assetId: asset.id, start: 0, duration: 30 }], { rand }).project;
}
const motions = (p: Project) => p.tracks.flatMap((t) => t.clips).filter((c): c is MotionClip => c.type === 'motion');

describe('Studio motion clips', () => {
  it('adds a piece on its own Motion track, above the video and kept off the speaker', () => {
    const r = applyEdits(talking(), [{ op: 'add_motion', piece: 'headline', text: 'Build your brand', sub: 'Episode 12', start: 1, duration: 3, place: 'auto' }], { rand });
    const t = r.project.tracks.find((x) => x.name === MOTION_TRACK)!;
    expect(t.kind).toBe('text');
    expect(r.project.tracks.indexOf(t)).toBeGreaterThan(r.project.tracks.findIndex((x) => x.kind === 'video'));
    const c = motions(r.project)[0]!;
    expect(c).toMatchObject({ piece: 'headline', text: 'Build your brand', sub: 'Episode 12', start: 1, duration: 3, accent: '#8B6BFF' });
    // Tall video: above the head; wide video: beside it.
    expect(c.transform.y).toBeLessThan(0.3);
    const wide = applyEdits(talking({ width: 1920, height: 1080 }), [{ op: 'add_motion', piece: 'chips', text: 'Points', items: ['a', 'b'], start: 1, duration: 3, place: 'auto' }], { rand });
    expect(motions(wide.project)[0]!.transform.x).toBeGreaterThan(0.65);
    // Saved and loaded again unchanged.
    expect(Project.parse(JSON.parse(JSON.stringify(r.project)))).toEqual(r.project);
    expect(describeProject(r.project)).toMatch(/motion headline “Build your brand” \/ “Episode 12”/);
  });

  it('syncs to the speech: starts on the spoken words, each word of a headline comes in as it is said', () => {
    const r = applyEdits(talking(), [{ op: 'add_motion', piece: 'headline', text: 'Build your brand in 30 days', say: 'build your brand in thirty days', place: 'auto' }], { rand });
    const c = motions(r.project)[0]!;
    expect(c.start).toBeCloseTo(1.35, 2); // "build" at 1.55, 0.2 s before
    expect(c.start + c.duration).toBeGreaterThan(3.6 + 1);
    // build, your, brand, in at their own times; "30" (said "thirty") and "days" spread on.
    expect(c.beats!.slice(0, 4)).toEqual([0.2, 0.6, 0.8, 1.3]);
    expect(c.beats!.every((b, i) => i === 0 || b >= c.beats![i - 1]!)).toBe(true);
    expect(r.changes[0]).toMatch(/on the words “build your brand in thirty days\.”/);
  });

  it('finds the phrase nearest to start when it is said twice, and a counter lands on the number', () => {
    const late = applyEdits(talking(), [{ op: 'add_motion', piece: 'word_pop', text: 'Build your brand', say: 'build your brand', start: 19, place: 'auto' }], { rand });
    expect(motions(late.project)[0]!.start).toBeCloseTo(19.8, 2);
    const stat = applyEdits(talking(), [{ op: 'add_motion', piece: 'stat', text: 'more views', value: 87, unit: '%', say: 'views went up 87 percent', place: 'auto' }], { rand });
    const c = motions(stat.project)[0]!;
    expect(c.start + c.beats![0]!).toBeCloseTo(6.8, 2);
  });

  it('list rows come in on the words said for each', () => {
    const r = applyEdits(
      talking(),
      [{ op: 'add_motion', piece: 'list', text: '3 steps', items: ['Pick one platform', 'Post every day', 'Reply to everyone'], say: 'first pick one platform', sayItems: ['pick one platform', 'post every day', 'reply to everyone'], place: 'auto' }],
      { rand },
    );
    const c = motions(r.project)[0]!;
    expect(c.beats!.map((b) => Math.round((c.start + b) * 100) / 100)).toEqual([10.35, 12.25, 14.15]);
    // It stays until a moment after the last row is said.
    expect(c.start + c.duration).toBeGreaterThan(15.3);
  });

  it('says plainly when the words are not in the transcript (or there is none)', () => {
    expect(() => applyEdits(talking(), [{ op: 'add_motion', piece: 'headline', text: 'x', say: 'something never said here', place: 'auto' }], { rand })).toThrow(/Could not find “something never said here” in the transcript/);
    const bare = { ...newProject({ name: 'Empty', rand }) };
    expect(() => applyEdits(bare, [{ op: 'add_motion', piece: 'headline', text: 'x', say: 'hello there', place: 'auto' }], { rand })).toThrow(/run studio__transcript first/);
    expect(() => applyEdits(bare, [{ op: 'add_motion', piece: 'headline', text: 'x', place: 'auto' }], { rand })).toThrow(/needs a start/);
  });

  it('set changes its words, piece and colours, and null removes a field', () => {
    const r = applyEdits(talking(), [{ op: 'add_motion', piece: 'chips', text: 'Points', items: ['One', 'Two'], icon: 'check', start: 1, duration: 3, place: 'auto' }], { rand });
    const id = motions(r.project)[0]!.id;
    const s = applyEdits(r.project, [{ op: 'set', clip: id, text: 'What you get', motion: { piece: 'list', icon: null, accent: '#FF7AD9', items: ['A', 'B', 'C'] } }], { rand });
    const c = motions(s.project)[0]!;
    expect(c).toMatchObject({ piece: 'list', text: 'What you get', accent: '#FF7AD9', items: ['A', 'B', 'C'] });
    expect(c.icon).toBeUndefined();
    expect(() => applyEdits(r.project, [{ op: 'set', clip: r.project.tracks[0]!.clips[0]!.id, motion: { piece: 'list' } }], { rand })).toThrow(/no motion settings/);
  });

  it('matches spoken words loosely (punctuation, case, one misheard word)', () => {
    const words = [w('So,', 0, 0.2), w('the', 0.3, 0.4), w('REAL', 0.5, 0.8), w('uh', 0.85, 0.9), w('secret', 1, 1.4), w('is', 1.5, 1.6), w('consistency!', 1.7, 2.4)];
    expect(findSpoken(words, 'the real secret is consistency')?.map((x) => x.text)).toEqual(['the', 'REAL', 'secret', 'is', 'consistency!']);
    expect(findSpoken(words, 'nothing like it')).toBeNull();
  });
});
