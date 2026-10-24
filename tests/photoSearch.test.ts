import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IndexBackend, IndexRow } from '../src/main/files/fileSearch';
import { parseVerdict, photoWords, pictureSize } from '../src/main/files/photoIndex';
import type { ChatRequest } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

/** Windows Search that knows nothing about these pictures (names like IMG_2041.jpg say nothing). */
class EmptyIndex implements IndexBackend {
  async query(): Promise<IndexRow[]> {
    return [];
  }
}

/** A JPEG header (APP0 + start-of-frame with the size), padded to look like a photo. */
function jpeg(width = 1200, height = 800, bytes = 20_000, seed = 0): Buffer {
  const b = Buffer.alloc(bytes, seed);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]).copy(b, 0);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.copy(b, 20);
  return b;
}

let h: Harness;
const homes: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** What the fake model "sees": a description chosen by the picture's bytes (the seed byte at the end). */
const SEEN: Record<number, string> = { 1: 'An orange wooden table on a sunny patio', 2: 'A grey cat asleep on a blue sofa', 3: 'A red bicycle leaning on a brick wall' };

function setup(o: { photos?: boolean; slow?: Promise<void> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-home-'));
  homes.push(home);
  const sent: ChatRequest[] = [];
  h = makeHarness({
    script: async (req) => {
      sent.push(req);
      if (o.slow) await o.slow;
      const img = req.messages[0]!.content.find((b) => b.type === 'image') as { dataBase64: string } | undefined;
      const seed = img ? Buffer.from(img.dataBase64, 'base64').at(-1)! : 0;
      const text = JSON.stringify({ description: SEEN[seed] ?? `Picture number ${seed}`, keywords: ['photo', `seed${seed}`], sensitive: false });
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 0, outputTokens: 0 }, model: 'keo-test-1', native: undefined };
    },
    deps: { fileIndex: new EmptyIndex(), homeDir: home, photoGapMs: 0 },
  });
  const put = (rel: string, data: Buffer) => {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    return full;
  };
  h.services.settings.update({ files: { searchEnabled: true, describePhotos: o.photos ?? true } });
  return { home, put, sent };
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

type Found = { results: Array<{ path: string; name: string; match: string; description?: string }>; note: string | null; trust: string };

async function describeAll() {
  await h.services.photos.estimate();
  await h.services.photos.start();
  await waitFor(() => ['done', 'failed', 'blocked'].includes(h.services.photos.state().phase));
  return h.services.photos.state();
}

describe('photo descriptions', () => {
  it('describes each picture once and keeps it; a changed picture is described again', async () => {
    const { put, sent } = setup();
    put('Downloads/IMG_2041.jpg', jpeg(1200, 800, 20_000, 1));
    const cat = put('Pictures/IMG_0007.jpg', jpeg(1200, 800, 20_000, 2));
    const est = await h.services.photos.estimate();
    expect(est).toMatchObject({ phase: 'ready', found: 2, described: 0, toDescribe: 2 });
    expect(est.approxTokens).toBeGreaterThan(0);
    expect(sent).toHaveLength(0); // counting sends nothing
    const done = await describeAll();
    expect(done).toMatchObject({ phase: 'done', done: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.messages[0]!.content.some((b) => b.type === 'image')).toBe(true);
    expect(h.services.photoStore.count()).toBe(2);

    // Unchanged: nothing to do, nothing sent.
    expect(await h.services.photos.estimate()).toMatchObject({ found: 2, described: 2, toDescribe: 0 });
    await describeAll();
    expect(sent).toHaveLength(2);

    // Changed (new content and time): described again.
    fs.writeFileSync(cat, jpeg(1200, 800, 21_000, 3));
    fs.utimesSync(cat, new Date(), new Date(Date.now() + 5000));
    expect(await h.services.photos.estimate()).toMatchObject({ toDescribe: 1 });
    await describeAll();
    expect(sent).toHaveLength(3);
    const bike = ok<Found>(await run('files.search', { query: 'red bicycle', kind: 'picture' }));
    expect(bike.results.map((r) => r.name)).toEqual(['IMG_0007.jpg']);
    expect(ok<Found>(await run('files.search', { query: 'grey cat', kind: 'picture' })).results).toHaveLength(0);
  });

  it('finds a picture by what is in it, not by its name', async () => {
    const { put, home } = setup();
    put('Downloads/IMG_2041.jpg', jpeg(1200, 800, 20_000, 1));
    put('Pictures/IMG_0007.jpg', jpeg(1200, 800, 20_000, 2));
    await describeAll();
    const found = ok<Found>(await run('files.search', { query: 'photo of the orange table', kind: 'picture', folder: path.join(home, 'Downloads') }));
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ name: 'IMG_2041.jpg', match: 'described' });
    expect(found.results[0]!.description).toMatch(/orange wooden table/);
    expect(found.trust).toMatch(/untrusted/);
    // Plural and "kind any" work too; another folder does not leak in.
    expect(ok<Found>(await run('files.search', { query: 'tables' })).results.map((r) => r.name)).toEqual(['IMG_2041.jpg']);
    expect(ok<Found>(await run('files.search', { query: 'orange table', folder: path.join(home, 'Pictures') })).results).toHaveLength(0);

    // Off: descriptions are not used (and nothing is sent).
    h.services.settings.update({ files: { describePhotos: false } });
    const off = ok<Found>(await run('files.search', { query: 'orange table', kind: 'picture' }));
    expect(off.results).toHaveLength(0);
    expect(off.note).toMatch(/Let Keo look at my photos/);
  });

  it('never describes pictures in excluded folders, tiny pictures or private-looking names', async () => {
    const { put, home, sent } = setup();
    put('Pictures/Private/IMG_1.jpg', jpeg(1200, 800, 20_000, 1));
    put('Pictures/icon.png', Buffer.alloc(2000, 1));
    put('Pictures/thumb.jpg', jpeg(100, 80, 20_000, 1));
    put('Pictures/bank statement.jpg', jpeg(1200, 800, 20_000, 1));
    put('Pictures/IMG_2.jpg', jpeg(1200, 800, 20_000, 2));
    h.services.settings.update({ files: { excluded: [path.join(home, 'Pictures', 'Private')] } });
    const done = await describeAll();
    // thumb.jpg is counted (big file) but skipped once its size is read; it is never sent.
    expect(done.phase).toBe('done');
    expect(sent).toHaveLength(1);
    expect(h.services.photoStore.count()).toBe(1);
  });

  it('sends nothing without the switch, or without consent for the provider', async () => {
    const { put, sent } = setup({ photos: false });
    const pic = put('Downloads/IMG_2041.jpg', jpeg(1200, 800, 20_000, 1));
    expect((await h.services.photos.start()).phase).toBe('blocked');
    const look = await run('files.look_at_pictures', { paths: [pic] });
    expect('rejected' in look && look.rejected).toMatch(/off|outside/i);
    expect(sent).toHaveLength(0);

    // Switch on, but the provider is a remote one the user has not allowed to see pictures.
    h.services.settings.update({ files: { describePhotos: true } });
    const remote = Object.create(h.provider, { id: { value: 'openrouter' }, destination: { value: () => 'OpenRouter (openrouter.ai)' } }) as typeof h.provider;
    h.services.providers.active = () => remote;
    const blocked = await h.services.photos.start();
    expect(blocked.phase).toBe('blocked');
    expect(blocked.message).toMatch(/not allowed yet/);
    expect(sent).toHaveLength(0);

    // With consent it may.
    h.services.settings.update({ permissions: { visionExport: { openrouter: true } } });
    await describeAll();
    expect(sent).toHaveLength(1);
  });

  it('shows progress, pauses and resumes, and stops at the cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { put, sent } = setup({ slow: gate });
    for (let i = 0; i < 12; i++) put(`Pictures/IMG_${i}.jpg`, jpeg(1200, 800, 20_000 + i, 1));
    h.services.settings.update({ files: { photoCap: 10 } });
    const states: Array<{ phase: string; done: number }> = [];
    h.services.setPush((ch, p) => {
      if (ch === 'files:photosChanged') states.push(p as { phase: string; done: number });
    });
    expect(await h.services.photos.estimate()).toMatchObject({ found: 12, toDescribe: 10 });
    await h.services.photos.start();
    await waitFor(() => sent.length === 1);
    h.services.photos.pause();
    release();
    await waitFor(() => h.services.photos.state().phase === 'paused');
    expect(h.services.photos.state().done).toBe(0); // the picture in flight when paused stays first in line
    const resumed = await h.services.photos.start();
    expect(resumed.phase).toBe('running');
    await waitFor(() => h.services.photos.state().phase === 'done');
    expect(h.services.photos.state()).toMatchObject({ done: 10, toDescribe: 10 });
    expect(h.services.photoStore.count()).toBe(10); // the cap: 2 left for the next run
    const progress = states.filter((s) => s.phase === 'running').map((s) => s.done);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(10);
    expect(await h.services.photos.estimate()).toMatchObject({ found: 12, described: 10, toDescribe: 2 });
  });

  it('looks at the newest pictures in a folder on demand, only after approval', async () => {
    const { put, home, sent } = setup();
    const old = put('Downloads/IMG_1000.jpg', jpeg(1200, 800, 20_000, 2));
    fs.utimesSync(old, new Date('2025-01-01'), new Date('2025-01-01'));
    put('Downloads/IMG_2041.jpg', jpeg(1200, 800, 20_000, 1));
    const downloads = path.join(home, 'Downloads');
    const asked = await run('files.look_at_pictures', { folder: downloads, count: 1 }, false);
    expect('needed' in asked && asked.needed).toBe(true);
    expect('preview' in asked && asked.preview?.dataExport).toMatch(/1 picture go/);
    expect(sent).toHaveLength(0);
    const r = ok<{ pictures: Array<{ name: string; status: string; description: string | null }>; trust: string }>(await run('files.look_at_pictures', { folder: downloads, count: 1 }));
    expect(r.pictures).toEqual([expect.objectContaining({ name: 'IMG_2041.jpg', status: 'described' })]);
    expect(r.trust).toMatch(/untrusted/);
    expect(sent).toHaveLength(1);
    // Kept: the next search finds it without sending anything.
    expect(ok<Found>(await run('files.search', { query: 'orange table', kind: 'picture' })).results[0]?.name).toBe('IMG_2041.jpg');
    expect(sent).toHaveLength(1);
  });

  it('suggests looking when a picture is not described yet', async () => {
    const { put } = setup();
    put('Downloads/IMG_2041.jpg', jpeg(1200, 800, 20_000, 1));
    const r = ok<Found>(await run('files.search', { query: 'orange table', kind: 'picture' }));
    expect(r.results).toHaveLength(0);
    expect(r.note).toMatch(/files__look_at_pictures/);
  });
});

describe('photo helpers', () => {
  it('reads sizes from PNG and JPEG headers', () => {
    expect(pictureSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    const png = Buffer.alloc(40);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(200, 20);
    expect(pictureSize(png)).toEqual({ width: 300, height: 200 });
  });

  it('keeps the words that say what is in the picture', () => {
    expect(photoWords('photo of the orange tables in Downloads')).toEqual(['orange', 'table', 'download']);
  });

  it('parses the model’s answer and refuses an empty one', () => {
    expect(parseVerdict('```json\n{"description":"A dog","keywords":["dog","Park"]}\n```')).toEqual({ description: 'A dog', keywords: ['dog', 'park'], sensitive: false });
    expect(parseVerdict('{"sensitive":true}')).toMatchObject({ sensitive: true, description: '' });
    expect(() => parseVerdict('{}')).toThrow();
  });
});
