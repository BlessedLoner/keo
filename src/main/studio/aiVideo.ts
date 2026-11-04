import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHARACTER_PICTURE_USD, MOTION_CLONE_PER_SECOND, REAL_PICTURE_USD, SWAP_PER_SECOND, swapCost, type SwapResolution } from '../../shared/aiPrices';

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

/** Swapping the person in a video for a character (fal.ai's Wan 2.2 Animate Replace). */
export const SWAP_MODEL = {
  label: 'Wan 2.2 Animate Replace',
  endpoint: 'fal-ai/wan/v2.2-14b/animate/replace',
  /** US dollars per "video second" (fal.ai bills 16 frames as one second). */
  perSecond: SWAP_PER_SECOND,
} as const;
export { swapCost, type SwapResolution };

export interface SwapRequest {
  /** The video file's bytes (MP4, up to 90 MB) and the character's picture (JPEG). */
  video: Buffer;
  image: Buffer;
  resolution: SwapResolution;
  seconds: number;
  /** Frames a second of the video sent (fal.ai bills every 16 frames). */
  fps?: number;
}

/** New pictures of a character from their own picture (the same face): fal.ai's Nano Banana edit. */
export const PICTURE_MODEL = {
  label: 'Nano Banana',
  endpoint: 'fal-ai/nano-banana/edit',
  /** US dollars a picture. */
  perPicture: CHARACTER_PICTURE_USD,
} as const;

/** Realistic pictures (Nano Banana Pro): the first frames of AI video shots, and a character put into a video's scene. */
export const REAL_PICTURE_MODEL = { label: 'Nano Banana Pro', edit: 'fal-ai/nano-banana-pro/edit', text: 'fal-ai/nano-banana-pro', perPicture: REAL_PICTURE_USD } as const;

/** A stable clone: the character performs the video's moves (Kling 2.6 Pro Motion Control, up to 30 s). */
export const MOTION_CLONE_MODEL = { label: 'Kling Motion Control', endpoint: 'fal-ai/kling-video/v2.6/pro/motion-control', perSecond: MOTION_CLONE_PER_SECOND, maxSeconds: 30 } as const;

/** A picture from words alone (fal.ai's Nano Banana), for AI video shots without a character. */
export const FRAME_MODEL = { label: 'Nano Banana', endpoint: 'fal-ai/nano-banana', perPicture: CHARACTER_PICTURE_USD } as const;

export interface CharacterPictureRequest {
  /** The character's own picture (JPEG) and what the new picture shows. */
  image: Buffer;
  prompt: string;
  aspect: '9:16' | '16:9' | '1:1' | '4:5';
}

interface RunOptions {
  waitMs?: number;
  context?: PendingShot['context'];
  progress?: (stage: 'queued' | 'making' | 'saving', queuePosition?: number) => void;
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
      /** The user's own fal.ai key (Settings → Advanced), used instead of Keo Cloud when set. */
      key: () => string | null;
      /** Keo Cloud: its gateway address and the user's fresh sign-in (null when signed out). Paid with Studio credits. */
      cloud?: { base: string; token: () => Promise<string | null> };
      dir: string;
      fetch: Fetch;
      log: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
      /** Waits between status checks (tests make it instant). */
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** The file a request with this id is (or will be) kept in. */
  cacheFileOf(hash: string, ext: ShotExt = 'mp4'): string {
    return path.join(this.d.dir, `ai-shot-${hash}.${ext}`);
  }

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
  async generate(r: AiVideoRequest, signal: AbortSignal, o: RunOptions = {}): Promise<{ file: string; cached: boolean; seconds: number }> {
    const m = AI_VIDEO_MODELS[r.model];
    const seconds = modelSeconds(r.model, r.seconds);
    return this.run(
      { hash: this.hashOf(r), model: r.model, seconds, endpoint: m.endpoint, uploads: [{ bytes: r.image, type: 'image/jpeg', name: 'keo-picture.jpg' }], input: ([image]) => m.input({ ...r, image: image!, seconds }) },
      signal,
      o,
    );
  }

  /** The same character swap (video, picture, quality) gives the same id. */
  swapHash(r: SwapRequest): string {
    const h = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    return crypto.createHash('sha256').update(JSON.stringify([SWAP_MODEL.endpoint, h(r.video), h(r.image), r.resolution])).digest('hex').slice(0, 24);
  }

  /** The person in a video replaced by the character in a picture (their motion, expressions and light kept). */
  async swap(r: SwapRequest, signal: AbortSignal, o: RunOptions = {}): Promise<{ file: string; cached: boolean; seconds: number }> {
    if (r.video.length > 90 * 1024 * 1024) throw new AiVideoError('That video file is over 90 MB: split it or export a shorter part first.');
    return this.run(
      {
        hash: this.swapHash(r),
        model: 'wan-animate-replace',
        seconds: r.seconds,
        endpoint: SWAP_MODEL.endpoint,
        uploads: [
          { bytes: r.video, type: 'video/mp4', name: 'keo-video.mp4' },
          { bytes: r.image, type: 'image/jpeg', name: 'keo-character.jpg' },
        ],
        input: ([video, image]) => ({ video_url: video!, image_url: image!, resolution: r.resolution, video_quality: 'high' }),
        meter: { seconds: r.seconds, fps: r.fps ?? 30 },
      },
      signal,
      o,
    );
  }

  /** The same picture request gives the same id. */
  pictureHash(r: CharacterPictureRequest): string {
    return crypto.createHash('sha256').update(JSON.stringify([PICTURE_MODEL.endpoint, crypto.createHash('sha256').update(r.image).digest('hex'), r.prompt, r.aspect])).digest('hex').slice(0, 24);
  }

  /** A new picture of a character, keeping their face: from their own picture and a description. */
  async characterPicture(r: CharacterPictureRequest, signal: AbortSignal): Promise<{ file: string; cached: boolean }> {
    const made = await this.run(
      {
        hash: this.pictureHash(r),
        model: 'nano-banana-edit',
        seconds: 0,
        ext: 'png',
        endpoint: PICTURE_MODEL.endpoint,
        uploads: [{ bytes: r.image, type: 'image/jpeg', name: 'keo-character.jpg' }],
        input: ([image]) => ({ prompt: r.prompt, image_urls: [image!], num_images: 1, output_format: 'png', aspect_ratio: r.aspect }),
      },
      signal,
      { waitMs: 3 * 60_000 },
    );
    return { file: made.file, cached: made.cached };
  }

  /**
   * The first frame of an AI video shot: from the characters' pictures (and the shot before, so the
   * place, clothes and light carry on) when there are any, else from the words alone.
   */
  async frame(r: { references: Buffer[]; prompt: string; aspect: '9:16' | '16:9' | '1:1'; quality?: 'real' | 'draft' }, signal: AbortSignal): Promise<{ file: string; cached: boolean }> {
    const refs = r.references.slice(0, 4);
    // Real: Nano Banana Pro at 2K (true skin, light and detail); draft: the fast, cheaper Nano Banana.
    const real = (r.quality ?? 'real') === 'real';
    const hash = crypto.createHash('sha256').update(JSON.stringify(['frame', real ? 'pro' : 'draft', refs.map((b) => crypto.createHash('sha256').update(b).digest('hex')), r.prompt, r.aspect])).digest('hex').slice(0, 24);
    const extra = real ? { resolution: '2K' } : {};
    const made = await this.run(
      refs.length
        ? {
            hash,
            model: real ? 'nano-banana-pro-edit' : 'nano-banana-edit',
            seconds: 0,
            ext: 'png',
            endpoint: real ? REAL_PICTURE_MODEL.edit : PICTURE_MODEL.endpoint,
            uploads: refs.map((bytes, i) => ({ bytes, type: 'image/jpeg', name: `keo-reference-${i + 1}.jpg` })),
            input: (urls) => ({ prompt: r.prompt, image_urls: urls, num_images: 1, output_format: 'png', aspect_ratio: r.aspect, ...extra }),
          }
        : { hash, model: real ? 'nano-banana-pro' : 'nano-banana', seconds: 0, ext: 'png', endpoint: real ? REAL_PICTURE_MODEL.text : FRAME_MODEL.endpoint, uploads: [], input: () => ({ prompt: r.prompt, num_images: 1, output_format: 'png', aspect_ratio: r.aspect, ...extra }) },
      signal,
      { waitMs: 4 * 60_000 },
    );
    return { file: made.file, cached: made.cached };
  }

  /** The same stable clone (video, picture) gives the same id. */
  motionHash(r: { video: Buffer; image: Buffer }): string {
    return crypto.createHash('sha256').update(JSON.stringify([MOTION_CLONE_MODEL.endpoint, crypto.createHash('sha256').update(r.video).digest('hex'), crypto.createHash('sha256').update(r.image).digest('hex')])).digest('hex').slice(0, 24);
  }

  /**
   * A stable clone: the character (a picture of them, ideally already in the video's place and pose)
   * performs exactly the moves of the video (Kling Motion Control). The whole picture is made
   * anew, so the character is the same in every frame: no flicker back to the original person.
   */
  async motionClone(r: { video: Buffer; image: Buffer; seconds: number }, signal: AbortSignal, o: RunOptions = {}): Promise<{ file: string; cached: boolean; seconds: number }> {
    if (r.video.length > 90 * 1024 * 1024) throw new AiVideoError('That video file is over 90 MB: choose a shorter part.');
    return this.run(
      {
        hash: this.motionHash(r),
        model: 'kling-motion-control',
        seconds: r.seconds,
        endpoint: MOTION_CLONE_MODEL.endpoint,
        uploads: [
          { bytes: r.video, type: 'video/mp4', name: 'keo-moves.mp4' },
          { bytes: r.image, type: 'image/jpeg', name: 'keo-character.jpg' },
        ],
        input: ([video, image]) => ({ video_url: video!, image_url: image!, character_orientation: 'video', keep_original_sound: false }),
        meter: { seconds: r.seconds, fps: 30 },
      },
      signal,
      o,
    );
  }

  /** The same line in the same voice sample gives the same id. */
  speechHash(r: OwnVoiceRequest): string {
    return crypto.createHash('sha256').update(JSON.stringify([OWN_VOICE_MODEL.endpoint, crypto.createHash('sha256').update(r.sample).digest('hex'), r.text])).digest('hex').slice(0, 24);
  }

  /** A line spoken in a character's own voice: like their voice sample (Chatterbox). */
  async speak(r: OwnVoiceRequest, signal: AbortSignal): Promise<{ file: string; cached: boolean }> {
    const made = await this.run(
      {
        hash: this.speechHash(r),
        model: 'chatterbox',
        seconds: 0,
        ext: 'wav',
        endpoint: OWN_VOICE_MODEL.endpoint,
        uploads: [{ bytes: r.sample, type: r.sampleType, name: `keo-voice.${r.sampleType.includes('mpeg') ? 'mp3' : 'wav'}` }],
        input: ([sample]) => ({ text: r.text, audio_url: sample!, exaggeration: 0.35, temperature: 0.7, cfg: 0.5 }),
      },
      signal,
      { waitMs: 3 * 60_000 },
    );
    return { file: made.file, cached: made.cached };
  }

  /** A new voice from a description: a sample of it saying the given line (MiniMax Voice Design). */
  async designVoice(r: { about: string; line: string }, signal: AbortSignal): Promise<{ file: string; cached: boolean }> {
    const hash = crypto.createHash('sha256').update(JSON.stringify([VOICE_DESIGN_MODEL.endpoint, r.about, r.line])).digest('hex').slice(0, 24);
    const made = await this.run(
      { hash, model: 'minimax-voice-design', seconds: 0, ext: 'mp3', endpoint: VOICE_DESIGN_MODEL.endpoint, uploads: [], input: () => ({ prompt: r.about, preview_text: r.line }) },
      signal,
      { waitMs: 3 * 60_000 },
    );
    return { file: made.file, cached: made.cached };
  }

  /** Any fal.ai request done the safe way: kept if made before, remembered while made, cancelled on Stop. */
  private async run(
    spec: { hash: string; model: PendingShot['model']; seconds: number; ext?: ShotExt; endpoint: string; uploads: Array<{ bytes: Buffer; type: string; name: string }>; input: (urls: string[]) => Record<string, unknown>; meter?: { seconds: number; fps: number } },
    signal: AbortSignal,
    o: RunOptions,
  ): Promise<{ file: string; cached: boolean; seconds: number }> {
    const { hash, seconds } = spec;
    const file = path.join(this.d.dir, `ai-shot-${hash}.${spec.ext ?? 'mp4'}`);
    if (fs.existsSync(file)) return { file, cached: true, seconds };
    const route = await this.route();
    if (!route) throw new AiVideoError(NO_ROUTE);
    let job = this.pending().find((p) => p.hash === hash);
    if (job) this.d.log.info('studio.ai_shot_resumed', { model: spec.model });
    else {
      // Pictures and videos go to fal.ai's storage first and the model gets their links (fal.ai
      // advises against sending files inside the request: large ones can make the request fail).
      let submitted: Record<string, unknown>;
      try {
        const urls: string[] = [];
        for (const u of spec.uploads) urls.push(await this.retried(signal, () => this.upload(u.bytes, u.type, u.name, route, signal)));
        // Through Keo Cloud the gateway prices the request, takes the credits and runs it with Keo's key.
        submitted = await this.retried(signal, () =>
          route.kind === 'own'
            ? this.call(`https://queue.fal.run/${spec.endpoint}`, 'POST', signal, spec.input(urls))
            : this.call(`${route.base}/studio/run`, 'POST', signal, { endpoint: spec.endpoint, input: spec.input(urls), ...(spec.meter ?? {}) }),
        );
      } catch (e) {
        if (signal.aborted) throw new AiVideoError('Stopped.');
        const message = e instanceof AiVideoError ? e.message : offline(e);
        this.d.log.warn('studio.ai_shot_not_sent', { model: spec.model, reason: message.slice(0, 300) });
        throw new AiVideoError(message);
      }
      job = {
        hash,
        model: spec.model,
        seconds,
        statusUrl: String(submitted.status_url ?? ''),
        resultUrl: String(submitted.response_url ?? ''),
        cancelUrl: typeof submitted.cancel_url === 'string' ? submitted.cancel_url : null,
        submittedAt: new Date().toISOString(),
        ...(spec.ext && spec.ext !== 'mp4' ? { ext: spec.ext } : {}),
        ...(o.context ? { context: o.context } : {}),
      };
      this.savePending([...this.pending().filter((p) => p.hash !== hash), job]);
      this.d.log.info('studio.ai_shot_submitted', { model: spec.model, seconds });
    }
    try {
      const made = await this.finish(job, signal, { waitMs: o.waitMs ?? 5 * 60_000, ...(o.progress ? { progress: o.progress } : {}) });
      return { file: made, cached: false, seconds };
    } catch (e) {
      // Stopped by the user: ask fal.ai not to finish (and charge for) it, and forget it.
      if (signal.aborted) {
        if (job.cancelUrl) await this.call(job.cancelUrl, 'PUT', new AbortController().signal).catch(() => undefined);
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
    const file = path.join(this.d.dir, `ai-shot-${job.hash}.${job.ext ?? 'mp4'}`);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const started = Date.now();
    try {
      for (;;) {
        if (signal.aborted) throw new AiVideoError('Stopped.');
        const st = await this.retried(signal, () => this.call(job.statusUrl, 'GET', signal));
        if (st.status === 'COMPLETED') {
          if (st.error) throw new AiVideoError(`fal.ai could not make the clip: ${String(st.error).slice(0, 200)}`);
          break;
        }
        o.progress?.(st.status === 'IN_QUEUE' ? 'queued' : 'making', typeof st.queue_position === 'number' ? st.queue_position : undefined);
        if (Date.now() - started >= o.waitMs) throw new AiVideoPending(job);
        await sleep(4000);
      }
      const result = await this.retried(signal, () => this.call(job.resultUrl, 'GET', signal));
      // A video model answers with video.url, a picture model with images[0].url, a voice with audio.url.
      const url = (result.video as { url?: unknown } | undefined)?.url ?? (result.images as Array<{ url?: unknown }> | undefined)?.[0]?.url ?? (result.audio as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new AiVideoError('fal.ai finished but sent nothing to download.');
      o.progress?.('saving');
      const video = await this.d.fetch(url, { signal });
      if (!video.ok) throw new AiVideoError(`The finished clip could not be downloaded (${video.status}).`);
      const bytes = Buffer.from(await video.arrayBuffer());
      if (bytes.length < 1000) throw new AiVideoError('fal.ai sent an empty file.');
      fs.mkdirSync(this.d.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, bytes);
      fs.renameSync(`${file}.tmp`, file);
      this.forget(job.hash);
      this.d.log.info('studio.ai_shot_made', { model: job.model, seconds: job.seconds, waitedMs: Date.now() - Date.parse(job.submittedAt) });
      return file;
    } catch (e) {
      // A request fal.ai failed is forgotten; one still being made (or a network hiccup) is kept.
      // Why it failed is written down, so it can be told to the user and looked into.
      if (e instanceof AiVideoError && !(e instanceof AiVideoPending) && !signal.aborted) {
        this.forget(job.hash);
        this.d.log.warn('studio.ai_shot_failed', { model: job.model, seconds: job.seconds, reason: e.message.slice(0, 300) });
      }
      throw e;
    }
  }

  /**
   * Checks every remembered request once, briefly: the ones fal.ai finished are downloaded and
   * handed to onReady (Keo puts them on the timeline). Run at start-up and every minute or so.
   */
  async checkPending(onReady: (job: PendingShot, file: string) => void, onFailed: (job: PendingShot, message: string) => void): Promise<void> {
    if (this.checking || !this.pending().length) return;
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

  /** Tries again (up to 3 times, a few seconds apart) when the network drops; fal.ai's own answers are not retried. */
  private async retried<T>(signal: AbortSignal, f: () => Promise<T>): Promise<T> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    for (let attempt = 1; ; attempt++) {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AiVideoError || signal.aborted || attempt >= 3) throw e;
        this.d.log.info('studio.ai_shot_retry', { attempt, reason: String((e as Error)?.message ?? e).slice(0, 120) });
        await sleep(3000 * attempt);
      }
    }
  }

  /** Which way requests go now: the user's own fal.ai key if set, else Keo Cloud if signed in. */
  async route(): Promise<Route | null> {
    const key = this.d.key();
    if (key) return { kind: 'own', key };
    const token = this.d.cloud ? await this.d.cloud.token() : null;
    return token && this.d.cloud ? { kind: 'keo', base: this.d.cloud.base, token } : null;
  }

  /**
   * The sign-in for an address: fal.ai's queue with the user's key, Keo Cloud's Studio addresses
   * with their Keo sign-in. Missing (signed out, key removed) is not a failure of the request: it
   * stays remembered and is tried again later.
   */
  private async authFor(url: string): Promise<{ header: string; keo: boolean }> {
    if (url.startsWith('https://queue.fal.run/')) {
      const key = this.d.key();
      if (!key) throw new NoRoute();
      return { header: `Key ${key}`, keo: false };
    }
    if (this.d.cloud && url.startsWith(`${this.d.cloud.base}/studio/`)) {
      const token = await this.d.cloud.token();
      if (!token) throw new NoRoute();
      return { header: `Bearer ${token}`, keo: true };
    }
    throw new AiVideoError('The AI service answered with an unexpected address.');
  }

  private async call(url: string, method: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    const auth = await this.authFor(url);
    const res = await this.d.fetch(url, { method, headers: { Authorization: auth.header, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AiVideoError(auth.keo ? falReason(json) || `Keo Cloud answered with an error (${res.status}).` : falError(res.status, json));
    return json;
  }

  /** A file put in fal.ai's storage (as fal.ai's own client does): its link for the model. */
  private async upload(bytes: Buffer, type: string, name: string, route: Route, signal: AbortSignal): Promise<string> {
    // Through Keo Cloud the gateway asks fal.ai for the upload address (Keo's key never leaves it).
    const start = await this.d.fetch(route.kind === 'own' ? 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3' : `${route.base}/studio/upload`, {
      method: 'POST',
      headers: { Authorization: route.kind === 'own' ? `Key ${route.key}` : `Bearer ${route.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: type, file_name: name }),
      signal,
    });
    const s = (await start.json().catch(() => ({}))) as { upload_url?: unknown; file_url?: unknown; detail?: unknown };
    if (!start.ok) throw new AiVideoError(route.kind === 'own' ? falError(start.status, s as Record<string, unknown>) : falReason(s as Record<string, unknown>) || `Keo Cloud answered with an error (${start.status}).`);
    if (typeof s.upload_url !== 'string' || typeof s.file_url !== 'string' || !/^https:\/\//.test(s.upload_url) || !/^https:\/\//.test(s.file_url)) throw new AiVideoError('fal.ai did not give an address to upload the picture to.');
    const put = await this.d.fetch(s.upload_url, { method: 'PUT', headers: { 'Content-Type': type }, body: new Uint8Array(bytes), signal });
    if (!put.ok) throw new AiVideoError(`The ${type.startsWith('video') ? 'video' : 'picture'} could not be uploaded to fal.ai (${put.status}).`);
    return s.file_url;
  }
}

/** Which way AI requests go: the user's own fal.ai key, or Keo Cloud (Studio credits). */
export type Route = { kind: 'own'; key: string } | { kind: 'keo'; base: string; token: string };

const NO_ROUTE = 'Keo Studio’s AI needs your Keo account: sign in (Settings → Providers → Keo account). Or add your own fal.ai key under Settings → Advanced.';

/** No way to reach the request right now (signed out, key removed): it is kept and tried again later. */
class NoRoute extends Error {
  constructor() {
    super(NO_ROUTE);
  }
}

/** What a finished request is saved as. */
export type ShotExt = 'mp4' | 'png' | 'wav' | 'mp3';

/** Speaking like a voice sample (fal.ai's Chatterbox: any voice from 5 to 30 seconds of it). */
export const OWN_VOICE_MODEL = { label: 'Chatterbox', endpoint: 'fal-ai/chatterbox/text-to-speech' } as const;
/** A voice made from a description (fal.ai's MiniMax Voice Design). */
export const VOICE_DESIGN_MODEL = { label: 'MiniMax Voice Design', endpoint: 'fal-ai/minimax/voice-design' } as const;

export interface OwnVoiceRequest {
  /** The voice sample (WAV or MP3). */
  sample: Buffer;
  sampleType: 'audio/wav' | 'audio/mpeg';
  text: string;
}

/** A request fal.ai accepted, remembered until its clip is downloaded. */
export interface PendingShot {
  hash: string;
  model: AiVideoModelId | 'wan-animate-replace' | 'nano-banana-edit' | 'nano-banana' | 'nano-banana-pro-edit' | 'nano-banana-pro' | 'kling-motion-control' | 'chatterbox' | 'minimax-voice-design';
  /** What the result is saved as (a video unless said). */
  ext?: ShotExt;
  seconds: number;
  statusUrl: string;
  resultUrl: string;
  cancelUrl: string | null;
  submittedAt: string;
  /** Where the clip goes when it is ready. */
  context?: { projectId: string; at: number; about: string; in?: number; duration?: number; trackName?: string; muted?: boolean };
}

/** fal.ai is still making the clip: it is remembered and arrives later. */
export class AiVideoPending extends AiVideoError {
  constructor(readonly job: PendingShot) {
    super('fal.ai is still making the clip. Keo keeps checking and adds it to the timeline when it is ready (it will not be paid for twice).');
  }
}

/** A network failure (no answer at all), in words for the user. */
function offline(e: unknown): string {
  return `Keo could not reach fal.ai (${String((e as Error)?.message ?? e).slice(0, 80)}). Check the internet connection and try again: nothing was paid.`;
}

/** fal.ai's reason, from the shapes it answers with ({detail: "…"}, {detail: [{msg}]}, {error}, {message}). */
export function falReason(json: Record<string, unknown>): string {
  const d = json.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (x && typeof x === 'object' && typeof (x as { msg?: unknown }).msg === 'string' ? (x as { msg: string }).msg : typeof x === 'string' ? x : '')).filter(Boolean);
    return (msgs.length ? msgs.join('; ') : JSON.stringify(d)).slice(0, 300);
  }
  for (const k of ['error', 'message'] as const) if (typeof json[k] === 'string') return json[k] as string;
  // Keo Cloud's errors: {error: {message}}.
  const e = json.error as { message?: unknown } | undefined;
  if (e && typeof e.message === 'string') return e.message;
  return '';
}

/** fal.ai's error, in words for the user. */
function falError(status: number, json: Record<string, unknown>): string {
  const detail = falReason(json);
  if (status === 401 || status === 403) return 'fal.ai did not accept the API key: check it in Settings → Providers.';
  if (status === 402) return 'The fal.ai account has no credit left: add credit at fal.ai/dashboard/billing.';
  if (status === 422) return `fal.ai could not use this request${detail ? `: ${detail}` : ''}.`;
  if (status === 429) return 'fal.ai is busy for this account right now: try again in a minute.';
  if (status === 499) return 'fal.ai stopped this request before it finished (on its side, not in Keo). Try again; if it keeps happening, try the other model.';
  return `fal.ai answered with an error (${status})${detail ? `: ${detail.slice(0, 200)}` : ''}.`;
}
