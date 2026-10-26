import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnimateSpec, buildAnimation } from '../src/main/pictures/animate';
import { buildEditGraph, EditOp } from '../src/main/pictures/edit';
import type { PictureAi } from '../src/main/pictures/studio';
import type { FfmpegRunner, RunOptions, RunResult } from '../src/main/video/ffmpeg';
import { makeHarness, type Harness } from './helpers';

/** ffmpeg and ffprobe in memory: ffprobe reports a 400×300 picture; ffmpeg "renders" by writing the output file. */
class FakeFfmpeg implements FfmpegRunner {
  runs: string[][] = [];
  texts: string[] = [];
  async ffprobe(): Promise<RunResult> {
    return { code: 0, stderr: '', stdout: Buffer.from(JSON.stringify({ format: { duration: '0.04' }, streams: [{ codec_type: 'video', width: 400, height: 300 }] })) };
  }
  async ffmpeg(args: string[], o: RunOptions): Promise<RunResult> {
    this.runs.push(args);
    // The text files exist while ffmpeg runs.
    if (o.cwd) for (const f of fs.readdirSync(o.cwd)) if (f.endsWith('.txt')) this.texts.push(fs.readFileSync(path.join(o.cwd, f), 'utf8'));
    fs.writeFileSync(args[args.length - 1]!, 'rendered');
    return { code: 0, stderr: '', stdout: Buffer.alloc(0) };
  }
}

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(o: { ai?: PictureAi | null } = {}) {
  const ff = new FakeFfmpeg();
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-docs-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-home-'));
  dirs.push(docs, home);
  const opened: string[] = [];
  h = makeHarness({
    deps: { videoRunner: () => ({ runner: ff, key: 'fake' }), documentsDir: docs, homeDir: home, pictureAi: o.ai ?? null, openPath: async (p) => (opened.push(p), true), fontsDir: 'C:\\Windows\\Fonts' },
  });
  const pic = path.join(home, 'Keo new logo.jpeg');
  fs.writeFileSync(pic, 'jpeg');
  return { ff, docs, home, pic, opened };
}

async function run(capabilityId: string, input: unknown, approve = true) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  const needed = step.state === 'awaiting_authorization';
  if (needed && !approve) return { needed, preview: a.preview, step } as const;
  if (needed) h.services.tasks.approveStep(step.id, step.inputHash);
  else h.services.tasks.pump();
  for (let i = 0; i < 200 && !['completed', 'failed', 'cancelled'].includes(h.services.tasks.get(t.id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
  return { needed, preview: a.preview, step: h.services.tasks.get(t.id)!.steps[0]! } as const;
}
function ok<T>(r: Awaited<ReturnType<typeof run>>): T {
  if ('rejected' in r) throw new Error(r.rejected);
  expect(r.step.error ?? null).toBeNull();
  expect(r.step.state).toBe('succeeded');
  return r.step.result as T;
}

describe('the edit graph', () => {
  it('extends the canvas, writes text from a file in a Windows font with a glow, and rounds the corners', () => {
    const ops = [
      { op: 'extend', right: 1, color: '#000000' },
      { op: 'text', text: 'KEO AI', x: 0.75, y: 0.5, size: 0.15, glow: '#4a7dff' },
      { op: 'round_corners', radius: 0.1 },
    ].map((o) => EditOp.parse(o));
    const g = buildEditGraph(ops, { width: 400, height: 300 }, { fontsDir: 'C:\\Windows\\Fonts', workDir: 'C:\\work' });
    expect(g.size).toEqual({ width: 800, height: 300 });
    expect(g.graph).toContain('pad=800:300:0:0:color=0x000000');
    expect(g.graph).toContain("fontfile='C\\:/Windows/Fonts/segoeuib.ttf'");
    expect(g.graph).toContain("textfile='C\\:/work/text1.txt'");
    expect(g.graph).toContain('boxblur=');
    expect(g.graph).toContain('geq=');
    expect(g.graph.endsWith('[out]')).toBe(true);
    expect(g.texts).toEqual([{ file: path.join('C:\\work', 'text1.txt'), text: 'KEO AI' }]);
  });

  it('never puts the words into the filter string, whatever they contain', () => {
    const g = buildEditGraph([EditOp.parse({ op: 'text', text: "Hi';drawtext=text=x,[0:v]:\\ end" })], { width: 100, height: 100 }, { fontsDir: 'F', workDir: 'W' });
    expect(g.graph).not.toContain('Hi');
    expect(g.graph).not.toContain('end');
  });

  it('overlays another picture as an extra input, and crops by fractions', () => {
    const g = buildEditGraph([EditOp.parse({ op: 'crop', x: 0.25, y: 0, width: 0.5, height: 1 }), EditOp.parse({ op: 'overlay', image: 'C:\\pics\\logo.png', width: 0.4 })], { width: 400, height: 300 }, { fontsDir: 'F', workDir: 'W' });
    expect(g.inputs).toEqual(['C:\\pics\\logo.png']);
    expect(g.graph).toContain('crop=200:300:100:0');
    expect(g.graph).toContain('[1:v]format=rgba,scale=80:-2');
  });

  it('builds MP4 (H.264) and GIF animations with quoted text expressions', () => {
    const mp4 = buildAnimation('in.png', { width: 800, height: 300 }, AnimateSpec.parse({ motion: 'float', text: { text: 'KEO AI', x: 0.75, entrance: 'slide_left' } }), 'out.mp4', { fontsDir: 'F', workDir: 'W' });
    const fc = mp4.args[mp4.args.indexOf('-filter_complex') + 1]!;
    expect(mp4.args).toContain('libx264');
    expect(fc).toMatch(/x='[^']*min\(1,max\(0,/);
    expect(fc).toContain('sin(2*PI*t/3.2)');
    const gif = buildAnimation('in.png', { width: 800, height: 300 }, AnimateSpec.parse({ motion: 'zoom', format: 'gif' }), 'out.gif', { fontsDir: 'F', workDir: 'W' });
    expect(gif.args[gif.args.indexOf('-filter_complex') + 1]).toContain('palettegen');
    expect(gif.args).not.toContain('libx264');
  });
});

describe('crops', () => {
  it('always fit inside the picture, even near the edges', async () => {
    const { cropBox } = await import('../src/main/pictures/edit');
    expect(cropBox({ width: 1024, height: 823 }, { x: 0.45, y: 0.5, width: 0.55, height: 0.5 })).toEqual({ x: 461, y: 412, w: 562, h: 410 });
    const c = cropBox({ width: 101, height: 77 }, { x: 0.99, y: 0.99, width: 1, height: 1 });
    expect(c.x + c.w).toBeLessThanOrEqual(101);
    expect(c.y + c.h).toBeLessThanOrEqual(77);
    expect(c.w).toBeGreaterThanOrEqual(2);
  });
});

describe('picture capabilities', () => {
  it('makes an edited copy in Documents\\Keo after approval, writes the text for ffmpeg, and opens it', async () => {
    const { ff, docs, pic, opened } = setup();
    const r = await run('picture.edit', { source: pic, operations: [{ op: 'extend', right: 1 }, { op: 'text', text: 'KEO AI', x: 0.75 }] }, false);
    expect('needed' in r && r.needed).toBe(true);
    const out = ok<{ path: string; width: number }>(await run('picture.edit', { source: pic, operations: [{ op: 'extend', right: 1 }, { op: 'text', text: 'KEO AI', x: 0.75 }], open: true }));
    expect(out.path).toBe(path.join(docs, 'Keo', 'Keo new logo edited.png'));
    expect(out.width).toBe(800);
    expect(fs.readFileSync(out.path, 'utf8')).toBe('rendered');
    expect(fs.readFileSync(pic, 'utf8')).toBe('jpeg'); // the original is untouched
    expect(ff.texts).toContain('KEO AI');
    expect(opened).toEqual([out.path]);
    // A second edit never overwrites the first.
    const again = ok<{ path: string }>(await run('picture.edit', { source: pic, operations: [{ op: 'grayscale' }] }));
    expect(again.path).toBe(path.join(docs, 'Keo', 'Keo new logo edited (2).png'));
  });

  it('animates a picture as MP4', async () => {
    const { pic } = setup();
    const out = ok<{ path: string; format: string }>(await run('picture.animate', { source: pic, motion: 'pulse', text: { text: 'KEO AI', entrance: 'fade' } }));
    expect(out.path.endsWith('Keo new logo animated.mp4')).toBe(true);
    expect(out.format).toBe('mp4');
  });

  it('refuses pictures outside the allowed folders and files that are not pictures', async () => {
    const { home } = setup();
    const outside = await run('picture.edit', { source: path.join(h.dir, 'x.png'), operations: [{ op: 'grayscale' }] });
    expect('rejected' in outside && outside.rejected).toMatch(/outside the folders/);
    const doc = path.join(home, 'notes.txt');
    fs.writeFileSync(doc, 'x');
    const r = await run('picture.edit', { source: doc, operations: [{ op: 'grayscale' }] });
    expect('rejected' in r).toBe(false);
    expect('step' in r ? r.step?.error : null).toMatch(/not a picture/);
  });

  it('hides AI pictures without an OpenAI key, and with one always asks and names the cost', async () => {
    setup();
    const none = await run('picture.generate', { prompt: 'a futuristic robot logo' });
    expect('rejected' in none && none.rejected).toMatch(/OpenAI API key/);
    await h.close();
    const calls: string[] = [];
    const ai: PictureAi = {
      generate: async (o) => (calls.push(`gen:${o.prompt}:${o.quality}`), Buffer.from('png-gen')),
      edit: async (o) => (calls.push(`edit:${o.name}:${o.background}`), Buffer.from('png-edit')),
    };
    const { pic, docs } = setup({ ai });
    h.services.settings.update({ autonomy: { level: 'hands_free' } });
    const r = await run('picture.generate', { prompt: 'a futuristic robot logo' }, false);
    expect('needed' in r && r.needed).toBe(true);
    expect('preview' in r && JSON.stringify(r.preview)).toMatch(/Costs money/);
    const g = ok<{ path: string }>(await run('picture.generate', { prompt: 'a futuristic robot logo' }));
    expect(fs.readFileSync(g.path, 'utf8')).toBe('png-gen');
    const e = ok<{ path: string }>(await run('picture.ai_edit', { source: pic, instruction: 'remove the background', background: 'transparent' }));
    expect(e.path).toBe(path.join(docs, 'Keo', 'Keo new logo no background.png'));
    expect(calls).toEqual(['gen:a futuristic robot logo:medium', 'edit:Keo new logo.jpeg:transparent']);
  });

  it('picks an image model the account has, replaces one OpenAI no longer has, and reports a refusal as not done', async () => {
    const { pic } = setup();
    await h.close();
    const ff = new FakeFfmpeg();
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-docs-'));
    dirs.push(docs);
    h = makeHarness({ deps: { videoRunner: () => ({ runner: ff, key: 'fake' }), documentsDir: docs, homeDir: path.dirname(pic), openPath: async () => true } });
    h.services.secrets.set('openai', 'sk-test-not-real');
    const { ProviderError } = await import('../src/main/providers/types');
    const used: string[] = [];
    const openai = h.services.providers.openai as unknown as Record<string, unknown>;
    openai.imageModels = async () => ['dall-e-3', 'gpt-image-1.5', 'whisper-1'];
    openai.generateImage = async (o: { model: string }) => {
      used.push(o.model);
      if (o.model === 'gpt-image-1') throw new ProviderError('bad_request', "OpenAI rejected the request: 400 The model 'gpt-image-1' does not exist.", { status: 400 });
      return Buffer.from('png');
    };
    // "auto" (the default) picks the newest the account has.
    ok(await run('picture.generate', { prompt: 'a robot logo' }));
    expect(used).toEqual(['gpt-image-1.5']);
    // A saved model OpenAI no longer has is replaced once.
    h.services.settings.update({ pictures: { aiModel: 'gpt-image-1' } });
    ok(await run('picture.generate', { prompt: 'a robot logo' }));
    expect(used.slice(1)).toEqual(['gpt-image-1', 'gpt-image-1.5']);
    // A refusal before anything happened is "failed — nothing made", never "uncertain".
    openai.generateImage = async () => {
      throw new ProviderError('quota', 'OpenAI: insufficient quota.', { status: 429 });
    };
    const r = await run('picture.generate', { prompt: 'a robot logo' });
    expect('step' in r && r.step?.state).toBe('failed');
    expect('step' in r ? r.step?.error : '').toMatch(/Nothing was made/);
  });

  it('shows only pictures and animations from Documents\\Keo or the allowed folders in the chat', () => {
    const { docs, pic } = setup();
    expect(h.services.viewablePicture(path.join(docs, 'Keo', 'x.png'))).toEqual({ mimeType: 'image/png' });
    expect(h.services.viewablePicture(path.join(docs, 'Keo', 'x.mp4'))).toEqual({ mimeType: 'video/mp4' });
    expect(h.services.viewablePicture(pic)).toEqual({ mimeType: 'image/jpeg' });
    expect(h.services.viewablePicture(path.join(h.dir, 'keo.db'))).toBeNull();
    expect(h.services.viewablePicture(path.join(docs, 'Keo', 'notes.txt'))).toBeNull();
    expect(h.services.viewablePicture(path.join('C:\\', 'Windows', 'System32', 'x.png'))).toBeNull();
  });
});
