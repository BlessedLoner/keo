import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiVideoError, AiVideoPending, estimateCost, FalVideo, modelSeconds, swapCost, type AiVideoRequest } from '../src/main/studio/aiVideo';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const req: AiVideoRequest = { model: 'kling-3-pro', image: Buffer.from('jpeg-bytes'), prompt: 'she smiles, slow push in', seconds: 5, audio: false, aspect: '9:16' };

/** A fake fal.ai: answers the queue, then the video. Records every call. */
function fakeFal(o: { statuses?: Array<Record<string, unknown>>; submitStatus?: number; result?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: unknown }> = [];
  const statuses = [...(o.statuses ?? [{ status: 'IN_QUEUE', queue_position: 2 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }])];
  const base = 'https://queue.fal.run/fal-ai/kling-video/requests/r1';
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.headers ? { headers: init.headers } : {}), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : init?.body ? { body: Buffer.from(init.body).toString() } : {}) });
    if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) return json(200, { upload_url: 'https://upload.fal.media/put/abc', file_url: 'https://v3.fal.media/files/keo-picture.jpg' });
    if (url === 'https://upload.fal.media/put/abc') return json(200, {});
    if (url.startsWith('https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video')) return json(o.submitStatus ?? 200, o.submitStatus && o.submitStatus >= 400 ? { detail: 'bad' } : { request_id: 'r1', status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
    if (url === `${base}/status`) return json(200, statuses.shift() ?? { status: 'COMPLETED' });
    if (url === `${base}/cancel`) return json(202, { status: 'CANCELLATION_REQUESTED' });
    if (url === base) return json(200, o.result ?? { video: { url: 'https://v3.fal.media/files/clip.mp4' } });
    if (url === 'https://v3.fal.media/files/clip.mp4') return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(5000).fill(7).buffer };
    return json(404, {});
  };
  return { fetch, calls };
}

const make = (f: ReturnType<typeof fakeFal>, key: string | null = 'fal-test-key', dir = tempDir('keo-ai-')) => ({ fal: new FalVideo({ key: () => key, dir, fetch: f.fetch, log, sleep: async () => undefined }), dir });

describe('AI shots through fal.ai (a fake fal.ai: nothing is paid)', () => {
  it('prices and lengths', () => {
    expect(modelSeconds('veo-3.1-fast', 5)).toBe(4);
    expect(modelSeconds('kling-3-pro', 5)).toBe(5);
    expect(estimateCost('kling-3-pro', 5, false)).toBe(0.56);
    expect(estimateCost('kling-3-pro', 5, true)).toBe(0.84);
    expect(estimateCost('veo-3.1-fast', 8, true)).toBe(1.2);
  });

  it('submits, waits, downloads and keeps the clip; the same request is never paid twice', async () => {
    const f = fakeFal();
    const { fal } = make(f);
    const stages: string[] = [];
    const r = await fal.generate(req, new AbortController().signal, { progress: (s) => stages.push(s) });
    expect(r.cached).toBe(false);
    expect(fs.readFileSync(r.file).length).toBe(5000);
    // The picture goes to fal.ai's storage first; the model gets its link.
    expect(f.calls[0]!.url).toContain('https://rest.fal.ai/storage/upload/initiate');
    expect(f.calls[1]).toMatchObject({ url: 'https://upload.fal.media/put/abc', method: 'PUT', body: 'jpeg-bytes' });
    const submit = f.calls[2]!;
    expect(submit.method).toBe('POST');
    expect(submit.headers?.Authorization).toBe('Key fal-test-key');
    expect(submit.body).toEqual({ prompt: 'she smiles, slow push in', start_image_url: 'https://v3.fal.media/files/keo-picture.jpg', duration: '5', generate_audio: false });
    expect(stages).toEqual(['queued', 'making', 'saving']);
    const n = f.calls.length;
    const again = await fal.generate(req, new AbortController().signal);
    expect(again).toEqual({ file: r.file, cached: true, seconds: 5 });
    expect(f.calls.length).toBe(n);
  });

  it('says clearly what went wrong', async () => {
    await expect(make(fakeFal(), null).fal.generate(req, new AbortController().signal)).rejects.toThrow(/fal.ai API key/);
    await expect(make(fakeFal({ submitStatus: 401 })).fal.generate(req, new AbortController().signal)).rejects.toThrow(/did not accept the API key/);
    await expect(make(fakeFal({ submitStatus: 402 })).fal.generate(req, new AbortController().signal)).rejects.toThrow(/no credit left/);
    await expect(make(fakeFal({ statuses: [{ status: 'COMPLETED', error: 'Content blocked' }] })).fal.generate(req, new AbortController().signal)).rejects.toThrow(/could not make the clip: Content blocked/);
    await expect(make(fakeFal({ result: { video: {} } })).fal.generate(req, new AbortController().signal)).rejects.toThrow(AiVideoError);
  });

  it('stopping asks fal.ai to cancel, so it is not charged', async () => {
    const f = fakeFal({ statuses: [{ status: 'IN_QUEUE' }, { status: 'IN_QUEUE' }, { status: 'IN_QUEUE' }] });
    const stop = new AbortController();
    const fal = new FalVideo({ key: () => 'k-123456789', dir: tempDir('keo-ai-'), fetch: f.fetch, log, sleep: async () => stop.abort() });
    await expect(fal.generate(req, stop.signal)).rejects.toThrow(/Stopped/);
    expect(f.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/cancel'))).toBe(true);
  });

  it('the clip lands on the AI shots track, marked as AI-made', async () => {
    const dir = tempDir('keo-ai-studio-');
    const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'video', duration: 5, width: 720, height: 1280, hasAudio: false }), changed: () => undefined });
    const p = s.create('AI', 'vertical');
    const clipFile = path.join(dir, 'ai.mp4');
    fs.writeFileSync(clipFile, 'x');
    const r = await s.addAiClip(p.id, clipFile, { at: 3, seconds: 5, about: 'AI clip of a character smiling' });
    const now = s.get(p.id);
    expect(now.assets.find((a) => a.id === r.asset.id)?.aiMade).toBe(true);
    const track = now.tracks.find((t) => t.name === 'AI shots')!;
    expect(track.clips.map((c) => [c.start, c.duration])).toEqual([[3, 5]]);
  });
});

describe('fal.ai stopping a request on its side', () => {
  it('says so plainly instead of "error 499"', async () => {
    const f = fakeFal();
    const plain = f.fetch;
    const fetch: typeof plain = async (url, init) => (url === 'https://queue.fal.run/fal-ai/kling-video/requests/r1' ? { ok: false, status: 499, json: async () => ({ detail: 'Request was cancelled.' }), arrayBuffer: async () => new ArrayBuffer(0) } : plain(url, init));
    const fal = new FalVideo({ key: () => 'k-123456789', dir: tempDir('keo-ai-'), fetch, log, sleep: async () => undefined });
    await expect(fal.generate(req, new AbortController().signal)).rejects.toThrow(/stopped this request before it finished \(on its side, not in Keo\)/);
  });
});

describe('A clip fal.ai takes long to make is never lost or paid twice', () => {
  it('is remembered when Keo stops waiting, resumed (not resubmitted) when asked again, and delivered', async () => {
    const queued = [{ status: 'IN_QUEUE', queue_position: 4 }];
    const f = fakeFal({ statuses: [...queued, ...queued] });
    const { fal } = make(f);
    // Keo waits no longer here: the request stays remembered.
    await expect(fal.generate(req, new AbortController().signal, { waitMs: 0, context: { projectId: 'pr_test0001', at: 2, about: 'x' } })).rejects.toThrow(AiVideoPending);
    expect(fal.pending().map((p) => [p.model, p.context?.at])).toEqual([['kling-3-pro', 2]]);
    const submits = () => f.calls.filter((c) => c.method === 'POST' && c.url.includes('queue.fal.run')).length;
    const uploads = () => f.calls.filter((c) => c.url.includes('storage/upload')).length;
    expect([submits(), uploads()]).toEqual([1, 1]);
    // Asked again: the same request is picked up, nothing is uploaded or submitted again.
    await expect(fal.generate(req, new AbortController().signal, { waitMs: 0 })).rejects.toThrow(AiVideoPending);
    expect([submits(), uploads()]).toEqual([1, 1]);
    // Later, the background check finds it finished and hands it over.
    const ready: string[] = [];
    await fal.checkPending((job, file) => ready.push(`${job.context?.projectId} ${path.basename(file)}`), () => undefined);
    expect(ready).toEqual([`pr_test0001 ${path.basename(fal.cacheFile(req))}`]);
    expect(fal.pending()).toEqual([]);
    expect([submits(), uploads()]).toEqual([1, 1]);
  });

  it('a clip fal.ai fails is forgotten and reported', async () => {
    const f = fakeFal({ statuses: [{ status: 'IN_QUEUE' }, { status: 'COMPLETED', error: 'Image blocked' }] });
    const { fal } = make(f);
    await expect(fal.generate(req, new AbortController().signal, { waitMs: 0 })).rejects.toThrow(AiVideoPending);
    const failed: string[] = [];
    await fal.checkPending(() => undefined, (_job, message) => failed.push(message));
    expect(failed).toEqual(['fal.ai could not make the clip: Image blocked']);
    expect(fal.pending()).toEqual([]);
  });

  it('stopping forgets the request after asking fal.ai to cancel it', async () => {
    const f = fakeFal({ statuses: [{ status: 'IN_QUEUE' }, { status: 'IN_QUEUE' }] });
    const stop = new AbortController();
    const fal = new FalVideo({ key: () => 'k-123456789', dir: tempDir('keo-ai-'), fetch: f.fetch, log, sleep: async () => stop.abort() });
    await expect(fal.generate(req, stop.signal)).rejects.toThrow(/asked to cancel/);
    expect(fal.pending()).toEqual([]);
  });
});

describe('Character swap (Wan Animate Replace, a fake fal.ai)', () => {
  it('prices by frames, 16 to a billed second', () => {
    // 10 s of 30 fps video = 300 frames = 18.75 billed seconds.
    expect(swapCost(10, 30, '720p')).toBe(1.5);
    expect(swapCost(10, 30, '480p')).toBe(0.75);
  });

  it('uploads the video and the picture, asks for the swap, keeps the result', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const base = 'https://queue.fal.run/fal-ai/wan/requests/s1';
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    let n = 0;
    const fetch = async (url: string, init?: { method?: string; body?: string | Uint8Array }) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        n++;
        return json(200, { upload_url: `https://upload.fal.media/put/${n}`, file_url: `https://v3.fal.media/files/up${n}` });
      }
      if (url.startsWith('https://upload.fal.media/put/')) return json(200, {});
      if (url === 'https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace') return json(200, { request_id: 's1', status_url: `${base}/status`, response_url: base });
      if (url === `${base}/status`) return json(200, { status: 'COMPLETED' });
      if (url === base) return json(200, { video: { url: 'https://v3.fal.media/files/swapped.mp4' } });
      if (url === 'https://v3.fal.media/files/swapped.mp4') return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(4000).buffer };
      return json(404, {});
    };
    const fal = new FalVideo({ key: () => 'k-123456789', dir: tempDir('keo-swap-'), fetch, log, sleep: async () => undefined });
    const r = await fal.swap({ video: Buffer.from('mp4'), image: Buffer.from('jpg'), resolution: '480p', seconds: 6 }, new AbortController().signal);
    expect(r.cached).toBe(false);
    const submit = calls.find((c) => c.url.endsWith('/animate/replace'))!;
    expect(submit.body).toEqual({ video_url: 'https://v3.fal.media/files/up1', image_url: 'https://v3.fal.media/files/up2', resolution: '480p', video_quality: 'high' });
    expect(calls.filter((c) => c.url.includes('storage/upload/initiate')).map((c) => (c.body as { content_type: string }).content_type)).toEqual(['video/mp4', 'image/jpeg']);
    expect((await fal.swap({ video: Buffer.from('mp4'), image: Buffer.from('jpg'), resolution: '480p', seconds: 6 }, new AbortController().signal)).cached).toBe(true);
    await expect(fal.swap({ video: Buffer.alloc(91 * 1024 * 1024), image: Buffer.from('jpg'), resolution: '480p', seconds: 6 }, new AbortController().signal)).rejects.toThrow(/over 90 MB/);
  });
});

describe('Same-face pictures of a character (Nano Banana, a fake fal.ai)', () => {
  it('sends the character’s picture as the reference and keeps the new picture', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const base = 'https://queue.fal.run/fal-ai/nano-banana/requests/p1';
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    const fetch = async (url: string, init?: { method?: string; body?: string | Uint8Array }) => {
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) return json(200, { upload_url: 'https://upload.fal.media/put/1', file_url: 'https://v3.fal.media/files/kira.jpg' });
      if (url === 'https://upload.fal.media/put/1') return json(200, {});
      if (url === 'https://queue.fal.run/fal-ai/nano-banana/edit') return json(200, { request_id: 'p1', status_url: `${base}/status`, response_url: base });
      if (url === `${base}/status`) return json(200, { status: 'COMPLETED' });
      if (url === base) return json(200, { images: [{ url: 'https://v3.fal.media/files/new.png' }] });
      if (url === 'https://v3.fal.media/files/new.png') return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(3000).buffer };
      return json(404, {});
    };
    const fal = new FalVideo({ key: () => 'k-123456789', dir: tempDir('keo-pic-'), fetch, log, sleep: async () => undefined });
    const r = await fal.characterPicture({ image: Buffer.from('kira'), prompt: 'Kira on a rooftop at sunset', aspect: '9:16' }, new AbortController().signal);
    expect(r.file.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(r.file).length).toBe(3000);
    expect(calls.find((c) => c.url.endsWith('/nano-banana/edit'))!.body).toEqual({ prompt: 'Kira on a rooftop at sunset', image_urls: ['https://v3.fal.media/files/kira.jpg'], num_images: 1, output_format: 'png', aspect_ratio: '9:16' });
    expect((await fal.characterPicture({ image: Buffer.from('kira'), prompt: 'Kira on a rooftop at sunset', aspect: '9:16' }, new AbortController().signal)).cached).toBe(true);
  });
});
