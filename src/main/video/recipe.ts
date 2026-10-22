import { z } from 'zod';

/**
 * The edit recipe: everything Keo needs to render a video, as plain data. The model never writes
 * ffmpeg commands; it only proposes recipes and changes to them, which are validated here, and
 * the render step turns a recipe into fixed ffmpeg arguments (render.ts).
 */

export const ASPECTS = ['9:16', '16:9', '1:1', '4:5'] as const;
export const Aspect = z.enum(ASPECTS);
export type AspectT = z.infer<typeof Aspect>;

/** Simple transitions (ffmpeg xfade names; 'cut' = none). */
export const TRANSITIONS = ['cut', 'fade', 'fadeblack', 'fadewhite', 'slideleft', 'slideup', 'zoomin'] as const;
export const Transition = z.enum(TRANSITIONS);

/** Fonts every Windows PC has (captions and text are drawn with the PC's own fonts). */
export const FONTS = ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Comic Sans MS'] as const;
export const Font = z.enum(FONTS);

export const Position = z.enum(['top', 'center', 'bottom']);
const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour like #FFFFFF');
const Sec = z.number().finite().min(0).max(3600);

export const ClipId = z.string().regex(/^c\d{1,3}$/, 'a clip id like c1 from the clip analysis');

export const Shot = z
  .object({
    clipId: ClipId,
    /** Where the shot starts in the source clip (seconds). */
    inSec: Sec,
    /** How long the shot lasts in the finished video (seconds). */
    durationSec: z.number().finite().min(0.2).max(120),
    /** Playback speed (0.5 = slow motion, 2 = double speed). */
    speed: z.number().min(0.25).max(4).default(1),
  })
  .strict();
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
    transition: z.object({ kind: Transition.default('cut'), seconds: z.number().min(0.1).max(1.5).default(0.3) }).strict().prefault({}),
    texts: z.array(TextOverlay).max(30).default([]),
    captions: CaptionStyle.prefault({}),
    music: Music.nullable().default(null),
    /** Volume of the clips' own sound (0 = muted). */
    clipVolume: z.number().min(0).max(2).default(1),
    /** What Keo could not follow from the template (shown to the user). */
    notes: z.array(z.string().max(300)).max(20).default([]),
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

const PACE: Record<TemplateStyle['pacing'], number> = { fast: 1.2, medium: 2.2, slow: 3.5 };

export interface PlanOptions {
  title?: string;
  targetSeconds?: number;
  aspect?: AspectT;
  captions?: boolean;
  music?: { path: string; beats: number[] } | null;
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
  const shots = assignClips(lengths, usable, notes);

  const transition = o.transition ?? style?.transitions ?? 'cut';
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
    transition: { kind: transition, seconds: 0.3 },
    texts,
    captions,
    music: o.music ? { path: o.music.path } : null,
    clipVolume: o.clipVolume ?? (o.music ? 0.35 : 1),
    notes,
  });
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
    const srcEnd = s.inSec + s.durationSec * s.speed;
    const inShot = words.filter((w) => w.startSec >= s.inSec - 0.05 && w.startSec < srcEnd - 0.05);
    const at = (src: number) => round2(starts[i]! + Math.max(0, src - s.inSec) / s.speed);
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
  z.object({ op: z.literal('transition'), kind: Transition, seconds: z.number().min(0.1).max(1.5).optional() }).strict(),
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
    return c ? Math.max(0.2, (c.durationSec - s.inSec) / s.speed) : s.durationSec;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'set_length': {
        const before = totalSeconds(r);
        const k = op.seconds / before;
        for (const s of r.shots) s.durationSec = round2(clamp(s.durationSec * k, 0.2, room(s)));
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
      case 'transition':
        r.transition = { kind: op.kind, seconds: op.seconds ?? r.transition.seconds };
        changes.push(op.kind === 'cut' ? 'Hard cuts' : `${op.kind} transitions`);
        break;
      case 'music_volume':
        if (!r.music) throw new RecipeError('no_music', 'The video has no music. Nothing was changed.');
        r.music.volume = op.volume;
        changes.push(`Music volume ${Math.round(op.volume * 100)} %`);
        break;
      case 'remove_music':
        if (!r.music) throw new RecipeError('no_music', 'The video has no music. Nothing was changed.');
        r.music = null;
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
  if (/^(?:use )?(?:hard cuts|no transitions|just cuts|cuts only)$/.test(c)) return { op: 'transition', kind: 'cut' };
  return null;
}
