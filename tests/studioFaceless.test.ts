import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { readWav, wavOf } from '../src/main/studio/captions';
import { applyEdits, newProject, projectDuration, type Asset, type MediaClip, type RenderJob, type TextClip } from '../src/shared/studio';
import { facelessOps, pictureSize, scenesFromScript, Storyboard } from '../src/shared/studioFaceless';
import { speechLike } from './fakeSpeechSound';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

describe('Faceless creator: storyboard', () => {
  it('reads a script: one scene per paragraph, with picture and title lines', () => {
    const scenes = scenesFromScript('Did you know?\n[title: Fun fact]\n\nThe sea makes air.\n[picture: green plankton in blue water]\n\n\nSay thanks.');
    expect(scenes).toHaveLength(3);
    expect(scenes[0]).toMatchObject({ narration: 'Did you know?', title: 'Fun fact' });
    expect(scenes[1]).toMatchObject({ narration: 'The sea makes air.', picture: { prompt: 'green plankton in blue water' } });
    expect(scenes[2]!.picture).toBeUndefined();
    expect(pictureSize('vertical')).toBe('1024x1536');
    expect(pictureSize('landscape')).toBe('1536x1024');
  });

  it('builds the timeline: pictures moving, voice, titles, transitions, captions, music', () => {
    n = 0;
    const assets: Asset[] = [
      ...[1, 2, 3].map((i) => ({ id: `as_pic0000${i}`, kind: 'image' as const, path: `C:\\k\\p${i}.png`, name: `p${i}.png`, duration: 0, width: 1024, height: 1536, hasAudio: false })),
      ...[1, 2, 3].map((i) => ({ id: `as_voc0000${i}`, kind: 'audio' as const, path: `C:\\k\\v${i}.wav`, name: `v${i}.wav`, duration: 2 + i, width: 0, height: 0, hasAudio: true })),
      { id: 'as_music001', kind: 'audio', path: 'C:\\m\\song.mp3', name: 'song.mp3', duration: 6, width: 0, height: 0, hasAudio: true },
      { id: 'as_whoosh01', kind: 'audio', path: 'C:\\k\\whoosh.wav', name: 'Whoosh', duration: 0.55, width: 0, height: 0, hasAudio: true },
    ];
    const p = { ...newProject({ name: 'F', rand }), assets };
    const board = Storyboard.parse({ title: 'Ocean air', music: 'as_music001', scenes: [{ narration: 'Did you know the ocean makes air?', title: 'Ocean air' }, { narration: 'Tiny plants do it.' }, { narration: 'Say thank you.', transition: 'flash' }] });
    const media = [1, 2, 3].map((i) => ({ pictureId: `as_pic0000${i}`, voiceId: `as_voc0000${i}`, voiceSeconds: 2 + i, speech: [{ start: 0.1, end: 1.9 + i }] }));
    const { ops, duration } = facelessOps(p, board, media, { sfx: 'as_whoosh01' });
    const out = applyEdits(p, ops, { rand }).project;
    expect(duration).toBeCloseTo(3.35 + 4.35 + 5.35, 3);
    expect(projectDuration(out)).toBeCloseTo(duration, 2);
    expect(out.name).toBe('Ocean air');
    expect(out.loudness).toBe('social');
    const pics = out.tracks.find((t) => t.name === 'Video')!.clips as MediaClip[];
    expect(pics.map((c) => c.start)).toEqual([0, 3.35, 7.7]);
    expect(pics[0]!.enter).toBeUndefined();
    expect(pics[2]!.enter?.kind).toBe('flash');
    expect(pics.every((c) => c.zooms?.length === 2)).toBe(true);
    expect(out.tracks.find((t) => t.name === 'Voice')!.clips).toHaveLength(3);
    expect(out.tracks.find((t) => t.name === 'Effects')!.clips.map((c) => c.start)).toEqual([3.2, 7.55]);
    // The music again after it ends, ducked under the voice.
    const music = out.tracks.find((t) => t.name === 'Music')!.clips;
    expect(music.map((c) => [c.start, c.duration])).toEqual([
      [0, 6],
      [6, 6],
      [12, 1.05],
    ]);
    expect(music.every((c) => c.type === 'audio' && c.duck === -14)).toBe(true);
    // Captions: every word of the script, inside its own scene.
    const caps = out.tracks.find((t) => t.name === 'Captions')!.clips as TextClip[];
    expect(caps.map((c) => c.text).join(' ')).toBe('Did you know the ocean makes air? Tiny plants do it. Say thank you.');
    expect(caps.find((c) => c.text.startsWith('Tiny'))!.start).toBeGreaterThanOrEqual(3.35);
    const title = out.tracks.find((t) => t.name === 'Text')!.clips[0] as TextClip;
    expect(title).toMatchObject({ text: 'Ocean air', animIn: 'letters' });
  });
});

// ------------------------------------------------------------------ end to end (fake voice and pictures)

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function setup() {
  const dir = tempDir('keo-faceless-');
  const spoken: string[] = [];
  const pictures: string[] = [];
  const jobs: RenderJob[] = [];
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (_req: ChatRequest) => reply('ok'),
    deps: {
      videosDir: path.join(dir, 'Videos'),
      // A voice clip whose length follows the text (about 15 letters a second), speech all through.
      studioNarrate: async (text) => {
        spoken.push(text);
        const secs = Math.max(1, text.length / 15);
        return { audio: wavOf(speechLike(secs, [[0.1, secs - 0.1]]), 16000), mimeType: 'audio/wav' };
      },
      pictureAi: {
        generate: async (o) => {
          pictures.push(o.prompt);
          return PNG_1PX;
        },
        edit: async () => PNG_1PX,
      },
      studioProbe: async (file) => (file.endsWith('.wav') ? { kind: 'audio', duration: readWav(fs.readFileSync(file)).samples.length / 16000, width: 0, height: 0, hasAudio: true } : { kind: 'image', duration: 0, width: 1024, height: 1536, hasAudio: false }),
      studioJob: (jobId, job) => {
        jobs.push(job);
        setTimeout(() => {
          const s = h!.services.studio;
          if (job.kind === 'asset_audio') {
            const a = s.get(job.projectId).assets.find((x) => x.id === job.assetId)!;
            s.jobDone(jobId, { wavBase64: fs.readFileSync(a.path).toString('base64') }, null);
          } else s.jobDone(jobId, null, 'not in this test');
        }, 5);
      },
    },
  });
  h.services.settings.update({ agent: { approvalWaitSeconds: 10 } });
  const conv = h.services.conversations.create('faceless');
  return { conversationId: conv.id, spoken, pictures, jobs };
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
  await waitFor(() => ['succeeded', 'failed', 'outcome_uncertain', ...(approve ? [] : ['awaiting_authorization'])].includes(h!.services.tasks.get(t.id)!.steps[0]!.state), 15000);
  return { rejected: null, requiresApproval: a.requiresApproval, step: h!.services.tasks.get(t.id)!.steps[0]! };
}

describe('Keo’s faceless video tool', () => {
  it('asks first, then makes the voice, the pictures and the whole timeline', async () => {
    const s = setup();
    const board = {
      title: 'Ocean air',
      pictureStyle: 'macro photo',
      look: 'cool',
      scenes: [
        { narration: 'Did you know the ocean makes most of your air?', title: 'Every second breath' },
        { narration: 'Tiny plants called phytoplankton do it.', picture: { prompt: 'glowing phytoplankton in blue water' } },
        { narration: 'So say thank you to the sea.' },
      ],
    };
    const wait = await run(s, 'studio.faceless', board, false);
    expect(wait.requiresApproval).toBe(true);
    expect(s.spoken).toHaveLength(0);
    const r = await run(s, 'studio.faceless', board);
    expect(r.step!.state).toBe('succeeded');
    const out = r.step!.result as { projectId: string; scenes: number; pictures: number; durationSec: number; voice: string };
    expect(out).toMatchObject({ scenes: 3, pictures: 3, voice: 'the test voice' });
    expect(s.spoken).toEqual(board.scenes.map((x) => x.narration));
    expect(s.pictures[1]).toMatch(/glowing phytoplankton in blue water\. Style: macro photo\. No text/);
    expect(s.pictures[0]).toMatch(/Did you know the ocean/);
    const p = h!.services.studio.get(out.projectId);
    expect(p.name).toBe('Ocean air');
    expect(p.tracks.find((t) => t.name === 'Voice')!.clips).toHaveLength(3);
    expect((p.tracks.find((t) => t.name === 'Video')!.clips[0] as MediaClip).color?.temperature).toBeLessThan(0);
    expect(p.tracks.find((t) => t.name === 'Captions')!.clips.length).toBeGreaterThan(5);
    expect(p.tracks.find((t) => t.name === 'Effects')!.clips).toHaveLength(2);
    expect(out.durationSec).toBeCloseTo(projectDuration(p), 2);
    // The pictures are Keo's own files (Documents\\Keo; in tests, the profile's created folder).
    expect(p.assets.filter((a) => a.kind === 'image').every((a) => /[\\/](Keo|created)[\\/]/.test(a.path))).toBe(true);
    // Everything it made can be undone in two steps (the look, then the timeline).
    h!.services.studio.undoEdit(out.projectId);
    h!.services.studio.undoEdit(out.projectId);
    expect(projectDuration(h!.services.studio.get(out.projectId))).toBe(0);
  });

  it('says what it needs when there is no voice', async () => {
    const dir = tempDir('keo-faceless-none-');
    h = makeHarness({ dir: path.join(dir, 'profile'), script: () => reply('ok') });
    const plan = h.services.facelessPlan(Storyboard.parse({ title: 'X', scenes: [{ narration: 'Hello there.' }] }));
    expect(plan.voice).toBeNull();
    expect(plan.reason).toMatch(/Keo account .* OpenAI API key/);
    await expect(h.services.facelessCreate(Storyboard.parse({ title: 'X', scenes: [{ narration: 'Hello there.' }] }))).rejects.toThrow(/voice needs/);
  });
});

describe('Faceless creator: plans, retries and failures', () => {
  const board = (n = 3) => Storyboard.parse({ title: 'Plan test', scenes: Array.from({ length: n }, (_, i) => ({ narration: `Scene number ${i + 1} is here.` })) });
  /** The account as Keo Cloud reports it (signed in, this plan, this much used today). */
  const plan = (features: Record<string, number>, usage: { images?: number; voiceSeconds?: number } = {}) => {
    const acc = h!.services.account as unknown as { status: () => unknown };
    const real = acc.status.bind(acc);
    acc.status = () => ({ ...(real() as object), signedIn: true, plan: { id: 'x', name: 'Free', dailyRequests: 1, dailyTokens: 1, features }, usage: { day: 'd', requests: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, images: usage.images ?? 0, voiceSeconds: usage.voiceSeconds ?? 0 } });
  };

  it('checks the plan’s pictures before anything is made', async () => {
    const s = setup();
    plan({ images: 0 });
    expect(h!.services.facelessPlan(board()).reason).toMatch(/not in your Free plan/);
    plan({ images: 5 }, { images: 4 });
    expect(h!.services.facelessPlan(board()).reason).toMatch(/needs 3 new pictures, and your plan makes 1 more today/);
    await expect(h!.services.facelessCreate(board())).rejects.toThrow(/makes 1 more today/);
    expect(s.spoken).toHaveLength(0);
    expect(s.pictures).toHaveLength(0);
    plan({ images: 10 }, { images: 4 });
    expect(h!.services.facelessPlan(board()).reason).toBeNull();
  });

  it('a failed run leaves no empty project, and the next try reuses what was made', async () => {
    const s = setup();
    // The pictures fail the first time (after the voice is made).
    let fail = true;
    const ai = (h!.services.pictures as unknown as { d: { ai: () => unknown } }).d;
    const realAi = ai.ai;
    ai.ai = () => ({ generate: async () => { if (fail) throw new Error('The picture service is busy'); return PNG_1PX; }, edit: async () => PNG_1PX });
    await expect(h!.services.facelessCreate(board())).rejects.toThrow(/busy\. What Keo already made is kept/);
    expect(h!.services.studio.list()).toHaveLength(0);
    expect(s.spoken).toHaveLength(3);
    fail = false;
    const r = await h!.services.facelessCreate(board());
    expect(r.scenes).toBe(3);
    // The voice was not made again.
    expect(s.spoken).toHaveLength(3);
    // And a third time, nothing new at all (pictures reused too).
    ai.ai = () => ({ generate: async () => { throw new Error('should not be asked'); }, edit: async () => PNG_1PX });
    expect(h!.services.facelessPlan(board()).reason).toBeNull();
    await h!.services.facelessCreate(board());
    ai.ai = realAi;
  });
});
