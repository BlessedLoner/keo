import { captionCues, dimensions, round2, totalSeconds, type ClipInfo, type Recipe, type TextOverlayT } from './recipe';
import { encoderArgs, type VideoEncoder } from './ffmpeg';

/**
 * Turns a recipe into one ffmpeg run: every shot is cut from its clip, scaled to fill the frame,
 * joined (hard cuts or simple transitions), mixed with the music, and the captions and texts are
 * drawn from a subtitles file. User text never appears in the arguments; it lives only in that
 * file, which ffmpeg reads from the render's own folder.
 */
export interface RenderPlan {
  args: string[];
  /** The captions/text file to write next to the output before running (null = none). */
  ass: string | null;
  durationSec: number;
  width: number;
  height: number;
  notes: string[];
}

export const ASS_NAME = 'keo-text.ass';

export function buildRenderPlan(
  r: Recipe,
  clips: Map<string, ClipInfo>,
  o: { preview: boolean; outFile: string; encoder: VideoEncoder; subtitlesFilter: boolean },
): RenderPlan {
  const { width: W, height: H } = dimensions(r.aspect, o.preview);
  const fps = o.preview ? Math.min(r.fps, 30) : r.fps;
  const notes: string[] = [];
  const xf = r.transition.kind !== 'cut' && r.shots.length > 1;
  const t = xf ? r.transition.seconds : 0;
  const args: string[] = ['-y', '-v', 'error'];
  const filters: string[] = [];

  // Each shot's length in the output, including the overlap a transition needs.
  const lens: number[] = r.shots.map((s, i) => {
    const c = clips.get(s.clipId);
    if (!c) throw new Error(`Clip ${s.clipId} is not in this project.`);
    const want = s.durationSec + (xf && i < r.shots.length - 1 ? t : 0);
    const available = Math.max(0.1, (c.durationSec - s.inSec) / s.speed);
    return round2(Math.min(want, available));
  });
  // A transition cannot be longer than the shorter of its two shots.
  if (xf && lens.some((l) => l <= t + 0.05)) notes.push('Some shots are very short, so their transitions are shortened.');

  r.shots.forEach((s, i) => {
    const c = clips.get(s.clipId)!;
    args.push('-ss', s.inSec.toFixed(3), '-t', (lens[i]! * s.speed + 0.1).toFixed(3), '-i', c.file);
  });
  const musicIndex = r.music ? r.shots.length : -1;
  if (r.music) args.push(...(r.music.startSec > 0 ? ['-ss', r.music.startSec.toFixed(3)] : []), '-i', r.music.path);

  r.shots.forEach((s, i) => {
    const c = clips.get(s.clipId)!;
    const L = lens[i]!.toFixed(3);
    filters.push(
      `[${i}:v]setpts=(PTS-STARTPTS)/${s.speed},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p,trim=duration=${L},setpts=PTS-STARTPTS[v${i}]`,
    );
    const norm = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${L},asetpts=PTS-STARTPTS,apad=whole_dur=${L}`;
    if (c.hasAudio) filters.push(`[${i}:a]${atempo(s.speed)}${norm}[a${i}]`);
    else filters.push(`anullsrc=r=48000:cl=stereo,${norm}[a${i}]`);
  });

  let total: number;
  if (!xf) {
    filters.push(`${r.shots.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${r.shots.length}:v=1:a=1[vj][aj]`);
    total = lens.reduce((a, b) => a + b, 0);
  } else {
    let vPrev = 'v0';
    let aPrev = 'a0';
    let length = lens[0]!;
    for (let i = 1; i < r.shots.length; i++) {
      const d = Math.max(0.05, Math.min(t, lens[i - 1]! - 0.05, lens[i]! - 0.05));
      const offset = Math.max(0, length - d);
      const vOut = i === r.shots.length - 1 ? 'vj' : `vx${i}`;
      const aOut = i === r.shots.length - 1 ? 'aj' : `ax${i}`;
      filters.push(`[${vPrev}][v${i}]xfade=transition=${r.transition.kind}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
      filters.push(`[${aPrev}][a${i}]acrossfade=d=${d.toFixed(3)}[${aOut}]`);
      length = length + lens[i]! - d;
      vPrev = vOut;
      aPrev = aOut;
    }
    total = length;
  }
  total = round2(total);

  // Sound: the clips' own sound at its volume, with the music under it.
  if (r.music) {
    const fade = Math.min(r.music.fadeOutSec, total / 3);
    filters.push(`[aj]volume=${r.clipVolume}[ac]`);
    filters.push(
      `[${musicIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${total.toFixed(3)},volume=${r.music.volume}${fade > 0 ? `,afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}` : ''}[am]`,
    );
    filters.push(`[ac][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    filters.push(`[aj]volume=${r.clipVolume}[aout]`);
  }

  const cues = captionCues(r, clips);
  const anyText = cues.length > 0 || r.texts.length > 0;
  let ass: string | null = null;
  if (anyText && o.subtitlesFilter) {
    ass = buildAss(r, cues, W, H);
    filters.push(`[vj]subtitles=${ASS_NAME}[vout]`);
  } else {
    if (anyText) notes.push('This ffmpeg cannot draw text (it has no subtitles filter), so captions and texts are left out.');
    filters.push('[vj]null[vout]');
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...encoderArgs(o.encoder, o.preview, H),
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    o.preview ? '96k' : '192k',
    '-ar',
    '48000',
    '-t',
    total.toFixed(3),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    o.outFile,
  );
  return { args, ass, durationSec: total, width: W, height: H, notes };
}

/** ffmpeg's atempo takes 0.5–2 per step; slower or faster speeds chain several. */
function atempo(speed: number): string {
  if (speed === 1) return '';
  const parts: number[] = [];
  let s = speed;
  while (s > 2) {
    parts.push(2);
    s /= 2;
  }
  while (s < 0.5) {
    parts.push(0.5);
    s /= 0.5;
  }
  parts.push(Math.round(s * 10000) / 10000);
  return parts.map((p) => `atempo=${p},`).join('');
}

// ------------------------------------------------------------------ captions and texts (ASS)

const ALIGN = { bottom: 2, center: 5, top: 8 } as const;

/** #RRGGBB → ASS &HAABBGGRR */
export function assColour(hex: string, alpha = 0): string {
  const h = hex.replace('#', '');
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Text as plain words: no override tags, no line breaks Keo did not put there. */
export function assText(s: string): string {
  return s
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

export function buildAss(r: Recipe, cues: Array<{ startSec: number; endSec: number; text: string }>, W: number, H: number): string {
  const c = r.captions;
  const margin = (pos: 'top' | 'center' | 'bottom') => (pos === 'center' ? 0 : Math.round(H * (pos === 'bottom' ? 0.16 : 0.1)));
  const size = (pct: number) => Math.max(8, Math.round((pct / 100) * H));
  const styles = [
    `Style: Caption,${c.font},${size(c.sizePct)},${assColour(c.color)},${assColour(c.color)},${assColour(c.outline)},${assColour('#000000', 0x80)},-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size(c.sizePct) * 0.08))},1,${ALIGN[c.position]},${Math.round(W * 0.06)},${Math.round(W * 0.06)},${margin(c.position)},1`,
    ...r.texts.map((t: TextOverlayT, i) => {
      const fs = size(t.sizePct);
      // BorderStyle 3 = a box behind the text.
      return `Style: T${i},${t.font},${fs},${assColour(t.color)},${assColour(t.color)},${assColour('#000000', t.box ? 0x40 : 0)},${assColour('#000000', 0x40)},-1,0,0,0,100,100,0,0,${t.box ? 3 : 1},${t.box ? Math.round(fs * 0.25) : Math.max(2, Math.round(fs * 0.07))},0,${ALIGN[t.position]},${Math.round(W * 0.07)},${Math.round(W * 0.07)},${margin(t.position)},1`;
    }),
  ];
  const end = totalSeconds(r);
  const events = [
    ...r.texts.map((t, i) => `Dialogue: 1,${assTime(t.startSec)},${assTime(Math.min(t.endSec, end))},T${i},,0,0,0,,${assText(t.text)}`),
    ...cues.map((q) => `Dialogue: 0,${assTime(q.startSec)},${assTime(q.endSec)},Caption,,0,0,0,,${assText(q.text)}`),
  ];
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
