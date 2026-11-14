import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type MediaClip, type Project } from '../src/shared/studio';
import { allOnMain, closeUp, magneticMove, magneticTrimEnd, magneticTrimStart, mainTrack } from '../src/shared/studioTimeline';

/** A main track of three 2-second clips (A B C) and an overlay clip above. */
function setup(): Project {
  let p: Project = { ...newProject({ name: 'T', format: 'vertical' }), assets: [{ id: 'as_vid00001', kind: 'video', name: 'v.mp4', path: 'C:/v.mp4', duration: 60, width: 1080, height: 1920, hasAudio: true }] as never };
  p = applyEdits(p, [
    { op: 'add_media', assetId: 'as_vid00001', start: 0, in: 0, duration: 2 },
    { op: 'add_media', assetId: 'as_vid00001', start: 2, in: 10, duration: 2 },
    { op: 'add_media', assetId: 'as_vid00001', start: 4, in: 20, duration: 2 },
    { op: 'add_media', assetId: 'as_vid00001', start: 1, in: 30, duration: 1.5, trackName: 'Overlay' },
  ]).project;
  return p;
}
const main = (p: Project) => (mainTrack(p)!.clips as MediaClip[]).slice().sort((a, b) => a.start - b.start).map((c) => [c.in, c.start, c.duration]);

describe('The magnetic main track', () => {
  it('reorders by where the clip is dropped and keeps the track packed from 0:00', () => {
    const p = setup();
    const [a] = mainTrack(p)!.clips;
    // A dropped after C: B C A.
    const q = applyEdits(p, magneticMove(p, a!.id, 5.2, mainTrack(p)!.id)).project;
    expect(main(q)).toEqual([
      [10, 0, 2],
      [20, 2, 2],
      [0, 4, 2],
    ]);
  });

  it('leaves no gap when a clip is dragged off the main track, and inserts a clip brought onto it', () => {
    const p = setup();
    const b = mainTrack(p)!.clips.find((c) => (c as MediaClip).in === 10)!;
    const overlay = p.tracks.find((t) => t.name === 'Overlay')!;
    const q = applyEdits(p, magneticMove(p, b.id, 3, overlay.id)).project;
    expect(main(q)).toEqual([
      [0, 0, 2],
      [20, 2, 2],
    ]);
    // The overlay clip brought down between A and C.
    const o = overlay.clips[0]!;
    const r = applyEdits(q, magneticMove(q, o.id, 1.5, mainTrack(q)!.id)).project;
    expect(main(r)).toEqual([
      [0, 0, 2],
      [30, 2, 1.5],
      [20, 3.5, 2],
    ]);
  });

  it('trims ripple: the clips after follow, the trimmed clip keeps its place', () => {
    const p = setup();
    const b = mainTrack(p)!.clips.find((c) => (c as MediaClip).in === 10)!;
    const shorter = applyEdits(p, magneticTrimEnd(p, b.id, 1.2)).project;
    expect(main(shorter)).toEqual([
      [0, 0, 2],
      [10, 2, 1.2],
      [20, 3.2, 2],
    ]);
    const front = applyEdits(p, magneticTrimStart(p, b.id, 0.5)).project;
    expect(main(front)).toEqual([
      [0, 0, 2],
      [10.5, 2, 1.5],
      [20, 3.5, 2],
    ]);
    // The overlay is never touched.
    expect(front.tracks.find((t) => t.name === 'Overlay')!.clips[0]!.start).toBe(1);
  });

  it('moves a clip onto a new track of its own (one edit), and the main track closes up behind it', () => {
    const p = setup();
    const b = mainTrack(p)!.clips.find((c) => (c as MediaClip).in === 10)!;
    const q = applyEdits(p, [{ op: 'move', clip: b.id, start: 5, newTrack: true }, ...closeUp(p, b.id)]).project;
    const fresh = q.tracks.at(-1)!;
    expect(fresh).toMatchObject({ kind: 'video', name: 'Video 3' });
    expect(fresh.clips.map((c) => [c.id, c.start])).toEqual([[b.id, 5]]);
    expect(main(q)).toEqual([
      [0, 0, 2],
      [20, 2, 2],
    ]);
  });

  it('knows when a selection is all on the main track', () => {
    const p = setup();
    expect(allOnMain(p, mainTrack(p)!.clips.map((c) => c.id))).toBe(true);
    expect(allOnMain(p, [p.tracks.find((t) => t.name === 'Overlay')!.clips[0]!.id])).toBe(false);
  });
});
