import { captionCues, cutInto, dimensions, outputSeconds, round2, sourceSeconds, totalSeconds, type ClipInfo, type Recipe, type ShotT, type TextOverlayT, type TransitionKind } from './recipe';
import { encoderArgs, type VideoEncoder } from './ffmpeg';

/**
 * Turns a recipe into one ffmpeg run: every shot is cut from its clip, scaled to fill the frame,
 * zoomed and sped up or ramped as planned, and joined (runs of hard cuts concatenated, a
 * transition per cut with xfade). Each shot's sound is placed on the timeline (so J/L cuts work)
 * and mixed with the music, and the captions and texts are drawn from a subtitles file. User text never appears in the arguments; it lives only in that
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

/** The xfade transition behind each of Keo's cut looks (most have the same name). */
export function xfadeName(kind: Exclude<TransitionKind, 'cut'>): string {
  return kind === 'whip' ? 'slideleft' : kind === 'flash' ? 'fadewhite' : kind === 'punch' ? 'zoomin' : kind;
}

/** Tiny sound crossfade at hard cuts (no clicks). */
const HARD_FADE = 0.02;
const f3 = (v: number) => v.toFixed(3);

export function buildRenderPlan(
  r: Recipe,
  clips: Map<string, ClipInfo>,
  o: { preview: boolean; outFile: string; encoder: VideoEncoder; subtitlesFilter: boolean; blurFilter?: boolean },
): RenderPlan {
  const { width: W, height: H } = dimensions(r.aspect, o.preview);
  const fps = o.preview ? Math.min(r.fps, 30) : r.fps;
  const notes: string[] = [];
  const n = r.shots.length;
  const args: string[] = ['-y', '-v', 'error'];
  const filters: string[] = [];
  const clipOf = r.shots.map((s) => {
    const c = clips.get(s.clipId);
    if (!c) throw new Error(`Clip ${s.clipId} is not in this project.`);
    return c;
  });

  // 1. The cut into each shot, and how long its transition overlaps the shot before (0 = hard cut).
  const cuts = r.shots.map((_, i) => cutInto(r, i));
  const d = cuts.map((c, i) => (i === 0 || c.kind === 'cut' ? 0 : Math.max(0.05, Math.min(c.seconds, r.shots[i - 1]!.durationSec * 0.5, r.shots[i]!.durationSec * 0.5))));
  if (cuts.some((c, i) => c.kind !== 'cut' && d[i]! < c.seconds - 0.001)) notes.push('Some shots are very short, so their transitions are shortened.');

  // 2. Each shot's length in the output, including the overlap the next transition needs.
  const lens = r.shots.map((s, i) => {
    const available = Math.max(0.1, outputSeconds(s, clipOf[i]!.durationSec - s.inSec));
    return round2(Math.min(s.durationSec + (d[i + 1] ?? 0), available));
  });
  for (let i = 1; i < n; i++) if (d[i]! > 0) d[i] = Math.max(0.05, Math.min(d[i]!, lens[i - 1]! - 0.05, lens[i]! - 0.05));
  const starts: number[] = [0];
  for (let i = 1; i < n; i++) starts.push(starts[i - 1]! + lens[i - 1]! - d[i]!);
  const total = round2(starts[n - 1]! + lens[n - 1]!);

  // 3. Split sound edits (hard cuts only): J = the shot's sound starts `lead` early, L = the previous one runs `tail` on.
  const lead = r.shots.map(() => 0);
  const tail = r.shots.map(() => 0);
  let splitDropped = false;
  r.shots.forEach((s, i) => {
    if (i === 0 || !s.audio) return;
    if (d[i]! > 0) {
      splitDropped = true;
      return;
    }
    if (s.audio.kind === 'j') {
      // Needs footage before the in-point.
      lead[i] = Math.max(0, Math.min(s.audio.seconds, s.inSec / s.speed, lens[i - 1]! * 0.8));
    } else {
      const p = r.shots[i - 1]!;
      const pEnd = p.inSec + sourceSeconds(p, lens[i - 1]!);
      const pSpeed = p.ramp?.speed ?? p.speed;
      tail[i] = Math.max(0, Math.min(s.audio.seconds, (clipOf[i - 1]!.durationSec - pEnd) / pSpeed, lens[i]! * 0.8));
    }
  });
  if (splitDropped) notes.push('J/L sound cuts work on hard cuts only, so they are left out where a cut has a transition.');
  // Where the sound changes from shot i-1 to shot i, and how long it crossfades.
  const bound = (i: number) => (d[i]! > 0 ? starts[i]! : starts[i]! + tail[i]! - lead[i]!);
  const fade = (i: number) => (d[i]! > 0 ? d[i]! : HARD_FADE);
  const aFrom = r.shots.map((_, i) => (i === 0 ? 0 : bound(i)));
  const aTo = r.shots.map((_, i) => (i === n - 1 ? total : d[i + 1]! > 0 ? starts[i + 1]! + d[i + 1]! : bound(i + 1) + HARD_FADE));

  // 4. Inputs: each shot's footage (long enough for its picture and its sound), then the music,
  // then separate sound inputs for J-cuts (they need footage from before the in-point).
  const pre = r.shots.map((s, i) => Math.max(0, starts[i]! - aFrom[i]!) * s.speed);
  const srcFor = (s: ShotT, i: number, outEnd: number) => {
    const after = outEnd - starts[i]!;
    const inShot = sourceSeconds(s, Math.min(after, lens[i]!));
    return inShot + Math.max(0, after - lens[i]!) * (s.ramp?.speed ?? s.speed);
  };
  r.shots.forEach((s, i) => {
    const need = Math.max(sourceSeconds(s, lens[i]!), pre[i]! > 0 ? 0 : srcFor(s, i, aTo[i]!));
    args.push('-ss', f3(s.inSec), '-t', f3(need + 0.1), '-i', clipOf[i]!.file);
  });
  const musicIndex = r.music ? n : -1;
  if (r.music) args.push(...(r.music.startSec > 0 ? ['-ss', f3(r.music.startSec)] : []), '-i', r.music.path);
  const soundInput = r.shots.map((_, i) => i);
  let next = n + (r.music ? 1 : 0);
  r.shots.forEach((s, i) => {
    if (pre[i]! <= 0 || !clipOf[i]!.hasAudio) return;
    args.push('-ss', f3(s.inSec - pre[i]!), '-t', f3(pre[i]! + srcFor(s, i, aTo[i]!) + 0.1), '-i', clipOf[i]!.file);
    soundInput[i] = next++;
  });

  // 5. Pictures: speed (or ramp), fill the frame, zoom, length.
  r.shots.forEach((s, i) => {
    const L = lens[i]!;
    filters.push(`[${i}:v]${speedFilter(s)},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}${zoomFilter(s, W, H, L)},format=yuv420p,trim=duration=${f3(L)},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`);
  });

  // 6. Runs of hard cuts are concatenated; transitions join the runs with xfade. (Every shot ends
  // in the same time base as concat's output, or xfade refuses to join a run with a single shot.)
  const groups: number[][] = [];
  r.shots.forEach((_, i) => (i === 0 || d[i]! > 0 ? groups.push([i]) : groups[groups.length - 1]!.push(i)));
  const groupLabel = groups.map((g, k) => {
    if (g.length === 1) return `v${g[0]}`;
    filters.push(`${g.map((i) => `[v${i}]`).join('')}concat=n=${g.length}:v=1:a=0[g${k}]`);
    return `g${k}`;
  });
  let acc = groupLabel[0]!;
  let accLen = groups[0]!.reduce((a, i) => a + lens[i]!, 0);
  for (let k = 1; k < groups.length; k++) {
    const i = groups[k]![0]!;
    const kind = cuts[i]!.kind as Exclude<TransitionKind, 'cut'>;
    const offset = Math.max(0, accLen - d[i]!);
    const out = `x${k}`;
    // A whip is a fast slide with directional blur while it moves (when this ffmpeg has dblur).
    const blur = kind === 'whip' && o.blurFilter ? `,dblur=angle=0:radius=${Math.max(4, Math.round(W * 0.04))}:enable='between(t,${f3(offset)},${f3(offset + d[i]!)})'` : '';
    filters.push(`[${acc}][${groupLabel[k]}]xfade=transition=${xfadeName(kind)}:duration=${f3(d[i]!)}:offset=${f3(offset)}${blur}[${out}]`);
    acc = out;
    accLen = accLen + groups[k]!.reduce((a, j) => a + lens[j]!, 0) - d[i]!;
  }
  filters.push(`[${acc}]null[vj]`);

  // 7. Sound: each shot's piece placed on the timeline and mixed (crossfades at transitions,
  // 20 ms at hard cuts, shifted for J/L cuts). Every piece runs to the end of the video: amix can
  // stop early when its inputs end at different times (seen with ffmpeg 9 on Windows).
  const pieces: string[] = [];
  r.shots.forEach((s, i) => {
    if (!clipOf[i]!.hasAudio) return;
    const from = aFrom[i]!;
    const PL = Math.max(0.05, aTo[i]! - from);
    const fi = i === 0 ? 0 : Math.min(fade(i), PL / 2);
    const fo = i === n - 1 ? 0 : Math.min(fade(i + 1), PL / 2);
    const src = soundInput[i]!;
    const norm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const finish = `atrim=duration=${f3(PL)},asetpts=PTS-STARTPTS,apad=whole_dur=${f3(PL)}${fi > 0 ? `,afade=t=in:st=0:d=${f3(fi)}` : ''}${fo > 0 ? `,afade=t=out:st=${f3(PL - fo)}:d=${f3(fo)}` : ''}${from > 0.0005 ? `,adelay=delays=${Math.round(from * 1000)}:all=1` : ''},apad=whole_dur=${f3(total)}`;
    // A ramp changes speed partway: the two parts are sped up separately and joined.
    const rampAt = s.ramp ? starts[i]! + s.ramp.atSec : Infinity;
    if (s.ramp && aTo[i]! > rampAt + 0.01) {
      const split = pre[i]! + s.ramp.atSec * s.speed;
      filters.push(`[${src}:a]asetpts=PTS-STARTPTS,asplit=2[s${i}a][s${i}b]`);
      filters.push(`[s${i}a]atrim=end=${f3(split)},asetpts=PTS-STARTPTS,${atempo(s.speed)}${norm}[s${i}c]`);
      filters.push(`[s${i}b]atrim=start=${f3(split)},asetpts=PTS-STARTPTS,${atempo(s.ramp.speed)}${norm}[s${i}d]`);
      filters.push(`[s${i}c][s${i}d]concat=n=2:v=0:a=1,${finish}[p${i}]`);
    } else {
      filters.push(`[${src}:a]asetpts=PTS-STARTPTS,${atempo(s.speed)}${norm},${finish}[p${i}]`);
    }
    pieces.push(`[p${i}]`);
  });
  const whole = `apad=whole_dur=${f3(total)},atrim=duration=${f3(total)}`;
  if (!pieces.length) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(total)}[aj]`);
  else if (pieces.length === 1) filters.push(`${pieces[0]}${whole}[aj]`);
  else filters.push(`${pieces.join('')}amix=inputs=${pieces.length}:duration=longest:dropout_transition=0:normalize=0,${whole}[aj]`);

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

/** The shot's timing: one speed, or a ramp from its speed to the ramp's speed at ramp.atSec. */
export function speedFilter(s: ShotT): string {
  if (!s.ramp) return `setpts=(PTS-STARTPTS)/${s.speed}`;
  const a = f3(s.ramp.atSec * s.speed); // source seconds where the speed changes
  const T = '(PTS-STARTPTS)*TB';
  return `setpts='if(lt(${T},${a}),(PTS-STARTPTS)/${s.speed},(${a}/${s.speed}+(${T}-${a})/${s.ramp.speed})/TB)'`;
}

/**
 * Zoom keyframes as a per-frame scale (then a centre crop back to the frame): a punch-in snaps
 * in over two frames at zoom.atSec; a push / pull eases in / out over the whole shot.
 */
export function zoomFilter(s: ShotT, W: number, H: number, L: number): string {
  if (!s.zoom) return '';
  const a = s.zoom.amount - 1;
  const z =
    s.zoom.kind === 'punch'
      ? `1+${a.toFixed(4)}*clip((t-${f3(s.zoom.atSec)})/0.07,0,1)`
      : s.zoom.kind === 'push'
        ? `1+${a.toFixed(4)}*min(t/${f3(L)},1)`
        : `${s.zoom.amount.toFixed(4)}-${a.toFixed(4)}*min(t/${f3(L)},1)`;
  return `,scale=w='2*trunc(${W}*(${z})/2)':h='2*trunc(${H}*(${z})/2)':eval=frame,crop=${W}:${H},setsar=1`;
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
