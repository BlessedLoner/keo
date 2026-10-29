import { bridged, clipEnd, clipSpeech, curveAt, duckGain, gateGain, isAV, timelineSpeech, volumeAt, type Asset, type MediaClip, type Project, type Span, type VoiceFx } from '@shared/studio';
import { invoke } from '../lib/api';
import { sourceTime, visibleAt, type Drawable, type SourceProvider } from './engine';
import { voiceChain, voiceFxChain } from './sound';

/** A project's media file, served by Keo's own protocol (only media that is in the project). */
export const mediaUrl = (projectId: string, assetId: string) => `app://keo/media/${projectId}/${assetId}`;

// ---------------------------------------------------------------- preview (live playback)

/**
 * The Studio preview's media: one video element per visible clip, kept in step with the playhead
 * (playing at the clip's speed, or sought when paused), and the sound of clips and audio tracks.
 */
export class PreviewSources implements SourceProvider {
  private readonly videos = new Map<string, HTMLVideoElement>();
  private readonly sounds = new Map<string, HTMLAudioElement>();
  private readonly images = new Map<string, HTMLImageElement>();
  /** Sound that goes through Keo's voice clean-up (once routed, an element stays in the graph). */
  private audioCtx: AudioContext | null = null;
  private readonly routes = new Map<HTMLMediaElement, { src: MediaElementAudioSourceNode; pre: GainNode; gain: GainNode; dry: GainNode; wet: GainNode; fx: VoiceFx | null; stop: () => void }>();
  private readonly speech = new WeakMap<Project, Span[]>();

  constructor(
    private readonly projectId: string,
    private readonly redraw: () => void,
  ) {}

  private video(c: MediaClip): HTMLVideoElement {
    let v = this.videos.get(c.id);
    if (!v) {
      v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.playsInline = true;
      v.src = mediaUrl(this.projectId, c.assetId);
      v.addEventListener('seeked', this.redraw);
      v.addEventListener('loadeddata', this.redraw);
      this.videos.set(c.id, v);
    }
    return v;
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
    if (asset.kind === 'image') {
      const i = this.image(asset);
      return i.complete && i.naturalWidth ? i : null;
    }
    const v = this.video(clip);
    return v.readyState >= 2 ? v : null;
  }

  private route(el: HTMLMediaElement, voice: boolean, fx: VoiceFx | null): GainNode {
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
      r = { src, pre, gain, dry, wet, fx: null, stop: () => undefined };
      this.routes.set(el, r);
    }
    if (r.fx !== fx) {
      // A different voice changer: the sound is wired through the new one.
      r.src.disconnect();
      r.stop();
      r.stop = () => undefined;
      if (fx) {
        const chain = voiceFxChain(ctx, r.src, fx);
        chain.out.connect(r.pre);
        r.stop = chain.stop;
      } else r.src.connect(r.pre);
      r.fx = fx;
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
    const activeVideos = new Set<string>();
    const activeSounds = new Set<string>();
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
          el = this.video(c);
          activeVideos.add(c.id);
        } else {
          let s = this.sounds.get(c.id);
          if (!s) {
            s = new Audio(mediaUrl(this.projectId, a.id));
            s.crossOrigin = 'anonymous';
            s.preload = 'auto';
            this.sounds.set(c.id, s);
          }
          el = s;
          activeSounds.add(c.id);
        }
        const fade = Math.min(c.fadeIn > 0 ? Math.min(1, (t - c.start) / c.fadeIn) : 1, c.fadeOut > 0 ? Math.min(1, (clipEnd(c) - t) / c.fadeOut) : 1);
        el.muted = tr.muted || !a.hasAudio || outside;
        const duck = (c.type === 'audio' && c.duck !== null ? duckGain(speech, t, c.duck) : 1) * (c.gate ? gateGain(clipSpeech(p, c), t, c.gate) : 1);
        const level = Math.max(0, volumeAt(c, t - c.start) * fade * duck);
        if (c.voice || c.voiceFx || this.routes.has(el)) {
          el.volume = 1;
          this.route(el, c.voice, c.voiceFx ?? null).gain.value = Math.min(4, level);
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
    for (const [id, v] of this.videos) if (!activeVideos.has(id) && !v.paused) v.pause();
    for (const [id, s] of this.sounds) if (!activeSounds.has(id) && !s.paused) s.pause();
  }

  pauseAll(): void {
    for (const v of this.videos.values()) v.pause();
    for (const s of this.sounds.values()) s.pause();
  }

  /** Forgets clips that are gone from the project. */
  prune(p: Project): void {
    const ids = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const [id, v] of this.videos)
      if (!ids.has(id)) {
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videos.delete(id);
      }
    for (const [id, s] of this.sounds)
      if (!ids.has(id)) {
        s.pause();
        this.sounds.delete(id);
      }
  }

  dispose(): void {
    this.pauseAll();
    for (const v of this.videos.values()) {
      v.removeAttribute('src');
      v.load();
    }
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
  samples: number;
  keyTimes: number[];
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
        return this.current;
      }
      if (!this.ended && this.decoder!.decodeQueueSize < 12) await this.feed();
      else await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('The video decoder stopped answering.');
  }

  close(): void {
    this.decoder?.close();
    for (const f of this.queue) f.close();
    this.current?.close();
    this.queue = [];
    this.current = null;
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
  private readonly decoders = new Map<string, ClipDecoder | ElementSeeker>();
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
        d = (await ClipDecoder.open(this.projectId, a.id)) ?? new ElementSeeker(mediaUrl(this.projectId, a.id));
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
