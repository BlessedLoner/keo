import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AI shots: a picture turned into a short video clip by an AI video model, through fal.ai (one
 * account and key, many models), paid per second by the user. Every finished clip is kept on
 * this PC, so the same request is never paid for twice. The key is only sent to fal.ai, never
 * logged or shown.
 */

export interface AiVideoModel {
  label: string;
  /** fal.ai's endpoint id. */
  endpoint: string;
  /** Seconds the model can make. */
  seconds: number[];
  /** About this many US dollars a second (fal.ai's list price when this was written: check fal.ai/pricing). */
  perSecond: { silent: number; audio: number };
  input(o: { prompt: string; image: string; seconds: number; audio: boolean; aspect: '9:16' | '16:9' | '1:1' }): Record<string, unknown>;
}

export const AI_VIDEO_MODELS = {
  // The everyday choice: good value, keeps a face and a look steady.
  'kling-3-pro': {
    label: 'Kling 3 Pro',
    endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
    seconds: [3, 4, 5, 6, 7, 8, 9, 10],
    perSecond: { silent: 0.112, audio: 0.168 },
    input: (o) => ({ prompt: o.prompt, start_image_url: o.image, duration: String(o.seconds), generate_audio: o.audio }),
  },
  // Cheaper drafts, and clips with their own sound.
  'veo-3.1-fast': {
    label: 'Veo 3.1 Fast',
    endpoint: 'fal-ai/veo3.1/fast/image-to-video',
    seconds: [4, 6, 8],
    perSecond: { silent: 0.1, audio: 0.15 },
    input: (o) => ({ prompt: o.prompt, image_url: o.image, duration: `${o.seconds}s`, aspect_ratio: o.aspect === '1:1' ? 'auto' : o.aspect, resolution: '720p', generate_audio: o.audio }),
  },
} satisfies Record<string, AiVideoModel>;
export type AiVideoModelId = keyof typeof AI_VIDEO_MODELS;

/** The nearest length a model can make. */
export function modelSeconds(model: AiVideoModelId, want: number): number {
  const options = AI_VIDEO_MODELS[model].seconds;
  return options.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), options[0]!);
}

/** About what one clip costs, in US dollars (rounded up to the cent). */
export function estimateCost(model: AiVideoModelId, seconds: number, audio: boolean): number {
  const m = AI_VIDEO_MODELS[model];
  // A hair below each cent first, so 0.56000000000000001 stays 0.56.
  return Math.ceil(modelSeconds(model, seconds) * (audio ? m.perSecond.audio : m.perSecond.silent) * 100 - 1e-6) / 100;
}

export class AiVideoError extends Error {}

export interface AiVideoRequest {
  model: AiVideoModelId;
  /** The picture, as JPEG bytes (Keo uploads it to fal.ai's storage and sends the model its link). */
  image: Buffer;
  prompt: string;
  seconds: number;
  audio: boolean;
  aspect: '9:16' | '16:9' | '1:1';
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export class FalVideo {
  constructor(
    private readonly d: {
      key: () => string | null;
      dir: string;
      fetch: Fetch;
      log: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
      /** Waits between status checks (tests make it instant). */
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** The file a request was (or will be) kept in. */
  cacheFile(r: AiVideoRequest): string {
    return path.join(this.d.dir, `ai-shot-${this.hashOf(r)}.mp4`);
  }
  /** The same request (model, picture, words, length, sound, shape) gives the same id. */
  hashOf(r: AiVideoRequest): string {
    const picture = crypto.createHash('sha256').update(r.image).digest('hex');
    return crypto.createHash('sha256').update(JSON.stringify([AI_VIDEO_MODELS[r.model].endpoint, r.prompt, picture, modelSeconds(r.model, r.seconds), r.audio, r.aspect])).digest('hex').slice(0, 24);
  }

  // ---------------------------------------------------------------- requests fal.ai is making

  /** Requests fal.ai accepted and has not finished for us yet (kept on disk: a paid clip is never lost). */
  pending(): PendingShot[] {
    try {
      return (JSON.parse(fs.readFileSync(path.join(this.d.dir, 'pending.json'), 'utf8')) as PendingShot[]).filter((p) => Date.now() - Date.parse(p.submittedAt) < 3 * 24 * 3600_000);
    } catch {
      return [];
    }
  }
  private savePending(list: PendingShot[]): void {
    fs.mkdirSync(this.d.dir, { recursive: true });
    const file = path.join(this.d.dir, 'pending.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
    fs.renameSync(`${file}.tmp`, file);
  }
  private forget(hash: string): void {
    this.savePending(this.pending().filter((p) => p.hash !== hash));
  }

  /**
   * Makes the clip, or finds it made before, or picks up the same request fal.ai is still making
   * (never paying twice). Waits up to `waitMs`; if fal.ai is not done by then, the request stays
   * remembered and AiVideoPending is thrown: finish() (or the background checks) get it later.
   */
  async generate(
    r: AiVideoRequest,
    signal: AbortSignal,
    o: { waitMs?: number; context?: PendingShot['context']; progress?: (stage: 'queued' | 'making' | 'saving', queuePosition?: number) => void } = {},
  ): Promise<{ file: string; cached: boolean; seconds: number }> {
    const seconds = modelSeconds(r.model, r.seconds);
    const hash = this.hashOf(r);
    const file = this.cacheFile(r);
    if (fs.existsSync(file)) return { file, cached: true, seconds };
    const key = this.d.key();
    if (!key) throw new AiVideoError('AI shots need a fal.ai API key: add one in Settings → Providers.');
    let job = this.pending().find((p) => p.hash === hash);
    if (job) this.d.log.info('studio.ai_shot_resumed', { model: r.model });
    else {
      const m = AI_VIDEO_MODELS[r.model];
      // The picture goes to fal.ai's storage first and the model gets its link (fal.ai advises
      // against sending pictures inside the request: large ones can make the request fail).
      const image = await this.upload(r.image, key, signal);
      const submitted = await this.call(key, `https://queue.fal.run/${m.endpoint}`, 'POST', signal, m.input({ ...r, image, seconds }));
      job = {
        hash,
        model: r.model,
        seconds,
        statusUrl: String(submitted.status_url ?? ''),
        resultUrl: String(submitted.response_url ?? ''),
        cancelUrl: typeof submitted.cancel_url === 'string' ? submitted.cancel_url : null,
        submittedAt: new Date().toISOString(),
        ...(o.context ? { context: o.context } : {}),
      };
      this.savePending([...this.pending().filter((p) => p.hash !== hash), job]);
      this.d.log.info('studio.ai_shot_submitted', { model: r.model, seconds });
    }
    try {
      const made = await this.finish(job, signal, { waitMs: o.waitMs ?? 5 * 60_000, ...(o.progress ? { progress: o.progress } : {}) });
      return { file: made, cached: false, seconds };
    } catch (e) {
      // Stopped by the user: ask fal.ai not to finish (and charge for) it, and forget it.
      if (signal.aborted) {
        if (job.cancelUrl) await this.d.fetch(job.cancelUrl, { method: 'PUT', headers: { Authorization: `Key ${key}` } }).catch(() => undefined);
        this.forget(hash);
        throw new AiVideoError('Stopped: fal.ai was asked to cancel the clip.');
      }
      throw e;
    }
  }

  /**
   * Waits for a remembered request (up to waitMs) and downloads its clip; throws AiVideoPending
   * if fal.ai is still making it, AiVideoError if it failed (then it is forgotten).
   */
  async finish(job: PendingShot, signal: AbortSignal, o: { waitMs: number; progress?: (stage: 'queued' | 'making' | 'saving', queuePosition?: number) => void }): Promise<string> {
    const key = this.d.key();
    if (!key) throw new AiVideoError('AI shots need a fal.ai API key: add one in Settings → Providers.');
    const file = path.join(this.d.dir, `ai-shot-${job.hash}.mp4`);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const started = Date.now();
    try {
      for (;;) {
        if (signal.aborted) throw new AiVideoError('Stopped.');
        const st = await this.call(key, job.statusUrl, 'GET', signal);
        if (st.status === 'COMPLETED') {
          if (st.error) throw new AiVideoError(`fal.ai could not make the clip: ${String(st.error).slice(0, 200)}`);
          break;
        }
        o.progress?.(st.status === 'IN_QUEUE' ? 'queued' : 'making', typeof st.queue_position === 'number' ? st.queue_position : undefined);
        if (Date.now() - started >= o.waitMs) throw new AiVideoPending(job);
        await sleep(4000);
      }
      const result = await this.call(key, job.resultUrl, 'GET', signal);
      const url = (result.video as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new AiVideoError('fal.ai finished but sent no video.');
      o.progress?.('saving');
      const video = await this.d.fetch(url, { signal });
      if (!video.ok) throw new AiVideoError(`The finished clip could not be downloaded (${video.status}).`);
      const bytes = Buffer.from(await video.arrayBuffer());
      if (bytes.length < 1000) throw new AiVideoError('fal.ai sent an empty video.');
      fs.mkdirSync(this.d.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, bytes);
      fs.renameSync(`${file}.tmp`, file);
      this.forget(job.hash);
      this.d.log.info('studio.ai_shot_made', { model: job.model, seconds: job.seconds, waitedMs: Date.now() - Date.parse(job.submittedAt) });
      return file;
    } catch (e) {
      // A request fal.ai failed is forgotten; one still being made (or a network hiccup) is kept.
      if (e instanceof AiVideoError && !(e instanceof AiVideoPending) && !signal.aborted) this.forget(job.hash);
      throw e;
    }
  }

  /**
   * Checks every remembered request once, briefly: the ones fal.ai finished are downloaded and
   * handed to onReady (Keo puts them on the timeline). Run at start-up and every minute or so.
   */
  async checkPending(onReady: (job: PendingShot, file: string) => void, onFailed: (job: PendingShot, message: string) => void): Promise<void> {
    if (this.checking || !this.d.key()) return;
    this.checking = true;
    try {
      for (const job of this.pending()) {
        try {
          onReady(job, await this.finish(job, new AbortController().signal, { waitMs: 0 }));
        } catch (e) {
          if (e instanceof AiVideoPending) continue;
          if (e instanceof AiVideoError) onFailed(job, e.message);
          // Anything else (offline): tried again next time.
        }
      }
    } finally {
      this.checking = false;
    }
  }
  private checking = false;

  private async call(key: string, url: string, method: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    if (!url.startsWith('https://queue.fal.run/')) throw new AiVideoError('fal.ai answered with an unexpected address.');
    const res = await this.d.fetch(url, { method, headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AiVideoError(falError(res.status, json));
    return json;
  }

  /** A JPEG put in fal.ai's storage (as fal.ai's own client does): its link for the model. */
  private async upload(jpeg: Buffer, key: string, signal: AbortSignal): Promise<string> {
    const start = await this.d.fetch('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg', file_name: 'keo-picture.jpg' }),
      signal,
    });
    const s = (await start.json().catch(() => ({}))) as { upload_url?: unknown; file_url?: unknown; detail?: unknown };
    if (!start.ok) throw new AiVideoError(falError(start.status, s as Record<string, unknown>));
    if (typeof s.upload_url !== 'string' || typeof s.file_url !== 'string' || !/^https:\/\//.test(s.upload_url) || !/^https:\/\//.test(s.file_url)) throw new AiVideoError('fal.ai did not give an address to upload the picture to.');
    const put = await this.d.fetch(s.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg), signal });
    if (!put.ok) throw new AiVideoError(`The picture could not be uploaded to fal.ai (${put.status}).`);
    return s.file_url;
  }
}

/** A request fal.ai accepted, remembered until its clip is downloaded. */
export interface PendingShot {
  hash: string;
  model: AiVideoModelId;
  seconds: number;
  statusUrl: string;
  resultUrl: string;
  cancelUrl: string | null;
  submittedAt: string;
  /** Where the clip goes when it is ready. */
  context?: { projectId: string; at: number; about: string };
}

/** fal.ai is still making the clip: it is remembered and arrives later. */
export class AiVideoPending extends AiVideoError {
  constructor(readonly job: PendingShot) {
    super('fal.ai is still making the clip. Keo keeps checking and adds it to the timeline when it is ready (it will not be paid for twice).');
  }
}

/** fal.ai's error, in words for the user. */
function falError(status: number, json: Record<string, unknown>): string {
  const detail = typeof json.detail === 'string' ? json.detail : Array.isArray(json.detail) ? JSON.stringify(json.detail).slice(0, 200) : '';
  if (status === 401 || status === 403) return 'fal.ai did not accept the API key: check it in Settings → Providers.';
  if (status === 402) return 'The fal.ai account has no credit left: add credit at fal.ai/dashboard/billing.';
  if (status === 422) return `fal.ai could not use this request${detail ? `: ${detail}` : ''}.`;
  if (status === 429) return 'fal.ai is busy for this account right now: try again in a minute.';
  if (status === 499) return 'fal.ai stopped this request before it finished (on its side, not in Keo). Try again; if it keeps happening, try the other model.';
  return `fal.ai answered with an error (${status})${detail ? `: ${detail.slice(0, 200)}` : ''}.`;
}
