import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { readWav, wavOf } from '../src/main/studio/captions';
import { fillerCuts, planCleanup, punchIns, retakeCuts, silenceCuts } from '../src/main/studio/cleanup';
import { SFX, sfxWav, type SfxKind } from '../src/main/studio/sfx';
import { applyEdits, bridged, duckGain, mergeRanges, newProject, timelineSpeech, timelineWords, zoomAt, type Asset, type MediaClip, type Project, type RenderJob, type TextClip } from '../src/shared/studio';
import { speechLike } from './fakeSpeechSound';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const w = (text: string, start: number, end: number) => ({ text, start, end });

/** A project with one talking-head video (speech analysed, transcribed) placed at 0. */
function talking(over: Partial<Asset> = {}, clip: { in?: number; duration?: number } = {}): Project {
  n = 0;
  const p0 = newProject({ name: 'Talk', rand });
  const asset: Asset = {
    id: 'as_talk0001',
    kind: 'video',
    path: 'C:\\v\\talk.mp4',
    name: 'talk.mp4',
    duration: 20,
    width: 1080,
    height: 1920,
    hasAudio: true,
    speech: [
      { start: 1, end: 3 },
      { start: 5, end: 6 },
      { start: 6.2, end: 9 },
    ],
    words: [w('So', 1, 1.2), w('um', 1.3, 1.6), w('today', 1.7, 2.1), w('we', 2.2, 2.4), w('edit.', 2.5, 2.9), w('This', 5, 5.3), w('is', 5.4, 5.6), w('the', 5.7, 5.9), w('This', 6.2, 6.5), w('is', 6.6, 6.8), w('the', 6.9, 7.1), w('best', 7.2, 7.6), w('part.', 7.7, 8.5)],
    wordsExact: true,
    ...over,
  };
  return applyEdits({ ...p0, assets: [asset] }, [{ op: 'add_media', assetId: asset.id, start: 0, ...(clip.in !== undefined ? { in: clip.in } : {}), duration: clip.duration ?? 10 }], { rand }).project;
}

describe('Studio phase 2: the model', () => {
  it('maps speech and words from the source onto the timeline (trim and speed)', () => {
    const p = talking({}, { in: 2, duration: 4 });
    expect(timelineSpeech(p)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    const words = timelineWords(p).map((x) => `${x.text}@${x.start}`);
    expect(words).toContain('we@0.2');
    expect(words.some((x) => x.startsWith('So'))).toBe(false);
    const fast = applyEdits(p, [{ op: 'set', clip: p.tracks[0]!.clips[0]!.id, speed: 2 }], { rand }).project;
    expect(timelineSpeech(fast)[1]).toEqual({ start: 1.5, end: 2 });
  });

  it('cuts several ranges at once, as they were before the cut', () => {
    const p = talking();
    const { project, changes } = applyEdits(
      p,
      [
        {
          op: 'cut_ranges',
          ranges: [
            { from: 3.2, to: 4.8 },
            { from: 0, to: 0.8 },
            { from: 4.5, to: 4.9 },
          ],
        },
      ],
      { rand },
    );
    const clips = project.tracks[0]!.clips as MediaClip[];
    expect(clips.map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 2.4, 0.8],
      [2.4, 5.1, 4.9],
    ]);
    expect(changes[0]).toMatch(/2 parts out \(2.5s in all\)/);
    expect(mergeRanges([{ from: 2, to: 3 }, { from: 0, to: 1 }, { from: 0.5, to: 2 }])).toEqual([{ from: 0, to: 3 }]);
  });

  it('caption words and zooms belong to their clip: they move, split and cut with it', () => {
    let p = applyEdits(newProject({ name: 'C', rand }), [{ op: 'add_captions', replace: true, lines: [{ text: 'one two three', start: 2, end: 4, words: [w('one', 2, 2.5), w('two', 2.6, 3.1), w('three', 3.2, 3.9)] }] }], { rand }).project;
    const cap = () => p.tracks.find((t) => t.name === 'Captions')!.clips as TextClip[];
    expect(cap()[0]!.words!.map((x) => x.start)).toEqual([0, 0.6, 1.2]);
    p = applyEdits(p, [{ op: 'move', clip: cap()[0]!.id, start: 10 }], { rand }).project;
    expect(cap()[0]!.words![0]!.start).toBe(0);
    p = applyEdits(p, [{ op: 'split', clip: cap()[0]!.id, at: 10.6 }], { rand }).project;
    expect(cap().map((c) => c.words!.map((x) => x.text))).toEqual([['one'], ['two', 'three']]);
    expect(cap()[1]!.words![0]!.start).toBe(0);

    p = talking();
    const id = p.tracks[0]!.clips[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, zooms: [{ at: 0, scale: 1, x: 0.5, y: 0.5, ease: 'cut' }, { at: 8, scale: 1.2, x: 0.5, y: 0.5, ease: 'ramp' }] }], { rand }).project;
    p = applyEdits(p, [{ op: 'split', clip: id, at: 4 }], { rand }).project;
    const [a, b] = p.tracks[0]!.clips as MediaClip[];
    // The first half keeps the ramp's target; the second half starts where the push had got to.
    expect(zoomAt(a!.zooms, 4)).toEqual(zoomAt([{ at: 0, scale: 1, x: 0.5, y: 0.5, ease: 'cut' }, { at: 8, scale: 1.2, x: 0.5, y: 0.5, ease: 'ramp' }], 4));
    expect(b!.zooms![0]!.scale).toBeCloseTo(1.1, 2);
    expect(b!.zooms![1]).toMatchObject({ at: 4, scale: 1.2, ease: 'ramp' });
  });

  it('zooms: cut, smooth and ramp', () => {
    const z = [
      { at: 1, scale: 1.2, x: 0.5, y: 0.4, ease: 'cut' as const },
      { at: 3, scale: 1, x: 0.5, y: 0.5, ease: 'smooth' as const },
    ];
    expect(zoomAt(z, 0.5).scale).toBe(1);
    expect(zoomAt(z, 1.5)).toEqual({ scale: 1.2, x: 0.5, y: 0.4 });
    expect(zoomAt(z, 3.2).scale).toBeGreaterThan(1);
    expect(zoomAt(z, 3.2).scale).toBeLessThan(1.2);
    expect(zoomAt(z, 4).scale).toBe(1);
    expect(zoomAt([{ at: 2, scale: 1.5, x: 0.5, y: 0.5, ease: 'ramp' }], 1).scale).toBeCloseTo(1.25, 5);
  });

  it('ducks music under speech, easing down before and up after', () => {
    const speech = bridged([
      { start: 2, end: 4 },
      { start: 4.3, end: 5 },
    ]);
    expect(speech).toEqual([{ start: 2, end: 5 }]);
    const low = Math.pow(10, -14 / 20);
    expect(duckGain(speech, 1, -14)).toBe(1);
    expect(duckGain(speech, 3, -14)).toBeCloseTo(low, 5);
    expect(duckGain(speech, 1.9, -14)).toBeGreaterThan(low);
    expect(duckGain(speech, 5.2, -14)).toBeGreaterThan(low);
    expect(duckGain(speech, 6, -14)).toBe(1);
  });

  it('colour, voice, duck and loudness are clip and project settings', () => {
    let p = talking();
    const id = p.tracks[0]!.clips[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, color: { contrast: 0.3 }, voice: true }, { op: 'set_project', loudness: 'social' }], { rand }).project;
    const c = p.tracks[0]!.clips[0] as MediaClip;
    expect(c.color).toEqual({ exposure: 0, contrast: 0.3, saturation: 0, temperature: 0, vignette: 0 });
    expect(c.voice).toBe(true);
    expect(p.loudness).toBe('social');
    expect(() => applyEdits(p, [{ op: 'set', clip: id, duck: -10 }], { rand })).toThrow(/music ducking/);
  });
});

describe('Studio phase 2: clean-up', () => {
  it('shortens long pauses, keeping a little air around speech', () => {
    const cuts = silenceCuts(talking(), { minSilence: 0.6, keep: 0.15 });
    expect(cuts).toEqual([
      { from: 0, to: 0.85, reason: 'silence' },
      { from: 3.15, to: 4.85, reason: 'silence' },
      { from: 9.15, to: 10, reason: 'silence' },
    ]);
  });

  it('finds filler words and retakes in the transcript', () => {
    const words = timelineWords(talking());
    expect(fillerCuts(words)).toEqual([{ from: 1.26, to: 1.66, reason: 'filler', text: 'um' }]);
    const r = retakeCuts(words);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ reason: 'retake', from: 4.95, to: 6.15 });
    expect(r[0]!.text).toMatch(/This is the/);
    // A stutter, and a sentence started again after a pause.
    expect(retakeCuts([w('I', 0, 0.2), w('I', 0.3, 0.5), w('think', 0.6, 1)]).map((c) => c.text)).toEqual(['I']);
    expect(retakeCuts([w('So', 0, 0.2), w('the', 0.3, 0.4), w('plan', 0.5, 0.8), w('was', 0.9, 1.2), w('So', 2, 2.2), w('the', 2.3, 2.4), w('plan', 2.5, 2.8), w('is', 2.9, 3), w('simple.', 3.1, 3.6)])).toEqual([expect.objectContaining({ from: 0, to: 1.95 })]);
    // Different sentences that start alike are not retakes.
    expect(retakeCuts([w('We', 0, 0.2), w('should', 0.3, 0.6), w('go.', 0.7, 1), w('We', 2, 2.2), w('should', 2.3, 2.6), w('leave', 2.7, 3)])).toEqual([]);
  });

  it('plans everything together, and says what it cannot do yet', () => {
    const plan = planCleanup(talking(), { silences: true, fillers: true, retakes: true });
    expect(plan.cuts.map((c) => c.reason)).toEqual(['silence', 'filler', 'silence', 'retake', 'silence']);
    expect(plan.seconds).toBeGreaterThan(4);
    const noWords = planCleanup(talking({ words: undefined }), { fillers: true });
    expect(noWords.cuts).toEqual([]);
    expect(noWords.notes[0]).toMatch(/transcript first/);
  });

  it('punch-ins alternate at new phrases', () => {
    const { ops, points } = punchIns(talking(), { scale: 1.2, minGap: 2 });
    expect(points).toBeGreaterThanOrEqual(2);
    const zooms = (ops[0] as { zooms: Array<{ scale: number }> }).zooms;
    expect(zooms.map((z) => z.scale).slice(0, 2)).toEqual([1.2, 1]);
  });
});

describe('Keo sound effects', () => {
  it('are made on this PC as short, clean WAV files', () => {
    for (const k of Object.keys(SFX) as SfxKind[]) {
      const s = readWav(sfxWav(k));
      expect(s.rate).toBe(48000);
      expect(s.samples.length / s.rate).toBeCloseTo(SFX[k].seconds, 2);
      let peak = 0;
      for (const v of s.samples) peak = Math.max(peak, Math.abs(v));
      expect(peak / 32767).toBeGreaterThan(0.6);
      expect(peak / 32767).toBeLessThan(0.75);
    }
  });
});

// ------------------------------------------------------------------ the tools (fake render window)

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

function setup() {
  const dir = tempDir('keo-autopilot-');
  const talk = path.join(dir, 'talk.mp3');
  fs.writeFileSync(talk, 'x');
  const videos = path.join(dir, 'Videos');
  const made = path.join(videos, 'Keo', 'b-roll.png');
  fs.mkdirSync(path.dirname(made), { recursive: true });
  fs.writeFileSync(made, 'x');
  const jobs: RenderJob[] = [];
  const sent: number[] = [];
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (_req: ChatRequest) => reply('ok'),
    deps: {
      videosDir: videos,
      studioProbe: async (file) => (file.endsWith('.mp3') ? { kind: 'audio', duration: 10, width: 0, height: 0, hasAudio: true } : { kind: 'image', duration: 0, width: 800, height: 600, hasAudio: false }),
      studioJob: (jobId, job) => {
        jobs.push(job);
        // Speech from 1 to 3 s and 5 to 9 s of a 10-second recording.
        setTimeout(() => h!.services.studio.jobDone(jobId, job.kind === 'asset_audio' ? { wavBase64: wavOf(speechLike(10, [[1, 3], [5, 9]]), 16000).toString('base64') } : null, job.kind === 'asset_audio' ? null : 'not in this test'), 5);
      },
      videoTranscribe: async () => {
        sent.push(1);
        // Relative to the piece of sound sent (it starts just before 1 s).
        return [
          { startSec: 0.1, endSec: 0.4, text: 'Hello' },
          { startSec: 0.5, endSec: 0.8, text: 'uh' },
          { startSec: 0.9, endSec: 1.6, text: 'friends.' },
        ];
      },
    },
  });
  h.services.settings.update({ agent: { approvalWaitSeconds: 10 } });
  const conv = h.services.conversations.create('autopilot');
  h.services.conversations.addMessage({ conversationId: conv.id, role: 'user', content: `Edit ${talk} for me`, status: 'complete' });
  return { conversationId: conv.id, talk, made, jobs, sent };
}

async function run(s: { conversationId: string }, capabilityId: string, input: unknown, approve = true) {
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

describe('Keo’s Studio autopilot tools', () => {
  it('clean up pauses on this PC, then fillers after the transcript (which asks first)', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Talk', format: 'vertical' }, show: false });
    await run(s, 'studio.add_media', { paths: [s.talk], placeOnTimeline: true });
    const dry = await run(s, 'studio.clean_up', { dryRun: true });
    expect(dry.step!.state).toBe('succeeded');
    expect(dry.step!.result).toMatchObject({ cut: false, durationSec: 10 });
    expect(s.sent).toHaveLength(0);
    const r = await run(s, 'studio.clean_up', { keep: 0.1 });
    expect(r.step!.result).toMatchObject({ cut: true, byReason: { silence: 3 } });
    expect((r.step!.result as { durationSec: number }).durationSec).toBeLessThan(7);

    // Fillers need the transcript; the transcript needs the user's OK.
    const none = await run(s, 'studio.clean_up', { silences: false, fillers: true });
    expect((none.step!.result as { notes: string[] }).notes[0]).toMatch(/transcript first/);
    const wait = await run(s, 'studio.transcript', {}, false);
    expect(wait.requiresApproval).toBe(true);
    expect(s.sent).toHaveLength(0);
    const t = await run(s, 'studio.transcript', {});
    expect(t.step!.state).toBe('succeeded');
    expect((t.step!.result as { phrases: Array<{ text: string }> }).phrases.map((x) => x.text).join(' ')).toMatch(/Hello uh friends\./);
    const f = await run(s, 'studio.clean_up', { silences: false, fillers: true });
    expect(f.step!.result).toMatchObject({ cut: true, byReason: { filler: 1 } });
    // Asked again: the transcript is kept, nothing is sent.
    await run(s, 'studio.transcript', {});
    expect(s.sent).toHaveLength(1);
  });

  it('polish the sound, colour, add effects and punch-ins', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Polish', format: 'vertical' }, show: false });
    await run(s, 'studio.add_media', { paths: [s.talk, s.made], placeOnTimeline: true });
    const snd = await run(s, 'studio.sound', { voice: true, loudness: 'social' });
    expect(snd.step!.state).toBe('succeeded');
    let p = h!.services.studio.resolve();
    expect(p.loudness).toBe('social');
    expect(p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio').every((c) => c.type === 'audio' && c.voice)).toBe(true);
    const noMusic = await run(s, 'studio.sound', { duckDb: -14 });
    expect(noMusic.step!.error).toMatch(/no music to duck/);

    const col = await run(s, 'studio.color', { look: 'warm' });
    expect(col.step!.state).toBe('succeeded');
    p = h!.services.studio.resolve();
    expect((p.tracks[0]!.clips[0] as MediaClip).color?.temperature).toBeGreaterThan(0.3);

    const fx = await run(s, 'studio.sound_effect', { kind: 'whoosh', at: [1, 3] });
    expect(fx.step!.state).toBe('succeeded');
    p = h!.services.studio.resolve();
    const effects = p.tracks.find((t) => t.name === 'Effects')!;
    expect(effects.clips.map((c) => c.start)).toEqual([1, 3]);
    expect(fs.existsSync(p.assets.find((a) => a.name.startsWith('Whoosh'))!.path)).toBe(true);

    // Punch-ins need a talking video (here there is only a picture).
    const pi = await run(s, 'studio.punch_in', {});
    expect(pi.step!.error).toMatch(/no talking-head video/);
  });

  it('use pictures Keo made itself without the user naming them', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'B-roll', format: 'vertical' }, show: false });
    const r = await run(s, 'studio.add_media', { paths: [s.made] });
    expect(r.step!.state).toBe('succeeded');
    const id = (r.step!.result as { added: Array<{ id: string }> }).added[0]!.id;
    const e = await run(s, 'studio.edit', { ops: [{ op: 'add_media', assetId: id, trackName: 'B-roll', start: 1, duration: 2, zooms: [{ at: 0, scale: 1 }, { at: 2, scale: 1.12, ease: 'ramp' }] }] });
    expect(e.step!.state).toBe('succeeded');
    const p = h!.services.studio.resolve();
    expect(p.tracks.map((t) => t.name)).toEqual(['Video', 'B-roll', 'Text', 'Audio']);
  });
});
