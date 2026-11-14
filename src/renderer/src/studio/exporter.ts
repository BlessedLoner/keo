import { estimateMotion, type MotionEstimate } from '@shared/editDnaMotion';
import { prepareLuts } from './grade';
import { prepareScenes } from './scene3d';
import type { MotionClip } from '@shared/studio';
import { CODEC_NAMES, CODECS, encoderConfig } from './codecs';
import { bridged, clipEnd, findClip, clipSpeech, curveArea, curveAt, duckGain, gateGain, isAV, type Span, type SpeedPoint, projectDuration, QUALITY_BPP, CODEC_BITS, type ExportVideoCodec, timelineSpeech, volumeAt, type ExportQuality, type Key, type MediaClip, type Project, type VoiceFx, type Eq } from '@shared/studio';
import { denoise } from '@shared/denoise';
import { boxTracker, frameShift, type Gray } from '@shared/studioTrack';
import { buildPalette, GIF_END, gifFrame, gifHead, join, paletteMapper, wavStereo } from '@shared/gif';
import { invoke } from '../lib/api';
import { drawFrame, fontsReady, layerBoxes, visibleAt } from './engine';
import type { ReviewSample } from '@shared/studioReview';
import { ClipDecoder, ElementSeeker, ExactSources, mediaUrl } from './media';
import { loadCutout, personBox } from './cutout';
import { eqChain, normalize, voiceChain, voiceFxChain } from './sound';

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

/** Background removal is ready before a project that uses it is drawn. */
async function prepareCutout(p: Project): Promise<void> {
  await fontsReady(p);
  if (!p.tracks.some((t) => t.clips.some((c) => c.type === 'media' && c.cutout))) return;
  if (!(await loadCutout())) throw new Error('Background removal could not start on this PC.');
}

/** Every clip's sound mixed into one stereo track (null: the video is silent). */
export async function mixAudio(p: Project, o: { loudness?: boolean } = {}): Promise<AudioBuffer | null> {
  const dur = projectDuration(p);
  const parts: Array<{ assetId: string; start: number; in: number; duration: number; speed: number; volume: number; volumeKeys?: Key[]; fadeIn: number; fadeOut: number; voice: boolean; reversed?: boolean; fx?: VoiceFx; eq?: Eq; duck: number | null; curve?: SpeedPoint[]; gate?: { db: number; speech: Span[] } }> = [];
  for (const tr of p.tracks) {
    if (tr.muted) continue;
    for (const c of tr.clips) {
      if (!isAV(c) || (c.volume <= 0 && !c.volumeKeys?.some((k) => k.value > 0))) continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      if (!a || !a.hasAudio || a.kind === 'image') continue;
      parts.push({ assetId: a.id, start: c.start, in: c.in, duration: c.duration, speed: c.type === 'media' ? c.speed : 1, volume: c.volume, ...(c.volumeKeys?.length ? { volumeKeys: c.volumeKeys } : {}), fadeIn: c.fadeIn, fadeOut: c.fadeOut, voice: c.voice, ...(c.type === 'media' && c.reversed ? { reversed: true } : {}), ...(c.voiceFx ? { fx: c.voiceFx } : {}), ...(c.eq ? { eq: c.eq } : {}), duck: c.type === 'audio' ? c.duck : null, ...(c.type === 'media' && c.speedCurve ? { curve: c.speedCurve } : {}), ...(c.gate ? { gate: { db: c.gate, speech: clipSpeech(p, c) } } : {}) });
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
    const forward = decoded.get(part.assetId);
    if (!forward) continue;
    // Backwards: the sound reversed (once per file), played from the mirrored point.
    let buf = forward;
    if (part.reversed) {
      const key = `${part.assetId}:reversed`;
      if (!decoded.has(key)) {
        const r = ctx.createBuffer(forward.numberOfChannels, forward.length, forward.sampleRate);
        for (let ch = 0; ch < forward.numberOfChannels; ch++) r.getChannelData(ch).set(forward.getChannelData(ch).slice().reverse());
        decoded.set(key, r);
      }
      buf = decoded.get(key)!;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = part.speed;
    if (part.curve) {
      // A speed curve: the sound speeds up and slows down with the picture (20 steps a second).
      const n = Math.max(2, Math.ceil(part.duration * 20) + 1);
      const rates = new Float32Array(n);
      for (let i = 0; i < n; i++) rates[i] = curveAt(part.curve, i / (n - 1));
      src.playbackRate.setValueCurveAtTime(rates, part.start, part.duration);
    }
    const gain = ctx.createGain();
    const end = part.start + part.duration;
    if (part.volumeKeys) {
      // Volume keyframes (with the fades): a gain curve sampled every 20 ms, as the preview hears it.
      const step = 0.02;
      const n = Math.max(2, Math.ceil(part.duration / step) + 1);
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const rt = (i / (n - 1)) * part.duration;
        const fade = Math.min(part.fadeIn > 0 ? Math.min(1, rt / part.fadeIn) : 1, part.fadeOut > 0 ? Math.min(1, (part.duration - rt) / part.fadeOut) : 1);
        curve[i] = volumeAt(part, rt) * Math.max(0, fade);
      }
      gain.gain.setValueCurveAtTime(curve, part.start, part.duration);
    } else {
      gain.gain.setValueAtTime(part.fadeIn > 0 ? 0 : part.volume, part.start);
      if (part.fadeIn > 0) gain.gain.linearRampToValueAtTime(part.volume, part.start + part.fadeIn);
      if (part.fadeOut > 0) {
        gain.gain.setValueAtTime(part.volume, Math.max(part.start, end - part.fadeOut));
        gain.gain.linearRampToValueAtTime(0, end);
      }
    }
    let out: AudioNode = part.voice ? voiceChain(ctx, src) : src;
    if (part.eq) out = eqChain(ctx, out, part.eq);
    if (part.fx) out = voiceFxChain(ctx, out, part.fx).out;
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
    if (part.gate && part.gate.speech.length) {
      // Noise gate: quieter between the clip's own sentences.
      const g = ctx.createGain();
      const step = 0.02;
      const n = Math.max(2, Math.ceil(part.duration / step) + 1);
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = gateGain(part.gate.speech, part.start + i * step, part.gate.db);
      g.gain.setValueCurveAtTime(curve, part.start, (n - 1) * step);
      out = out.connect(g);
    }
    out.connect(gain).connect(ctx.destination);
    const span = part.curve ? part.duration * curveArea(part.curve, 0, 1) : part.duration * part.speed;
    src.start(part.start, part.reversed ? Math.max(0, buf.duration - part.in - span) : part.in, span);
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

async function encodeAudio(buf: AudioBuffer, opusOnly = false): Promise<AudioOut | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  // WebM carries Opus only.
  for (const codec of opusOnly ? (['opus'] as const) : (['aac', 'opus'] as const)) {
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

async function videoEncoderConfig(w: number, h: number, fps: number, bpp = 0.16, family: ExportVideoCodec = 'h264'): Promise<VideoEncoderConfig> {
  // The software encoder first: hardware encoders can stop answering in Keo's hidden render window
  // (seen on Intel/Windows), the software one does not. H.265 usually has only a hardware encoder.
  const bitrate = Math.round(w * h * fps * bpp * CODEC_BITS[family]);
  const tried: string[] = [];
  for (const hardwareAcceleration of ['prefer-software', 'prefer-hardware'] as const) {
    for (const codec of CODECS[family]) {
      for (const latencyMode of ['realtime', 'quality'] as const) {
        const config = encoderConfig(family, codec, w, h, fps, bitrate, hardwareAcceleration, latencyMode);
        const ok = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
        if (!ok.supported) continue;
        if (await encoderWorks(config, w, h)) return config;
        tried.push(`${codec}/${hardwareAcceleration}/${latencyMode}`);
      }
    }
  }
  if (!tried.length && family !== 'h264') throw new Error(`This PC cannot encode ${CODEC_NAMES[family]} at ${w}×${h}. Export as MP4 (H.264) instead.`);
  throw new Error(`This PC’s ${CODEC_NAMES[family]} encoder did not produce video (tried ${tried.join(', ') || 'none'}).`);
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
  size?: { width: number; height: number; fps: number; quality: ExportQuality; video?: ExportVideoCodec; from?: number },
): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
  const family = size?.video ?? 'h264';
  // Carrying on a stopped export: its first frames (and all its sound) are in the file already.
  const from = Math.max(0, Math.floor(size?.from ?? 0));
  const W = even(size?.width ?? p.width);
  const H = even(size?.height ?? p.height);
  const fps = size?.fps ?? p.fps;
  const bpp = QUALITY_BPP[size?.quality ?? 'high'];
  const total = Math.max(1, Math.ceil(projectDuration(p) * fps - 1e-6));
  await prepareCutout(p);
  progress({ stage: from ? 'video' : 'sound', done: from, total });
  const mixed = from ? null : await mixAudio(p, { loudness: true });
  console.info(`export: sound mixed (${mixed ? mixed.duration.toFixed(2) + 's' : 'silent'})`);
  const audio = mixed ? await encodeAudio(mixed, family === 'vp9') : null;
  if (mixed && !audio && family === 'vp9') throw new Error('This PC cannot encode Opus sound for a WebM. Export as MP4 instead.');
  console.info(`export: sound encoded (${audio ? audio.codec + ' ' + audio.chunks.length + ' packets' : 'none'})`);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as CanvasRenderingContext2D;
  const sources = new ExactSources(p.id);
  const config = await videoEncoderConfig(W, H, fps, bpp, family);
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
        // VP9 needs no description; H.264 and H.265 do.
        const avcC = desc ? bytes(desc) : family === 'vp9' ? new Uint8Array() : null;
        if (!avcC) {
          failed = new Error('The video encoder did not describe its stream.');
          return;
        }
        begun = invoke('studio:exportBegin', { exportId, projectId: p.id, video: { width: W, height: H, codec: family, avcC }, audio: audio ? { codec: audio.codec, sampleRate: SAMPLE_RATE, channels: 2, config: audio.config } : null }).then(async () => {
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
    // 3D scene clips: the viewer and any realistic models are in place before the first frame.
    await prepareScenes(p.tracks.flatMap((tr) => tr.clips).filter((c): c is MotionClip => c.type === 'motion'));
    // Imported LUTs are read before the first frame, so every frame has its look.
    await prepareLuts(p.tracks.flatMap((tr) => tr.clips).map((c) => (c.type === 'media' || c.type === 'adjust' ? c.color : undefined)));
    for (let i = from; i < total; i++) {
      if (cancelled()) throw new Error('The export was cancelled.');
      if (failed) throw failed;
      const t = i / fps;
      const media = visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media');
      await sources.prepare(p, media, t);
      drawFrame(ctx, p, t, sources);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i === from || i % (fps * 2) === 0 });
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
  await prepareCutout(p);
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
 * Keo's self-review, measured: at each time, where every text is and where the person is (found
 * in the pictures alone, without the text on top).
 */
export async function reviewSamples(p: Project, times: number[]): Promise<ReviewSample[]> {
  const W = even(360);
  const H = even((360 * p.height) / p.width);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as CanvasRenderingContext2D;
  await prepareCutout(p);
  const findPeople = await loadCutout().catch(() => false);
  // The person is found in the talking video alone (the bottom video track), so a picture laid
  // over it cannot hide them; everything else is checked against them.
  const main = p.tracks.find((t) => t.kind === 'video' && t.name !== 'B-roll' && t.clips.some((c) => c.type === 'media'));
  const pictures: Project = { ...p, tracks: p.tracks.map((t) => (t === main ? t : { ...t, hidden: true })) };
  const isOverlay = (track: string) => !!track && track !== main?.name && !track.startsWith('Person cut-out');
  const trackOf = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, t.name] as const)));
  const out: ReviewSample[] = [];
  const sources = new ExactSources(p.id);
  try {
    for (const t of times) {
      const media = visibleAt(pictures, t).filter((c): c is MediaClip => c.type === 'media');
      let person: ReviewSample['person'] = null;
      if (findPeople && media.length) {
        await sources.prepare(pictures, media, t);
        drawFrame(ctx, pictures, t, sources);
        person = personBox(canvas, W, H);
      }
      const boxes = layerBoxes(ctx, p, t, W, H).map((b) => ({ ...b, track: trackOf.get(b.id) ?? '', box: { x0: (b.cx - b.w / 2) / W, y0: (b.cy - b.h / 2) / H, x1: (b.cx + b.w / 2) / W, y1: (b.cy + b.h / 2) / H } }));
      const texts = boxes.filter((b) => b.type === 'text').map((b) => ({ clip: b.id, track: b.track, box: b.box }));
      const overlays = boxes
        .filter((b) => b.type === 'media' && isOverlay(b.track))
        .map((b) => ({ clip: b.id, track: b.track, asset: (findClip(p, b.id)?.clip as MediaClip | undefined)?.assetId ?? '', box: b.box }));
      out.push({ t, person, texts, overlays });
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

/**
 * Colour fingerprints of one video's frames at `times` (seconds into the file, sorted): each a
 * 64-bin colour histogram of a tiny copy of the frame, summing to 1. For finding shot changes.
 */
export async function assetSignatures(p: Project, assetId: string, times: number[]): Promise<number[][]> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') throw new Error('That is not a video of this project.');
  const W = 32;
  const H = 18;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const exact = await ClipDecoder.open(p.id, assetId);
  const source = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
  const out: number[][] = [];
  try {
    for (const t of times) {
      const f = await source.frameAt(Math.max(0, Math.min(t, a.duration - 0.01)));
      if (!f) {
        out.push(out.at(-1) ?? new Array<number>(64).fill(1 / 64));
        continue;
      }
      ctx.drawImage(f as CanvasImageSource, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const bins = new Array<number>(64).fill(0);
      for (let i = 0; i < px.length; i += 4) bins[((px[i]! >> 6) << 4) | ((px[i + 1]! >> 6) << 2) | (px[i + 2]! >> 6)]! += 1;
      out.push(bins.map((b) => Math.round((b / (W * H)) * 1e4) / 1e4));
    }
  } finally {
    source.close();
  }
  return out;
}

/**
 * Edit DNA's quality pass: the timeline drawn at each time (as the export draws it) beside the
 * reference video's frame at the matching time, both 64 pixels wide — how alike they are in
 * picture (correlation of the greyscale, 0–1) and in colour (histogram overlap, 0–1).
 */
/**
 * Black bars baked into a video (a wide video saved in a tall frame, and so on): for each edge, the
 * share of the picture that is black in every frame looked at (0 when there is none).
 */
export async function videoBars(p: Project, assetId: string, times: number[]): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') return { left: 0, top: 0, right: 0, bottom: 0 };
  const exact = await ClipDecoder.open(p.id, assetId);
  const video = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
  const W = 96;
  const H = Math.max(16, Math.round((W * (a.height || 16)) / Math.max(1, a.width || 9)));
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true })!;
  // Rows and columns that have picture in them, in any frame.
  const rows = new Array<boolean>(H).fill(false);
  const cols = new Array<boolean>(W).fill(false);
  let seen = 0;
  try {
    for (const t of times) {
      const f = await video.frameAt(Math.max(0, Math.min(t, a.duration - 0.05)));
      if (!f) continue;
      seen++;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(f as CanvasImageSource, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (px[i]! + px[i + 1]! + px[i + 2]! > 3 * 22) {
            rows[y] = true;
            cols[x] = true;
          }
        }
    }
  } finally {
    video.close();
  }
  if (!seen) return { left: 0, top: 0, right: 0, bottom: 0 };
  const first = (xs: boolean[]) => Math.max(0, xs.indexOf(true));
  const last = (xs: boolean[]) => Math.max(0, xs.length - 1 - xs.lastIndexOf(true));
  // Only real bars (more than 3% of an edge), cut a hair inside so no black line is left.
  const edge = (n: number, of: number) => (n / of > 0.03 ? Math.min(0.45, Math.round((n / of + 0.005) * 1000) / 1000) : 0);
  if (!rows.includes(true)) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left: edge(first(cols), W), right: edge(last(cols), W), top: edge(first(rows), H), bottom: edge(last(rows), H) };
}

export async function compareTimeline(p: Project, assetId: string, times: number[], source: number[]): Promise<Array<{ picture: number; colour: number }>> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') throw new Error('That is not a video of this project.');
  const W = 64;
  const H = Math.max(16, Math.round((W * p.height) / p.width));
  const tl = new OffscreenCanvas(W, H);
  const tctx = tl.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const ref = new OffscreenCanvas(W, H);
  const rctx = ref.getContext('2d', { alpha: false, willReadFrequently: true })!;
  await prepareCutout(p);
  const sources = new ExactSources(p.id);
  const exact = await ClipDecoder.open(p.id, assetId);
  const video = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
  const read = (ctx: OffscreenCanvasRenderingContext2D) => {
    const px = ctx.getImageData(0, 0, W, H).data;
    const grey = new Float32Array(W * H);
    const bins = new Array<number>(64).fill(0);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      grey[j] = 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
      bins[((px[i]! >> 6) << 4) | ((px[i + 1]! >> 6) << 2) | (px[i + 2]! >> 6)]! += 1 / (W * H);
    }
    return { grey, bins };
  };
  const out: Array<{ picture: number; colour: number }> = [];
  try {
    for (let k = 0; k < times.length; k++) {
      const t = times[k]!;
      const media = visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media');
      await sources.prepare(p, media, t);
      drawFrame(tctx as unknown as CanvasRenderingContext2D, p, t, sources);
      const f = await video.frameAt(Math.max(0, Math.min(source[k] ?? t, a.duration - 0.01)));
      if (!f) {
        out.push({ picture: 0, colour: 0 });
        continue;
      }
      // The reference fills the frame the way a "cover" clip does.
      const iw = (f as { displayWidth?: number; width?: number }).displayWidth ?? (f as { width: number }).width;
      const ih = (f as { displayHeight?: number; height?: number }).displayHeight ?? (f as { height: number }).height;
      const s = Math.max(W / Math.max(1, iw), H / Math.max(1, ih));
      rctx.fillStyle = '#000';
      rctx.fillRect(0, 0, W, H);
      rctx.drawImage(f as CanvasImageSource, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
      const A = read(tctx);
      const B = read(rctx);
      let ma = 0;
      let mb = 0;
      for (let i = 0; i < A.grey.length; i++) {
        ma += A.grey[i]!;
        mb += B.grey[i]!;
      }
      ma /= A.grey.length;
      mb /= B.grey.length;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < A.grey.length; i++) {
        const x = A.grey[i]! - ma;
        const y = B.grey[i]! - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
      // Two flat pictures of the same brightness are alike; one flat and one busy are not.
      const corr = da < 1e-3 || db < 1e-3 ? (Math.abs(ma - mb) < 12 && da < 1e-3 && db < 1e-3 ? 1 : 0) : num / Math.sqrt(da * db);
      let overlap = 0;
      for (let i = 0; i < 64; i++) overlap += Math.min(A.bins[i]!, B.bins[i]!);
      out.push({ picture: Math.round(Math.max(0, corr) * 1000) / 1000, colour: Math.round(overlap * 1000) / 1000 });
    }
  } finally {
    sources.close();
    video.close();
  }
  return out;
}

/** Edit DNA's quality pass: the camera move of the timeline itself between pairs of times (as drawn, 96 pixels wide). */
export async function timelineMotion(p: Project, pairs: Array<[number, number]>): Promise<MotionEstimate[]> {
  const W = 96;
  const H = Math.max(16, Math.round((W * p.height) / p.width));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  await prepareCutout(p);
  const sources = new ExactSources(p.id);
  const grey = async (t: number): Promise<Uint8Array> => {
    const media = visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media');
    await sources.prepare(p, media, t);
    drawFrame(ctx as unknown as CanvasRenderingContext2D, p, t, sources);
    const px = ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) out[j] = Math.round(0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!);
    return out;
  };
  const out: MotionEstimate[] = [];
  try {
    for (const [t0, t1] of pairs) out.push(estimateMotion(await grey(t0), await grey(t1), W, H));
  } finally {
    sources.close();
  }
  return out;
}

/**
 * Edit DNA: the camera move between each pair of times of a video — frames decoded one at a time,
 * shrunk to 96 pixels wide and greyscale, then compared (zoom, pan, how much changes).
 */
export async function assetMotion(p: Project, assetId: string, pairs: Array<[number, number]>): Promise<MotionEstimate[]> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') throw new Error('That is not a video of this project.');
  const W = 96;
  const H = Math.max(16, Math.round((W * (a.height || 9)) / (a.width || 16)));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const exact = await ClipDecoder.open(p.id, assetId);
  const source = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
  const grey = async (t: number): Promise<Uint8Array | null> => {
    const f = await source.frameAt(Math.max(0, Math.min(t, a.duration - 0.01)));
    if (!f) return null;
    ctx.drawImage(f as CanvasImageSource, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) out[j] = Math.round(0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!);
    return out;
  };
  const out: MotionEstimate[] = [];
  try {
    for (const [t0, t1] of pairs) {
      const g0 = await grey(t0);
      const g1 = await grey(t1);
      out.push(g0 && g1 ? estimateMotion(g0, g1, W, H) : { zoom: 1, dx: 0, dy: 0, residual: 1, energy: 0, brightness: 0 });
    }
  } finally {
    source.close();
  }
  return out;
}

/**
 * One picture of a media file for Keo to look at: a picture as it is, a video as three frames
 * side by side (near its start, middle and end). PNG, base64.
 */
export async function assetSheet(p: Project, assetId: string): Promise<string> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind === 'audio') throw new Error('That is not a picture or video of this project.');
  const cell = 360;
  const aspect = a.width > 0 && a.height > 0 ? a.width / a.height : 16 / 9;
  const cw = aspect >= 1 ? cell : Math.round(cell * aspect);
  const ch = aspect >= 1 ? Math.round(cell / aspect) : cell;
  const times = a.kind === 'video' ? [0.15, 0.5, 0.85].map((f) => f * a.duration) : [0];
  const canvas = new OffscreenCanvas(cw * times.length + 8 * (times.length - 1), ch);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (a.kind === 'image') {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('The picture could not be read.'));
      i.src = mediaUrl(p.id, assetId);
    });
    ctx.drawImage(img, 0, 0, cw, ch);
  } else {
    const exact = await ClipDecoder.open(p.id, assetId);
    const source = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
    try {
      for (const [k, t] of times.entries()) {
        const f = await source.frameAt(Math.max(0, Math.min(t, a.duration - 0.01)));
        if (f) ctx.drawImage(f as CanvasImageSource, k * (cw + 8), 0, cw, ch);
      }
    } finally {
      source.close();
    }
  }
  return base64(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
}

const base64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * An animated GIF (up to 480 px wide, up to 15 frames a second, one palette for the whole
 * animation) or the sound alone as a WAV: the same engine and mix as the MP4 export.
 */
export async function exportFile(p: Project, format: 'gif' | 'wav', progress: Progress, cancelled: () => boolean): Promise<{ base64: string; frames: number; durationSec: number }> {
  const dur = projectDuration(p);
  if (format === 'wav') {
    progress({ stage: 'sound', done: 0, total: 1 });
    const mixed = await mixAudio(p, { loudness: true });
    if (!mixed) throw new Error('The timeline has no sound to save.');
    return { base64: base64(wavStereo(mixed.getChannelData(0), mixed.numberOfChannels > 1 ? mixed.getChannelData(1) : mixed.getChannelData(0), mixed.sampleRate)), frames: 0, durationSec: mixed.duration };
  }
  await prepareCutout(p);
  const W = even(Math.min(480, p.width));
  const H = even((W * p.height) / p.width);
  const fps = Math.min(15, p.fps);
  const total = Math.max(1, Math.ceil(dur * fps - 1e-6));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
  const sources = new ExactSources(p.id);
  const draw = async (t: number): Promise<Uint8Array> => {
    await sources.prepare(p, visibleAt(p, t).filter((c): c is MediaClip => c.type === 'media'), t);
    drawFrame(ctx, p, t, sources);
    return new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer);
  };
  try {
    // One palette from frames across the whole animation, then each frame mapped and compressed.
    const samples: Uint8Array[] = [];
    for (let k = 0; k < 8; k++) samples.push((await draw((dur * (k + 0.5)) / 8)).slice());
    const pal = buildPalette(samples);
    const map = paletteMapper(pal);
    const parts: Uint8Array[] = [gifHead(W, H, pal)];
    const delay = Math.round(100 / fps);
    for (let i = 0; i < total; i++) {
      if (cancelled()) throw new Error('The export was cancelled.');
      parts.push(gifFrame(W, H, map(await draw(i / fps)), delay));
      if (i % 10 === 0) progress({ stage: 'video', done: i, total });
    }
    parts.push(GIF_END);
    progress({ stage: 'saving', done: total, total });
    return { base64: base64(join(parts)), frames: total, durationSec: total / fps };
  } finally {
    sources.close();
  }
}

/** A media file's whole sound with the background noise taken out, as a 48 kHz stereo WAV (base64). */
export async function denoiseAsset(p: Project, assetId: string, strength: number): Promise<{ base64: string; seconds: number }> {
  const bytes = await (await fetch(mediaUrl(p.id, assetId))).arrayBuffer();
  const buf = await new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(bytes);
  const left = denoise(buf.getChannelData(0), { strength });
  const right = buf.numberOfChannels > 1 ? denoise(buf.getChannelData(1), { strength }) : left;
  return { base64: base64(wavStereo(left, right, buf.sampleRate)), seconds: buf.duration };
}

/**
 * Motion in one video at `times` (seconds into the file, sorted), from small grey copies of its
 * frames: where a box (fractions of the video) goes, or how far the whole picture moves from
 * frame to frame (fractions of the video's width and height).
 */
export async function trackMotion(p: Project, assetId: string, times: number[], box: { x: number; y: number; w: number; h: number } | null): Promise<Array<{ x: number; y: number; lost?: boolean }>> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || a.kind !== 'video') throw new Error('That is not a video of this project.');
  const W = 320;
  const H = Math.max(16, Math.round((W * (a.height || 9)) / (a.width || 16)));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const exact = await ClipDecoder.open(p.id, assetId);
  const source = exact ?? new ElementSeeker(mediaUrl(p.id, assetId));
  const gray = async (t: number): Promise<Gray> => {
    const f = await source.frameAt(Math.max(0, Math.min(t, a.duration - 0.01)));
    if (f) ctx.drawImage(f as CanvasImageSource, 0, 0, W, H);
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const px = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < px.length; i += 4, j++) px[j] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
    return { w: W, h: H, px };
  };
  const out: Array<{ x: number; y: number; lost?: boolean }> = [];
  try {
    let prev = await gray(times[0] ?? 0);
    if (box) {
      const step = boxTracker(prev, { x: box.x * W, y: box.y * H, w: box.w * W, h: box.h * H });
      out.push(step(null));
      for (const t of times.slice(1)) out.push(step(await gray(t)));
    } else {
      out.push({ x: 0, y: 0 });
      for (const t of times.slice(1)) {
        const cur = await gray(t);
        const s = frameShift(prev, cur, Math.round(W * 0.06));
        out.push({ x: s.dx / W, y: s.dy / H });
        prev = cur;
      }
    }
  } finally {
    source.close();
  }
  return out;
}
