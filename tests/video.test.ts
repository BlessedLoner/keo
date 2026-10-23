import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mentions } from '../src/main/capabilities/video';
import { Logger } from '../src/main/logging/logger';
import { channelAllowed } from '../src/main/ipc/roles';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { detectBeats, lastError, locateFfmpeg, parseProbe, parseSceneScores, pickEncoder, shotsFromCuts } from '../src/main/video/ffmpeg';
import {
  applyDirection,
  buildRecipe,
  captionCues,
  cutInto,
  dimensions,
  editLabel,
  nearestAspect,
  parseDirection,
  RecipeError,
  RecipeSchema,
  round2,
  shotStarts,
  snapToBeats,
  sourceSeconds,
  totalSeconds,
  type ClipInfo,
  type Recipe,
  type TemplateAnalysis,
} from '../src/main/video/recipe';
import { assColour, assText, assTime, buildAss, buildRenderPlan, speedFilter, xfadeName, zoomFilter } from '../src/main/video/render';
import { momentsOf, NO_FFMPEG, parseStyle, pickFrameTimes, safeName, VideoStudio } from '../src/main/video/studio';
import { FakeFfmpeg } from './fakeFfmpeg';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

function clip(id: string, durationSec: number, over: Partial<ClipInfo> = {}): ClipInfo {
  return { id, file: `C:\\clips\\${id}.mp4`, name: `${id}.mp4`, durationSec, width: 1080, height: 1920, fps: 30, hasAudio: true, moments: [{ startSec: 1, durationSec: 2, score: 1 }], words: null, description: null, ...over };
}

function template(over: Partial<TemplateAnalysis> = {}): TemplateAnalysis {
  return {
    id: 't_1',
    file: 'C:\\t.mp4',
    durationSec: 10,
    width: 1080,
    height: 1920,
    fps: 30,
    aspect: '9:16',
    hasAudio: true,
    shots: [
      { startSec: 0, durationSec: 2 },
      { startSec: 2, durationSec: 3 },
      { startSec: 5, durationSec: 5 },
    ],
    beats: [],
    tempoBpm: null,
    style: null,
    styleNote: null,
    ...over,
  };
}

const clipsMap = (cs: ClipInfo[]) => new Map(cs.map((c) => [c.id, c]));

// ------------------------------------------------------------------ recipe

describe('edit recipe', () => {
  it('follows the template rhythm, scaled to the target length, with a different clip per shot', () => {
    const r = buildRecipe(template(), [clip('c1', 20), clip('c2', 20), clip('c3', 20)], { targetSeconds: 20 });
    expect(r.shots.map((s) => s.durationSec)).toEqual([4, 6, 10]);
    expect(new Set(r.shots.map((s) => s.clipId)).size).toBe(3);
    expect(r.aspect).toBe('9:16');
    expect(totalSeconds(r)).toBe(20);
    // No words in the clips: captions are off, with a note saying why.
    expect(r.captions.enabled).toBe(false);
    expect(r.notes.join(' ')).toMatch(/no transcribed speech/i);
  });

  it('moves cuts onto nearby beats', () => {
    expect(snapToBeats([2, 3, 5], [0, 0.5, 1, 1.5, 2.1, 2.6, 3.1, 3.6, 4.1, 4.6, 5.1], 10)).toEqual([2.1, 3, 4.9]);
  });

  it('uses the template pace when it has no cuts, and the shortest clips as they are', () => {
    const r = buildRecipe(template({ shots: [{ startSec: 0, durationSec: 10 }], style: { ...style(), pacing: 'fast' } }), [clip('c1', 1)], { targetSeconds: 6 });
    expect(r.shots.length).toBe(5);
    expect(r.shots.every((s) => s.durationSec <= 1)).toBe(true);
    expect(r.notes.join(' ')).toMatch(/shorter than the template/);
  });

  it('refuses when no clip is usable', () => {
    expect(() => buildRecipe(null, [clip('c1', 0.2)])).toThrow(RecipeError);
  });

  it('rejects unknown fields and bad values', () => {
    const r = buildRecipe(null, [clip('c1', 20)]);
    expect(RecipeSchema.safeParse({ ...r, ffmpeg: '-i x' }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...r, shots: [{ ...r.shots[0], clipId: '../x' }] }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...r, texts: [{ text: 'x', startSec: 2, endSec: 1 }] }).success).toBe(false);
  });

  it('puts the words of each shot on the video timeline (speed and start taken into account)', () => {
    const c1 = clip('c1', 20, { words: [w(1.0, 1.3, 'hello'), w(1.4, 1.8, 'there'), w(1.9, 2.2, 'friend'), w(9, 9.5, 'later')] });
    const r = RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [{ clipId: 'c1', inSec: 5, durationSec: 2 }, { clipId: 'c1', inSec: 1, durationSec: 2, speed: 2 }], captions: { enabled: true, maxWordsPerLine: 2 } });
    expect(captionCues(r, clipsMap([c1]))).toEqual([
      { startSec: 2, endSec: 2.4, text: 'hello there' },
      { startSec: 2.45, endSec: 2.7, text: 'friend' }, // shown at least 0.25 s
    ]);
  });
});

const w = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });
function style() {
  return { textOverlays: [], captions: { present: true, position: 'center' as const, sizePct: 7, color: '#FFEE00', uppercase: true, wordsPerLine: 2 }, palette: ['#FF0055'], hook: null, pacing: 'medium' as const, transitions: 'fade' as const, notes: '' };
}

// ------------------------------------------------------------------ live direction

describe('live direction', () => {
  const base = (): { r: Recipe; clips: Map<string, ClipInfo> } => {
    const cs = [clip('c1', 12, { words: [w(1, 1.5, 'hi')] }), clip('c2', 6), clip('c3', 30)];
    return { r: buildRecipe(template(), cs, { targetSeconds: 10, captions: true }), clips: clipsMap(cs) };
  };

  it('understands “shorter intro and bigger captions” without the model', () => {
    const { r, clips } = base();
    const ops = parseDirection('Please make the intro shorter and bigger captions.', r)!;
    expect(ops).toEqual([{ op: 'trim_start', seconds: 0.8 }, { op: 'captions', sizePct: 7.15 }]);
    const out = applyDirection(r, ops, clips);
    expect(out.recipe.shots[0]!.durationSec).toBe(1.2);
    expect(out.recipe.shots[0]!.inSec).toBe(r.shots[0]!.inSec + 0.8);
    expect(out.recipe.captions.sizePct).toBe(7.15);
    expect(out.changes).toEqual(['Intro 0.8 s shorter', 'Captions: sizePct']);
  });

  it('understands lengths, formats and music, and leaves anything else to the model', () => {
    const { r } = base();
    expect(parseDirection('make it 20 seconds', r)).toEqual([{ op: 'set_length', seconds: 20 }]);
    expect(parseDirection('vertical', r)).toEqual([{ op: 'aspect', aspect: '9:16' }]);
    expect(parseDirection('captions at the top', r)).toEqual([{ op: 'captions', position: 'top' }]);
    expect(parseDirection('no captions', r)).toEqual([{ op: 'captions', enabled: false }]);
    // No music in this video: not understood here (the model explains).
    expect(parseDirection('louder music', r)).toBeNull();
    expect(parseDirection('shorter intro and swap the dog clip for the beach one', r)).toBeNull();
  });

  it('never makes a shot longer than its clip allows', () => {
    const { r, clips } = base();
    const out = applyDirection(r, [{ op: 'set_length', seconds: 60 }], clips);
    for (const s of out.recipe.shots) expect(s.inSec + s.durationSec * s.speed).toBeLessThanOrEqual(clips.get(s.clipId)!.durationSec + 0.01);
    expect(out.changes[0]).toMatch(/not long enough/);
  });

  it('changes nothing when one change in the set is impossible', () => {
    const { r, clips } = base();
    const before = structuredClone(r);
    expect(() => applyDirection(r, [{ op: 'captions', sizePct: 9 }, { op: 'remove_shot', index: 9 }], clips)).toThrow(/Nothing was changed/);
    expect(r).toEqual(before);
    expect(() => applyDirection(r, [{ op: 'swap_clip', index: 0, clipId: 'c9' }], clips)).toThrow(/no clip c9/);
    expect(() => applyDirection(r, [{ op: 'music_volume', volume: 1 }], clips)).toThrow(/no music/);
  });

  it('swaps, moves, slows and adds text', () => {
    const { r, clips } = base();
    const out = applyDirection(
      r,
      [
        { op: 'swap_clip', index: 1, clipId: 'c3', inSec: 10 },
        { op: 'move_shot', from: 2, to: 0 },
        { op: 'speed', index: null, speed: 0.5 },
        { op: 'add_text', text: 'Summer {\\b1} trip', startSec: 0, endSec: 99 },
      ],
      clips,
    );
    expect(out.recipe.shots[2]!.clipId).toBe('c3');
    expect(out.recipe.shots.every((s) => s.speed === 0.5)).toBe(true);
    expect(out.recipe.texts[0]!.endSec).toBeLessThanOrEqual(totalSeconds(out.recipe));
  });
});

// ------------------------------------------------------------------ ffmpeg helpers

describe('ffmpeg helpers', () => {
  it('reads probes, including phone videos stored sideways', () => {
    const p = parseProbe(JSON.stringify({ format: { duration: '12.5' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30000/1001', tags: { rotate: '90' } }, { codec_type: 'audio', codec_name: 'aac' }] }));
    expect(p).toMatchObject({ durationSec: 12.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true, hasVideo: true });
    expect(nearestAspect(p.width, p.height)).toBe('9:16');
    expect(nearestAspect(1280, 720)).toBe('16:9');
    expect(() => parseProbe('not json')).toThrow();
    expect(p.audioDurationSec).toBeNull();
    expect(parseProbe(JSON.stringify({ format: { duration: '6' }, streams: [{ codec_type: 'audio', duration: '2.21' }] })).audioDurationSec).toBe(2.21);
  });

  it('reads scene changes and turns cuts into shots', () => {
    const log = '[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:1.5\n[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.61\nother\n[Parsed_metadata_2 @ 0x1] frame:1 pts:2 pts_time:4.04\n[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.40';
    expect(parseSceneScores(log)).toEqual([
      { t: 1.5, score: 0.61 },
      { t: 4.04, score: 0.4 },
    ]);
    expect(shotsFromCuts([1.5, 1.6, 4.04], 6)).toEqual([
      { startSec: 0, durationSec: 1.6 },
      { startSec: 1.6, durationSec: 2.44 },
      { startSec: 4.04, durationSec: 1.96 },
    ]);
  });

  it('finds the beat of a steady 120 BPM click', () => {
    const rate = 11025;
    const pcm = new Int16Array(rate * 8);
    for (let b = 0.25; b < 8; b += 0.5) for (let k = 0; k < 300; k++) pcm[Math.floor(b * rate) + k] = Math.round(20000 * Math.exp(-k / 60) * (k % 2 ? 1 : -1));
    const r = detectBeats(pcm, rate);
    expect(r.bpm).toBeGreaterThanOrEqual(115);
    expect(r.bpm).toBeLessThanOrEqual(125);
    expect(r.onsets.length).toBeGreaterThanOrEqual(14);
    expect(Math.abs(r.beats[1]! - r.beats[0]! - 0.5)).toBeLessThan(0.05);
    // On the clicks themselves (0.25, 0.75, …), without drifting over 8 seconds.
    expect(r.bpm).toBe(120);
    const offClick = (b: number) => Math.abs(b - 0.25 - 0.5 * Math.round((b - 0.25) / 0.5));
    for (const b of r.beats) expect(offClick(b)).toBeLessThan(0.03);
    expect(detectBeats(new Int16Array(100))).toEqual({ onsets: [], beats: [], bpm: null });
  });

  it('finds ffmpeg from the chosen file or PATH, never anything else', () => {
    const files = new Set(['D:\\tools\\ffmpeg.exe', 'D:\\tools\\ffprobe.exe', 'E:\\bin\\ffmpeg.exe', 'E:\\bin\\ffprobe.exe', 'F:\\x\\ffmpeg.exe']);
    const exists = (p: string) => files.has(p);
    if (process.platform !== 'win32') return;
    expect(locateFfmpeg('D:\\tools\\ffmpeg.exe', '', exists)).toMatchObject({ source: 'settings', ffprobe: 'D:\\tools\\ffprobe.exe' });
    expect(locateFfmpeg('D:\\tools\\evil.exe', '', exists)).toBeNull();
    expect(locateFfmpeg('F:\\x\\ffmpeg.exe', 'E:\\bin', exists)).toBeNull(); // no ffprobe beside it, and PATH is not used instead
    expect(locateFfmpeg(null, 'C:\\nothing;"E:\\bin"', exists)).toMatchObject({ source: 'path', ffmpeg: 'E:\\bin\\ffmpeg.exe' });
    expect(locateFfmpeg(null, 'C:\\nothing', exists)).toBeNull();
  });

  it('prefers libx264 and falls back to LGPL-build encoders', () => {
    expect(pickEncoder({ encoders: new Set(['h264_mf', 'libx264']), filters: new Set() })).toBe('libx264');
    expect(pickEncoder({ encoders: new Set(['aac', 'h264_mf', 'h264_nvenc']), filters: new Set() })).toBe('h264_mf');
    expect(pickEncoder({ encoders: new Set(['aac']), filters: new Set() })).toBeNull();
  });

  it('reports the useful error line', () => {
    expect(lastError('ffmpeg version 7\nInput #0\nclip.mp4: Invalid data found when processing input\n')).toBe('clip.mp4: Invalid data found when processing input');
  });
});

// ------------------------------------------------------------------ render plan

describe('render plan', () => {
  const cs = [clip('c1', 12, { words: [w(1.2, 1.6, 'hello')] }), clip('c2', 8, { hasAudio: false })];
  const recipe = (over: Record<string, unknown> = {}) =>
    RecipeSchema.parse({
      title: 'Trip; rm -rf "x"',
      aspect: '9:16',
      shots: [
        { clipId: 'c1', inSec: 1, durationSec: 2 },
        { clipId: 'c2', inSec: 0, durationSec: 3 },
      ],
      texts: [{ text: "It's 'ok'; [x] {\\b1}", startSec: 0, endSec: 2 }],
      captions: { enabled: true },
      ...over,
    });

  it('cuts, scales to fill the frame, fills silence and keeps user text out of the arguments', () => {
    const p = buildRenderPlan(recipe(), clipsMap(cs), { preview: true, outFile: 'C:\\w\\p.mp4', encoder: 'libx264', subtitlesFilter: true });
    expect(p).toMatchObject({ width: 360, height: 640, durationSec: 5 });
    const graph = p.args[p.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('scale=360:640:force_original_aspect_ratio=increase,crop=360:640');
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(graph).not.toContain('[1:a]'); // c2 has no sound: silence there
    expect(graph).toContain('subtitles=keo-text.ass');
    expect(p.args.join(' ')).not.toMatch(/Trip|ok'|rm -rf/);
    expect(p.args.slice(-1)[0]).toBe('C:\\w\\p.mp4');
    expect(p.args).toContain('ultrafast');
    expect(p.ass).toContain('Dialogue: 1,0:00:00.00,0:00:02.00,T0,,0,0,0,,It\'s \'ok\'; [x] (/b1)');
    expect(p.ass).toContain(',Caption,,0,0,0,,hello');
  });

  it('chains transitions with the right offsets and mixes the music under the clips', () => {
    const p = buildRenderPlan(recipe({ transition: { kind: 'fade', seconds: 0.5 }, music: { path: 'C:\\m\\song.mp3', volume: 0.7 }, clipVolume: 0.3 }), clipsMap(cs), { preview: false, outFile: 'o.mp4', encoder: 'h264_mf', subtitlesFilter: true });
    const graph = p.args[p.args.indexOf('-filter_complex') + 1]!;
    // First shot is 2 s + 0.5 s of overlap; the fade starts at 2 s. Total stays 5 s.
    expect(graph).toContain('xfade=transition=fade:duration=0.500:offset=2.000');
    // The sound crossfades with the picture.
    expect(graph).toContain('afade=t=out:st=2.000:d=0.500');
    expect(graph).toContain('[aj]volume=0.3[ac]');
    expect(graph).toContain('amix=inputs=2:duration=first');
    expect(p.durationSec).toBe(5);
    expect(p.args).toContain('C:\\m\\song.mp3');
    expect(p.args).toContain('h264_mf');
    expect(p).toMatchObject({ width: 1080, height: 1920 });
  });

  it('leaves text out (with a note) when ffmpeg cannot draw it', () => {
    const p = buildRenderPlan(recipe(), clipsMap(cs), { preview: true, outFile: 'o.mp4', encoder: 'mpeg4', subtitlesFilter: false });
    expect(p.ass).toBeNull();
    expect(p.notes.join(' ')).toMatch(/no subtitles filter/);
  });

  it('writes ASS colours, times and text safely', () => {
    expect(assColour('#FF8800')).toBe('&H000088FF');
    expect(assTime(3725.456)).toBe('1:02:05.46');
    expect(assText('a{\\pos(1,1)}b\nc')).toBe('a(/pos(1,1))b c');
    const ass = buildAss(recipe(), [], 1080, 1920);
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toMatch(/Style: Caption,Arial Black,106,/);
  });

  it('sizes previews small and finals full', () => {
    expect(dimensions('16:9', true)).toEqual({ width: 640, height: 360 });
    expect(dimensions('4:5', false)).toEqual({ width: 1080, height: 1350 });
  });
});

// ------------------------------------------------------------------ editing like an editor

describe('editing per cut', () => {
  const grid = (to: number, step = 0.5) => Array.from({ length: Math.round(to / step) + 1 }, (_, i) => round2(i * step));
  const graphOf = (p: { args: string[] }) => p.args[p.args.indexOf('-filter_complex') + 1]!;
  const two = [clip('c1', 12), clip('c2', 12)];

  it('keeps old recipes valid: one transition for every cut, rendered as before', () => {
    // A recipe saved by Keo 1.12 (no per-cut fields, no beats, no style).
    const old = RecipeSchema.parse({
      schema: 1,
      title: 'Old',
      aspect: '9:16',
      fps: 30,
      shots: [
        { clipId: 'c1', inSec: 0, durationSec: 2, speed: 1 },
        { clipId: 'c2', inSec: 0, durationSec: 2, speed: 1 },
        { clipId: 'c1', inSec: 4, durationSec: 2, speed: 1 },
      ],
      transition: { kind: 'fade', seconds: 0.3 },
      texts: [],
      music: null,
      clipVolume: 1,
      notes: [],
    });
    expect(old.beats).toEqual([]);
    expect(old.style).toBe('');
    expect(cutInto(old, 0)).toEqual({ kind: 'cut', seconds: 0 });
    expect(cutInto(old, 1)).toEqual({ kind: 'fade', seconds: 0.3 });
    expect(editLabel(old, 2)).toBe('fade in');
    const graph = graphOf(buildRenderPlan(old, clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true }));
    expect(graph).toContain('xfade=transition=fade:duration=0.300:offset=2.000');
    expect(graph).toContain('xfade=transition=fade:duration=0.300:offset=4.000');
    // The old change "use fades / hard cuts" still means every cut.
    const out = applyDirection(old, [{ op: 'transition', kind: 'cut' }], clipsMap(two));
    expect(out.recipe.shots.map((_, i) => cutInto(out.recipe, i).kind)).toEqual(['cut', 'cut', 'cut']);
    expect(graphOf(buildRenderPlan(out.recipe, clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true }))).not.toContain('xfade');
  });

  it('validates the new edit fields strictly', () => {
    const shot = { clipId: 'c1', inSec: 0, durationSec: 2 };
    const ok = (s: Record<string, unknown>) => RecipeSchema.safeParse({ title: 't', aspect: '9:16', shots: [shot, { ...shot, ...s }] }).success;
    expect(ok({ transition: { kind: 'whip' }, zoom: { kind: 'punch', atSec: 1 }, ramp: { atSec: 1, speed: 0.5 }, audio: { kind: 'l', seconds: 0.3 } })).toBe(true);
    expect(ok({ transition: { kind: 'spin' } })).toBe(false);
    expect(ok({ ramp: { atSec: 2.5, speed: 1 } })).toBe(false); // after the shot ends
    expect(ok({ zoom: { kind: 'punch', atSec: 3 } })).toBe(false);
    expect(ok({ zoom: { kind: 'punch', amount: 3 } })).toBe(false);
    expect(ok({ audio: { kind: 'x', seconds: 0.3 } })).toBe(false);
    expect(ok({ zoom: { kind: 'push', filter: 'crop' } })).toBe(false);
    // Quick transitions stay quick.
    const r = RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [shot, { ...shot, transition: { kind: 'flash', seconds: 1 } }] });
    expect(cutInto(r, 1)).toEqual({ kind: 'flash', seconds: 0.2 });
  });

  it('plans hard cuts on the beat, with punch-ins on beats, matching a fast template', () => {
    const t = template({ durationSec: 6, shots: [1, 1.5, 1, 1.5, 1].map((d, i, a) => ({ startSec: a.slice(0, i).reduce((x, y) => x + y, 0), durationSec: d })) });
    const r = buildRecipe(t, [clip('c1', 20), clip('c2', 20), clip('c3', 20)], { music: { path: 'C:\\m\\song.mp3', beats: grid(8), bpm: 120 } });
    expect(r.transition.kind).toBe('cut');
    expect(r.shots.every((s) => !s.transition)).toBe(true);
    const starts = shotStarts(r);
    for (const st of starts) expect(r.beats).toContain(st);
    const punches = r.shots.map((s, i) => ({ s, i })).filter(({ s }) => s.zoom?.kind === 'punch');
    expect(punches.length).toBe(2);
    for (const { s, i } of punches) expect(r.beats).toContain(round2(starts[i]! + s.zoom!.atSec));
    expect(r.shots.slice(1).every((s) => /hard cut on the beat/.test(s.why ?? ''))).toBe(true);
    expect(r.style).toMatch(/^Hard cuts on the beat \(120 BPM\), matching the template’s fast pace \(1\.2 s a shot\)/);
    expect(r.style).toMatch(/2 punch-ins/);
    expect(RecipeSchema.parse(r)).toEqual(r);
  });

  it('uses the template’s stylised transition only where it fits, never on every cut', () => {
    const nine = template({ durationSec: 9, shots: Array.from({ length: 9 }, (_, i) => ({ startSec: i, durationSec: 1 })), style: { ...style(), transitions: 'whip', pacing: 'fast' } });
    const r = buildRecipe(nine, [clip('c1', 30), clip('c2', 30)]);
    const kinds = r.shots.map((_, i) => cutInto(r, i).kind).slice(1);
    expect(kinds.filter((k) => k === 'whip').length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === 'whip').length).toBeLessThanOrEqual(2);
    expect(kinds.filter((k) => k === 'cut').length).toBeGreaterThanOrEqual(6);
    expect(r.style).toMatch(/^Mostly hard cuts/);

    // A soft template look goes into the slower moment only.
    const soft = buildRecipe(template({ durationSec: 6.5, shots: [1, 1, 1, 3.5].map((d, i) => ({ startSec: i, durationSec: d })), style: style() }), [clip('c1', 30), clip('c2', 30)]);
    expect(soft.shots.map((_, i) => cutInto(soft, i).kind)).toEqual(['cut', 'cut', 'cut', 'fade']);
    expect(soft.shots[3]!.why).toMatch(/fade into a slower moment/);

    // Asked for one look everywhere: that is what it gets.
    const asked = buildRecipe(nine, [clip('c1', 30)], { transition: 'fade' });
    expect(asked.transition.kind).toBe('fade');
    expect(asked.style).toMatch(/Every cut is a fade, as asked/);
  });

  it('plans a speed ramp and an L-cut where speech carries over', () => {
    const ramp = buildRecipe(template({ durationSec: 8, shots: [2, 2, 2, 2].map((d, i) => ({ startSec: i * 2, durationSec: d })) }), [clip('c1', 20), clip('c2', 20)], { music: { path: 'C:\\m\\s.mp3', beats: grid(9) } });
    const ramped = ramp.shots.filter((s) => s.ramp);
    expect(ramped.length).toBe(1);
    expect(ramped[0]).toMatchObject({ speed: 1.8, ramp: { speed: 1 } });
    expect(ramped[0]!.why).toMatch(/speed ramp 1\.8× → 1× landing on the beat/);
    // The ramp uses more footage, and the clip has it.
    expect(ramped[0]!.inSec + sourceSeconds(ramped[0]!)).toBeLessThanOrEqual(20);

    const talk = buildRecipe(template({ durationSec: 4, shots: [{ startSec: 0, durationSec: 2 }, { startSec: 2, durationSec: 2 }] }), [clip('c1', 20, { words: [w(2.8, 3.3, 'carry')] }), clip('c2', 20)]);
    expect(talk.shots[0]).toMatchObject({ clipId: 'c1', inSec: 1 });
    expect(talk.shots[1]!.audio).toEqual({ kind: 'l', seconds: 0.35 });
    expect(talk.shots[1]!.why).toMatch(/L-cut/);
  });

  it('renders per-cut transitions: hard-cut runs concatenated, xfade between them, a blurred whip', () => {
    const r = RecipeSchema.parse({
      title: 't',
      aspect: '9:16',
      shots: [
        { clipId: 'c1', inSec: 0, durationSec: 2 },
        { clipId: 'c2', inSec: 0, durationSec: 2, transition: { kind: 'whip' } },
        { clipId: 'c1', inSec: 3, durationSec: 2 },
        { clipId: 'c2', inSec: 3, durationSec: 2, transition: { kind: 'dissolve', seconds: 0.4 } },
      ],
    });
    const p = buildRenderPlan(r, clipsMap(two), { preview: false, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true, blurFilter: true });
    const graph = graphOf(p);
    expect(graph).toContain('[v1][v2]concat=n=2:v=1:a=0[g1]');
    expect(graph).toContain("[v0][g1]xfade=transition=slideleft:duration=0.200:offset=2.000,dblur=angle=0:radius=43:enable='between(t,2.000,2.200)'[x1]");
    expect(graph).toContain('[x1][v3]xfade=transition=dissolve:duration=0.400:offset=6.000[x2]');
    expect(graph).toContain('trim=duration=2.200,setpts=PTS-STARTPTS,settb=AVTB[v0]'); // shot 1 runs on under the whip; one time base for xfade
    expect(p.durationSec).toBe(totalSeconds(r));
    // Each shot's sound sits where its picture is, crossfading like the picture.
    expect(graph).toContain('adelay=delays=2000:all=1');
    expect(graph).toContain('adelay=delays=6000:all=1');
    expect(graph).toContain('amix=inputs=4:duration=longest:dropout_transition=0:normalize=0');
    // Without dblur in this ffmpeg, the whip is a plain fast slide.
    expect(graphOf(buildRenderPlan(r, clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true }))).not.toContain('dblur');
    expect(xfadeName('punch')).toBe('zoomin');
    expect(xfadeName('flash')).toBe('fadewhite');
  });

  it('renders punch-ins, slow pushes and speed ramps as per-frame filters', () => {
    const s = (over: Record<string, unknown>) => RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [{ clipId: 'c1', inSec: 0, durationSec: 2, ...over }] }).shots[0]!;
    expect(zoomFilter(s({ zoom: { kind: 'punch', amount: 1.2, atSec: 0.8 } }), 1080, 1920, 2)).toBe(",scale=w='2*trunc(1080*(1+0.2000*clip((t-0.800)/0.07,0,1))/2)':h='2*trunc(1920*(1+0.2000*clip((t-0.800)/0.07,0,1))/2)':eval=frame,crop=1080:1920,setsar=1");
    expect(zoomFilter(s({ zoom: { kind: 'push', amount: 1.1 } }), 360, 640, 2)).toContain('1+0.1000*min(t/2.000,1)');
    expect(zoomFilter(s({}), 360, 640, 2)).toBe('');
    const rampShot = s({ speed: 1.8, ramp: { atSec: 1, speed: 1 } });
    expect(speedFilter(rampShot)).toBe("setpts='if(lt((PTS-STARTPTS)*TB,1.800),(PTS-STARTPTS)/1.8,(1.800/1.8+((PTS-STARTPTS)*TB-1.800)/1)/TB)'");
    expect(speedFilter(s({ speed: 2 }))).toBe('setpts=(PTS-STARTPTS)/2');
    const p = buildRenderPlan(RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [{ clipId: 'c1', inSec: 0, durationSec: 2, speed: 1.8, ramp: { atSec: 1, speed: 1 } }] }), clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true });
    // 1 s at 1.8× and 1 s at 1× use 2.8 s of footage.
    expect(p.args.slice(0, 8)).toEqual(['-y', '-v', 'error', '-ss', '0.000', '-t', '2.900', '-i']);
    const graph = graphOf(p);
    expect(graph).toContain('asplit=2[s0a][s0b]');
    expect(graph).toContain('[s0a]atrim=end=1.800,asetpts=PTS-STARTPTS,atempo=1.8,');
    expect(graph).toContain('[s0b]atrim=start=1.800,asetpts=PTS-STARTPTS,aresample');
  });

  it('a saved video whose sound stops early fails its check', async () => {
    const dir = tempDir('keo-video-verify-');
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, 'x');
    const fake = new FakeFfmpeg();
    fake.add(file, { durationSec: 6, width: 1080, height: 1920, audioSec: 2.21 });
    const studio = new VideoStudio({
      runner: () => ({ runner: fake, key: 'fake' }),
      workRoot: () => dir,
      outputRoot: () => dir,
      visionBlocked: () => 'no',
      askVision: async () => '',
      transcribeBlocked: () => 'no',
      transcribe: async () => [],
      sent: () => undefined,
      changed: () => undefined,
      log: new Logger(null),
    });
    const v = await studio.verify(file, { durationSec: 6, width: 1080, height: 1920 }, AbortSignal.timeout(5000));
    expect(v).toEqual({ ok: false, detail: 'The video was saved, but its sound stops at 2.2 s.' });
  });

  it('renders J and L cuts by moving the sound boundary, never the picture', () => {
    const r = (audio: Record<string, unknown>) =>
      RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [{ clipId: 'c1', inSec: 0, durationSec: 2 }, { clipId: 'c2', inSec: 3, durationSec: 2, audio }] });
    const j = buildRenderPlan(r({ kind: 'j', seconds: 0.5 }), clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true });
    const jg = graphOf(j);
    expect(jg).toContain('[v0][v1]concat=n=2:v=1:a=0'); // picture: a straight cut at 2 s
    expect(jg).toContain('[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=1.520');
    // Shot 2's sound comes from 0.5 s before its in-point and starts at 1.5 s.
    expect(j.args.join(' ')).toContain('-ss 2.500 -t 2.600 -i C:\\clips\\c2.mp4');
    expect(jg).toMatch(/\[2:a\]asetpts=PTS-STARTPTS,.*adelay=delays=1500:all=1,apad=whole_dur=4.000\[p1\]/);
    const l = graphOf(buildRenderPlan(r({ kind: 'l', seconds: 0.3 }), clipsMap(two), { preview: true, outFile: 'o.mp4', encoder: 'libx264', subtitlesFilter: true }));
    expect(l).toContain('atrim=duration=2.320');
    expect(l).toContain('adelay=delays=2300:all=1');
    expect(j.durationSec).toBe(4);
  });

  it('changes cuts, zooms, ramps and sound cuts live, and keeps cuts on the beat', () => {
    const cs = [clip('c1', 20), clip('c2', 20), clip('c3', 20)];
    const base = RecipeSchema.parse({ title: 't', aspect: '9:16', shots: [2, 3, 5].map((d, i) => ({ clipId: `c${i + 1}`, inSec: 0, durationSec: d })), beats: grid(12), music: { path: 'C:\\m\\s.mp3' } });
    const out = applyDirection(
      base,
      [
        { op: 'transition', kind: 'whip', index: 2 },
        { op: 'zoom', index: 1, kind: 'punch', atSec: 0.5 },
        { op: 'speed_ramp', index: 0, speed: 0.5, atSec: 1 },
        { op: 'audio_cut', index: 1, kind: 'j', seconds: 0.4 },
      ],
      clipsMap(cs),
    ).recipe;
    expect(out.shots.map((_, i) => cutInto(out, i).kind)).toEqual(['cut', 'cut', 'whip']);
    expect(out.shots[1]!.zoom).toEqual({ kind: 'punch', amount: 1.15, atSec: 0.5 });
    expect(out.shots[0]!.ramp).toEqual({ atSec: 1, speed: 0.5 });
    expect(out.shots[1]!.audio).toEqual({ kind: 'j', seconds: 0.4 });
    expect(() => applyDirection(base, [{ op: 'audio_cut', index: 0, kind: 'l' }], clipsMap(cs))).toThrow(/first shot has no cut/);
    expect(() => applyDirection({ ...base, beats: [] }, [{ op: 'beat_sync' }], clipsMap(cs))).toThrow(/no music beat/);
    // A new length keeps every cut on a beat.
    const shorter = applyDirection(base, [{ op: 'set_length', seconds: 7 }], clipsMap(cs)).recipe;
    expect(shorter.shots.map((s) => s.durationSec)).toEqual([1.5, 2, 3.5]);
    for (const st of shotStarts(shorter)) expect(base.beats).toContain(st);
    // A shot made shorter than its punch-in moves the punch inside it.
    const cutDown = applyDirection(out, [{ op: 'shot_length', index: 1, seconds: 0.4 }], clipsMap(cs)).recipe;
    expect(cutDown.shots[1]!.zoom!.atSec).toBe(0.2);
    expect(parseDirection('no zooms and hard cuts', base)).toEqual([{ op: 'zoom', index: null, kind: 'none' }, { op: 'transition', kind: 'cut' }]);
    expect(parseDirection('whip transitions', base)).toEqual([{ op: 'transition', kind: 'whip' }]);
    expect(parseDirection('cut on the beat', base)).toEqual([{ op: 'beat_sync' }]);
    expect(parseDirection('cut on the beat', { ...base, beats: [] })).toBeNull();
  });
});

describe('studio helpers', () => {
  it('picks lively moments and frame times', () => {
    const m = momentsOf([{ t: 5.1, score: 0.3 }, { t: 5.6, score: 0.4 }, { t: 1, score: 0.05 }], 10);
    expect(m[0]).toMatchObject({ startSec: 4, score: 1 });
    expect(momentsOf([], 1.5)).toEqual([{ startSec: 0, durationSec: 1.5, score: 0.1 }]);
    expect(pickFrameTimes([{ startSec: 0, durationSec: 2 }], 2, 6)).toEqual([1]);
  });

  it('reads the model’s style reply leniently', () => {
    const s = parseStyle('Here you go:\n```json\n{"captions":{"present":true,"position":"top","sizePct":40,"color":"red"},"pacing":"fast","transitions":"spin","palette":["#112233","bad"]}\n```')!;
    expect(s.captions).toMatchObject({ present: true, position: 'top', sizePct: 5.5, color: '#FFFFFF' });
    expect(s.pacing).toBe('fast');
    expect(s.transitions).toBe('cut');
    expect(parseStyle('no json')).toBeNull();
    expect(safeName('a<b>:c?/d')).toBe('a b c d');
  });
});

// ------------------------------------------------------------------ capabilities (fake ffmpeg)

interface Setup {
  ff: FakeFfmpeg | null;
  dir: string;
  videos: string;
  template: string;
  clips: string;
  conversationId: string;
}

function setup(opts: { ffmpeg?: boolean; transcribe?: boolean; style?: string } = {}): Setup {
  const dir = tempDir('keo-video-');
  const clips = path.join(dir, 'My Clips');
  fs.mkdirSync(clips);
  const ff = opts.ffmpeg === false ? null : new FakeFfmpeg();
  const tpl = path.join(dir, 'template.mp4');
  fs.writeFileSync(tpl, 'x');
  ff?.add(tpl, { durationSec: 9, width: 1080, height: 1920, scenes: [{ t: 3, score: 0.7 }, { t: 6, score: 0.5 }], clicks: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5] });
  for (const [n, d] of [
    ['beach.mp4', 12],
    ['dog.mov', 7],
    ['city.mp4', 20],
  ] as const) {
    fs.writeFileSync(path.join(clips, n), 'x');
    ff?.add(path.join(clips, n), { durationSec: d, width: 1920, height: 1080, scenes: [{ t: 2, score: 0.2 }, { t: 2.4, score: 0.3 }] });
  }
  fs.writeFileSync(path.join(clips, 'notes.txt'), 'not a clip');
  const videos = path.join(dir, 'Videos');
  const styleJson = opts.style ?? JSON.stringify({ captions: { present: true, position: 'center', sizePct: 7, color: '#FFEE00', uppercase: true, wordsPerLine: 2 }, pacing: 'fast', transitions: 'cut', palette: ['#FFFFFF'], hook: 'A dog on a beach', textOverlays: [{ text: 'WAIT FOR IT', position: 'top', atSec: 0.5 }], notes: 'Upbeat' });
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (req: ChatRequest) => (req.correlationId.startsWith('video_') ? reply(req.messages[0]!.content.some((b) => b.type === 'text' && b.text.includes('one from each')) ? JSON.stringify({ clips: [{ id: 'c1', description: 'a sunny beach', appeal: 9 }] }) : styleJson) : reply('ok')),
    deps: {
      videoRunner: () => (ff ? { runner: ff, key: 'fake' } : null),
      videosDir: videos,
      ...(opts.transcribe ? { videoTranscribe: async () => [w(2.1, 2.4, 'look'), w(2.5, 2.9, 'at'), w(3, 3.3, 'this')] } : {}),
    },
  });
  if (opts.transcribe) h.services.settings.update({ video: { transcribeAudio: true } });
  h.services.settings.update({ agent: { approvalWaitSeconds: 10 } });
  const conv = h.services.conversations.create('video');
  h.services.conversations.addMessage({ conversationId: conv.id, role: 'user', content: `Make a video like ${tpl} from the clips in ${clips}`, status: 'complete' });
  return { ff, dir, videos, template: tpl, clips, conversationId: conv.id };
}

/** Runs a capability the way the model's tool call does (admission, task, approval when needed). */
async function run(s: Setup, capabilityId: string, input: unknown, approve = true) {
  const a = h!.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason, requiresApproval: null, step: null };
  const t = h!.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: s.conversationId, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h!.services.tasks.submit(t.id);
  const first = h!.services.tasks.get(t.id)!.steps[0]!;
  if (first.state === 'awaiting_authorization') {
    if (approve) h!.services.tasks.approveStep(first.id, first.inputHash);
  } else h!.services.tasks.pump();
  await waitFor(() => ['succeeded', 'failed', 'outcome_uncertain', ...(approve ? [] : ['awaiting_authorization'])].includes(h!.services.tasks.get(t.id)!.steps[0]!.state), 8000);
  return { rejected: null, requiresApproval: a.requiresApproval, step: h!.services.tasks.get(t.id)!.steps[0]! };
}

describe('video capabilities', () => {
  it('say clearly when ffmpeg is missing, and change nothing', async () => {
    const s = setup({ ffmpeg: false });
    const st = await run(s, 'video.check_tools', {});
    expect(st.step!.result).toMatchObject({ found: false, message: NO_FFMPEG });
    expect(NO_FFMPEG).toMatch(/Set up video tools/);
    expect(NO_FFMPEG).toMatch(/only when you click it/);
    const r = await run(s, 'video.analyze_template', { templatePath: s.template });
    expect(r.step!.state).toBe('failed');
    expect(r.step!.error).toMatch(/ffmpeg is not installed/);
    expect(h!.services.video.get(undefined)).toBeNull();
  });

  it('use only files the user named or picked', async () => {
    const s = setup();
    const other = path.join(s.dir, 'secret.mp4');
    fs.writeFileSync(other, 'x');
    s.ff!.add(other, { durationSec: 5, width: 100, height: 100 });
    const r = await run(s, 'video.analyze_template', { templatePath: other });
    expect(r.step!.error).toMatch(/only files the user named or picked/);
    expect(r.step!.error).toMatch(/Nothing was read/);
    // A folder must be given by its full path (its name alone is too common).
    const f = await run(s, 'video.analyze_clips', { folder: path.join(s.dir, 'other', 'My Clips') });
    expect(f.step!.error).toMatch(/only files the user named or picked/);
    expect(s.ff!.calls.length).toBe(0);
    // Picked in Keo's dialog: allowed.
    h!.services.video.notePicked(other);
    expect((await run(s, 'video.analyze_template', { templatePath: other })).step!.state).toBe('succeeded');
    // Relative paths and non-video files are refused.
    expect((await run(s, 'video.analyze_template', { templatePath: 'template.mp4' })).step!.error).toMatch(/full path/);
  });

  it('analyse, plan, preview, direct live, and save a checked video that never replaces a file', async () => {
    const s = setup({ transcribe: true });
    const t = await run(s, 'video.analyze_template', { templatePath: s.template });
    expect(t.step!.state).toBe('succeeded');
    expect(t.step!.result).toMatchObject({ durationSec: 9, aspect: '9:16', shots: 3, shotLengths: [3, 3, 3] });
    expect((t.step!.result as { tempoBpm: number }).tempoBpm).toBeGreaterThan(100);
    expect((t.step!.result as { style: { hook: string } }).style.hook).toBe('A dog on a beach');

    const c = await run(s, 'video.analyze_clips', { folder: s.clips });
    expect(c.step!.state).toBe('succeeded');
    const cr = c.step!.result as { clips: Array<{ id: string; name: string; words: number; description: string | null }>; captionsNote: string | null };
    expect(cr.clips.map((x) => x.name)).toEqual(['beach.mp4', 'city.mp4', 'dog.mov']);
    expect(cr.clips[0]).toMatchObject({ id: 'c1', words: 3, description: 'a sunny beach' });
    expect(cr.captionsNote).toBeNull();
    expect(h!.services.audit.recent(200).some((a) => a.kind === 'video.transcribe')).toBe(true);

    const p = await run(s, 'video.plan_edit', { title: 'Beach day', hook: 'Best day ever' });
    expect(p.step!.state).toBe('succeeded');
    const plan = p.step!.result as { projectId: string; totalSec: number; captions: { enabled: boolean; sizePct: number; position: string }; texts: unknown[] };
    expect(plan.totalSec).toBe(9);
    expect(plan.captions).toEqual({ enabled: true, sizePct: 7, position: 'center' });
    expect(plan.texts).toHaveLength(1);

    const studio = h!.services.video;
    await studio.previewSettled(plan.projectId);
    let view = studio.view()!;
    expect(view.status).toBe('ready');
    expect(view.preview?.version).toBe(1);
    expect(studio.previewBytes(plan.projectId, 1)?.byteLength).toBeGreaterThan(0);
    const preview = s.ff!.renders.at(-1)!;
    expect(preview.out.startsWith(h!.dir)).toBe(true); // Keo's own folder
    expect(preview.ass).toContain('Best day ever');
    expect(preview.ass).toMatch(/LOOK AT|LOOK/); // uppercase captions from the template

    // Live direction from the preview window: understood locally, applied, new preview.
    const said = await h!.services.videoSay('shorter intro and bigger captions');
    expect(said).toMatchObject({ applied: true, forwarded: false });
    await studio.previewSettled(plan.projectId);
    view = studio.view()!;
    expect(view.preview?.version).toBe(2);
    expect(view.captions.sizePct).toBe(9.1);
    expect(view.canUndo).toBe(true);
    expect(h!.services.audit.recent(200).some((a) => a.kind === 'capability.admission' && a.capabilityId === 'video.direct')).toBe(true);
    expect((await h!.services.videoUndo()).ok).toBe(true);
    await studio.previewSettled(plan.projectId);
    expect(studio.view()!.captions.sizePct).toBe(7);

    // Something Keo does not understand by itself goes to the conversation.
    const fwd = await h!.services.videoSay('swap the dog clip for the beach one');
    expect(fwd).toMatchObject({ applied: false, forwarded: true });

    // The model's structured change.
    const d = await run(s, 'video.direct', { changes: [{ op: 'swap_clip', index: 0, clipId: 'c3' }, { op: 'add_text', text: 'THE END', startSec: 7, endSec: 9, position: 'bottom' }] });
    expect(d.step!.state).toBe('succeeded');
    const bad = await run(s, 'video.direct', { changes: [{ op: 'remove_shot', index: 40 }] });
    expect(bad.step!.error).toMatch(/Nothing was changed/);
    expect((await run(s, 'video.direct', { changes: [{ op: 'ffmpeg', args: '-i x' }] })).rejected).toBeTruthy();

    // Saving needs approval, goes to Videos\Keo and is checked.
    const pending = await run(s, 'video.render_final', {}, false);
    expect(pending.requiresApproval).toBe(true);
    expect(pending.step!.state).toBe('awaiting_authorization');
    expect(fs.existsSync(path.join(s.videos, 'Keo'))).toBe(false);
    h!.services.tasks.cancel(h!.services.tasks.list(50).find((x) => x.steps[0]?.id === pending.step!.id)!.id);
    const f1 = await run(s, 'video.render_final', {});
    expect(f1.step!.error ?? f1.step!.state).toBe('succeeded');
    expect(f1.step!.verificationDetail).toMatch(/9\.\d s, 1080×1920, with sound/);
    const file1 = (f1.step!.result as { file: string }).file;
    expect(path.dirname(file1)).toBe(path.join(s.videos, 'Keo'));
    expect(path.basename(file1)).toMatch(/^\d{4}-\d{2}-\d{2} Beach day\.mp4$/);
    const finalArgs = s.ff!.renders.at(-1)!.args;
    expect(finalArgs).toContain('veryfast');
    const f2 = await run(s, 'video.render_final', {});
    const file2 = (f2.step!.result as { file: string }).file;
    expect(path.basename(file2)).toMatch(/Beach day \(2\)\.mp4$/);
    expect(fs.existsSync(file1) && fs.existsSync(file2)).toBe(true);
  });

  it('skip captions with a clear note when sending sound is not allowed, and use frames only when allowed', async () => {
    const s = setup();
    const c = await run(s, 'video.analyze_clips', { folder: s.clips, lookAtClips: false });
    expect((c.step!.result as { captionsNote: string }).captionsNote).toMatch(/not allowed yet \(Settings → Video\)/);
    expect(s.ff!.calls.some((x) => x.args.includes('wav'))).toBe(false);
    const t = await run(s, 'video.analyze_template', { templatePath: s.template, lookAtFrames: false });
    expect((t.step!.result as { style: unknown; styleNote: string }).style).toBeNull();
    expect((t.step!.result as { styleNote: string }).styleNote).toMatch(/not analysed/);
    const p = await run(s, 'video.plan_edit', {});
    expect((p.step!.result as { captions: { enabled: boolean } }).captions.enabled).toBe(false);
  });

  it('report a failed render without leaving a file behind', async () => {
    const s = setup();
    await run(s, 'video.analyze_clips', { folder: s.clips, captions: false, lookAtClips: false });
    s.ff!.failRender = 'Error opening output file: Invalid argument';
    await run(s, 'video.plan_edit', {});
    const p = h!.services.video.get(undefined)!;
    await h!.services.video.previewSettled(p.id);
    expect(h!.services.video.view()!.status).toBe('error');
    expect(h!.services.video.view()!.message).toMatch(/Invalid argument/);
    const f = await run(s, 'video.render_final', {});
    expect(f.step!.state).toBe('failed');
    expect(f.step!.error).toMatch(/could not make the video/);
    expect(fs.existsSync(path.join(s.videos, 'Keo'))).toBe(false);
  });

  it('restart the preview when a new change arrives while one is being made', async () => {
    const s = setup();
    await run(s, 'video.analyze_clips', { folder: s.clips, captions: false, lookAtClips: false });
    s.ff!.renderDelayMs = 300;
    await run(s, 'video.plan_edit', {});
    const studio = h!.services.video;
    const id = studio.get(undefined)!.id;
    studio.direct([{ op: 'set_length', seconds: 6 }], { conversationId: s.conversationId });
    await studio.previewSettled(id);
    expect(studio.view()!.preview?.version).toBe(2);
    expect(s.ff!.renders).toHaveLength(1);
  });
});

describe('paths the user named', () => {
  it('match whole names and paths only', () => {
    const said = ['Use C:/Users/me/Videos/Trip and the template "beach-intro.mp4" please'];
    expect(mentions(said, 'C:\\Users\\me\\Videos\\Trip')).toBe(true);
    expect(mentions(said, 'beach-intro.mp4')).toBe(true);
    expect(mentions(said, 'intro.mp4')).toBe(false);
    expect(mentions(said, 'C:\\Users\\me\\Videos\\Tr')).toBe(false);
    expect(mentions(said, 'mp4')).toBe(false);
  });
});

describe('video preview window', () => {
  it('may only watch, direct, undo, save and close', () => {
    for (const ch of ['video:get', 'video:preview', 'video:say', 'video:undo', 'video:export', 'video:openFolder', 'video:close', 'settings:get'] as const) expect(channelAllowed('video', ch)).toBe(true);
    for (const ch of ['memory:list', 'chat:send', 'settings:update', 'tasks:approveStep', 'video:pickFfmpeg', 'video:pickOutput', 'results:send', 'desktop:listWindows'] as const) expect(channelAllowed('video', ch)).toBe(false);
    // Other small windows cannot drive the video window's actions.
    expect(channelAllowed('results', 'video:export')).toBe(false);
    expect(channelAllowed('command', 'video:say')).toBe(false);
  });
});
