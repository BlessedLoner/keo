import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { counterText, motionAt } from '../src/shared/studioMotion';
import { applyEdits, describeProject, EASES, keyValue, newProject, type Asset, type MediaClip, type Project, type RenderJob, type ShapeClip, type TextClip } from '../src/shared/studio';
import { PRESETS, presetOps, type PresetId } from '../src/shared/studioPresets';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const pic: Asset = { id: 'as_logo0001', kind: 'image', path: 'C:\\p\\logo.png', name: 'logo.png', duration: 0, width: 512, height: 512, hasAudio: false };

function project(): Project {
  n = 0;
  return { ...newProject({ name: 'Motion', rand }), assets: [pic] };
}
const clips = (p: Project) => p.tracks.flatMap((t) => t.clips);

describe('Studio motion: keyframes and easing', () => {
  it('eases between keyframes and holds before the first and after the last', () => {
    const keys = [
      { at: 1, value: 0, ease: 'linear' as const },
      { at: 3, value: 10, ease: 'linear' as const },
      { at: 4, value: 20, ease: 'hold' as const },
    ];
    expect(keyValue(keys, 0)).toBe(0);
    expect(keyValue(keys, 2)).toBe(5);
    expect(keyValue(keys, 3.9)).toBe(10);
    expect(keyValue(keys, 4)).toBe(20);
    expect(keyValue(keys, 9)).toBe(20);
    expect(EASES.back(0.5)).toBeGreaterThan(0.5);
    expect(EASES.bounce(1)).toBeCloseTo(1, 5);
    expect(EASES.elastic(0)).toBe(0);
  });

  it('keyframes move with their clip: a split keeps the motion continuous', () => {
    let p = applyEdits(project(), [{ op: 'add_shape', shape: 'circle', start: 2, duration: 4, keys: { x: [{ at: 0, value: 0.2, ease: 'linear' }, { at: 4, value: 0.8, ease: 'linear' }] } }], { rand }).project;
    const id = clips(p).find((c) => c.type === 'shape')!.id;
    p = applyEdits(p, [{ op: 'split', clip: id, at: 4 }], { rand }).project;
    const [a, b] = clips(p).filter((c): c is ShapeClip => c.type === 'shape');
    expect(keyValue(a!.keys!.x!, 2)).toBeCloseTo(0.5, 5);
    expect(keyValue(b!.keys!.x!, 0)).toBeCloseTo(0.5, 5);
    expect(keyValue(b!.keys!.x!, 2)).toBeCloseTo(0.8, 5);
    // The same moment on screen, before and after the split.
    expect(motionAt(b!, 5, 1080).x).toBeCloseTo(0.65, 5);
  });

  it('a set replaces or removes one property’s keyframes and leaves the others', () => {
    let p = applyEdits(project(), [{ op: 'add_shape', shape: 'rect', start: 0, duration: 2, keys: { x: [{ at: 0, value: 0.1, ease: 'linear' }], scale: [{ at: 0, value: 2, ease: 'hold' }] } }], { rand }).project;
    const id = clips(p)[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, keys: { x: null, opacity: [{ at: 1, value: 0.5, ease: 'out' }] } }], { rand }).project;
    const s = clips(p)[0] as ShapeClip;
    expect(Object.keys(s.keys!).sort()).toEqual(['opacity', 'scale']);
  });
});

describe('Studio motion: entrances, exits and loops', () => {
  it('slide, pop, wipe and flash at the right moments, and nothing in the middle', () => {
    const p = applyEdits(project(), [{ op: 'add_shape', shape: 'rect', start: 0, duration: 4, enter: { kind: 'slide-left', seconds: 0.5 }, exit: { kind: 'wipe-right', seconds: 0.5 } }], { rand }).project;
    const s = clips(p)[0] as ShapeClip;
    expect(motionAt(s, 0, 1080).x).toBeGreaterThan(1);
    expect(motionAt(s, 2, 1080)).toMatchObject({ x: 0.5, reveal: null, opacity: 1 });
    expect(motionAt(s, 3.75, 1080).reveal).toMatchObject({ kind: 'wipe-right' });
    const flash = applyEdits(project(), [{ op: 'add_media', assetId: pic.id, start: 0, duration: 2, enter: { kind: 'flash', seconds: 0.4 } }], { rand }).project;
    expect(motionAt(clips(flash)[0] as MediaClip, 0.1, 1080).flash).toBeGreaterThan(0.5);
  });

  it('loops keep moving while the layer is on', () => {
    const p = applyEdits(project(), [{ op: 'add_text', text: 'Hi', start: 0, duration: 5, loop: { kind: 'float', amount: 1, period: 2 } }], { rand }).project;
    const t = clips(p).find((c) => c.type === 'text') as TextClip;
    expect(motionAt(t, 0.5, 1080).y).not.toBeCloseTo(motionAt(t, 1.5, 1080).y, 3);
  });

  it('text keeps its own animations; entrances are for videos, pictures and shapes', () => {
    const p = applyEdits(project(), [{ op: 'add_text', text: 'Hi', start: 0, duration: 2 }], { rand }).project;
    const id = clips(p).find((c) => c.type === 'text')!.id;
    expect(() => applyEdits(p, [{ op: 'set', clip: id, enter: { kind: 'pop', seconds: 0.4 } }], { rand })).toThrow(/use animIn for text/);
  });

  it('counters count with an ease-out and then hold', () => {
    const c = { from: 0, to: 10000, decimals: 0, prefix: '$', suffix: '+', separator: true, seconds: 2 };
    expect(counterText(c, 0, 3)).toBe('$0+');
    expect(counterText(c, 2, 3)).toBe('$10,000+');
    expect(counterText(c, 9, 3)).toBe('$10,000+');
    const mid = Number(counterText(c, 1, 3).replace(/[$+,]/g, ''));
    expect(mid).toBeGreaterThan(5000);
  });
});

describe('Studio motion: elements, masks and mock-ups', () => {
  it('shapes go on a Graphics track above the videos and under text', () => {
    const p = applyEdits(project(), [{ op: 'add_shape', shape: 'star', start: 1, duration: 2, style: { fill: '#FFD400', glow: 20 } }], { rand }).project;
    expect(p.tracks.map((t) => t.name)).toEqual(['Video', 'Graphics', 'Text', 'Audio']);
    expect(describeProject(p)).toMatch(/star 0.5x0.1 at 0.5,0.5 #FFD400/);
  });

  it('media gets a mask, a device frame and a shadow; text gets a counter', () => {
    let p = applyEdits(project(), [{ op: 'add_media', assetId: pic.id, start: 0, duration: 3, frame: 'phone', enter: { kind: 'slide-up', seconds: 0.6 } }], { rand }).project;
    const id = clips(p)[0]!.id;
    p = applyEdits(p, [{ op: 'set', clip: id, mask: { shape: 'circle', radius: 0.5 }, shadow: 20, frame: null }], { rand }).project;
    const m = clips(p)[0] as MediaClip;
    expect(m).toMatchObject({ mask: { shape: 'circle' }, shadow: 20, enter: { kind: 'slide-up' } });
    expect(m.frame).toBeUndefined();
    expect(describeProject(p)).toMatch(/\[in slide-up, circle mask\]/);
    expect(() => applyEdits(p, [{ op: 'set', clip: id, counter: { from: 0, to: 5, decimals: 0, prefix: '', suffix: '', separator: true } }], { rand })).toThrow(/no counter/);
  });

  it('every preset is valid edits (media presets need a picture or video)', () => {
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      const p = project();
      const ops = presetOps(p, id, { at: 1, text: id === 'counter' ? '25,000 views' : 'Big news today', subtext: 'Founder', assetId: pic.id });
      const r = applyEdits(p, ops, { rand });
      expect(r.changes.length, id).toBeGreaterThan(0);
    }
    expect(() => presetOps(project(), 'phone', { at: 0 })).toThrow(/needs a picture or video/);
    expect(() => presetOps(project(), 'counter', { at: 0, text: 'no number' })).toThrow(/needs a number/);
    const counter = applyEdits(project(), presetOps(project(), 'counter', { at: 0, text: '$2.5M raised' }), { rand }).project;
    expect((clips(counter).find((c) => c.type === 'text') as TextClip).counter).toMatchObject({ to: 2.5, decimals: 1, prefix: '$', suffix: 'M raised' });
    const words = presetOps(project(), 'kinetic-words', { at: 0, text: 'one two three' });
    expect(words).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ tools

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function setup() {
  const dir = tempDir('keo-motion-');
  const tpl = path.join(dir, 'template.mp4');
  fs.writeFileSync(tpl, 'x');
  const jobs: RenderJob[] = [];
  const asked: ChatRequest[] = [];
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    script: (req: ChatRequest) => {
      if (req.correlationId.startsWith('video_')) {
        asked.push(req);
        return reply(JSON.stringify({ palette: ['#0A0A12', '#8B6BFF'], frames: [{ time: 1, text: [{ words: 'BIG IDEA', effects: 'glow' }] }], recipe: 'Dark background, glowing kinetic words' }));
      }
      return reply('ok');
    },
    deps: {
      studioProbe: async () => ({ kind: 'video', duration: 6, width: 1080, height: 1920, hasAudio: false }),
      studioJob: (jobId, job) => {
        jobs.push(job);
        setTimeout(() => h!.services.studio.jobDone(jobId, job.kind === 'frames' ? job.times.map((time) => ({ time, pngBase64: PNG_1PX })) : null, job.kind === 'frames' ? null : 'not in this test'), 5);
      },
    },
  });
  h.services.settings.update({ agent: { approvalWaitSeconds: 10 } });
  const conv = h.services.conversations.create('motion');
  h.services.conversations.addMessage({ conversationId: conv.id, role: 'user', content: `Make something in the style of ${tpl}`, status: 'complete' });
  return { conversationId: conv.id, tpl, jobs, asked, dir };
}

async function run(s: { conversationId: string }, capabilityId: string, input: unknown) {
  const a = h!.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason, step: null };
  const t = h!.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: s.conversationId, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h!.services.tasks.submit(t.id);
  const first = h!.services.tasks.get(t.id)!.steps[0]!;
  if (first.state === 'awaiting_authorization') h!.services.tasks.approveStep(first.id, first.inputHash);
  else h!.services.tasks.pump();
  await waitFor(() => ['succeeded', 'failed', 'outcome_uncertain'].includes(h!.services.tasks.get(t.id)!.steps[0]!.state), 8000);
  return { rejected: null, step: h!.services.tasks.get(t.id)!.steps[0]! };
}

describe('Keo’s motion tools', () => {
  it('add presets as one edit each', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Promo', format: 'vertical' }, show: false });
    const r = await run(s, 'studio.preset', { preset: 'lower-third', at: 1, text: 'Ada Obi', subtext: 'Founder, Keo', color2: '#FF3D7F' });
    expect(r.step!.state).toBe('succeeded');
    const p = h!.services.studio.resolve();
    expect(clips(p).filter((c) => c.type === 'shape')).toHaveLength(2);
    expect(clips(p).filter((c) => c.type === 'text').map((c) => (c as TextClip).text)).toEqual(['Ada Obi', 'Founder, Keo']);
    const bad = await run(s, 'studio.preset', { preset: 'avatar', at: 0 });
    expect(bad.step!.error).toMatch(/needs a picture or video/);
    await run(s, 'studio.undo', {});
    expect(clips(h!.services.studio.resolve())).toHaveLength(0);
  });

  it('study a template from its own frames, without putting it on the timeline', async () => {
    const s = setup();
    await run(s, 'studio.open', { create: { name: 'Copy the style', format: 'vertical' }, show: false });
    const m = await run(s, 'studio.add_media', { paths: [s.tpl] });
    const assetId = (m.step!.result as { added: Array<{ id: string }> }).added[0]!.id;
    const r = await run(s, 'studio.study_template', { assetId, frames: 8 });
    expect(r.step!.state).toBe('succeeded');
    expect((r.step!.result as { study: string }).study).toMatch(/glowing kinetic words/);
    // Eight frames in two batches, spread over the video; eight pictures sent once.
    const frameJobs = s.jobs.filter((j): j is Extract<RenderJob, { kind: 'frames' }> => j.kind === 'frames');
    expect(frameJobs.map((j) => j.times.length)).toEqual([6, 2]);
    expect(frameJobs[0]!.projectId).not.toBe(h!.services.studio.resolve().id);
    expect(s.asked.at(-1)!.messages[0]!.content.filter((b) => b.type === 'image')).toHaveLength(8);
    // The short-lived project is gone and the timeline is untouched.
    expect(h!.services.studio.list()).toHaveLength(1);
    expect(clips(h!.services.studio.resolve())).toHaveLength(0);
  });
});
