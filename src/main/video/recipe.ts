import { z } from 'zod';

/**
 * The edit recipe: everything Keo needs to render a video, as plain data. The model never writes
 * ffmpeg commands; it only proposes recipes and changes to them, which are validated here, and
 * the render step turns a recipe into fixed ffmpeg arguments (render.ts).
 */

export const ASPECTS = ['9:16', '16:9', '1:1', '4:5'] as const;
export const Aspect = z.enum(ASPECTS);
export type AspectT = z.infer<typeof Aspect>;

/**
 * How one shot meets the next. 'cut' is a hard cut; the others are ffmpeg xfade transitions of
 * the same name (all checked against ffmpeg 9.0.2's xfade list), except Keo's three quick ones:
 * 'whip' (a fast slide with directional blur), 'flash' (a few white frames) and 'punch' (a quick
 * zoom through the cut). The first seven are the original list; old recipes keep working.
 * (xfade's squeezev is left out on purpose: it crashes ffmpeg 9.0.2.)
 */
export const TRANSITIONS = [
  'cut',
  'fade',
  'fadeblack',
  'fadewhite',
  'slideleft',
  'slideup',
  'zoomin',
  'dissolve',
  'slideright',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'coverleft',
  'coverright',
  'revealleft',
  'revealright',
  'circleopen',
  'circleclose',
  'radial',
  'pixelize',
  'hblur',
  'squeezeh',
  'whip',
  'flash',
  'punch',
] as const;
export const Transition = z.enum(TRANSITIONS);
export type TransitionKind = (typeof TRANSITIONS)[number];

/** Gentle transitions (they suit slower moments); the rest are lively. */
export const SOFT_TRANSITIONS: ReadonlySet<TransitionKind> = new Set(['fade', 'dissolve', 'fadeblack', 'fadewhite', 'hblur']);
/** Keo's quick transitions only look right when short. */
const QUICK_MAX: Partial<Record<TransitionKind, number>> = { whip: 0.3, flash: 0.2, punch: 0.3 };

/** A sensible length for a transition of this kind (seconds). */
export function defaultTransitionSeconds(kind: TransitionKind): number {
  if (kind === 'cut') return 0;
  if (kind === 'flash') return 0.12;
  if (kind === 'whip' || kind === 'punch') return 0.2;
  return SOFT_TRANSITIONS.has(kind) ? 0.4 : 0.3;
}

/** Fonts every Windows PC has (captions and text are drawn with the PC's own fonts). */
export const FONTS = ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Comic Sans MS'] as const;
export const Font = z.enum(FONTS);

export const Position = z.enum(['top', 'center', 'bottom']);
const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour like #FFFFFF');
const Sec = z.number().finite().min(0).max(3600);

export const ClipId = z.string().regex(/^c\d{1,3}$/, 'a clip id like c1 from the clip analysis');

/** The cut into a shot (from the one before it). */
export const CutTransition = z.object({ kind: Transition, seconds: z.number().min(0.05).max(1.5).optional() }).strict();

export const ZOOM_KINDS = ['punch', 'push', 'pull'] as const;
/** punch = a sudden punch-in at atSec (emphasis); push / pull = a slow zoom in / out over the whole shot. */
export const Zoom = z
  .object({
    kind: z.enum(ZOOM_KINDS),
    /** How far in (1.15 = 15 % closer). */
    amount: z.number().min(1.02).max(1.6).default(1.15),
    /** For punch: seconds into the shot. */
    atSec: z.number().min(0).max(120).default(0),
  })
  .strict();

/** A speed ramp: the shot plays at its speed until atSec (seconds into the shot), then at this speed. */
export const Ramp = z.object({ atSec: z.number().min(0.1).max(120), speed: z.number().min(0.25).max(4) }).strict();

/** A split edit at the cut into this shot: J = its sound starts early, L = the previous shot's sound carries on. */
export const AudioSplit = z.object({ kind: z.enum(['j', 'l']), seconds: z.number().min(0.05).max(1.5) }).strict();

export const Shot = z
  .object({
    clipId: ClipId,
    /** Where the shot starts in the source clip (seconds). */
    inSec: Sec,
    /** How long the shot lasts in the finished video (seconds). */
    durationSec: z.number().finite().min(0.2).max(120),
    /** Playback speed (0.5 = slow motion, 2 = double speed). */
    speed: z.number().min(0.25).max(4).default(1),
    /** The cut into this shot (absent: the recipe's transition; ignored for the first shot). */
    transition: CutTransition.optional(),
    zoom: Zoom.optional(),
    ramp: Ramp.optional(),
    audio: AudioSplit.optional(),
    /** Why the planner edited this shot this way (shown to the user and the model). */
    why: z.string().max(160).optional(),
  })
  .strict()
  .refine((s) => !s.ramp || s.ramp.atSec < s.durationSec, 'a speed ramp must start inside its shot')
  .refine((s) => !s.zoom || s.zoom.kind !== 'punch' || s.zoom.atSec < s.durationSec, 'a punch-in must happen inside its shot');
export type ShotT = z.infer<typeof Shot>;

export const TextOverlay = z
  .object({
    text: z.string().trim().min(1).max(120),
    startSec: Sec,
    endSec: Sec,
    position: Position.default('top'),
    /** Text height as a percentage of the video height. */
    sizePct: z.number().min(2).max(15).default(6),
    color: Hex.default('#FFFFFF'),
    /** A dark box behind the text. */
    box: z.boolean().default(false),
    font: Font.default('Arial Black'),
  })
  .strict()
  .refine((t) => t.endSec > t.startSec, 'endSec must be after startSec');
export type TextOverlayT = z.infer<typeof TextOverlay>;

export const CaptionStyle = z
  .object({
    enabled: z.boolean().default(true),
    position: Position.default('bottom'),
    sizePct: z.number().min(3).max(12).default(5.5),
    color: Hex.default('#FFFFFF'),
    outline: Hex.default('#000000'),
    uppercase: z.boolean().default(false),
    maxWordsPerLine: z.number().int().min(1).max(8).default(3),
    font: Font.default('Arial Black'),
  })
  .strict();
export type CaptionStyleT = z.infer<typeof CaptionStyle>;

export const Music = z
  .object({
    /** A music file the user chose on this computer (never downloaded by Keo in phase 1). */
    path: z.string().min(3).max(500),
    volume: z.number().min(0).max(2).default(0.8),
    /** Where in the song the video starts. */
    startSec: Sec.default(0),
    fadeOutSec: z.number().min(0).max(10).default(1.5),
  })
  .strict();

export const RecipeSchema = z
  .object({
    schema: z.literal(1).default(1),
    title: z.string().trim().min(1).max(120),
    aspect: Aspect,
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
    shots: z.array(Shot).min(1).max(200),
    /** The look of every cut that has none of its own (shots[i].transition). */
    transition: z.object({ kind: Transition.default('cut'), seconds: z.number().min(0.05).max(1.5).default(0.3) }).strict().prefault({}),
    texts: z.array(TextOverlay).max(30).default([]),
    captions: CaptionStyle.prefault({}),
    music: Music.nullable().default(null),
    /** Volume of the clips' own sound (0 = muted). */
    clipVolume: z.number().min(0).max(2).default(1),
    /** What Keo could not follow from the template (shown to the user). */
    notes: z.array(z.string().max(300)).max(20).default([]),
    /** Music beats on the finished video's timeline (cuts can be moved onto them again later). */
    beats: z.array(Sec).max(4000).default([]),
    /** The editing style in one or two sentences, and why. */
    style: z.string().max(400).default(''),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;

// ------------------------------------------------------------------ analysis results

export interface TemplateStyle {
  textOverlays: Array<{ text: string; position: 'top' | 'center' | 'bottom'; atSec: number | null }>;
  captions: { present: boolean; position: 'top' | 'center' | 'bottom'; sizePct: number; color: string; uppercase: boolean; wordsPerLine: number };
  palette: string[];
  hook: string | null;
  pacing: 'fast' | 'medium' | 'slow';
  transitions: (typeof TRANSITIONS)[number];
  notes: string;
}

export interface TemplateAnalysis {
  id: string;
  file: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  aspect: AspectT;
  hasAudio: boolean;
  shots: Array<{ startSec: number; durationSec: number }>;
  beats: number[];
  tempoBpm: number | null;
  style: TemplateStyle | null;
  /** Why the style is missing or partial (vision not allowed, model could not see pictures, …). */
  styleNote: string | null;
}

export interface Word {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ClipInfo {
  id: string;
  file: string;
  name: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** Lively parts of the clip, best first. */
  moments: Array<{ startSec: number; durationSec: number; score: number }>;
  /** Spoken words with times in the clip, when transcribed. */
  words: Word[] | null;
  /** A short description of the clip (from the vision model, if allowed). */
  description: string | null;
}

// ------------------------------------------------------------------ helpers

export function dimensions(aspect: AspectT, preview: boolean): { width: number; height: number } {
  const full = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] }[aspect] as [number, number];
  if (!preview) return { width: full[0], height: full[1] };
  // Previews: the long side is 640 px (fast to make, enough to judge the edit).
  const k = 640 / Math.max(full[0], full[1]);
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(full[0]), height: even(full[1]) };
}

export function nearestAspect(width: number, height: number): AspectT {
  if (!width || !height) return '9:16';
  const r = width / height;
  const options: Array<[AspectT, number]> = [
    ['9:16', 9 / 16],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['16:9', 16 / 9],
  ];
  return options.reduce((best, o) => (Math.abs(Math.log(o[1] / r)) < Math.abs(Math.log(best[1] / r)) ? o : best))[0];
}

export const round2 = (v: number) => Math.round(v * 100) / 100;

/** Length of the finished video (transitions overlap neighbouring shots). */
export function totalSeconds(r: Pick<Recipe, 'shots' | 'transition'>): number {
  return round2(r.shots.reduce((a, s) => a + s.durationSec, 0));
}

/** Where each shot starts in the finished video. */
export function shotStarts(r: Pick<Recipe, 'shots'>): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of r.shots) {
    out.push(round2(t));
    t += s.durationSec;
  }
  return out;
}

/** The cut into shot i: its own transition, else the recipe's (the first shot has none). */
export function cutInto(r: Pick<Recipe, 'shots' | 'transition'>, i: number): { kind: TransitionKind; seconds: number } {
  const s = r.shots[i];
  if (i <= 0 || !s) return { kind: 'cut', seconds: 0 };
  const kind = s.transition?.kind ?? r.transition.kind;
  if (kind === 'cut') return { kind, seconds: 0 };
  const want = s.transition ? (s.transition.seconds ?? defaultTransitionSeconds(kind)) : r.transition.seconds;
  return { kind, seconds: Math.min(want, QUICK_MAX[kind] ?? 1.5) };
}

/** Seconds of source footage the first `outSec` seconds of a shot use (speed and ramp included). */
export function sourceSeconds(s: ShotT, outSec: number = s.durationSec): number {
  if (!s.ramp || outSec <= s.ramp.atSec) return outSec * s.speed;
  return s.ramp.atSec * s.speed + (outSec - s.ramp.atSec) * s.ramp.speed;
}

/** When (seconds into the shot) the footage `srcSec` after its in-point is shown. */
export function outputSeconds(s: ShotT, srcSec: number): number {
  if (!s.ramp || srcSec <= s.ramp.atSec * s.speed) return srcSec / s.speed;
  return s.ramp.atSec + (srcSec - s.ramp.atSec * s.speed) / s.ramp.speed;
}

/** A short description of how a shot is edited ("whip in · punch-in at 0.8 s"); empty for a plain shot. */
export function editLabel(r: Pick<Recipe, 'shots' | 'transition'>, i: number): string {
  const s = r.shots[i];
  if (!s) return '';
  const parts: string[] = [];
  const cut = cutInto(r, i);
  if (i > 0 && cut.kind !== 'cut') parts.push(`${cut.kind} in`);
  if (s.zoom) parts.push(s.zoom.kind === 'punch' ? `punch-in at ${s.zoom.atSec.toFixed(1)} s` : s.zoom.kind === 'push' ? 'slow push-in' : 'slow pull-out');
  if (s.ramp) parts.push(`ramp ${s.speed}×→${s.ramp.speed}×`);
  if (i > 0 && s.audio) parts.push(`${s.audio.kind.toUpperCase()}-cut ${s.audio.seconds.toFixed(1)} s`);
  return parts.join(' · ');
}

const PACE: Record<TemplateStyle['pacing'], number> = { fast: 1.2, medium: 2.2, slow: 3.5 };

export interface PlanOptions {
  title?: string;
  targetSeconds?: number;
  aspect?: AspectT;
  captions?: boolean;
  music?: { path: string; beats: number[]; bpm?: number | null } | null;
  hook?: string | null;
  transition?: (typeof TRANSITIONS)[number];
  clipVolume?: number;
}

/**
 * Builds the first recipe: the template's shot rhythm (scaled to the target length, cuts moved
 * onto the beat), the clips' best moments spread across the shots, and the template's look.
 */
export function buildRecipe(template: TemplateAnalysis | null, clips: ClipInfo[], o: PlanOptions = {}): Recipe {
  const usable = clips.filter((c) => c.durationSec >= 0.4);
  if (!usable.length) throw new RecipeError('no_clips', 'None of the clips can be used (they are missing or shorter than half a second). Nothing was planned.');
  const notes: string[] = [];
  const target = clamp(o.targetSeconds ?? template?.durationSec ?? 15, 3, 180);
  const style = template?.style ?? null;

  // 1. Shot lengths: the template's own rhythm, else the pace it suggests (or a medium pace).
  let lengths: number[];
  if (template && template.shots.length >= 2) {
    const k = target / template.durationSec;
    lengths = template.shots.map((s) => s.durationSec * k);
  } else {
    const each = PACE[style?.pacing ?? 'medium'];
    const n = Math.max(1, Math.round(target / each));
    lengths = Array.from({ length: n }, () => target / n);
    if (template) notes.push('The template has no clear cuts, so Keo used an even rhythm.');
  }
  // 2. Cuts on the beat (music the user chose, else the template's own sound).
  const beats = o.music?.beats.length ? o.music.beats : (template?.beats ?? []);
  if (beats.length >= 4) lengths = snapToBeats(lengths, beats, target);

  // 3. Clips: best moments first, a different clip for each shot where possible.
  const assigned = assignClips(lengths, usable, notes);

  // 4. The editing itself: the look of each cut, punch-ins, a speed ramp, split sound edits.
  const musicBeats = o.music?.beats.length ? [...o.music.beats].sort((a, b) => a - b) : [];
  const edit = editShots(assigned, {
    beats: musicBeats,
    bpm: o.music?.bpm ?? null,
    style,
    template,
    clips: new Map(usable.map((c) => [c.id, c])),
    ...(o.transition ? { transition: o.transition } : {}),
  });
  const shots = edit.shots;
  const cap = style?.captions;
  const anyWords = usable.some((c) => c.words?.length);
  const wantCaptions = o.captions ?? (cap?.present ?? true);
  if (wantCaptions && !anyWords) notes.push('No captions: there is no transcribed speech in the clips.');
  const captions = CaptionStyle.parse({
    enabled: wantCaptions && anyWords,
    ...(cap ? { position: cap.position, sizePct: clamp(cap.sizePct, 3, 12), color: validHex(cap.color) ?? '#FFFFFF', uppercase: cap.uppercase, maxWordsPerLine: clamp(Math.round(cap.wordsPerLine), 1, 8) } : {}),
  });
  const hook = o.hook ?? null;
  const total = lengths.reduce((a, b) => a + b, 0);
  const texts = hook ? [TextOverlay.parse({ text: hook, startSec: 0, endSec: round2(Math.min(3, total)), position: 'top', sizePct: 6.5, box: true, color: validHex(style?.palette[0]) ?? '#FFFFFF' })] : [];
  if (style?.textOverlays.length && !hook) notes.push(`The template shows text (“${style.textOverlays[0]!.text.slice(0, 60)}”). Tell Keo your own text to add it.`);

  return RecipeSchema.parse({
    title: o.title ?? 'Keo video',
    aspect: o.aspect ?? template?.aspect ?? '9:16',
    fps: 30,
    shots,
    transition: edit.transition,
    texts,
    captions,
    music: o.music ? { path: o.music.path } : null,
    clipVolume: o.clipVolume ?? (o.music ? 0.35 : 1),
    notes,
    beats: musicBeats.filter((b) => b <= total + 1).slice(0, 4000).map(round2),
    style: edit.style,
  });
}

/** How fast the template cuts, measured from its shots (else the pace the model saw, else medium). */
export function templatePace(template: TemplateAnalysis | null): { pace: TemplateStyle['pacing']; avgShotSec: number | null } {
  if (template && template.shots.length >= 2) {
    const avg = template.durationSec / template.shots.length;
    return { pace: avg < 1.3 ? 'fast' : avg < 2.8 ? 'medium' : 'slow', avgShotSec: round2(avg) };
  }
  return { pace: template?.style?.pacing ?? 'medium', avgShotSec: null };
}

interface EditContext {
  /** Music beats on the video's timeline (empty without music). */
  beats: number[];
  bpm: number | null;
  style: TemplateStyle | null;
  template: TemplateAnalysis | null;
  clips: Map<string, ClipInfo>;
  /** The user asked for this look on every cut. */
  transition?: TransitionKind;
}

/**
 * Edits the planned shots the way a short-form editor would: hard cuts (on the beat when there
 * is music), a stylised transition only where the template's style and the music call for one,
 * punch-ins on beats or spoken emphasis, slow pushes that keep long shots alive, one speed ramp
 * into the strongest moment, and J/L cuts where speech runs across a cut. Every choice is
 * written into the shot's `why`, and the whole style into `style`.
 */
export function editShots(input: ShotT[], c: EditContext): { shots: ShotT[]; transition: { kind: TransitionKind; seconds: number }; style: string } {
  const shots: ShotT[] = input.map((s) => ({ ...s }));
  const n = shots.length;
  const starts = shotStarts({ shots });
  const end = (i: number) => starts[i]! + shots[i]!.durationSec;
  const { pace, avgShotSec } = templatePace(c.template);
  const beatNear = (t: number, tol = 0.06) => c.beats.findIndex((b) => Math.abs(b - t) <= tol);
  const beatsIn = (i: number, fromSec: number, toEndSec: number) => c.beats.filter((b) => b > starts[i]! + fromSec && b < end(i) - toEndSec);
  const why: string[][] = shots.map(() => []);
  const said: string[] = [];

  // ---- cuts
  let transition = { kind: 'cut' as TransitionKind, seconds: 0.3 };
  const styled: TransitionKind[] = [];
  let onBeat = 0;
  if (c.transition) {
    transition = { kind: c.transition, seconds: c.transition === 'cut' ? 0.3 : defaultTransitionSeconds(c.transition) };
    said.push(c.transition === 'cut' ? 'Hard cuts throughout, as asked' : `Every cut is a ${c.transition}, as asked`);
  } else {
    const liked = c.style?.transitions ?? 'cut';
    const flavour = liked === 'cut' ? 'hard' : SOFT_TRANSITIONS.has(liked) ? 'soft' : 'lively';
    const budget = flavour === 'soft' ? Math.max(1, Math.floor((n - 1) / 3)) : Math.max(1, Math.ceil((n - 1) / 4));
    let lastStyled = -10;
    for (let i = 1; i < n; i++) {
      const prev = shots[i - 1]!.durationSec;
      const cur = shots[i]!.durationSec;
      const k = beatNear(starts[i]!);
      const down = k >= 0 && k % 4 === 0;
      const change = cur >= prev * 1.8 || prev >= cur * 1.8 || i === n - 1;
      let pick: string | null = null;
      if (flavour === 'soft' && styled.length < budget && (cur >= 2.5 || i === n - 1) && pace !== 'fast') pick = `${liked} into a slower moment, like the template`;
      else if (flavour === 'soft' && styled.length < budget && i === n - 1) pick = `${liked} into the last shot, like the template`;
      else if (flavour === 'lively' && styled.length < budget && i - lastStyled >= 3 && (down || change)) pick = `${liked} at a ${down ? 'downbeat' : 'change of pace'}, like the template`;
      if (pick) {
        shots[i]!.transition = { kind: liked, seconds: defaultTransitionSeconds(liked) };
        styled.push(liked);
        lastStyled = i;
        why[i]!.push(pick);
      } else {
        const clip = c.clips.get(shots[i]!.clipId);
        const onAction = clip?.moments.some((m) => Math.abs(m.startSec - shots[i]!.inSec) < 0.05) ?? false;
        why[i]!.push(k >= 0 ? 'hard cut on the beat' : onAction ? 'hard cut into the action' : 'hard cut');
      }
      if (k >= 0) onBeat++;
    }
    const cuts = n - 1;
    if (cuts > 0) {
      const hard = cuts - styled.length;
      const base = hard === cuts ? 'Hard cuts' : 'Mostly hard cuts';
      const beat = c.beats.length ? (onBeat >= cuts / 2 ? ` on the beat${c.bpm ? ` (${c.bpm} BPM)` : ''}` : ' (near the beat where one is close)') : '';
      const paced = avgShotSec ? `, matching the template’s ${pace} pace (${avgShotSec.toFixed(1)} s a shot)` : `, at a ${pace} pace`;
      const extra = styled.length ? `; ${styled.length} ${styled[0]}${styled.length > 1 ? 's' : ''} where the template’s style fits` : c.style ? '' : ' (the template’s look was not analysed, so no stylised transitions)';
      said.push(`${base}${beat}${paced}${extra}`);
    }
  }

  // ---- zooms: a slow push on the hook, punch-ins on beats or speech, pushes on long shots
  const lively = pace !== 'slow';
  const maxZooms = Math.ceil(n / 2);
  let zooms = 0;
  let punches = 0;
  let pushes = 0;
  let alt = 0;
  const first = shots[0]!;
  if (n > 1 && first.durationSec >= 1.2 && lively) {
    first.zoom = { kind: 'push', amount: 1.08, atSec: 0 };
    why[0]!.push('slow push-in on the hook');
    zooms++;
    pushes++;
  }
  for (let i = 1; i < n && zooms < maxZooms; i++) {
    const s = shots[i]!;
    if (s.durationSec < 1) continue;
    let at: number | null = null;
    let reason = '';
    const inside = beatsIn(i, 0.35, 0.3);
    if (inside.length && lively) {
      at = inside[0]! - starts[i]!;
      reason = 'punch-in on the beat';
    } else if (!c.beats.length && lively) {
      const word = c.clips.get(s.clipId)?.words?.find((w) => w.startSec >= s.inSec + 0.35 * s.speed && w.startSec < s.inSec + (s.durationSec - 0.3) * s.speed);
      if (word) {
        at = outputSeconds(s, word.startSec - s.inSec);
        reason = 'punch-in on a spoken word';
      }
    }
    if (at !== null && alt++ % 2 === 0) {
      s.zoom = { kind: 'punch', amount: 1.15, atSec: round2(at) };
      why[i]!.push(`${reason} at ${at.toFixed(1)} s`);
      zooms++;
      punches++;
    } else if (s.durationSec >= 3) {
      s.zoom = { kind: pushes % 2 === 0 ? 'push' : 'pull', amount: 1.06, atSec: 0 };
      why[i]!.push(`slow ${pushes % 2 === 0 ? 'push-in' : 'pull-out'} keeps a long shot moving`);
      zooms++;
      pushes++;
    }
  }

  // ---- one speed ramp: fast into the strongest moment, landing on the beat when there is one
  let ramps = 0;
  if (n >= 3 && (pace === 'fast' || c.beats.length)) {
    const score = (s: ShotT) => c.clips.get(s.clipId)?.moments.find((m) => Math.abs(m.startSec - s.inSec) < 0.6)?.score ?? 0;
    const pick = shots
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > 0 && s.durationSec >= 1.6 && s.zoom?.kind !== 'punch' && s.speed === 1)
      .sort((a, b) => score(b.s) - score(a.s))[0];
    if (pick) {
      const s = pick.s;
      const clip = c.clips.get(s.clipId);
      const beat = beatsIn(pick.i, s.durationSec * 0.3, s.durationSec * 0.3)[0];
      const at = round2(beat !== undefined ? beat - starts[pick.i]! : s.durationSec * 0.35);
      const need = at * 1.8 + (s.durationSec - at);
      if (clip && clip.durationSec >= need) {
        // Start earlier in the clip so the moment itself still lands after the ramp.
        s.inSec = round2(Math.max(0, Math.min(s.inSec, clip.durationSec - need - 0.02)));
        s.speed = 1.8;
        s.ramp = { atSec: at, speed: 1 };
        why[pick.i]!.push(`speed ramp 1.8× → 1×${beat !== undefined ? ' landing on the beat' : ' into the moment'}`);
        ramps++;
      }
    }
  }

  // ---- J/L cuts where speech runs across a hard cut
  let splits = 0;
  for (let i = 1; i < n; i++) {
    const s = shots[i]!;
    const prev = shots[i - 1]!;
    if ((s.transition?.kind ?? transition.kind) !== 'cut') continue;
    const pc = c.clips.get(prev.clipId);
    const sc = c.clips.get(s.clipId);
    if (!pc?.hasAudio || !sc?.hasAudio) continue;
    const prevEnd = prev.inSec + sourceSeconds(prev);
    const lastSpeed = prev.ramp?.speed ?? prev.speed;
    const carried = pc.words?.find((w) => w.startSec < prevEnd - 0.02 && w.endSec > prevEnd + 0.04);
    if (carried) {
      const sec = round2(Math.min(0.8, (carried.endSec - prevEnd) / lastSpeed + 0.05, s.durationSec * 0.6, (pc.durationSec - prevEnd) / lastSpeed));
      if (sec >= 0.08) {
        s.audio = { kind: 'l', seconds: sec };
        why[i]!.push('L-cut: the speech carries over the cut');
        splits++;
        continue;
      }
    }
    const early = sc.words?.find((w) => w.startSec < s.inSec - 0.02 && w.endSec > s.inSec && s.inSec - w.startSec <= 0.8 * s.speed);
    if (early) {
      const sec = round2(Math.min(0.8, (s.inSec - early.startSec) / s.speed + 0.05, prev.durationSec * 0.6, s.inSec / s.speed));
      if (sec >= 0.08) {
        s.audio = { kind: 'j', seconds: sec };
        why[i]!.push('J-cut: the speech starts before its picture');
        splits++;
      }
    }
  }

  const extras = [punches ? `${punches} punch-in${punches > 1 ? 's' : ''} for emphasis` : '', pushes ? `${pushes} slow push${pushes > 1 ? 'es' : ''}` : '', ramps ? 'a speed ramp into the strongest moment' : '', splits ? `${splits} J/L cut${splits > 1 ? 's' : ''} where speech crosses a cut` : ''].filter(Boolean);
  if (extras.length) said.push(extras.join(', '));
  shots.forEach((s, i) => {
    if (why[i]!.length) s.why = why[i]!.join('; ').slice(0, 160);
  });
  const style = said.length ? `${said.join('. ')}.` : '';
  return { shots, transition, style: style.slice(0, 400) };
}

/** Moves each cut to the nearest beat (within 40 % of the shorter neighbouring shot). */
export function snapToBeats(lengths: number[], beats: number[], total: number): number[] {
  const cuts: number[] = [];
  let t = 0;
  for (let i = 0; i < lengths.length - 1; i++) {
    t += lengths[i]!;
    cuts.push(t);
  }
  const sorted = [...beats].sort((a, b) => a - b);
  const snapped: number[] = [];
  let prev = 0;
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i]!;
    const next = i + 1 < cuts.length ? cuts[i + 1]! : total;
    const room = Math.min(c - prev, next - c) * 0.4;
    let best = c;
    let bestD = Infinity;
    for (const b of sorted) {
      const d = Math.abs(b - c);
      if (d < bestD && d <= room && b - prev >= 0.3) {
        best = b;
        bestD = d;
      }
    }
    // Rounded here, so the shot lengths add up to the total exactly.
    snapped.push(round2(best));
    prev = round2(best);
  }
  const out: number[] = [];
  prev = 0;
  for (const c of [...snapped, total]) {
    out.push(round2(c - prev));
    prev = c;
  }
  return out;
}

function assignClips(lengths: number[], clips: ClipInfo[], notes: string[]): ShotT[] {
  const order = [...clips].sort((a, b) => (b.moments[0]?.score ?? 0) - (a.moments[0]?.score ?? 0));
  const used = new Map<string, Array<[number, number]>>();
  const overlaps = (id: string, a: number, b: number) => (used.get(id) ?? []).some(([x, y]) => a < y && b > x);
  const shots: ShotT[] = [];
  let shortened = false;
  let rot = 0;
  for (const want of lengths) {
    let pick: { clip: ClipInfo; inSec: number; dur: number } | null = null;
    for (let k = 0; k < order.length && !pick; k++) {
      const clip = order[(rot + k) % order.length]!;
      if (clip.durationSec < want) continue;
      const starts = [...clip.moments.map((m) => m.startSec), 0, clip.durationSec / 3, (clip.durationSec * 2) / 3];
      for (const s of starts) {
        const inSec = Math.max(0, Math.min(s, clip.durationSec - want));
        if (!overlaps(clip.id, inSec, inSec + want)) {
          pick = { clip, inSec, dur: want };
          break;
        }
      }
      // Every part already used: reuse the clip's best moment rather than skip it.
      if (!pick && k === order.length - 1) pick = { clip, inSec: Math.max(0, Math.min(clip.moments[0]?.startSec ?? 0, clip.durationSec - want)), dur: want };
    }
    if (!pick) {
      // No clip is long enough: the longest one, as long as it is.
      const clip = order.reduce((a, b) => (b.durationSec > a.durationSec ? b : a));
      pick = { clip, inSec: 0, dur: Math.max(0.2, clip.durationSec - 0.05) };
      shortened = true;
    }
    rot = (order.indexOf(pick.clip) + 1) % order.length;
    used.set(pick.clip.id, [...(used.get(pick.clip.id) ?? []), [pick.inSec, pick.inSec + pick.dur]]);
    shots.push({ clipId: pick.clip.id, inSec: round2(pick.inSec), durationSec: round2(pick.dur), speed: 1 });
  }
  if (shortened) notes.push('Some clips are shorter than the template’s shots, so the video is a little shorter than the template.');
  return shots;
}

// ------------------------------------------------------------------ captions

/** Caption lines on the finished video's timeline, from the words spoken in each shot. */
export function captionCues(r: Recipe, clips: Map<string, ClipInfo>): Array<{ startSec: number; endSec: number; text: string }> {
  if (!r.captions.enabled) return [];
  const starts = shotStarts(r);
  const cues: Array<{ startSec: number; endSec: number; text: string }> = [];
  r.shots.forEach((s, i) => {
    const words = clips.get(s.clipId)?.words ?? [];
    const srcEnd = s.inSec + sourceSeconds(s);
    const inShot = words.filter((w) => w.startSec >= s.inSec - 0.05 && w.startSec < srcEnd - 0.05);
    const at = (src: number) => round2(starts[i]! + outputSeconds(s, Math.max(0, src - s.inSec)));
    for (let k = 0; k < inShot.length; k += r.captions.maxWordsPerLine) {
      const group = inShot.slice(k, k + r.captions.maxWordsPerLine);
      const text = group.map((w) => w.text.trim()).filter(Boolean).join(' ');
      if (!text) continue;
      const start = at(group[0]!.startSec);
      const end = Math.min(at(Math.min(group[group.length - 1]!.endSec, srcEnd)), round2(starts[i]! + s.durationSec));
      cues.push({ startSec: start, endSec: Math.max(end, round2(start + 0.25)), text: r.captions.uppercase ? text.toUpperCase() : text });
    }
  });
  return cues;
}

// ------------------------------------------------------------------ live direction

const Index = z.number().int().min(0).max(199);

/** One change to a recipe. The model turns the user's words into these; Keo applies them exactly. */
export const DirectionOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_length'), seconds: z.number().min(3).max(180) }).strict(),
  z.object({ op: z.literal('trim_start'), seconds: z.number().min(0.1).max(30).describe('Make the first shot (the intro) this many seconds shorter') }).strict(),
  z.object({ op: z.literal('shot_length'), index: Index, seconds: z.number().min(0.2).max(120) }).strict(),
  z.object({ op: z.literal('remove_shot'), index: Index }).strict(),
  z.object({ op: z.literal('move_shot'), from: Index, to: Index }).strict(),
  z.object({ op: z.literal('swap_clip'), index: Index, clipId: ClipId, inSec: Sec.optional() }).strict(),
  z.object({ op: z.literal('speed'), index: Index.nullable().describe('null = every shot'), speed: z.number().min(0.25).max(4) }).strict(),
  z
    .object({
      op: z.literal('captions'),
      enabled: z.boolean().optional(),
      sizePct: z.number().min(3).max(12).optional(),
      position: Position.optional(),
      color: Hex.optional(),
      outline: Hex.optional(),
      uppercase: z.boolean().optional(),
      maxWordsPerLine: z.number().int().min(1).max(8).optional(),
      font: Font.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_text'),
      text: z.string().trim().min(1).max(120),
      startSec: Sec,
      endSec: Sec,
      position: Position.optional(),
      sizePct: z.number().min(2).max(15).optional(),
      color: Hex.optional(),
      box: z.boolean().optional(),
      font: Font.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('edit_text'),
      index: Index,
      text: z.string().trim().min(1).max(120).optional(),
      startSec: Sec.optional(),
      endSec: Sec.optional(),
      position: Position.optional(),
      sizePct: z.number().min(2).max(15).optional(),
      color: Hex.optional(),
      box: z.boolean().optional(),
      font: Font.optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove_text'), index: Index }).strict(),
  z
    .object({
      op: z.literal('transition'),
      kind: Transition,
      seconds: z.number().min(0.05).max(1.5).optional(),
      index: Index.optional().describe('Only the cut into this shot (1 = between the first and second shot); omit to change every cut'),
    })
    .strict(),
  z
    .object({
      op: z.literal('zoom'),
      index: Index.nullable().describe('null = every shot'),
      kind: z.enum(['none', ...ZOOM_KINDS]).describe('punch = sudden punch-in at atSec; push / pull = slow zoom in / out; none = remove'),
      amount: z.number().min(1.02).max(1.6).optional(),
      atSec: z.number().min(0).max(120).optional().describe('For punch: seconds into the shot'),
    })
    .strict(),
  z
    .object({
      op: z.literal('speed_ramp'),
      index: Index.nullable().describe('null = every shot (only to remove ramps)'),
      speed: z.number().min(0.25).max(4).nullable().describe('Speed from atSec on (the shot keeps its own speed before); null removes the ramp'),
      atSec: z.number().min(0.1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('audio_cut'),
      index: Index.describe('The cut into this shot (1 or more)'),
      kind: z.enum(['none', 'j', 'l']).describe('j = this shot’s sound starts early; l = the previous shot’s sound carries on; none = a straight cut'),
      seconds: z.number().min(0.05).max(1.5).optional(),
    })
    .strict(),
  z.object({ op: z.literal('beat_sync').describe('Move every cut onto the nearest music beat') }).strict(),
  z.object({ op: z.literal('music_volume'), volume: z.number().min(0).max(2) }).strict(),
  z.object({ op: z.literal('remove_music') }).strict(),
  z.object({ op: z.literal('clip_volume'), volume: z.number().min(0).max(2) }).strict(),
  z.object({ op: z.literal('aspect'), aspect: Aspect }).strict(),
  z.object({ op: z.literal('title'), title: z.string().trim().min(1).max(120) }).strict(),
]);
export type DirectionOpT = z.infer<typeof DirectionOp>;

export class RecipeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const validHex = (s: string | undefined | null) => (s && /^#[0-9A-Fa-f]{6}$/.test(s) ? s.toUpperCase() : null);

/**
 * Applies changes in order to a copy of the recipe. Any change that cannot be applied throws a
 * RecipeError and the recipe stays exactly as it was (the caller keeps the old one).
 */
export function applyDirection(recipe: Recipe, ops: DirectionOpT[], clips: Map<string, ClipInfo>): { recipe: Recipe; changes: string[] } {
  const r: Recipe = structuredClone(recipe);
  const changes: string[] = [];
  const shot = (i: number) => {
    const s = r.shots[i];
    if (!s) throw new RecipeError('no_such_shot', `There is no shot ${i + 1} (the video has ${r.shots.length}). Nothing was changed.`);
    return s;
  };
  /** Longest the shot may be with the footage its clip has after its start. */
  const room = (s: ShotT) => {
    const c = clips.get(s.clipId);
    return c ? Math.max(0.2, outputSeconds(s, c.durationSec - s.inSec)) : s.durationSec;
  };
  const cutIndex = (i: number) => {
    shot(i);
    if (i === 0) throw new RecipeError('no_cut', 'The first shot has no cut before it (cuts are numbered from 1). Nothing was changed.');
    return r.shots[i]!;
  };
  /** Every cut onto the nearest music beat, within the footage each clip has. */
  const resnap = () => {
    const lengths = snapToBeats(
      r.shots.map((s) => s.durationSec),
      r.beats,
      totalSeconds(r),
    );
    r.shots.forEach((s, i) => (s.durationSec = round2(clamp(lengths[i]!, 0.2, room(s)))));
  };
  for (const op of ops) {
    switch (op.op) {
      case 'set_length': {
        const before = totalSeconds(r);
        const k = op.seconds / before;
        for (const s of r.shots) s.durationSec = round2(clamp(s.durationSec * k, 0.2, room(s)));
        // The cuts stay on the music's beat.
        if (r.beats.length >= 4) resnap();
        changes.push(`Length ${before.toFixed(1)} s → ${totalSeconds(r).toFixed(1)} s${Math.abs(totalSeconds(r) - op.seconds) > 0.5 ? ' (the clips are not long enough for more)' : ''}`);
        break;
      }
      case 'trim_start': {
        const s = shot(0);
        if (s.durationSec - op.seconds < 0.4) {
          if (r.shots.length === 1) throw new RecipeError('too_short', 'The video has only one shot, so the intro cannot be shortened that much. Nothing was changed.');
          r.shots.shift();
          changes.push('Removed the intro shot');
        } else {
          // Start later in the clip: the intro's ending (usually the action) stays.
          s.inSec = round2(s.inSec + op.seconds * s.speed);
          s.durationSec = round2(s.durationSec - op.seconds);
          changes.push(`Intro ${op.seconds.toFixed(1)} s shorter`);
        }
        break;
      }
      case 'shot_length': {
        const s = shot(op.index);
        const max = room(s);
        s.durationSec = round2(Math.min(op.seconds, max));
        changes.push(`Shot ${op.index + 1} is ${s.durationSec.toFixed(1)} s${op.seconds > max ? ' (as long as its clip allows)' : ''}`);
        break;
      }
      case 'remove_shot': {
        shot(op.index);
        if (r.shots.length === 1) throw new RecipeError('last_shot', 'This is the only shot, so it cannot be removed. Nothing was changed.');
        r.shots.splice(op.index, 1);
        changes.push(`Removed shot ${op.index + 1}`);
        break;
      }
      case 'move_shot': {
        const s = shot(op.from);
        shot(op.to);
        r.shots.splice(op.from, 1);
        r.shots.splice(op.to, 0, s);
        changes.push(`Moved shot ${op.from + 1} to position ${op.to + 1}`);
        break;
      }
      case 'swap_clip': {
        const s = shot(op.index);
        const c = clips.get(op.clipId);
        if (!c) throw new RecipeError('no_such_clip', `There is no clip ${op.clipId} in this project. Nothing was changed.`);
        const need = s.durationSec * s.speed;
        s.clipId = c.id;
        s.inSec = round2(clamp(op.inSec ?? c.moments[0]?.startSec ?? 0, 0, Math.max(0, c.durationSec - need)));
        if (c.durationSec - s.inSec < need) s.durationSec = round2(Math.max(0.2, (c.durationSec - s.inSec) / s.speed));
        changes.push(`Shot ${op.index + 1} now uses ${c.name}`);
        break;
      }
      case 'speed': {
        const list = op.index === null ? r.shots : [shot(op.index)];
        for (const s of list) {
          s.speed = op.speed;
          s.durationSec = round2(Math.min(s.durationSec, room(s)));
        }
        changes.push(`${op.index === null ? 'All shots' : `Shot ${op.index + 1}`} at ${op.speed}× speed`);
        break;
      }
      case 'captions': {
        const { op: _op, ...rest } = op;
        if (rest.enabled === true && ![...clips.values()].some((c) => c.words?.length)) {
          throw new RecipeError('no_words', 'There is no transcribed speech in the clips, so there are no captions to show. Nothing was changed.');
        }
        r.captions = CaptionStyle.parse({ ...r.captions, ...rest });
        changes.push(rest.enabled === false ? 'Captions off' : `Captions: ${Object.keys(rest).join(', ')}`);
        break;
      }
      case 'add_text': {
        const { op: _op, ...t } = op;
        if (r.texts.length >= 30) throw new RecipeError('too_many_texts', 'The video already has 30 texts. Nothing was changed.');
        r.texts.push(TextOverlay.parse({ ...t, endSec: Math.min(t.endSec, Math.max(totalSeconds(r), t.startSec + 0.5)) }));
        changes.push(`Added the text “${t.text.slice(0, 40)}”`);
        break;
      }
      case 'edit_text': {
        const { op: _op, index, ...t } = op;
        const cur = r.texts[index];
        if (!cur) throw new RecipeError('no_such_text', `There is no text ${index + 1}. Nothing was changed.`);
        r.texts[index] = TextOverlay.parse({ ...cur, ...t });
        changes.push(`Changed text ${index + 1}`);
        break;
      }
      case 'remove_text': {
        if (!r.texts[op.index]) throw new RecipeError('no_such_text', `There is no text ${op.index + 1}. Nothing was changed.`);
        r.texts.splice(op.index, 1);
        changes.push(`Removed text ${op.index + 1}`);
        break;
      }
      case 'transition': {
        const seconds = op.seconds ?? defaultTransitionSeconds(op.kind);
        if (op.index !== undefined) {
          const s = cutIndex(op.index);
          s.transition = op.kind === 'cut' ? { kind: 'cut' } : { kind: op.kind, seconds };
          s.why = op.kind === 'cut' ? 'hard cut (your choice)' : `${op.kind} (your choice)`;
          changes.push(op.kind === 'cut' ? `Hard cut into shot ${op.index + 1}` : `${op.kind} into shot ${op.index + 1}`);
        } else {
          // Every cut: the per-cut choices give way to this one look.
          r.transition = { kind: op.kind, seconds: op.kind === 'cut' ? r.transition.seconds : seconds };
          for (const s of r.shots) {
            delete s.transition;
            delete s.why;
          }
          r.style = op.kind === 'cut' ? 'Hard cuts throughout (your choice).' : `Every cut is a ${op.kind} (your choice).`;
          changes.push(op.kind === 'cut' ? 'Hard cuts' : `${op.kind} transitions`);
        }
        break;
      }
      case 'zoom': {
        const list = op.index === null ? r.shots : [shot(op.index)];
        for (const s of list) {
          if (op.kind === 'none') delete s.zoom;
          else {
            const at = op.kind === 'punch' ? Math.min(op.atSec ?? s.durationSec / 2, s.durationSec - 0.15) : 0;
            s.zoom = Zoom.parse({ kind: op.kind, amount: op.amount ?? (op.kind === 'punch' ? 1.15 : 1.08), atSec: round2(Math.max(0, at)) });
          }
          delete s.why;
        }
        const what = op.kind === 'none' ? 'No zoom' : op.kind === 'punch' ? 'Punch-in' : op.kind === 'push' ? 'Slow push-in' : 'Slow pull-out';
        changes.push(`${what} on ${op.index === null ? 'every shot' : `shot ${op.index + 1}`}`);
        break;
      }
      case 'speed_ramp': {
        if (op.index === null && op.speed !== null) throw new RecipeError('ramp_which', 'Say which shot gets the speed ramp. Nothing was changed.');
        const list = op.index === null ? r.shots : [shot(op.index)];
        for (const s of list) {
          if (op.speed === null) delete s.ramp;
          else {
            if (s.durationSec < 0.4) throw new RecipeError('too_short', `Shot ${op.index! + 1} is too short for a speed ramp. Nothing was changed.`);
            s.ramp = { atSec: round2(clamp(op.atSec ?? s.durationSec * 0.4, 0.1, s.durationSec - 0.15)), speed: op.speed };
            s.durationSec = round2(Math.min(s.durationSec, room(s)));
            if (s.ramp.atSec >= s.durationSec - 0.05) throw new RecipeError('no_footage', `Clip ${s.clipId} does not have enough footage for that ramp. Nothing was changed.`);
          }
          delete s.why;
        }
        changes.push(op.speed === null ? `No speed ramp on ${op.index === null ? 'any shot' : `shot ${op.index + 1}`}` : `Shot ${op.index! + 1} ramps to ${op.speed}×`);
        break;
      }
      case 'audio_cut': {
        const s = cutIndex(op.index);
        if (op.kind === 'none') delete s.audio;
        else s.audio = { kind: op.kind, seconds: op.seconds ?? 0.3 };
        delete s.why;
        changes.push(op.kind === 'none' ? `Straight sound cut into shot ${op.index + 1}` : `${op.kind.toUpperCase()}-cut into shot ${op.index + 1}`);
        break;
      }
      case 'beat_sync':
        if (r.beats.length < 4) throw new RecipeError('no_beats', 'There is no music beat to cut to (add a music file first). Nothing was changed.');
        resnap();
        changes.push('Cuts moved onto the beat');
        break;
      case 'music_volume':
        if (!r.music) throw new RecipeError('no_music', 'The video has no music. Nothing was changed.');
        r.music.volume = op.volume;
        changes.push(`Music volume ${Math.round(op.volume * 100)} %`);
        break;
      case 'remove_music':
        if (!r.music) throw new RecipeError('no_music', 'The video has no music. Nothing was changed.');
        r.music = null;
        r.beats = [];
        r.clipVolume = Math.max(r.clipVolume, 1);
        changes.push('Music removed');
        break;
      case 'clip_volume':
        r.clipVolume = op.volume;
        changes.push(op.volume === 0 ? 'Clip sound muted' : `Clip sound ${Math.round(op.volume * 100)} %`);
        break;
      case 'aspect':
        r.aspect = op.aspect;
        changes.push(`Format ${op.aspect}`);
        break;
      case 'title':
        r.title = op.title;
        changes.push('Renamed');
        break;
    }
  }
  // Edits that no longer fit a shot after its length changed are dropped or moved, never left broken.
  r.shots.forEach((s, i) => {
    if (i === 0) {
      delete s.transition;
      delete s.audio;
    }
    if (s.ramp && s.ramp.atSec >= s.durationSec - 0.05) delete s.ramp;
    if (s.zoom?.kind === 'punch' && s.zoom.atSec >= s.durationSec - 0.05) s.zoom = { ...s.zoom, atSec: round2(s.durationSec / 2) };
  });
  // Texts never run past the end.
  const end = totalSeconds(r);
  r.texts = r.texts.filter((t) => t.startSec < end).map((t) => ({ ...t, endSec: Math.min(t.endSec, end) }));
  return { recipe: RecipeSchema.parse(r), changes };
}

/**
 * The common instructions, understood on the spot without asking the model ("shorter intro",
 * "bigger captions", "make it 20 seconds", "louder music"). Returns null when any part is not
 * understood; the instruction then goes to the model, which uses video__direct.
 */
export function parseDirection(text: string, r: Recipe): DirectionOpT[] | null {
  const clauses = text
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .split(/\s*(?:,|;|\band\b|\bthen\b|\balso\b)\s*/)
    .map((c) => c.replace(/^(?:please|can you|could you|now|ok(?:ay)?|keo)\s+/g, '').trim())
    .filter(Boolean);
  if (!clauses.length) return null;
  const ops: DirectionOpT[] = [];
  for (const c of clauses) {
    const op = parseClause(c, r);
    if (!op) return null;
    ops.push(op);
  }
  return ops;
}

const CAP = '(?:captions?|subtitles?|subs)';

function parseClause(c: string, r: Recipe): DirectionOpT | null {
  const first = r.shots[0]?.durationSec ?? 1;
  const total = totalSeconds(r);
  let m: RegExpMatchArray | null;
  if (/^(?:make (?:the )?)?(?:intro|opening|start|beginning)(?: a bit| much)? (?:shorter|quicker|faster)$|^(?:shorter|quicker|faster) (?:intro|opening|start)$|^(?:cut|trim) (?:the )?(?:intro|opening|start)(?: down)?$/.test(c)) {
    return { op: 'trim_start', seconds: round2(clamp(first * 0.4, 0.1, 30)) };
  }
  if ((m = c.match(/^(?:cut|trim) (\d+(?:\.\d+)?) ?(?:s|sec|secs|seconds?) (?:off|from) (?:the )?(?:intro|start|beginning)$/))) return { op: 'trim_start', seconds: clamp(Number(m[1]), 0.1, 30) };
  if (/^(?:make (?:the )?)?(?:intro|opening) (?:longer|slower)$|^longer intro$/.test(c)) return { op: 'shot_length', index: 0, seconds: round2(first * 1.4) };
  if ((m = c.match(new RegExp(`^(?:make (?:the )?)?${CAP} (?:a bit |much )?(bigger|larger|smaller)$|^(bigger|larger|smaller) ${CAP}$`)))) {
    const grow = (m[1] ?? m[2]) !== 'smaller';
    return { op: 'captions', sizePct: round2(clamp(r.captions.sizePct * (grow ? 1.3 : 1 / 1.3), 3, 12)) };
  }
  if ((m = c.match(new RegExp(`^(?:put |move |show )?(?:the )?${CAP} (?:at |to |on |in )?(?:the )?(top|bottom|middle|center|centre)$`)))) {
    return { op: 'captions', position: m[1] === 'top' ? 'top' : m[1] === 'bottom' ? 'bottom' : 'center' };
  }
  if (new RegExp(`^(?:no|remove|hide|turn off|disable|without) (?:the )?${CAP}(?: off)?$|^${CAP} off$`).test(c)) return { op: 'captions', enabled: false };
  if (new RegExp(`^(?:add|show|turn on|enable) (?:the )?${CAP}$|^${CAP} on$`).test(c)) return { op: 'captions', enabled: true };
  if (new RegExp(`^(?:all caps|uppercase|capital letters)(?: ${CAP})?$|^${CAP} (?:in )?(?:all caps|uppercase|capitals)$`).test(c)) return { op: 'captions', uppercase: true };
  if ((m = c.match(/^(?:make it |make the video |)(?:(\d+(?:\.\d+)?) ?(?:s|sec|secs|seconds?)(?: long)?)$/)) || (m = c.match(/^(?:make it|cut it to|shorten it to|length|make the video) (\d+(?:\.\d+)?) ?(?:s|sec|secs|seconds?)(?: long)?$/))) {
    return { op: 'set_length', seconds: clamp(Number(m[1]), 3, 180) };
  }
  if (/^(?:make it |make the video |)(?:a bit |much )?shorter$/.test(c)) return { op: 'set_length', seconds: round2(clamp(total * 0.8, 3, 180)) };
  if (/^(?:make it |make the video |)(?:a bit |much )?longer$/.test(c)) return { op: 'set_length', seconds: round2(clamp(total * 1.2, 3, 180)) };
  if (/^(?:make the |turn the |turn )?music (?:a bit )?(?:louder|up)$|^louder music$|^turn up the music$/.test(c)) return r.music ? { op: 'music_volume', volume: round2(clamp(r.music.volume * 1.3, 0, 2)) } : null;
  if (/^(?:make the |turn the |turn )?music (?:a bit )?(?:quieter|softer|down|lower)$|^(?:quieter|softer) music$|^turn down the music$/.test(c)) return r.music ? { op: 'music_volume', volume: round2(clamp(r.music.volume / 1.3, 0, 2)) } : null;
  if (/^(?:no|remove|drop|without|mute) (?:the )?music$/.test(c)) return r.music ? { op: 'remove_music' } : null;
  if (/^(?:mute|silence|remove) (?:the )?(?:clips?|clip audio|clip sound|original (?:audio|sound)|voices?)$/.test(c)) return { op: 'clip_volume', volume: 0 };
  if (/^(?:make it |)(?:vertical|portrait|9[:x/]16|for (?:tiktok|reels|shorts))$/.test(c)) return { op: 'aspect', aspect: '9:16' };
  if (/^(?:make it |)(?:horizontal|landscape|widescreen|16[:x/]9|for youtube)$/.test(c)) return { op: 'aspect', aspect: '16:9' };
  if (/^(?:make it |)(?:square|1[:x/]1)$/.test(c)) return { op: 'aspect', aspect: '1:1' };
  if (/^(?:use |add )?(?:cross ?fades?|fades?|fade transitions|smooth transitions)$/.test(c)) return { op: 'transition', kind: 'fade' };
  if (/^(?:use )?(?:hard cuts|no transitions|just cuts|cuts only|no fades?)$/.test(c)) return { op: 'transition', kind: 'cut' };
  if (/^(?:use |add )?(?:whips?|whip pans?|whip transitions)$/.test(c)) return { op: 'transition', kind: 'whip' };
  if (/^(?:use |add )?(?:flash(?:es)?|flash transitions|white flash(?:es)?)$/.test(c)) return { op: 'transition', kind: 'flash' };
  if (/^(?:no|remove|without) (?:the )?(?:zooms?|punch[- ]?ins?|zoom effects)$/.test(c)) return { op: 'zoom', index: null, kind: 'none' };
  if (/^(?:no|remove|without) (?:the )?(?:speed ramps?|ramps?)$/.test(c)) return { op: 'speed_ramp', index: null, speed: null };
  if (/^(?:cut|cuts|sync(?: it| the cuts)?|snap(?: the cuts)?) (?:on|to) (?:the )?(?:beat|music|rhythm)$|^on the beat$/.test(c)) return r.beats.length >= 4 ? { op: 'beat_sync' } : null;
  return null;
}
