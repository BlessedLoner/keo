import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, Project, timelineWords, zoomAt, type Asset, type MediaClip, type MotionClip } from '../src/shared/studio';
import { MOTION_EDIT_TRACKS, MotionBeatInput, motionEditOps, motionPlanPrompt, planBeats, sentences, transcriptForPlan, type MotionBeat } from '../src/shared/studioMotionEdit';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const w = (text: string, start: number, end: number) => ({ text, start, end });

/** A 60-second talking video with its transcript, from 0. */
function podcast(size: { width: number; height: number } = { width: 1080, height: 1920 }): Project {
  n = 0;
  const p0 = { ...newProject({ name: 'Podcast', rand }), ...size };
  const words = [
    w('Hey', 0.4, 0.6), w('guys,', 0.65, 0.9), w('welcome', 0.95, 1.3), w('back.', 1.35, 1.7),
    w('Today', 3, 3.3), w('I', 3.35, 3.4), w('want', 3.45, 3.6), w('to', 3.65, 3.7), w('show', 3.75, 4), w('you', 4.05, 4.2), w('Keo.', 4.25, 4.8),
    w('Keo', 8, 8.3), w('is', 8.35, 8.45), w('your', 8.5, 8.65), w('personal', 8.7, 9.1), w('assistant.', 9.15, 9.8),
    w('It', 12, 12.1), w('edits', 12.15, 12.5), w('videos,', 12.55, 13), w('sends', 13.1, 13.4), w('messages', 13.45, 13.9), w('and', 13.95, 14.05), w('remembers', 14.1, 14.6), w('everything.', 14.65, 15.3),
    w('Views', 19, 19.3), w('went', 19.35, 19.5), w('up', 19.55, 19.7), w('87', 19.8, 20.2), w('percent', 20.25, 20.7), w('this', 20.75, 20.9), w('month.', 20.95, 21.4),
    w('Make', 26, 26.3), w('Kira', 26.35, 26.7), w('yours.', 26.75, 27.2),
    w('You', 31, 31.2), w('choose', 31.25, 31.6), w('a', 31.65, 31.7), w('male', 31.75, 32), w('voice', 32.05, 32.4), w('or', 32.45, 32.55), w('female', 32.6, 33), w('voice.', 33.05, 33.5),
    w('Everything', 38, 38.5), w('happens', 38.55, 38.9), w('on', 38.95, 39.05), w('your', 39.1, 39.25), w('computer.', 39.3, 39.9),
    w('Nothing', 44, 44.4), w('leaves', 44.45, 44.8), w('without', 44.85, 45.2), w('permission.', 45.25, 46),
    w('Download', 52, 52.5), w('Keo', 52.55, 52.8), w('today.', 52.85, 53.4),
  ];
  const asset: Asset = { id: 'as_talk0001', kind: 'video', path: 'C:\\v\\podcast.mp4', name: 'podcast.mp4', duration: 60, width: size.width, height: size.height, hasAudio: true, words, wordsExact: true };
  return applyEdits({ ...p0, assets: [asset, { id: 'as_whoosh01', kind: 'audio', path: 'C:\\s\\w.wav', name: 'whoosh.wav', duration: 1, width: 0, height: 0, hasAudio: true }] }, [{ op: 'add_media', assetId: asset.id, start: 0, duration: 60 }], { rand }).project;
}
const words = (p: Project) => timelineWords(p);
const clips = (p: Project, track: string) => p.tracks.find((t) => t.name === track)?.clips ?? [];
// The speaker: head from 0.2 down, filling the middle (a vertical talking video).
const people = [0, 10, 20, 30, 40, 50].map((t) => ({ t, box: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 1 } }));

describe('Studio motion edit', () => {
  it('plans beats over the WHOLE video, never two at once, kinds taking turns', () => {
    const p = podcast();
    const beats = planBeats(words(p));
    expect(beats.length).toBeGreaterThanOrEqual(5);
    const kinds = new Set(beats.map((b) => b.kind));
    expect(kinds.has('scene') && kinds.has('punch')).toBe(true);
    // The number becomes a counter.
    expect(beats.some((b) => b.value === 87 && b.unit === '%')).toBe(true);
    const r = applyEdits(p, motionEditOps(p, { words: words(p), people }).ops, { rand });
    const top = clips(r.project, MOTION_EDIT_TRACKS.top) as MotionClip[];
    // Graphics reach the second half, not only the first seconds.
    expect(Math.max(...top.map((c) => c.start))).toBeGreaterThan(30);
    // Nothing before the first two seconds.
    expect(Math.min(...top.map((c) => c.start))).toBeGreaterThan(1.5);
    const spans = top.map((c) => [c.start, c.start + c.duration]).sort((a, b) => a[0]! - b[0]!);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]!);
    expect(Project.parse(JSON.parse(JSON.stringify(r.project)))).toEqual(r.project);
  });

  it('cuts away to a keyword scene on the spoken words, the key word in the accent, light and dark taking turns', () => {
    const p = podcast();
    const beats: MotionBeat[] = [
      { kind: 'scene', say: 'Make Kira yours', key: 'yours' },
      { kind: 'scene', say: 'Everything happens on your computer', text: 'On your computer', key: 'computer' },
    ];
    const r = applyEdits(p, motionEditOps(p, { words: words(p), beats, people, sfx: { whoosh: 'as_whoosh01' } }).ops, { rand });
    const [a, b] = clips(r.project, MOTION_EDIT_TRACKS.top) as MotionClip[];
    expect(a).toMatchObject({ piece: 'scene', text: 'Make Kira yours', items: ['yours'], background: '#F4F1EA', color: '#111111' });
    // It lands just before "Make" (26 s) and each word comes in as it is said.
    expect(a!.start).toBeCloseTo(25.78, 2);
    expect(a!.beats).toEqual([0.22, 0.57, 0.97]);
    expect(b).toMatchObject({ text: 'On your computer', background: '#0D0C12', color: '#FFFFFF' });
    // A whoosh into each scene, on the motion edit's own sound track.
    expect(clips(r.project, MOTION_EDIT_TRACKS.sound).map((c) => c.start)).toEqual([25.73, 37.73]);
    // The scenes are drawn above the video.
    const order = r.project.tracks.map((t) => t.name);
    expect(order.indexOf(MOTION_EDIT_TRACKS.top)).toBeGreaterThan(order.findIndex((n) => n === 'Video' || r.project.tracks.find((t) => t.name === n)?.kind === 'video'));
  });

  it('frames the speaker in a card while a list builds on the words said for each item', () => {
    const p = podcast();
    const beats: MotionBeat[] = [{ kind: 'frame', say: 'It edits videos', text: 'What Keo does', items: ['Edits videos', 'Sends messages', 'Remembers everything'], sayItems: ['edits videos', 'sends messages', 'remembers everything'] }];
    const r = applyEdits(p, motionEditOps(p, { words: words(p), beats, people }).ops, { rand });
    const back = clips(r.project, MOTION_EDIT_TRACKS.back)[0] as MotionClip;
    const card = clips(r.project, MOTION_EDIT_TRACKS.video)[0] as MediaClip;
    const list = clips(r.project, MOTION_EDIT_TRACKS.top)[0] as MotionClip;
    expect(back.piece).toBe('backdrop');
    expect(card).toMatchObject({ assetId: 'as_talk0001', volume: 0, mask: { shape: 'rounded' } });
    // The same moment of the video, shrinking to the top half and back.
    expect(card.in).toBeCloseTo(card.start, 2);
    expect(card.keys!.scale!.map((k) => k.value)).toEqual([1, 0.54, 0.54, 1]);
    expect(card.keys!.y!.map((k) => k.value)).toEqual([0.5, 0.31, 0.31, 0.5]);
    // Each row on its words (12.15, 13.1, 14.1 s), below the card.
    expect(list).toMatchObject({ piece: 'list', items: ['Edits videos', 'Sends messages', 'Remembers everything'] });
    expect(list.beats!.map((b) => Math.round((list.start + b) * 100) / 100)).toEqual([12.15, 13.1, 14.1]);
    expect(list.transform.y).toBeGreaterThan(0.6);
    // Backdrop under the card, the list over it.
    const order = r.project.tracks.map((t) => t.name);
    expect(order.indexOf(MOTION_EDIT_TRACKS.back)).toBeLessThan(order.indexOf(MOTION_EDIT_TRACKS.video));
    expect(order.indexOf(MOTION_EDIT_TRACKS.video)).toBeLessThan(order.indexOf(MOTION_EDIT_TRACKS.top));
  });

  it('pops graphics off the face: below the face on a tall video, beside the speaker on a wide one', () => {
    const p = podcast();
    const r = applyEdits(p, motionEditOps(p, { words: words(p), beats: [{ kind: 'pop', say: 'personal assistant', text: 'Personal assistant', piece: 'headline' }], people }).ops, { rand });
    const g = clips(r.project, MOTION_EDIT_TRACKS.top)[0] as MotionClip;
    // The face ends about 0.54 down: the graphic sits under it.
    expect(g.transform.y).toBeGreaterThan(0.56);
    const wide = podcast({ width: 1920, height: 1080 });
    const left = [{ t: 8, box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 1 } }];
    const rw = applyEdits(wide, motionEditOps(wide, { words: words(wide), beats: [{ kind: 'pop', say: 'personal assistant', piece: 'word_pop' }], people: left }).ops, { rand });
    expect((clips(rw.project, MOTION_EDIT_TRACKS.top)[0] as MotionClip).transform.x).toBeGreaterThan(0.6);
  });

  it('moves the camera all the way through: a framing per sentence, punch-ins on the face, a push into each scene', () => {
    const p = podcast();
    const beats: MotionBeat[] = [{ kind: 'punch', say: 'personal assistant' }, { kind: 'scene', say: 'Make Kira yours' }];
    const r = applyEdits(p, motionEditOps(p, { words: words(p), beats, people }).ops, { rand });
    const main = r.project.tracks.find((t) => t.name !== MOTION_EDIT_TRACKS.video && t.kind === 'video')!.clips[0] as MediaClip;
    const z = main.zooms!;
    expect(z.length).toBeGreaterThan(10);
    // Late in the video the camera still moves.
    expect(z.some((k) => k.at > 50)).toBe(true);
    // The punch-in on "personal" (8.7 s) is close and aimed at the face.
    expect(zoomAt(z, 8.8).scale).toBeCloseTo(1.25, 2);
    expect(zoomAt(z, 8.8).y).toBeLessThan(0.45);
    // Pushing in as the scene comes (it starts at 25.78 s).
    expect(zoomAt(z, 25.85).scale).toBeGreaterThan(zoomAt(z, 25.5).scale);
    // Two framings take turns.
    const levels = sentences(words(p)).map((s) => Math.round(zoomAt(z, s[0]!.start + 0.01).scale * 100) / 100);
    expect(new Set(levels).size).toBeGreaterThan(1);
  });

  it('a word said twice lands where the beat means it', () => {
    const p = podcast();
    // "Keo" is said at 4.25, 8 and 52.55 s.
    const r = applyEdits(p, motionEditOps(p, { words: words(p), beats: [{ kind: 'scene', say: 'Keo', at: 52 }], people }).ops, { rand });
    expect((clips(r.project, MOTION_EDIT_TRACKS.top)[0] as MotionClip).start).toBeCloseTo(52.33, 2);
  });

  it('gives Keo’s model the transcript with times and checks each beat it writes back', () => {
    const p = podcast();
    const t = transcriptForPlan(words(p));
    expect(t.split('\n')[1]).toBe('[3.0s] Today I want to show you Keo.');
    expect(motionPlanPrompt(60, 'normal')).toMatch(/FIRST sentence to the LAST/);
    expect(MotionBeatInput.safeParse({ kind: 'scene', say: 'Make Kira yours', key: 'yours' }).success).toBe(true);
    expect(MotionBeatInput.safeParse({ kind: 'explode', say: 'x' }).success).toBe(false);
  });

  it('made again, it replaces itself; words it cannot find are reported, not guessed', () => {
    const p = podcast();
    const once = applyEdits(p, motionEditOps(p, { words: words(p), people }).ops, { rand }).project;
    const built = motionEditOps(once, { words: words(once), people, beats: [{ kind: 'scene', say: 'Make Kira yours' }, { kind: 'scene', say: 'never said this at all' }] });
    expect(built.missed).toEqual(['never said this at all']);
    const twice = applyEdits(once, built.ops, { rand }).project;
    expect(clips(twice, MOTION_EDIT_TRACKS.top)).toHaveLength(1);
    expect(twice.tracks.filter((t) => t.name === MOTION_EDIT_TRACKS.top)).toHaveLength(1);
    expect(() => motionEditOps(p, { words: [] })).toThrow(/transcribed/);
  });
});
