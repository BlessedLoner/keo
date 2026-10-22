import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ffmpeg and ffprobe, run as plain processes with fixed argument lists (never a shell, never a
 * command line built from text). Keo does not ship ffmpeg: it uses the copy the user chose in
 * Settings → Video, else the copy Keo downloaded when the user clicked "Set up video tools", else
 * one on PATH.
 */
export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export interface RunOptions {
  signal: AbortSignal;
  /** Working folder (the render's own folder, so the captions file needs no path in the filter). */
  cwd?: string;
  timeoutMs?: number;
  /** Seconds of output written so far (renders run with -progress pipe:1). */
  onProgress?: (seconds: number) => void;
  /** Larger stdout is cut off (and the run fails). */
  maxStdout?: number;
}

export interface FfmpegRunner {
  ffmpeg(args: string[], o: RunOptions): Promise<RunResult>;
  ffprobe(args: string[], o: RunOptions): Promise<RunResult>;
}

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  source: 'settings' | 'keo' | 'path';
}

export class FfmpegError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/**
 * The user's chosen ffmpeg.exe (with ffprobe.exe beside it), else Keo's own copy (`ownDir`, from
 * "Set up video tools"), else the first pair on PATH.
 */
export function locateFfmpeg(chosen: string | null, envPath: string | undefined = process.env.PATH, exists: (p: string) => boolean = isFile, ownDir: string | null = null): FfmpegTools | null {
  if (chosen) {
    const dir = path.dirname(chosen);
    const probe = path.join(dir, exe('ffprobe'));
    if (path.basename(chosen).toLowerCase() === exe('ffmpeg') && exists(chosen) && exists(probe)) return { ffmpeg: chosen, ffprobe: probe, source: 'settings' };
    return null;
  }
  if (ownDir) {
    const f = path.join(ownDir, exe('ffmpeg'));
    const p = path.join(ownDir, exe('ffprobe'));
    if (exists(f) && exists(p)) return { ffmpeg: f, ffprobe: p, source: 'keo' };
  }
  for (const dir of (envPath ?? '').split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const f = path.join(dir, exe('ffmpeg'));
    const p = path.join(dir, exe('ffprobe'));
    if (exists(f) && exists(p)) return { ffmpeg: f, ffprobe: p, source: 'path' };
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The real runner: child processes without a window, killed on cancel or timeout. */
export class ProcessRunner implements FfmpegRunner {
  constructor(private readonly tools: FfmpegTools) {}

  ffmpeg(args: string[], o: RunOptions): Promise<RunResult> {
    return run(this.tools.ffmpeg, ['-hide_banner', '-nostdin', ...args], o);
  }

  ffprobe(args: string[], o: RunOptions): Promise<RunResult> {
    return run(this.tools.ffprobe, ['-hide_banner', ...args], o);
  }
}

function run(file: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) {
      reject(new FfmpegError('cancelled', 'Cancelled.'));
      return;
    }
    const child = spawn(file, args, { shell: false, windowsHide: true, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let tooBig = false;
    let progressTail = '';
    const max = o.maxStdout ?? 64 * 1024 * 1024;
    child.stdout.on('data', (b: Buffer) => {
      if (o.onProgress) {
        progressTail += b.toString('utf8');
        const lines = progressTail.split(/\r?\n/);
        progressTail = lines.pop() ?? '';
        for (const l of lines) {
          const m = l.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) o.onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        }
        return;
      }
      outBytes += b.length;
      if (outBytes > max) {
        tooBig = true;
        child.kill();
        return;
      }
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8');
      // Only the end matters for errors; scene/beat parsing reads lines as they come, so keep plenty.
      if (err.length > 8_000_000) err = err.slice(-4_000_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new FfmpegError('timeout', `ffmpeg took longer than ${Math.round((o.timeoutMs ?? 0) / 1000)} s and was stopped.`));
    }, o.timeoutMs ?? 10 * 60_000);
    const onAbort = () => {
      child.kill();
      reject(new FfmpegError('cancelled', 'Cancelled.'));
    };
    o.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      reject(new FfmpegError('not_started', `ffmpeg could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      if (tooBig) reject(new FfmpegError('too_much_output', 'ffmpeg returned more data than expected.'));
      else resolve({ stdout: Buffer.concat(out), stderr: err, code });
    });
  });
}

/** The last meaningful ffmpeg error line (for messages to the user). */
export function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(frame=|size=|progress=|out_time|speed=)/.test(l));
  return (lines.reverse().find((l) => /error|invalid|no such|not found|unable|failed|cannot|could not/i.test(l)) ?? lines[0] ?? 'unknown error').slice(0, 300);
}

// ------------------------------------------------------------------ probe

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export async function probe(r: FfmpegRunner, file: string, signal: AbortSignal): Promise<ProbeResult> {
  const res = await r.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, timeoutMs: 30_000, maxStdout: 4 * 1024 * 1024 });
  if (res.code !== 0) throw new FfmpegError('probe_failed', `ffprobe could not read ${path.basename(file)}: ${lastError(res.stderr)}`);
  return parseProbe(res.stdout.toString('utf8'));
}

export function parseProbe(json: string): ProbeResult {
  let j: { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  try {
    j = JSON.parse(json);
  } catch {
    throw new FfmpegError('probe_failed', 'ffprobe returned something Keo cannot read.');
  }
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const rate = (s: unknown) => {
    const m = String(s ?? '').match(/^(\d+)\/(\d+)$/);
    return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : Number(s) || 0;
  };
  const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  let width = num(v?.width);
  let height = num(v?.height);
  // Phone videos are often stored sideways with a rotation flag.
  const rot = Math.abs(num((v?.tags as { rotate?: string } | undefined)?.rotate ?? (v?.side_data_list as Array<{ rotation?: number }> | undefined)?.find((d) => d.rotation !== undefined)?.rotation));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  const duration = num(j.format?.duration) || num(v?.duration) || num(a?.duration);
  return {
    durationSec: Math.round(duration * 1000) / 1000,
    width,
    height,
    fps: Math.round((rate(v?.avg_frame_rate) || rate(v?.r_frame_rate)) * 100) / 100,
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: (v?.codec_name as string | undefined) ?? null,
    audioCodec: (a?.codec_name as string | undefined) ?? null,
  };
}

// ------------------------------------------------------------------ scenes

/** Frames where the picture changes (scene score above the threshold), from ffmpeg's metadata=print log. */
export function parseSceneScores(stderr: string): Array<{ t: number; score: number }> {
  const out: Array<{ t: number; score: number }> = [];
  let t: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const pt = line.match(/pts_time:\s*(-?\d+(?:\.\d+)?)/);
    if (pt) {
      t = Number(pt[1]);
      continue;
    }
    const sc = line.match(/lavfi\.scene_score=(\d+(?:\.\d+)?)/);
    if (sc && t !== null) {
      out.push({ t: Math.round(t * 1000) / 1000, score: Number(sc[1]) });
      t = null;
    }
  }
  return out;
}

/** Scene changes of a video, measured on a small copy of the picture (fast). */
export async function sceneScores(r: FfmpegRunner, file: string, threshold: number, signal: AbortSignal, maxSec = 600): Promise<Array<{ t: number; score: number }>> {
  const res = await r.ffmpeg(['-v', 'info', '-t', String(maxSec), '-i', file, '-an', '-sn', '-vf', `scale=160:-2,select='gt(scene,${threshold})',metadata=print`, '-f', 'null', '-'], { signal, timeoutMs: 5 * 60_000 });
  if (res.code !== 0) throw new FfmpegError('scan_failed', `ffmpeg could not scan ${path.basename(file)}: ${lastError(res.stderr)}`);
  return parseSceneScores(res.stderr);
}

/** Cut points → shots (very short flickers are merged into the shot before). */
export function shotsFromCuts(cuts: number[], duration: number, minShot = 0.25): Array<{ startSec: number; durationSec: number }> {
  const points = [0, ...cuts.filter((c) => c > minShot && c < duration - minShot).sort((a, b) => a - b), duration];
  const shots: Array<{ startSec: number; durationSec: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const d = points[i + 1]! - start;
    if (d < minShot && shots.length) shots[shots.length - 1]!.durationSec += d;
    else shots.push({ startSec: start, durationSec: d });
  }
  return shots.map((s) => ({ startSec: Math.round(s.startSec * 100) / 100, durationSec: Math.round(s.durationSec * 100) / 100 }));
}

// ------------------------------------------------------------------ audio beats

export const BEAT_RATE = 11025;

/** The sound as mono 16-bit samples at a low rate (enough for beats; nothing is saved). */
export async function monoPcm(r: FfmpegRunner, file: string, signal: AbortSignal, maxSec = 180, startSec = 0): Promise<Int16Array> {
  const res = await r.ffmpeg(['-v', 'error', ...(startSec > 0 ? ['-ss', String(startSec)] : []), '-t', String(maxSec), '-i', file, '-vn', '-ac', '1', '-ar', String(BEAT_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
    signal,
    timeoutMs: 2 * 60_000,
    maxStdout: maxSec * BEAT_RATE * 2 + 1024,
  });
  if (res.code !== 0) throw new FfmpegError('audio_failed', `ffmpeg could not read the sound of ${path.basename(file)}: ${lastError(res.stderr)}`);
  const b = res.stdout;
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
}

/**
 * Onsets (sudden rises in loudness) and, when the sound has a steady pulse, the beat grid and
 * tempo. A simple energy-flux method: good enough to put cuts on the beat of pop music.
 */
export function detectBeats(pcm: Int16Array, rate = BEAT_RATE): { onsets: number[]; beats: number[]; bpm: number | null } {
  const hop = 256;
  const win = 1024;
  const frames = Math.floor((pcm.length - win) / hop);
  if (frames < 20) return { onsets: [], beats: [], bpm: null };
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) {
      const v = pcm[o + i]! / 32768;
      s += v * v;
    }
    energy[f] = Math.log(1e-6 + s / win);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  const fps = rate / hop;
  // Adaptive threshold: a peak well above the local average.
  const half = Math.round(fps * 0.4);
  const onsets: number[] = [];
  let last = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, f - half); k < Math.min(frames, f + half); k++) {
      sum += flux[k]!;
      n++;
    }
    const thr = (sum / n) * 1.6 + 0.08;
    if (flux[f]! > thr && flux[f]! >= flux[f - 1]! && flux[f]! >= flux[f + 1]! && f - last > fps * 0.1) {
      onsets.push(Math.round((f * hop) / rate * 1000) / 1000);
      last = f;
    }
  }
  // Tempo: autocorrelation of the flux over 60–180 BPM, gently preferring ~120.
  const minLag = Math.round((fps * 60) / 180);
  const maxLag = Math.round((fps * 60) / 60);
  let bestLag = 0;
  let best = 0;
  let mean = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag && lag < frames / 2; lag++) {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += flux[f]! * flux[f + lag]!;
    s /= frames - lag;
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    mean += s;
    count++;
    if (s * w > best) {
      best = s * w;
      bestLag = lag;
    }
  }
  mean /= Math.max(1, count);
  let zero = 0;
  for (let f = 0; f < frames; f++) zero += flux[f]! * flux[f]!;
  zero /= frames;
  const periodic = bestLag > 0 && best > mean * 1.15 && zero > 0;
  if (!periodic) return { onsets, beats: onsets, bpm: null };
  // Phase: the grid offset that lands on the most flux.
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let f = p; f < frames; f += bestLag) s += flux[f]!;
    if (s > phaseScore) {
      phaseScore = s;
      bestPhase = p;
    }
  }
  const beats: number[] = [];
  for (let f = bestPhase; f < frames; f += bestLag) beats.push(Math.round((f * hop) / rate * 1000) / 1000);
  return { onsets, beats, bpm: Math.round((60 * fps) / bestLag) };
}

// ------------------------------------------------------------------ frames

/** One frame as a PNG (scaled so its long side is at most `side`). */
export async function frameAt(r: FfmpegRunner, file: string, atSec: number, side: number, signal: AbortSignal): Promise<Buffer> {
  const res = await r.ffmpeg(['-v', 'error', '-ss', atSec.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale='if(gt(iw,ih),${side},-2)':'if(gt(iw,ih),-2,${side})'`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], {
    signal,
    timeoutMs: 30_000,
    maxStdout: 16 * 1024 * 1024,
  });
  if (res.code !== 0 || !res.stdout.length) throw new FfmpegError('frame_failed', `ffmpeg could not take a picture from ${path.basename(file)} at ${atSec.toFixed(1)} s: ${lastError(res.stderr)}`);
  return res.stdout;
}

// ------------------------------------------------------------------ encoders

export interface FfmpegFeatures {
  encoders: Set<string>;
  filters: Set<string>;
}

export async function features(r: FfmpegRunner, signal: AbortSignal): Promise<FfmpegFeatures> {
  const [e, f] = await Promise.all([r.ffmpeg(['-v', 'error', '-encoders'], { signal, timeoutMs: 20_000 }), r.ffmpeg(['-v', 'error', '-filters'], { signal, timeoutMs: 20_000 })]);
  const names = (text: string, re: RegExp) => new Set(text.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter((x): x is string => !!x));
  return {
    encoders: names(e.stdout.toString('utf8'), /^\s*[VAS][.A-Z]{5}\s+(\S+)/),
    filters: names(f.stdout.toString('utf8'), /^\s*[.A-Z|]{2,3}\s+(\S+)\s+\S+->\S+/),
  };
}

/**
 * H.264 encoders in order of preference. libx264 is only in GPL builds of ffmpeg; LGPL builds
 * on Windows have Media Foundation (h264_mf) and the graphics-card encoders.
 */
export const H264_ORDER = ['libx264', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264', 'mpeg4'] as const;
export type VideoEncoder = (typeof H264_ORDER)[number];

export function pickEncoder(f: FfmpegFeatures): VideoEncoder | null {
  return H264_ORDER.find((e) => f.encoders.has(e)) ?? null;
}

export function encoderArgs(enc: VideoEncoder, preview: boolean, height: number): string[] {
  const rate = preview ? '1200k' : height >= 1080 ? '10M' : '6M';
  switch (enc) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'veryfast', '-crf', preview ? '30' : '20', '-pix_fmt', 'yuv420p'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', preview ? 'p1' : 'p5', '-b:v', rate, '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-b:v', rate];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', preview ? 'speed' : 'balanced', '-b:v', rate];
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-b:v', rate, '-pix_fmt', 'yuv420p'];
    case 'libopenh264':
      return ['-c:v', 'libopenh264', '-b:v', rate, '-pix_fmt', 'yuv420p'];
    case 'mpeg4':
      return ['-c:v', 'mpeg4', '-q:v', preview ? '8' : '3', '-pix_fmt', 'yuv420p'];
  }
}
