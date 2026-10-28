import { describe, expect, it } from 'vitest';
import { applyEdits, describeProject, EditError, newProject, projectDuration, type Asset, type MediaClip, type Project, type TextClip } from '../src/shared/studio';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

function project(): Project {
  n = 0;
  const p = newProject({ name: 'Test', format: 'vertical', rand, now: new Date('2026-10-28T10:00:00Z') });
  const assets: Asset[] = [
    { id: 'as_video01', kind: 'video', path: 'C:\\clips\\a.mp4', name: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true },
    { id: 'as_video02', kind: 'video', path: 'C:\\clips\\b.mp4', name: 'b.mp4', duration: 4, width: 1080, height: 1920, hasAudio: false },
    { id: 'as_image01', kind: 'image', path: 'C:\\pics\\logo.png', name: 'logo.png', duration: 0, width: 512, height: 512, hasAudio: false },
    { id: 'as_music01', kind: 'audio', path: 'C:\\music\\beat.mp3', name: 'beat.mp3', duration: 60, width: 0, height: 0, hasAudio: true },
  ];
  return { ...p, assets };
}
const ids = (p: Project) => p.tracks.map((t) => t.clips.map((c) => `${c.id}@${c.start}+${c.duration}`));

describe('Keo Studio projects', () => {
  it('a new project has a video, a text and an audio track in the chosen format', () => {
    const p = project();
    expect(p).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(p.tracks.map((t) => t.kind)).toEqual(['video', 'text', 'audio']);
    expect(projectDuration(p)).toBe(0);
  });

  it('adds clips one after another, pictures for 3 s, and never longer than the source', () => {
    const { project: p, changes } = applyEdits(project(), [
      { op: 'add_media', assetId: 'as_video01', start: 'end', in: 2 },
      { op: 'add_media', assetId: 'as_image01' },
      { op: 'add_media', assetId: 'as_video02', duration: 99 },
    ]);
    const v = p.tracks[0]!.clips as MediaClip[];
    expect(v.map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 8, 2],
      [8, 3, 0],
      [11, 4, 0],
    ]);
    expect(projectDuration(p)).toBe(15);
    expect(changes).toHaveLength(3);
  });

  it('splits, trims and moves, keeping the right part of the source', () => {
    let p = applyEdits(project(), [{ op: 'add_media', assetId: 'as_video01' }]).project;
    const id = p.tracks[0]!.clips[0]!.id;
    p = applyEdits(p, [{ op: 'split', clip: id, at: 4 }]).project;
    const [a, b] = p.tracks[0]!.clips as MediaClip[];
    expect([a!.start, a!.duration, a!.in]).toEqual([0, 4, 0]);
    expect([b!.start, b!.duration, b!.in]).toEqual([4, 6, 4]);
    p = applyEdits(p, [{ op: 'trim', clip: b!.id, trimStart: 1, duration: 3 }]).project;
    const b2 = p.tracks[0]!.clips[1] as MediaClip;
    expect([b2.start, b2.duration, b2.in]).toEqual([5, 3, 5]);
    p = applyEdits(p, [{ op: 'move', clip: b2.id, start: 4 }]).project;
    expect((p.tracks[0]!.clips[1] as MediaClip).start).toBe(4);
  });

  it('changing speed keeps the same part of the source (the clip gets shorter or longer)', () => {
    let p = applyEdits(project(), [{ op: 'add_media', assetId: 'as_video01', duration: 6 }]).project;
    const id = p.tracks[0]!.clips[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, speed: 2 }]).project;
    expect(p.tracks[0]!.clips[0]).toMatchObject({ speed: 2, duration: 3 });
  });

  it('cuts a range out of every track and closes the gap (like removing a silence)', () => {
    let p = applyEdits(project(), [
      { op: 'add_media', assetId: 'as_video01' },
      { op: 'add_text', text: 'Hello', start: 1, duration: 2 },
      { op: 'add_text', text: 'After', start: 7, duration: 2 },
      { op: 'add_audio', assetId: 'as_music01', duration: 10 },
    ]).project;
    p = applyEdits(p, [{ op: 'cut_range', from: 2, to: 5 }]).project;
    expect(projectDuration(p)).toBe(7);
    const video = p.tracks[0]!.clips as MediaClip[];
    expect(video.map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 2, 0],
      [2, 5, 5],
    ]);
    const texts = p.tracks[1]!.clips as TextClip[];
    expect(texts.map((c) => [c.text, c.start, c.duration])).toEqual([
      ['Hello', 1, 1],
      ['After', 4, 2],
    ]);
  });

  it('styles text and keeps other style values', () => {
    let p = applyEdits(project(), [{ op: 'add_text', text: 'Big news', start: 0, duration: 2, style: { sizePct: 9, color: '#FFD400' } }]).project;
    const id = p.tracks[1]!.clips[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, style: { glow: 20 }, animIn: 'pop' }]).project;
    expect(p.tracks[1]!.clips[0]).toMatchObject({ animIn: 'pop', style: { sizePct: 9, color: '#FFD400', glow: 20, font: 'Segoe UI' } });
  });

  it('does all edits or none: one bad edit leaves the project as it was', () => {
    const p = applyEdits(project(), [{ op: 'add_media', assetId: 'as_video01' }]).project;
    const before = JSON.stringify(p);
    expect(() => applyEdits(p, [{ op: 'add_text', text: 'ok', start: 0, duration: 1 }, { op: 'split', clip: 'cl_missing1', at: 2 }])).toThrow(EditError);
    expect(JSON.stringify(p)).toBe(before);
    expect(() => applyEdits(p, [{ op: 'add_audio', assetId: 'as_video02' }])).toThrow(/no sound/);
    expect(() => applyEdits(p, [{ op: 'set', clip: p.tracks[0]!.clips[0]!.id, text: 'x' }])).toThrow(/no text/);
  });

  it('describes the timeline in words for Keo', () => {
    const p = applyEdits(project(), [
      { op: 'add_media', assetId: 'as_video01' },
      { op: 'add_text', text: 'Watch this', start: 0, duration: 2 },
    ]).project;
    const d = describeProject(p);
    expect(d).toMatch(/1080x1920, 30 fps, 10s/);
    expect(d).toMatch(/clip a\.mp4 from 0s/);
    expect(d).toMatch(/text “Watch this”/);
    expect(ids(p)[0]).toHaveLength(1);
  });
});
