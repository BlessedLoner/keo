import { bridged, clipEnd, duckGain, isAV, projectDuration, QUALITY_BPP, timelineSpeech, type ExportQuality, type MediaClip, type Project } from '@shared/studio';
import { invoke } from '../lib/api';
import { drawFrame, visibleAt } from './engine';
import { ExactSources, mediaUrl } from './media';
import { normalize, voiceChain } from './sound';

/**
 * Exporting and looking at frames, in Keo's render window: the same picture engine as the preview,
 * exact frames from the PC's video decoder, the PC's (hardware) H.264 encoder, the sound mixed
 * offline and encoded as AAC (or Opus), and Keo's own MP4 writer in the main process.
 */

const SAMPLE_RATE = 48000;

/** A plain copy of encoder output bytes (ArrayBuffer or a view of one). */
function bytes(d: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}
const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

/** Every clip's sound mixed into one stereo track (null: the video is silent). */
export async function mixAudio(p: Project, o: { loudness?: boolean } = {}): Promise<AudioBuffer | null> {
  const dur = projectDuration(p);
  const parts: Array<{ assetId: string; start: number; in: number; duration: number; speed: number; volume: number; fadeIn: number; fadeOut: number; voice: boolean; duck: number | null }> = [];
  for (const tr of p.tracks) {
    if (tr.muted) continue;
    for (const c of tr.clips) {
      if (!isAV(c) || c.volume <= 0) continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      if (!a || !a.hasAudio || a.kind === 'image') continue;
      parts.push({ assetId: a.id, start: c.start, in: c.in, duration: c.duration, speed: c.type === 'media' ? c.speed : 1, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, voice: c.voice, duck: c.type === 'audio' ? c.duck : null });
    }
  }
  if (!parts.length || dur <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SAMPLE_RATE), SAMPLE_RATE);
  const speech = bridged(timelineSpeech(p));
  const decoded = new Map<string, AudioBuffer | null>();
  for (const part of parts) {
    if (!decoded.has(part.assetId)) {
      try {
        const bytes = await (await fetch(mediaUrl(p.id, part.assetId))).arrayBuffer();
        decoded.set(part.assetId, await ctx.decodeAudioData(bytes));
      } catch {
        decoded.set(part.assetId, null);
      }
    }
    const buf = decoded.get(part.assetId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = part.speed;
    const gain = ctx.createGain();
    const end = part.start + part.duration;
    gain.gain.setValueAtTime(part.fadeIn > 0 ? 0 : part.volume, part.start);
    if (part.fadeIn > 0) gain.gain.linearRampToValueAtTime(part.volume, part.start + part.fadeIn);
    if (part.fadeOut > 0) {
      gain.gain.setValueAtTime(part.volume, Math.max(part.start, end - part.fadeOut));
      gain.gain.linearRampToValueAtTime(0, end);
    }
    let out: AudioNode = part.voice ? voiceChain(ctx, src) : src;
    if (part.duck !== null && speech.length) {
      // Music under speech: a gain curve sampled every 50 ms from the same rule the preview uses.
      const duck = ctx.createGain();
      const step = 0.05;
      const n = Math.max(2, Math.ceil(part.duration / step) + 1);
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = duckGain(speech, part.start + i * step, part.duck);
      duck.gain.setValueCurveAtTime(curve, part.start, (n - 1) * step);
      out = out.connect(duck);
    }
    out.connect(gain).connect(ctx.destination);
    src.start(part.start, part.in, part.duration * part.speed);
  }
  const mixed = await ctx.startRendering();
  if (o.loudness && p.loudness === 'social') normalize(mixed, -14);
  return mixed;
}

interface AudioOut {
  codec: 'aac' | 'opus';
  config: Uint8Array<ArrayBuffer>;
  chunks: Array<{ data: Uint8Array<ArrayBuffer>; timeUs: number; durationUs: number }>;
}

async function encodeAudio(buf: AudioBuffer): Promise<AudioOut | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const codec of ['aac', 'opus'] as const) {
    const config: AudioEncoderConfig = { codec: codec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: codec === 'aac' ? 192_000 : 160_000 };
    const ok = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!ok.supported) continue;
    const out: AudioOut = { codec, config: new Uint8Array(), chunks: [] };
    let failed: Error | null = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc && !out.config.length) out.config = bytes(desc as ArrayBuffer | ArrayBufferView);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        out.chunks.push({ data, timeUs: chunk.timestamp, durationUs: chunk.duration ?? 21333 });
      },
      error: (e) => {
        failed = e instanceof Error ? e : new Error(String(e));
      },
    });
    enc.configure(config);
    const frames = codec === 'aac' ? 1024 : 960;
    const left = buf.getChannelData(0);
    const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
    for (let at = 0; at < buf.length; at += frames) {
      const n = Math.min(frames, buf.length - at);
      const planar = new Float32Array(n * 2);
      planar.set(left.subarray(at, at + n), 0);
      planar.set(right.subarray(at, at + n), n);
      const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at / SAMPLE_RATE) * 1e6), data: planar });
      enc.encode(data);
      data.close();
      if (enc.encodeQueueSize > 64) await new Promise((r) => setTimeout(r, 1));
    }
    await enc.flush();
    enc.close();
    if (failed) throw failed;
    if (codec === 'aac' && !out.config.length) out.config = new Uint8Array([0x11, 0x90]); // AAC-LC, 48 kHz, stereo
    if (out.chunks.length) return out;
  }
  return null;
}

/** Whether an encoder with this config really produces video here (some hardware encoders stall). */
async function encoderWorks(config: VideoEncoderConfig, w: number, h: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (enc.state !== 'closed') enc.close();
      resolve(ok);
    };
    const enc = new VideoEncoder({ output: () => finish(true), error: () => finish(false) });
    const timer = setTimeout(() => finish(false), 4000);
    try {
      enc.configure(config);
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d')!;
      g.fillStyle = '#336699';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 3; i++) {
        const f = new VideoFrame(c, { timestamp: i * 33_333, duration: 33_333 });
        enc.encode(f, { keyFrame: i === 0 });
        f.close();
      }
      void enc.flush().catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function videoEncoderConfig(w: number, h: number, fps: number, bpp = 0.16): Promise<VideoEncoderConfig> {
  // Constrained Baseline first (no B-frames). The software encoder first: hardware encoders can
  // stop answering in Keo's hidden render window (seen on Intel/Windows), the software one does not.
  const bitrate = Math.round(w * h * fps * bpp);
  const tried: string[] = [];
  for (const hardwareAcceleration of ['prefer-software', 'prefer-hardware'] as const) {
    for (const codec of ['avc1.42e033', 'avc1.42e02a', 'avc1.4d0033', 'avc1.640033']) {
      for (const latencyMode of ['realtime', 'quality'] as const) {
        const config: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration, avc: { format: 'avc' }, latencyMode };
        const ok = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
        if (!ok.supported) continue;
        if (await encoderWorks(config, w, h)) return config;
        tried.push(`${codec}/${hardwareAcceleration}/${latencyMode}`);
      }
    }
  }
  throw new Error(`This PC’s H.264 encoder did not produce video (tried ${tried.join(', ') || 'none'}).`);
}

export type Progress = (p: { stage: 'sound' | 'video' | 'saving'; done: number; total: number }) => void;

/** Waits for p, but at most 30 s. */
function stalls<T>(p: Promise<T>, message: string): Promise<T> {
  let timer = 0 as unknown as ReturnType<typeof setTimeout>;
  return Promise.race([p.finally(() => clearTimeout(timer)), new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(message)), 30_000)))]);
}

/** Renders the whole project into an MP4 (the main process writes the file). */
export async function runExport(
  p: Project,
  exportId: string,
  progress: Progress,
  cancelled: () => boolean,
  size?: { width: number; height: number; fps: number; quality: ExportQuality },
): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
  const W = even(size?.width ?? p.width);
  const H = even(size?.height ?? p.height);
  const fps = size?.fps ?? p.fps;
  const bpp = QUALITY_BPP[size?.quality ?? 'high'];
  const total = Math.max(1, Math.ceil(projectDuration(p) * fps - 1e-6));
  progress({ stage: 'sound', done: 0, total });
  const mixed = await mixAudio(p, { loudness: true });
  console.info(`export: sound mixed (${mixed ? mixed.duration.toFixed(2) + 's' : 'silent'})`);
  const audio = mixed ? await encodeAudio(mixed) : null;
  console.info(`export: sound encoded (${audio ? audio.codec + ' ' + audio.chunks.length + ' packets' : 'none'})`);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as CanvasRenderingContext2D;
  const sources = new ExactSources(p.id);
  const config = await videoEncoderConfig(W, H, fps, bpp);
  console.info(`export: video encoder ${config.codec} ${config.hardwareAcceleration} ${config.latencyMode} ${W}x${H}@${fps}`);
  let begun: Promise<unknown> | null = null;
  let failed: Error | null = null;
  const sends: Promise<unknown>[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (!begun) {
        const desc = meta?.decoderConfig?.description as ArrayBuffer | ArrayBufferView | undefined;
        const avcC = desc ? bytes(desc) : null;
        if (!avcC) {
          failed = new Error('The video encoder did not describe its stream.');
          return;
        }
        begun = invoke('studio:exportBegin', { exportId, projectId: p.id, video: { width: W, height: H, avcC }, audio: audio ? { codec: audio.codec, sampleRate: SAMPLE_RATE, channels: 2, config: audio.config } : null }).then(async () => {
          for (const a of audio?.chunks ?? []) await invoke('studio:exportChunk', { exportId, kind: 'audio', data: a.data, timeUs: a.timeUs, durationUs: a.durationUs, key: true });
        });
      }
      const send = begun.then(() => invoke('studio:exportChunk', { exportId, kind: 'video', data, timeUs: chunk.timestamp, durationUs: chunk.duration ?? Math.round(1e6 / fps), key: chunk.type === 'key' }));
      sends.push(send);
    },
    error: (e) => {
      failed = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure(config);
  try {
    for (let i = 0; i < total; i++) {
      if (cancelled()) throw new Error('The export was cancelled.');
      if (failed) throw failed;
      const t = i / fps;
      const media = visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media');
      await sources.prepare(p, media, t);
      drawFrame(ctx, p, t, sources);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // Clips that have ended are not needed again.
      sources.release(new Set(p.tracks.flatMap((tr) => tr.clips.filter((c) => clipEnd(c) > t).map((c) => c.id))));
      // Every few seconds of video, take what the encoder has ready (some encoders hold frames
      // back until asked); an encoder that stops answering ends the export with a clear message.
      if ((i + 1) % (fps * 4) === 0) await stalls(encoder.flush(), 'The video encoder stopped answering.');
      const waitFrom = performance.now();
      while (encoder.encodeQueueSize > 48) {
        if (performance.now() - waitFrom > 20_000) throw new Error('The video encoder stopped answering.');
        await new Promise((r) => setTimeout(r, 2));
      }
      if (sends.length > 30) await Promise.all(sends.splice(0, sends.length - 10));
      if (i % 10 === 0) progress({ stage: 'video', done: i, total });
    }
    await stalls(encoder.flush(), 'The video encoder stopped answering.');
    if (failed) throw failed;
    await Promise.all(sends);
    progress({ stage: 'saving', done: total, total });
    return await invoke('studio:exportEnd', { exportId });
  } catch (e) {
    await invoke('studio:exportAbort', { exportId }).catch(() => undefined);
    throw e;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    sources.close();
  }
}

/** Frames of the timeline as PNG (for Keo to look at its own work), `width` pixels wide. */
export async function renderFrames(p: Project, times: number[], width: number): Promise<Array<{ time: number; pngBase64: string }>> {
  const W = even(width);
  const H = even((width * p.height) / p.width);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as CanvasRenderingContext2D;
  const out: Array<{ time: number; pngBase64: string }> = [];
  const sources = new ExactSources(p.id);
  try {
    for (const t of times) {
      const media = visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media');
      await sources.prepare(p, media, t);
      drawFrame(ctx, p, t, sources);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({ time: t, pngBase64: btoa(bin) });
    }
  } finally {
    sources.close();
  }
  return out;
}

/**
 * The timeline's sound as 16-bit mono WAV at sampleRate (for speech-to-text and finding silences),
 * base64; null when the timeline has no sound.
 */
export async function speechWav(p: Project, sampleRate: number): Promise<{ wavBase64: string; seconds: number } | null> {
  const mixed = await mixAudio(p);
  if (!mixed) return null;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(mixed.duration * sampleRate)), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = mixed;
  src.connect(ctx.destination);
  src.start();
  return wav16((await ctx.startRendering()).getChannelData(0), sampleRate);
}

/** One media file's own sound (all of it, before any edit) as 16-bit mono WAV, base64; null: no sound. */
export async function assetWav(p: Project, assetId: string, sampleRate: number): Promise<{ wavBase64: string; seconds: number } | null> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || !a.hasAudio || a.kind === 'image') return null;
  const bytes = await (await fetch(mediaUrl(p.id, a.id))).arrayBuffer();
  // Decoding in a 16 kHz context resamples to 16 kHz; the channels are averaged.
  const buf = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i]! += d[i]! / buf.numberOfChannels;
  }
  return wav16(mono, buf.sampleRate);
}

function wav16(mono: Float32Array, sampleRate: number): { wavBase64: string; seconds: number } {
  const bytes = new Uint8Array(44 + mono.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + mono.length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(mono[i]! * 32767))), true);
  // Base64 in slices (a single call would overflow the argument list).
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { wavBase64: btoa(bin), seconds: mono.length / sampleRate };
}

/** The size and length of a file Keo cannot read itself (pictures, MP3, WebM…). */
export async function probe(url: string): Promise<{ kind: 'video' | 'image' | 'audio'; duration: number; width: number; height: number; hasAudio: boolean } | null> {
  const asImage = await new Promise<{ w: number; h: number } | null>((res) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res(null);
    i.src = url;
  });
  if (asImage) return { kind: 'image', duration: 0, width: asImage.w, height: asImage.h, hasAudio: false };
  return new Promise((res) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.preload = 'metadata';
    v.muted = true;
    const done = (r: Awaited<ReturnType<typeof probe>>) => {
      v.removeAttribute('src');
      v.load();
      res(r);
    };
    v.onloadedmetadata = () => {
      const duration = Number.isFinite(v.duration) ? v.duration : 0;
      done(v.videoWidth ? { kind: 'video', duration, width: v.videoWidth, height: v.videoHeight, hasAudio: true } : { kind: 'audio', duration, width: 0, height: 0, hasAudio: true });
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}
