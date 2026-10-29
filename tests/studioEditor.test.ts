import { describe, expect, it } from 'vitest';
import { applyEdits, describeProject, exportSize, volumeAt, newProject, projectDuration, type Asset, type AudioClip, type MediaClip, type Project } from '../src/shared/studio';

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

describe('Speed curves, backdrop and effects', () => {
  it('a speed curve keeps the same part of the source and splits without a jump', async () => {
    const { curveArea, sourceSpan } = await import('../src/shared/studio');
    let p = withClip();
    const id = videos(p)[0]!.id;
    // 8 s of source (from 1 s) on the hero curve.
    p = applyEdits(p, [{ op: 'set', clip: id, speedCurve: 'hero' }], { rand }).project;
    const c = videos(p)[0]!;
    expect(c.speed).toBe(1);
    expect(sourceSpan(c, c.duration)).toBeCloseTo(8, 2);
    expect(c.duration).toBeCloseTo(8 / curveArea(c.speedCurve!, 0, 1), 2);
    // Splitting: the second part starts exactly where the first one ends in the source.
    const at = c.duration * 0.55;
    const whereInSource = c.in + sourceSpan(c, at);
    p = applyEdits(p, [{ op: 'split', clip: id, at }], { rand }).project;
    const [a, b] = videos(p);
    expect(b!.in).toBeCloseTo(whereInSource, 2);
    expect(a!.in + sourceSpan(a!, a!.duration)).toBeCloseTo(whereInSource, 2);
    expect(b!.in + sourceSpan(b!, b!.duration)).toBeCloseTo(9, 2);
    // Back to steady speed: the same 8 s of source again.
    const steady = applyEdits(withClip(), [{ op: 'set', clip: id, speedCurve: 'montage' }, { op: 'set', clip: id, speedCurve: null }], { rand }).project;
    expect(videos(steady)[0]!.duration).toBeCloseTo(8, 2);
    expect(() => applyEdits(p, [{ op: 'detach_audio', clip: a!.id }], { rand })).toThrow(/speed curve/);
  });

  it('backdrop and effects are clip settings', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    let a = applyEdits(p, [{ op: 'set', clip: id, fit: 'contain', backdrop: 'blur', effects: { grain: 0.4, vhs: 0.6 } }], { rand }).project;
    expect(videos(a)[0]).toMatchObject({ fit: 'contain', backdrop: 'blur', effects: { grain: 0.4, vhs: 0.6 } });
    a = applyEdits(a, [{ op: 'set', clip: id, effects: { grain: null, glow: 0.5 } }], { rand }).project;
    expect(videos(a)[0]!.effects).toEqual({ vhs: 0.6, glow: 0.5 });
    a = applyEdits(a, [{ op: 'set', clip: id, effects: null, backdrop: null }], { rand }).project;
    expect(videos(a)[0]!.effects).toBeUndefined();
    expect(videos(a)[0]!.backdrop).toBeUndefined();
  });
});

describe('Green screen and quiet the gaps', () => {
  it('green screen settings merge, and null removes them', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    let a = applyEdits(p, [{ op: 'set', clip: id, chroma: { color: '#00FF00' } }], { rand }).project;
    expect(videos(a)[0]!.chroma).toEqual({ color: '#00FF00', similarity: 0.4, smoothness: 0.25, spill: 0.5 });
    a = applyEdits(a, [{ op: 'set', clip: id, chroma: { similarity: 0.6 } }], { rand }).project;
    expect(videos(a)[0]!.chroma?.similarity).toBe(0.6);
    a = applyEdits(a, [{ op: 'set', clip: id, chroma: null }], { rand }).project;
    expect(videos(a)[0]!.chroma).toBeUndefined();
  });

  it('the gate opens for the clip’s own speech and closes in the gaps', async () => {
    const { clipSpeech, gateGain } = await import('../src/shared/studio');
    const p = withClip();
    const withSpeech = { ...p, assets: [{ ...vid, speech: [{ start: 2, end: 3 }, { start: 6, end: 7 }] }] };
    const c = videos(withSpeech)[0]!;
    // The clip starts 1 s into its video: speech at 1–2 s and 5–6 s on the timeline.
    const spans = clipSpeech(withSpeech, c);
    expect(spans).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    const low = Math.pow(10, -18 / 20);
    expect(gateGain(spans, 1.5, -18)).toBe(1);
    expect(gateGain(spans, 3.5, -18)).toBeCloseTo(low, 5);
    expect(gateGain(spans, 2.1, -18)).toBeGreaterThan(low);
    const gated = applyEdits(p, [{ op: 'set', clip: c.id, gate: -18 }], { rand }).project;
    expect(videos(gated)[0]!.gate).toBe(-18);
  });
});

describe('Studio editing: mirror, blend, voice changer, locked tracks', () => {
  it('flips, blends and changes the voice, and says so to Keo', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const a = applyEdits(p, [{ op: 'set', clip: id, flipX: true, blend: 'screen', voiceFx: 'robot' }], { rand }).project;
    expect(videos(a)[0]).toMatchObject({ flipX: true, blend: 'screen', voiceFx: 'robot' });
    expect(describeProject(a)).toMatch(/voice robot blend screen flipped/);
    // Back to normal: the fields go away.
    const b = applyEdits(a, [{ op: 'set', clip: id, flipX: false, blend: 'normal', voiceFx: null }], { rand }).project;
    expect(videos(b)[0]).not.toHaveProperty('flipX');
    expect(videos(b)[0]).not.toHaveProperty('blend');
    expect(videos(b)[0]).not.toHaveProperty('voiceFx');
    // The voice changer goes with the sound when it is detached.
    const c = applyEdits(a, [{ op: 'detach_audio', clip: id }], { rand }).project;
    expect((c.tracks.find((t) => t.name === 'Detached audio')!.clips[0] as AudioClip).voiceFx).toBe('robot');
  });

  it('a video without sound cannot get a voice changer', () => {
    n = 0;
    const silent = { ...vid, hasAudio: false };
    const p = applyEdits({ ...newProject({ name: 'S', rand }), assets: [silent] }, [{ op: 'add_media', assetId: silent.id, start: 0, duration: 4 }], { rand }).project;
    expect(() => applyEdits(p, [{ op: 'set', clip: videos(p)[0]!.id, voiceFx: 'deep' }], { rand })).toThrow(/no sound/);
  });

  it('a locked track’s clips cannot be changed until it is unlocked', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const track = p.tracks.find((t) => t.name === 'Video')!.id;
    const locked = applyEdits(p, [{ op: 'set_track', track, locked: true }], { rand }).project;
    expect(describeProject(locked)).toMatch(/\(locked\)/);
    for (const op of [{ op: 'move', clip: id, start: 3 }, { op: 'delete', clip: id }, { op: 'set', clip: id, volume: 0.5 }, { op: 'add_media', assetId: vid.id, start: 9, duration: 1, track }] as const)
      expect(() => applyEdits(locked, [op], { rand })).toThrow(/locked/);
    const open = applyEdits(locked, [{ op: 'set_track', track, locked: false }, { op: 'move', clip: id, start: 3 }], { rand }).project;
    expect(videos(open)[0]!.start).toBe(3);
  });
});

describe('Studio editing: volume keyframes', () => {
  it('the volume follows its keyframes, split keeps the curve, Keo sees it', () => {
    const p = withClip();
    const id = videos(p)[0]!.id;
    const keys = [
      { at: 0, value: 1, ease: 'linear' as const },
      { at: 4, value: 0.2, ease: 'linear' as const },
    ];
    const a = applyEdits(p, [{ op: 'set', clip: id, volumeKeys: keys }], { rand }).project;
    const c = videos(a)[0]!;
    expect(volumeAt(c, 2)).toBeCloseTo(0.6);
    expect(volumeAt(c, 6)).toBeCloseTo(0.2);
    expect(describeProject(a)).toMatch(/volume keys 0s:1 4s:0.2/);
    // Split at 2 s: the second part starts at the volume it was at there.
    const b = applyEdits(a, [{ op: 'split', clip: id, at: 2 }], { rand }).project;
    const second = videos(b)[1]!;
    expect(volumeAt(second, 0)).toBeCloseTo(0.6);
    expect(volumeAt(second, 2)).toBeCloseTo(0.2);
    expect(() => applyEdits(p, [{ op: 'set', clip: id, volumeKeys: [{ at: 0, value: 9, ease: 'linear' }] }], { rand })).toThrow(/0 \(silent\) to 4/);
    expect(videos(applyEdits(a, [{ op: 'set', clip: id, volumeKeys: null }], { rand }).project)[0]).not.toHaveProperty('volumeKeys');
  });
});

describe('Studio editing: adjustment layers', () => {
  it('sits above the videos and graphics, under titles, and can be tuned', () => {
    let p = withClip();
    p = applyEdits(p, [{ op: 'add_text', text: 'Title', start: 0, duration: 2 }, { op: 'add_shape', shape: 'rect', start: 0, duration: 2 }], { rand }).project;
    p = applyEdits(p, [{ op: 'add_adjust', start: 1, duration: 3, color: { saturation: -1 }, effects: { grain: 0.4 } }], { rand }).project;
    expect(p.tracks.map((t) => t.name)).toEqual(['Video', 'Graphics', 'Adjustments', 'Text', 'Audio']);
    const id = p.tracks[2]!.clips[0]!.id;
    expect(p.tracks[2]!.clips[0]).toMatchObject({ type: 'adjust', start: 1, duration: 3, strength: 1, blur: 0, color: { saturation: -1 }, effects: { grain: 0.4 } });
    p = applyEdits(p, [{ op: 'set', clip: id, blur: 4, strength: 0.5, fadeIn: 0.5, effects: { grain: null, vhs: 0.3 } }], { rand }).project;
    expect(p.tracks[2]!.clips[0]).toMatchObject({ blur: 4, strength: 0.5, fadeIn: 0.5, effects: { vhs: 0.3 } });
    expect(describeProject(p)).toMatch(/adjustment layer colour saturation -1 effects vhs 0.3 blur 4 strength 0.5/);
    // Blur and strength are for adjustment layers only.
    expect(() => applyEdits(p, [{ op: 'set', clip: videos(p)[0]!.id, strength: 0.2 }], { rand })).toThrow(/strength/);
    // Cutting time moves it like any clip.
    p = applyEdits(p, [{ op: 'cut_range', from: 0, to: 0.5 }], { rand }).project;
    expect(p.tracks[2]!.clips[0]!.start).toBe(0.5);
  });
});
