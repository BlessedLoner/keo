import fs from 'node:fs';
import path from 'node:path';
import type { FfmpegRunner, RunOptions, RunResult } from '../src/main/video/ffmpeg';

export interface FakeMedia {
  durationSec: number;
  width: number;
  height: number;
  fps?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  /** Scene changes (time, score) the fake reports for this file. */
  scenes?: Array<{ t: number; score: number }>;
  /** Clicks at these times in the fake sound (for beat detection). */
  clicks?: number[];
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000000050001a5f645400000000049454e44ae426082', 'hex');

/**
 * Stands in for ffmpeg/ffprobe: answers probes from a table, reports scene changes and sound,
 * and "renders" by writing a small file and remembering what it should contain. No real
 * process ever starts.
 */
export class FakeFfmpeg implements FfmpegRunner {
  media = new Map<string, FakeMedia>();
  calls: Array<{ tool: 'ffmpeg' | 'ffprobe'; args: string[]; cwd: string | undefined }> = [];
  encoders = ['libx264', 'h264_mf', 'aac'];
  filters = ['subtitles', 'xfade', 'acrossfade', 'amix', 'scale', 'crop'];
  failRender: string | null = null;
  /** Renders wait this long (to test cancelling a preview). */
  renderDelayMs = 0;
  /** What each render saw: the captions file it read, its output. */
  renders: Array<{ out: string; ass: string | null; args: string[] }> = [];

  add(file: string, m: FakeMedia): void {
    this.media.set(path.resolve(file).toLowerCase(), m);
  }

  private find(file: string): FakeMedia | undefined {
    const known = this.media.get(path.resolve(file).toLowerCase());
    if (known) return known;
    // A rendered file carries its own description, so it is still known after Keo moves it.
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.startsWith('fake mp4 ') ? (JSON.parse(text.slice(9)) as FakeMedia) : undefined;
    } catch {
      return undefined;
    }
  }

  async ffprobe(args: string[], o: RunOptions): Promise<RunResult> {
    this.calls.push({ tool: 'ffprobe', args, cwd: o.cwd });
    const file = args[args.length - 1]!;
    const m = this.find(file);
    if (!m || !fs.existsSync(file)) return { stdout: Buffer.alloc(0), stderr: `${file}: No such file or directory`, code: 1 };
    const streams = [
      ...(m.hasVideo === false ? [] : [{ codec_type: 'video', codec_name: 'h264', width: m.width, height: m.height, avg_frame_rate: `${m.fps ?? 30}/1` }]),
      ...(m.hasAudio === false ? [] : [{ codec_type: 'audio', codec_name: 'aac' }]),
    ];
    return { stdout: Buffer.from(JSON.stringify({ format: { duration: String(m.durationSec) }, streams })), stderr: '', code: 0 };
  }

  async ffmpeg(args: string[], o: RunOptions): Promise<RunResult> {
    this.calls.push({ tool: 'ffmpeg', args, cwd: o.cwd });
    if (o.signal.aborted) throw new Error('aborted');
    if (args.includes('-encoders')) return { stdout: Buffer.from(` V..... = Video\n ------\n${this.encoders.map((e) => ` V....D ${e}  fake encoder`).join('\n')}\n`), stderr: '', code: 0 };
    if (args.includes('-filters')) return { stdout: Buffer.from(` T.. = Timeline\n${this.filters.map((f) => ` TS. ${f}  V->V  fake filter`).join('\n')}\n`), stderr: '', code: 0 };
    const input = args[args.indexOf('-i') + 1]!;
    const m = this.find(input);
    const vf = args[args.indexOf('-vf') + 1] ?? '';
    if (args.includes('-filter_complex')) return this.render(args, o);
    if (!m) return { stdout: Buffer.alloc(0), stderr: `${input}: No such file or directory`, code: 1 };
    if (vf.includes('metadata=print')) {
      const thr = Number(vf.match(/gt\(scene,([\d.]+)\)/)?.[1] ?? 0);
      const lines = (m.scenes ?? []).filter((s) => s.score > thr).flatMap((s, i) => [`[Parsed_metadata_2 @ 0x1] frame:${i} pts:${Math.round(s.t * 1000)} pts_time:${s.t}`, `[Parsed_metadata_2 @ 0x1] lavfi.scene_score=${s.score}`]);
      return { stdout: Buffer.alloc(0), stderr: lines.join('\n'), code: 0 };
    }
    if (args.includes('s16le')) {
      const rate = Number(args[args.indexOf('-ar') + 1]);
      const secs = Math.min(Number(args[args.indexOf('-t') + 1] ?? m.durationSec), m.durationSec);
      const pcm = new Int16Array(Math.floor(rate * secs));
      for (const c of m.clicks ?? []) {
        const at = Math.floor(c * rate);
        for (let k = 0; k < 300 && at + k < pcm.length; k++) pcm[at + k] = Math.round(20000 * Math.exp(-k / 60) * (k % 2 ? 1 : -1));
      }
      return { stdout: Buffer.from(pcm.buffer), stderr: '', code: 0 };
    }
    if (args.includes('image2pipe')) return { stdout: PNG, stderr: '', code: 0 };
    if (args.includes('wav')) return { stdout: Buffer.from('RIFF....WAVEfmt fake'), stderr: '', code: 0 };
    return { stdout: Buffer.alloc(0), stderr: 'unexpected call', code: 1 };
  }

  private async render(args: string[], o: RunOptions): Promise<RunResult> {
    const out = path.resolve(o.cwd ?? '.', args[args.length - 1]!);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    const assFile = graph.includes('subtitles=') ? path.join(o.cwd ?? '.', graph.match(/subtitles=([^[;]+)/)![1]!) : null;
    const ass = assFile && fs.existsSync(assFile) ? fs.readFileSync(assFile, 'utf8') : null;
    if (assFile && !ass) return { stdout: Buffer.alloc(0), stderr: 'Unable to open keo-text.ass', code: 1 };
    if (this.renderDelayMs) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, this.renderDelayMs);
        o.signal.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new Error('cancelled'));
        });
      });
    }
    if (this.failRender) return { stdout: Buffer.alloc(0), stderr: this.failRender, code: 1 };
    const total = Number(args[args.indexOf('-t', args.indexOf('-filter_complex')) + 1]);
    o.onProgress?.(total / 2);
    o.onProgress?.(total);
    const size = graph.match(/scale=(\d+):(\d+):force_original_aspect_ratio/)!;
    fs.writeFileSync(out, `fake mp4 ${JSON.stringify({ durationSec: total, width: Number(size[1]), height: Number(size[2]), hasAudio: true })}`);
    this.renders.push({ out, ass, args });
    return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
  }
}
