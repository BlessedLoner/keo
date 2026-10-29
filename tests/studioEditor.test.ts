import { describe, expect, it } from 'vitest';
import { applyEdits, exportSize, newProject, projectDuration, type Asset, type AudioClip, type MediaClip, type Project } from '../src/shared/studio';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const vid: Asset = { id: 'as_video001', kind: 'video', path: 'C:\\v\\a.mp4', name: 'a.mp4', duration: 10, width: 1080, height: 1920, hasAudio: true };

function withClip(): Project {
  n = 0;
  return applyEdits({ ...newProject({ name: 'E', rand }), assets: [vid] }, [{ op: 'add_media', assetId: vid.id, start: 0, duration: 8, in: 1 }], { rand }).project;
}
const videos = (p: Project) => p.tracks.find((t) => t.name === 'Video')!.clips as MediaClip[];

describe('Studio editing: duplicate, detach, freeze', () => {
  it('duplicates after the clip, or where asked', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const a = applyEdits(p, [{ op: 'duplicate', clip: id }], { rand }).project;
    expect(videos(a).map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 8, 1],
      [8, 8, 1],
    ]);
    const b = applyEdits(p, [{ op: 'duplicate', clip: id, start: 20 }], { rand }).project;
    expect(videos(b)[1]!.start).toBe(20);
  });

  it('detaches a video’s sound onto its own track, once', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const a = applyEdits(p, [{ op: 'detach_audio', clip: id }], { rand }).project;
    expect(videos(a)[0]!.volume).toBe(0);
    const s = a.tracks.find((t) => t.name === 'Detached audio')!.clips[0] as AudioClip;
    expect([s.start, s.duration, s.in, s.volume]).toEqual([0, 8, 1, 1]);
    expect(() => applyEdits(a, [{ op: 'detach_audio', clip: id }], { rand })).toThrow(/already off or detached/);
  });

  it('freezes a frame and moves the rest later', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const a = applyEdits(p, [{ op: 'freeze', clip: id, at: 3, duration: 2 }], { rand }).project;
    const v = videos(a);
    expect(v.map((c) => [c.start, c.duration, c.in, !!c.freeze])).toEqual([
      [0, 3, 1, false],
      [3, 2, 4, true],
      [5, 5, 4, false],
    ]);
    expect(projectDuration(a)).toBe(10);
    expect(v[1]!.volume).toBe(0);
  });
});

describe('Export sizes', () => {
  it('keeps the project’s shape at the chosen resolution', () => {
    const vertical = { width: 1080, height: 1920, fps: 30 };
    expect(exportSize(vertical, { resolution: 'project', fps: 'project' })).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(exportSize(vertical, { resolution: '720', fps: 60 })).toEqual({ width: 720, height: 1280, fps: 60 });
    expect(exportSize({ width: 1920, height: 1080, fps: 25 }, { resolution: '2160', fps: 'project' })).toEqual({ width: 3840, height: 2160, fps: 25 });
    expect(exportSize({ width: 1080, height: 1350, fps: 30 }, { resolution: '720', fps: 'project' })).toEqual({ width: 720, height: 900, fps: 30 });
  });
});

describe('Transitions and crop', () => {
  it('a transition shows both clips around the cut, and a split starts clean', async () => {
    const { trackTransition } = await import('../src/shared/studio');
    let p = withClip();
    const id = videos(p)[0]!.id;
    p = applyEdits(p, [{ op: 'split', clip: id, at: 4 }], { rand }).project;
    const second = videos(p)[1]!;
    p = applyEdits(p, [{ op: 'set', clip: second.id, transition: { kind: 'crossfade', seconds: 1 } }], { rand }).project;
    const track = p.tracks.find((t) => t.name === 'Video')!;
    expect(trackTransition(track, 3.4)).toBeNull();
    const mid = trackTransition(track, 4)!;
    expect([mid.out.id, mid.in.id, mid.kind]).toEqual([id, second.id, 'crossfade']);
    expect(mid.p).toBeCloseTo(0.5, 5);
    expect(trackTransition(track, 4.49)!.p).toBeCloseTo(0.99, 2);
    expect(trackTransition(track, 4.5)).toBeNull();
    // Splitting the second clip: its new second half has no transition of its own.
    p = applyEdits(p, [{ op: 'split', clip: second.id, at: 6 }], { rand }).project;
    expect(videos(p).map((c) => c.transition?.kind ?? null)).toEqual([null, 'crossfade', null]);
    expect(() => applyEdits(p, [{ op: 'set', clip: id, transition: { kind: 'zoom', seconds: 0.5 } }], { rand })).not.toThrow();
  });

  it('crops a video, and a crop of nothing goes away', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const a = applyEdits(p, [{ op: 'set', clip: id, crop: { left: 0.1, bottom: 0.2 } }], { rand }).project;
    expect(videos(a)[0]!.crop).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0.2 });
    const b = applyEdits(a, [{ op: 'set', clip: id, crop: { left: 0, bottom: 0 } }], { rand }).project;
    expect(videos(b)[0]!.crop).toBeUndefined();
    expect(() => applyEdits(p, [{ op: 'set', clip: id, crop: { left: 0.6 } }], { rand })).toThrow();
  });
});
