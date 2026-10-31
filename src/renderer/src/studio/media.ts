import { bridged, clipEnd, clipSpeech, curveAt, duckGain, gateGain, isAV, timelineSpeech, volumeAt, type Asset, type MediaClip, type Project, type Span, type VoiceFx, type Eq } from '@shared/studio';
import { invoke } from '../lib/api';
import { sourceTime, visibleAt, type Drawable, type SourceProvider } from './engine';
import { cutoutReady, loadCutout } from './cutout';
import { eqChain, voiceChain, voiceFxChain } from './sound';

/** A project's media file, served by Keo's own protocol (only media that is in the project). */
export const mediaUrl = (projectId: string, assetId: string) => `app://keo/media/${projectId}/${assetId}`;

// ---------------------------------------------------------------- preview (live playback)

/**
 * Media elements for each file, lent to its clips: a project cut into a hundred pieces of one
 * video still uses only a few elements of that video (the browser has only so many decoders), a
 * clip borrows the element already nearest its moment (so a cut can play straight on), and
 * elements no clip needs are paused and, past the limit, let go.
 */
class MediaPool<T extends HTMLMediaElement> {
  private readonly bySrc = new Map<string, T[]>();
  private readonly byClip = new Map<string, T>();
  private readonly owner = new Map<T, string>();
  private readonly used = new Map<T, number>();
  /** Elements lent out in the current pass. */
  private readonly lent = new Set<T>();

  constructor(
    private readonly make: (src: string) => T,
    private readonly perFile: number,
    private readonly total: number,
  ) {}

  /** A new pass over the timeline: nothing is lent yet. */
  begin(): void {
    this.lent.clear();
  }

  /** The element a clip plays from (`want`: the second of the file it needs now). */
  lend(clipId: string, src: string, want: number): T {
    const mine = this.byClip.get(clipId);
    if (mine && mine.dataset.src === src && this.owner.get(mine) === clipId && !this.lent.has(mine)) return this.mark(clipId, mine);
    const list = this.bySrc.get(src) ?? [];
    const free = list.filter((e) => !this.lent.has(e));
    // The free element already nearest the moment (no seek, or a short one).
    let pick = free.sort((a, b) => Math.abs(a.currentTime - want) - Math.abs(b.currentTime - want))[0];
    if (!pick || (Math.abs(pick.currentTime - want) > 1 && list.length < this.perFile)) pick = this.create(src, list);
    return this.mark(clipId, pick);
  }

  /** The element lent to a clip, if any. */
  of(clipId: string): T | undefined {
    const e = this.byClip.get(clipId);
    return e && this.owner.get(e) === clipId ? e : undefined;
  }

  private mark(clipId: string, e: T): T {
    const before = this.owner.get(e);
    if (before && before !== clipId) this.byClip.delete(before);
    this.owner.set(e, clipId);
    this.byClip.set(clipId, e);
    this.lent.add(e);
    this.used.set(e, performance.now());
    return e;
  }

  private create(src: string, list: T[]): T {
    const e = this.make(src);
    e.dataset.src = src;
    list.push(e);
    this.bySrc.set(src, list);
    // Past the limit: the element unused for longest is let go.
    const all = [...this.bySrc.values()].flat();
    if (all.length > this.total) {
      const old = all.filter((x) => !this.lent.has(x) && x !== e).sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))[0];
      if (old) this.drop(old);
    }
    return e;
  }

  private drop(e: T): void {
    e.pause();
    e.removeAttribute('src');
    e.load();
    const src = e.dataset.src ?? '';
    this.bySrc.set(src, (this.bySrc.get(src) ?? []).filter((x) => x !== e));
    const owner = this.owner.get(e);
    if (owner) this.byClip.delete(owner);
    this.owner.delete(e);
    this.used.delete(e);
  }

  /** Elements not lent in this pass stop playing. */
  pauseIdle(): void {
    for (const list of this.bySrc.values()) for (const e of list) if (!this.lent.has(e) && !e.paused) e.pause();
  }

  pauseAll(): void {
    for (const list of this.bySrc.values()) for (const e of list) e.pause();
  }

  /** Clips that are gone no longer hold an element. */
  forget(keep: Set<string>): void {
    for (const [clip, e] of this.byClip)
      if (!keep.has(clip)) {
        this.byClip.delete(clip);
        if (this.owner.get(e) === clip) this.owner.delete(e);
      }
  }

  all(): T[] {
    return [...this.bySrc.values()].flat();
  }

  clear(): void {
    for (const e of this.all()) this.drop(e);
  }
}

/**
 * The Studio preview's media: video elements lent to the visible clips from a small pool per
 * file, kept in step with the playhead (playing at the clip's speed, or sought when paused), the
 * next clips made ready before they are reached, and the sound of clips and audio tracks.
 */
export class PreviewSources implements SourceProvider {
  private readonly videos = new MediaPool<HTMLVideoElement>(
    (src) => {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.playsInline = true;
      v.src = src;
      v.addEventListener('seeked', () => this.redraw());
      v.addEventListener('loadeddata', () => this.redraw());
      return v;
    },
    4,
    12,
  );
  private readonly sounds = new MediaPool<HTMLAudioElement>(
    (src) => {
      const s = new Audio(src);
      s.crossOrigin = 'anonymous';
      s.preload = 'auto';
      return s;
    },
    3,
    12,
  );
  private readonly images = new Map<string, HTMLImageElement>();
  /** Sound that goes through Keo's voice clean-up (once routed, an element stays in the graph). */
  private audioCtx: AudioContext | null = null;
  private readonly routes = new Map<HTMLMediaElement, { src: MediaElementAudioSourceNode; pre: GainNode; gain: GainNode; dry: GainNode; wet: GainNode; fx: string; stop: () => void }>();
  private readonly speech = new WeakMap<Project, Span[]>();

  constructor(
    private readonly projectId: string,
    private readonly redraw: () => void,
  ) {}

  private video(c: MediaClip, a: Asset, want: number): HTMLVideoElement {
    // A big video plays from its light copy when Keo has made one.
    return this.videos.lend(c.id, `${mediaUrl(this.projectId, c.assetId)}${a.proxy ? '?preview=1' : ''}`, want);
  }

  private image(a: Asset): HTMLImageElement {
    let i = this.images.get(a.id);
    if (!i) {
      i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = this.redraw;
      i.src = mediaUrl(this.projectId, a.id);
      this.images.set(a.id, i);
    }
    return i;
  }

  frame(clip: MediaClip, asset: Asset): Drawable | null {
    // Background removal starts the first time a clip needs it; the preview redraws when it is ready.
    if (clip.cutout && !cutoutReady()) void loadCutout().then((ok) => ok && this.redraw());
    if (asset.kind === 'image') {
      const i = this.image(asset);
      return i.complete && i.naturalWidth ? i : null;
    }
    // The element the last pass lent this clip (it is already at the clip's moment).
    const v = this.videos.of(clip.id) ?? this.video(clip, asset, clip.in);
    return v.readyState >= 2 && !v.seeking ? v : null;
  }

  private route(el: HTMLMediaElement, voice: boolean, fx: VoiceFx | null, eq: Eq | null): GainNode {
    const ctx = (this.audioCtx ??= new AudioContext());
    let r = this.routes.get(el);
    if (!r) {
      const src = ctx.createMediaElementSource(el);
      const pre = ctx.createGain();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      src.connect(pre);
      pre.connect(dry).connect(gain);
      voiceChain(ctx, pre).connect(wet).connect(gain);
      r = { src, pre, gain, dry, wet, fx: '', stop: () => undefined };
      this.routes.set(el, r);
    }
    const key = JSON.stringify([fx, eq]);
    if (r.fx !== key) {
      // A different equalizer or voice changer: the sound is wired through the new ones.
      r.src.disconnect();
      r.stop();
      r.stop = () => undefined;
      let node: AudioNode = eq ? eqChain(ctx, r.src, eq) : r.src;
      if (fx) {
        const chain = voiceFxChain(ctx, node, fx);
        node = chain.out;
        r.stop = chain.stop;
      }
      node.connect(r.pre);
      r.fx = key;
    }
    r.dry.gain.value = voice ? 0 : 1;
    r.wet.gain.value = voice ? 1 : 0;
    return r.gain;
  }

  /** Puts every clip's media where the playhead is (playing or paused). */
  sync(p: Project, t: number, playing: boolean): void {
    // Clips shown at t, including both clips of a transition.
    const shownNow = new Set(visibleAt(p, t).map((c) => c.id));
    let speech = this.speech.get(p);
    if (!speech) {
      speech = bridged(timelineSpeech(p));
      this.speech.set(p, speech);
    }
    this.videos.begin();
    this.sounds.begin();
    for (const tr of p.tracks) {
      for (const c of tr.clips) {
        const outside = t < c.start || t >= clipEnd(c);
        if (!isAV(c) || (outside && !shownNow.has(c.id))) continue;
        const a = p.assets.find((x) => x.id === c.assetId);
        if (!a || a.kind === 'image') continue;
        const target = c.type === 'media' ? sourceTime(c, a, t) : Math.min(a.duration, c.in + (t - c.start));
        // With a speed curve the playback rate follows the curve (the element allows 1/16 to 16).
        const rate = c.type === 'media' ? (c.speedCurve ? Math.max(0.0625, Math.min(16, curveAt(c.speedCurve, (t - c.start) / Math.max(0.01, c.duration)))) : c.speed) : 1;
        let el: HTMLMediaElement;
        if (c.type === 'media' && a.kind === 'video') {
          if (tr.hidden && (tr.muted || !a.hasAudio)) continue;
          el = this.video(c, a, target);
        } else el = this.sounds.lend(c.id, mediaUrl(this.projectId, a.id), target);
        const fade = Math.min(c.fadeIn > 0 ? Math.min(1, (t - c.start) / c.fadeIn) : 1, c.fadeOut > 0 ? Math.min(1, (clipEnd(c) - t) / c.fadeOut) : 1);
        el.muted = tr.muted || !a.hasAudio || outside;
        const duck = (c.type === 'audio' && c.duck !== null ? duckGain(speech, t, c.duck) : 1) * (c.gate ? gateGain(clipSpeech(p, c), t, c.gate) : 1);
        const level = Math.max(0, volumeAt(c, t - c.start) * fade * duck);
        if (c.voice || c.voiceFx || c.eq || this.routes.has(el)) {
          el.volume = 1;
          this.route(el, c.voice, c.voiceFx ?? null, c.eq ?? null).gain.value = Math.min(4, level);
          if (playing && this.audioCtx?.state === 'suspended') void this.audioCtx.resume();
        } else el.volume = Math.min(1, level);
        el.playbackRate = rate;
        if (playing && !(c.type === 'media' && c.freeze)) {
          if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
          if (el.paused) void el.play().catch(() => undefined);
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
        }
      }
    }
    if (playing) {
      // The next clips get ready before they are reached (their first frame decoded), so a cut
      // plays straight on instead of showing a gap while the next video seeks.
      // Only the next two clips of each file: enough to be ready, without taking the elements in use.
      const readied = new Map<string, number>();
      const upcoming = p.tracks
        .filter((tr) => !tr.hidden)
        .flatMap((tr) => tr.clips)
        .filter((c): c is MediaClip => c.type === 'media' && c.start > t && c.start <= t + 1.5)
        .sort((a, b) => a.start - b.start);
      for (const tr of [{ clips: upcoming }]) {
        for (const c of tr.clips) {
          const n = readied.get(c.assetId) ?? 0;
          if (n >= 2) continue;
          readied.set(c.assetId, n + 1);
          const a = p.assets.find((x) => x.id === c.assetId);
          if (!a || a.kind !== 'video') continue;
          const first = sourceTime(c, a, c.start);
          const v = this.video(c, a, first);
          v.muted = true;
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - first) > 0.05 && !v.seeking) v.currentTime = first;
        }
      }
    }
    this.videos.pauseIdle();
    this.sounds.pauseIdle();
  }

  /** How many media elements the preview holds (it stays small, however many clips there are). */
  elementCount(): number {
    return this.videos.all().length + this.sounds.all().length;
  }

  /** A visible video clip whose frame is not ready yet (the preview then keeps its last picture). */
  missing(p: Project, t: number): boolean {
    for (const c of visibleAt(p, t)) {
      if (c.type !== 'media') continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      if (a?.kind === 'video' && !this.frame(c, a)) return true;
    }
    return false;
  }

  pauseAll(): void {
    this.videos.pauseAll();
    this.sounds.pauseAll();
  }

  /** Forgets clips that are gone from the project. */
  prune(p: Project): void {
    const ids = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    this.videos.forget(ids);
    this.sounds.forget(ids);
  }

  dispose(): void {
    this.pauseAll();
    this.videos.clear();
    this.sounds.clear();
    this.images.clear();
    this.routes.clear();
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }
}

// ---------------------------------------------------------------- export (exact frames)

interface Track {
  codec: string;
  description: Uint8Array | null;
  width: number;
  height: number;
  /** Degrees clockwise the frames turn to stand upright (phone videos). */
  rotation?: number;
  samples: number;
  keyTimes: number[];
}

/** A frame turned upright (90, 180 or 270 degrees clockwise), as a frame of its own. */
function turnFrame(f: VideoFrame, rotation: number, canvas: OffscreenCanvas): VideoFrame {
  const w = f.displayWidth;
  const h = f.displayHeight;
  const side = rotation === 90 || rotation === 270;
  canvas.width = side ? h : w;
  canvas.height = side ? w : h;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(f, -w / 2, -h / 2, w, h);
  return new VideoFrame(canvas, { timestamp: f.timestamp, ...(f.duration !== null ? { duration: f.duration } : {}) });
}

/**
 * Exact frames of one clip for export: the PC's video decoder (WebCodecs) fed with the clip's
 * compressed frames, read by Keo straight from the MP4/MOV file. Moving forward in time keeps
 * decoding; jumping back starts again from the key frame before.
 */
export class ClipDecoder {
  private decoder: VideoDecoder | null = null;
  private queue: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private next = 0;
  private ended = false;
  private failed: Error | null = null;
  private lastAsked = -1;

  constructor(
    private readonly projectId: string,
    private readonly assetId: string,
    private readonly track: Track,
  ) {}

  static async open(projectId: string, assetId: string): Promise<ClipDecoder | null> {
    const t = (await invoke('studio:videoTrack', { projectId, assetId }).catch(() => null)) as Track | null;
    if (!t || typeof VideoDecoder === 'undefined') return null;
    const config: VideoDecoderConfig = { codec: t.codec, ...(t.description ? { description: t.description } : {}), hardwareAcceleration: 'prefer-hardware' };
    const ok = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!ok.supported) {
      const soft = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'no-preference' }).catch(() => ({ supported: false }));
      if (!soft.supported) return null;
    }
    return new ClipDecoder(projectId, assetId, t);
  }

  private start(fromTime: number): void {
    this.decoder?.close();
    for (const f of this.queue) f.close();
    this.queue = [];
    this.ended = false;
    this.next = -1;
    this.pendingTime = fromTime;
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.queue.push(f);
        this.queue.sort((a, b) => a.timestamp - b.timestamp);
      },
      error: (e) => {
        this.failed = e instanceof Error ? e : new Error(String(e));
      },
    });
    this.decoder.configure({ codec: this.track.codec, ...(this.track.description ? { description: this.track.description } : {}), hardwareAcceleration: 'no-preference' });
  }

  private pendingTime = 0;

  private async feed(): Promise<void> {
    const r = await invoke('studio:videoSamples', { projectId: this.projectId, assetId: this.assetId, ...(this.next < 0 ? { time: this.pendingTime } : { from: this.next }), count: 24 });
    if (!r.samples.length) {
      this.ended = true;
      await this.decoder!.flush().catch(() => undefined);
      return;
    }
    for (const s of r.samples) this.decoder!.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.time * 1e6), duration: Math.round(s.duration * 1e6), data: s.data }));
    this.next = r.from + r.samples.length;
    if (this.next >= this.track.samples) {
      this.ended = true;
      await this.decoder!.flush().catch(() => undefined);
    }
  }

  /** The frame showing at `time` seconds into the clip's media. */
  async frameAt(time: number): Promise<VideoFrame | null> {
    const us = Math.round(time * 1e6);
    // Back in time (or far ahead): start again from the key frame before.
    const ahead = this.current ? us - this.current.timestamp : 0;
    if (!this.decoder || time < this.lastAsked - 1e-4 || ahead > 3_000_000) this.start(time);
    this.lastAsked = time;
    for (let guard = 0; guard < 4000; guard++) {
      if (this.failed) throw this.failed;
      // A frame later than the wanted time is decoded: the one before it is the right one.
      const later = this.queue.findIndex((f) => f.timestamp > us + 500);
      if (later >= 0 || (this.ended && this.decoder!.decodeQueueSize === 0)) {
        const upto = later >= 0 ? later : this.queue.length;
        if (upto > 0) {
          this.current?.close();
          this.current = this.queue[upto - 1]!;
          for (let k = 0; k < upto - 1; k++) this.queue[k]!.close();
          this.queue.splice(0, upto);
        }
        return this.shown();
      }
      if (!this.ended && this.decoder!.decodeQueueSize < 12) await this.feed();
      else await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('The video decoder stopped answering.');
  }

  /**
   * Every frame from the one showing at `from` to the one showing at `to` (seconds), decoded once
   * and copied out of the decoder (so it can keep decoding). For playing a stretch backwards.
   */
  async framesBetween(from: number, to: number): Promise<VideoFrame[]> {
    this.start(from);
    this.current?.close();
    this.current = null;
    const fromUs = Math.round(from * 1e6) + 500;
    const toUs = Math.round(to * 1e6) + 500;
    const out: VideoFrame[] = [];
    let before: VideoFrame | null = null;
    let done = false;
    try {
      for (let guard = 0; guard < 20000 && !done; guard++) {
        if (this.failed) throw this.failed;
        while (this.queue.length) {
          const f = this.queue.shift()!;
          if (f.timestamp <= fromUs) {
            before?.close();
            before = f;
          } else if (f.timestamp > toUs) {
            f.close();
            done = true;
            break;
          } else {
            out.push(this.upright(await copyFrame(f)));
            f.close();
          }
        }
        if (done || (this.ended && this.decoder!.decodeQueueSize === 0)) break;
        if (!this.ended && this.decoder!.decodeQueueSize < 12) await this.feed();
        else await new Promise((r) => setTimeout(r, 2));
      }
      if (before) out.unshift(this.upright(await copyFrame(before)));
    } finally {
      before?.close();
      // The next frameAt starts again from a key frame.
      this.lastAsked = Infinity;
    }
    return out;
  }

  /** The current frame as it plays: upright when the file says to turn it. */
  private turned: { of: VideoFrame; frame: VideoFrame } | null = null;
  private turnCanvas: OffscreenCanvas | null = null;
  private shown(): VideoFrame | null {
    const f = this.current;
    const turn = this.track.rotation ?? 0;
    if (!f || !turn) return f;
    if (this.turned?.of !== f) {
      this.turned?.frame.close();
      this.turned = { of: f, frame: turnFrame(f, turn, (this.turnCanvas ??= new OffscreenCanvas(1, 1))) };
    }
    return this.turned.frame;
  }

  /** A copied frame turned upright (the copy is closed). */
  private upright(f: VideoFrame): VideoFrame {
    const turn = this.track.rotation ?? 0;
    if (!turn) return f;
    const t = turnFrame(f, turn, (this.turnCanvas ??= new OffscreenCanvas(1, 1)));
    f.close();
    return t;
  }

  close(): void {
    this.decoder?.close();
    for (const f of this.queue) f.close();
    this.current?.close();
    this.turned?.frame.close();
    this.turned = null;
    this.queue = [];
    this.current = null;
  }
}

/** A decoded frame copied into memory of its own (the decoder's frames are few and must go back). */
async function copyFrame(f: VideoFrame): Promise<VideoFrame> {
  try {
    const data = new Uint8Array(f.allocationSize());
    const layout = await f.copyTo(data);
    const r = f.visibleRect;
    return new VideoFrame(data, { format: f.format!, codedWidth: f.codedWidth, codedHeight: f.codedHeight, timestamp: f.timestamp, layout, displayWidth: f.displayWidth, displayHeight: f.displayHeight, ...(r ? { visibleRect: { x: r.x, y: r.y, width: r.width, height: r.height } } : {}), ...(f.duration !== null ? { duration: f.duration } : {}) });
  } catch {
    // A frame whose pixels cannot be read out directly: drawn onto a canvas of its own instead.
    const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
    c.getContext('2d')!.drawImage(f, 0, 0);
    return new VideoFrame(c, { timestamp: f.timestamp });
  }
}

/**
 * A video played backwards, exactly: a second of frames at a time is decoded once (from the key
 * frame before) and kept, then handed out last frame first.
 */
class BackwardFrames {
  private cache: VideoFrame[] = [];
  private lo = Infinity;
  private hi = -Infinity;
  constructor(private readonly decoder: ClipDecoder) {}

  async frameAt(time: number): Promise<VideoFrame | null> {
    if (!(time >= this.lo - 1e-4 && time <= this.hi + 1e-4)) {
      for (const f of this.cache) f.close();
      this.hi = time;
      this.lo = Math.max(0, time - 1);
      this.cache = await this.decoder.framesBetween(this.lo, this.hi);
    }
    const us = Math.round(time * 1e6) + 500;
    let best: VideoFrame | null = null;
    for (const f of this.cache) if (f.timestamp <= us) best = f;
    return best ?? this.cache[0] ?? null;
  }

  close(): void {
    for (const f of this.cache) f.close();
    this.cache = [];
    this.decoder.close();
  }
}

/** Fallback for media Keo cannot read itself (WebM and others): a video element, sought frame by frame. */
export class ElementSeeker {
  private readonly v: HTMLVideoElement;
  private ready: Promise<void>;
  constructor(url: string) {
    this.v = document.createElement('video');
    this.v.crossOrigin = 'anonymous';
    this.v.muted = true;
    this.v.preload = 'auto';
    this.v.src = url;
    this.ready = new Promise((res, rej) => {
      this.v.addEventListener('loadeddata', () => res(), { once: true });
      this.v.addEventListener('error', () => rej(new Error('This video could not be opened.')), { once: true });
    });
  }
  async frameAt(time: number): Promise<HTMLVideoElement> {
    await this.ready;
    if (Math.abs(this.v.currentTime - time) > 0.001) {
      await new Promise<void>((res) => {
        this.v.addEventListener('seeked', () => res(), { once: true });
        this.v.currentTime = time;
      });
    }
    return this.v;
  }
  close(): void {
    this.v.removeAttribute('src');
    this.v.load();
  }
}

/**
 * Exact frames for a whole project, prepared before each frame is drawn: decoders per clip,
 * pictures once per media.
 */
export class ExactSources implements SourceProvider {
  private readonly decoders = new Map<string, ClipDecoder | ElementSeeker | BackwardFrames>();
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly ready = new Map<string, Drawable>();

  constructor(private readonly projectId: string) {}

  /** Gets every visible clip's picture for time t ready (call before drawFrame). */
  async prepare(p: Project, clips: MediaClip[], t: number): Promise<void> {
    this.ready.clear();
    for (const c of clips) {
      const a = p.assets.find((x) => x.id === c.assetId);
      if (!a) continue;
      if (a.kind === 'image') {
        let b = this.bitmaps.get(a.id);
        if (!b) {
          const blob = await (await fetch(mediaUrl(this.projectId, a.id))).blob();
          b = await createImageBitmap(blob);
          this.bitmaps.set(a.id, b);
        }
        this.ready.set(c.id, b);
        continue;
      }
      let d = this.decoders.get(c.id);
      if (!d) {
        const exact = await ClipDecoder.open(this.projectId, a.id);
        d = exact ? (c.reversed ? new BackwardFrames(exact) : exact) : new ElementSeeker(mediaUrl(this.projectId, a.id));
        this.decoders.set(c.id, d);
      }
      const f = await d.frameAt(sourceTime(c, a, t));
      if (f) this.ready.set(c.id, f as unknown as Drawable);
    }
  }

  frame(clip: MediaClip): Drawable | null {
    return this.ready.get(clip.id) ?? null;
  }

  /** Closes decoders of clips that ended (they are not needed again in a forward export). */
  release(keep: Set<string>): void {
    for (const [id, d] of this.decoders)
      if (!keep.has(id)) {
        d.close();
        this.decoders.delete(id);
      }
  }

  close(): void {
    for (const d of this.decoders.values()) d.close();
    this.decoders.clear();
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
  }
}
