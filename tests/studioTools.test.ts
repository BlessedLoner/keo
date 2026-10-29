import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupOf } from '../src/main/agent/toolGroups';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import type { RenderJob } from '../src/shared/studio';
import { wavOf } from '../src/main/studio/captions';
import { speechLike } from './fakeSpeechSound';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

/**
 * Keo's Studio tools, run the way the model's tool calls run (admission, task, approval). The
 * render window is faked: no real video is drawn, nothing is sent to a real model.
 */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface Setup {
  dir: string;
  conversationId: string;
  photo: string;
  song: string;
  jobs: RenderJob[];
  vision: ChatRequest[];
  transcribed: number[];
}

function setup(): Setup {
  const dir = tempDir('keo-studio-tools-');
  const photo = path.join(dir, 'beach.png');
  const song = path.join(dir, 'song.mp3');
  const other = path.join(dir, 'private.png');
  for (const f of [photo, song, other]) fs.writeFileSync(f, 'x');
  const jobs: RenderJob[] = [];
  const vision: ChatRequest[] = [];
  const transcribed: number[] = [];
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (req: ChatRequest) => {
      if (req.correlationId.startsWith('video_')) {
        vision.push(req);
        return reply(JSON.stringify({ frames: [{ time: 1, description: 'A beach with the title in the middle' }], problems: [] }));
      }
      return reply('ok');
    },
    deps: {
      videosDir: path.join(dir, 'Videos'),
      // Speech-to-text with word times (relative to the piece of sound it gets).
      videoTranscribe: async (wav) => {
        transcribed.push(wav.length);
        return [
          { startSec: 0.1, endSec: 0.5, text: 'Hello' },
          { startSec: 0.6, endSec: 1, text: 'everyone.' },
          { startSec: 3.1, endSec: 3.6, text: 'Welcome' },
          { startSec: 3.7, endSec: 4, text: 'back' },
        ];
      },
      // The render window: measuring, frames and exports are answered at once.
      studioProbe: async (file) => (file.endsWith('.mp3') ? { kind: 'audio', duration: 30, width: 0, height: 0, hasAudio: true } : { kind: 'image', duration: 0, width: 800, height: 600, hasAudio: false }),
      studioJob: (jobId, job) => {
        jobs.push(job);
        setTimeout(() => {
          const s = h!.services.studio;
          if (job.kind === 'frames') s.jobDone(jobId, job.times.map((time) => ({ time, pngBase64: PNG_1PX })), null);
          // The timeline's sound: speech from 1 to 2 s and from 4 to 5 s.
          else if (job.kind === 'asset_audio') s.jobDone(jobId, { wavBase64: wavOf(speechLike(8, [[1, 2], [4, 5]]), 16000).toString('base64') }, null);
          else if (job.kind === 'audio') s.jobDone(jobId, { wavBase64: wavOf(speechLike(8, [[1, 2], [4, 5]]), 16000).toString('base64') }, null);
          else s.jobDone(jobId, null, 'not in this test');
        }, 5);
      },
    },
  });
  h.services.settings.update({ agent: { approvalWaitSeconds: 10 } });
  const conv = h.services.conversations.create('studio');
  h.services.conversations.addMessage({ conversationId: conv.id, role: 'user', content: `Make a short video from ${photo} with my song.mp3`, status: 'complete' });
  return { dir, conversationId: conv.id, photo, song, jobs, vision, transcribed };
}

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

describe('Keo Studio tools', () => {
  it('are their own tool group (Studio)', () => {
    expect(groupOf('studio__edit')).toBe('studio');
    expect(groupOf('studio__look')).toBe('studio');
  });

  it('create a project, add the files the user named, edit, undo and redo', async () => {
    const s = setup();
    const o = await run(s, 'studio.open', { create: { name: 'Beach day', format: 'vertical' }, show: false });
    expect(o.step!.state).toBe('succeeded');
    const opened = o.step!.result as { projectId: string; timeline: string };
    expect(opened.projectId).toMatch(/^pr_/);
    expect(opened.timeline).toMatch(/Beach day: 1080x1920/);

    const m = await run(s, 'studio.add_media', { paths: [s.photo, s.song], placeOnTimeline: true });
    expect(m.step!.state).toBe('succeeded');
    const added = m.step!.result as { added: Array<{ id: string; kind: string }>; durationSec: number };
    expect(added.added.map((a) => a.kind)).toEqual(['image', 'audio']);
    expect(added.durationSec).toBe(30);

    const e = await run(s, 'studio.edit', { ops: [{ op: 'add_text', text: 'Beach day', start: 0, duration: 2, animIn: 'words', style: { sizePct: 9, glow: 12 } }] });
    expect(e.step!.state).toBe('succeeded');
    expect((e.step!.result as { timeline: string }).timeline).toMatch(/text “Beach day”/);
    const p = h!.services.studio.resolve();
    expect(p.tracks[1]!.clips).toHaveLength(1);

    // A wrongly written op is explained exactly, and nothing changes.
    const typo = await run(s, 'studio.edit', { ops: [{ op: 'add_text', text: 'Big', start: 0, duration: 2, style: { sizePct: 99 } }] });
    expect(typo.step!.state).toBe('failed');
    expect(typo.step!.error).toContain('Nothing was changed. Fix: ops[0].style.sizePct: Too big');
    // An impossible edit changes nothing.
    const bad = await run(s, 'studio.edit', { ops: [{ op: 'delete', clip: 'cl_missing1' }] });
    expect(bad.step!.state).toBe('failed');
    expect(h!.services.studio.resolve().tracks[1]!.clips).toHaveLength(1);

    const u = await run(s, 'studio.undo', {});
    expect(u.step!.state).toBe('succeeded');
    expect(h!.services.studio.resolve().tracks[1]!.clips).toHaveLength(0);
    await run(s, 'studio.undo', { redo: true });
    expect(h!.services.studio.resolve().tracks[1]!.clips).toHaveLength(1);
  });

  it('use only media the user named (or picks)', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'X', format: 'square' }, show: false });
    const r = await run(s, 'studio.add_media', { paths: [path.join(s.dir, 'private.png')] });
    expect(r.step!.state).toBe('failed');
    expect(r.step!.error).toMatch(/only files the user named or picked/);
    expect(h!.services.studio.resolve().assets).toHaveLength(0);
    const rel = await run(s, 'studio.add_media', { paths: ['beach.png'] });
    expect(rel.step!.error).toMatch(/full path/);
    // Without paths the picker opens; in tests there is none.
    const pick = await run(s, 'studio.add_media', {});
    expect(pick.step!.error).toMatch(/file picker/);
  });

  it('look at drawn frames of the timeline to check the work', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Look', format: 'vertical' }, show: false });
    await run(s, 'studio.add_media', { paths: [s.photo], placeOnTimeline: true });
    const r = await run(s, 'studio.look', { times: [1, 99], question: 'Is the title readable?' });
    expect(r.step!.state).toBe('succeeded');
    expect(s.jobs.find((j) => j.kind === 'frames')).toMatchObject({ kind: 'frames', times: [1, 2.98], width: 512 });
    expect((r.step!.result as { answer: string }).answer).toMatch(/beach/);
    const sent = s.vision.at(-1)!.messages[0]!.content;
    expect(sent.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(JSON.stringify(sent)).toContain('Is the title readable?');
  });

  it('show the checklist in Studio', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Steps', format: 'vertical' }, show: false });
    const seen: unknown[] = [];
    h!.services.setPush((channel, payload) => {
      if (channel === 'studio:progress') seen.push(payload);
    });
    const r = await run(s, 'studio.checklist', { steps: [{ label: 'Find silences', status: 'done' }, { label: 'Add captions', status: 'running' }] });
    expect(r.step!.state).toBe('succeeded');
    expect(seen).toContainEqual(expect.objectContaining({ stage: 'checklist', steps: [expect.objectContaining({ label: 'Find silences' }), expect.objectContaining({ status: 'running' })] }));
  });

  it('add word-by-word captions after the user approves sending the sound', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Talk', format: 'vertical' }, show: false });
    await run(s, 'studio.add_media', { paths: [s.song], placeOnTimeline: true });
    const wait = await run(s, 'studio.captions', {}, false);
    expect(wait.requiresApproval).toBe(true);
    expect(s.transcribed).toHaveLength(0);
    const r = await run(s, 'studio.captions', { maxWords: 2 });
    expect(r.step!.state).toBe('succeeded');
    expect(r.step!.result).toMatchObject({ lines: 2, words: 4, exactTiming: true });
    // One piece of sound: from the first speech (about 0.95 s) to the end of the last.
    expect(s.transcribed).toHaveLength(1);
    const tr = h!.services.studio.resolve().tracks.find((t) => t.name === 'Captions')!;
    const first = tr.clips[0]!;
    expect(first.type === 'text' && first.text).toBe('Hello everyone.');
    expect(first.start).toBeGreaterThan(0.9);
    expect(first.start).toBeLessThan(1.2);
    expect(first.type === 'text' && first.words!.map((w) => w.text)).toEqual(['Hello', 'everyone.']);
    // One undo removes them all.
    await run(s, 'studio.undo', {});
    expect(h!.services.studio.resolve().tracks.find((t) => t.name === 'Captions')).toBeUndefined();
  });

  it('export only after the user approves', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Out', format: 'vertical' }, show: false });
    await run(s, 'studio.add_media', { paths: [s.photo], placeOnTimeline: true });
    const r = await run(s, 'studio.export', {}, false);
    expect(r.requiresApproval).toBe(true);
    expect(r.step!.state).toBe('awaiting_authorization');
    expect(s.jobs.some((j) => j.kind === 'export')).toBe(false);
  });
});
