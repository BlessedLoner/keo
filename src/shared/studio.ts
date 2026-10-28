import { z } from 'zod';

/**
 * Keo Studio: a video project as layers on a timeline. The same project and the same edit
 * operations are used by the Studio page (the user dragging things) and by Keo (its tools), so
 * every change is checked the same way and can be undone.
 *
 * Times are in seconds on the project's timeline. Positions are fractions of the frame (0..1, the
 * centre of the layer); sizes of text are a percentage of the frame's height. Tracks are drawn
 * bottom first: tracks[0] is the lowest layer.
 */

export const STUDIO_VERSION = 1;

const Id = z.string().regex(/^[a-z0-9]{2,8}_[A-Za-z0-9]{4,24}$/);
const Sec = z.number().min(0).max(24 * 3600);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const Transform = z
  .object({
    /** Centre of the layer, as a fraction of the frame (0.5, 0.5 = middle). */
    x: z.number().min(-2).max(3).default(0.5),
    y: z.number().min(-2).max(3).default(0.5),
    /** 1 = the layer's natural fit in the frame. */
    scale: z.number().min(0.01).max(20).default(1),
    rotation: z.number().min(-3600).max(3600).default(0),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();
export type Transform = z.infer<typeof Transform>;

export const AssetKind = z.enum(['video', 'image', 'audio']);
export type AssetKind = z.infer<typeof AssetKind>;

export const Asset = z
  .object({
    id: Id,
    kind: AssetKind,
    /** Full path on this PC. */
    path: z.string().min(3).max(1000),
    name: z.string().min(1).max(260),
    /** Seconds (0 for pictures). */
    duration: Sec,
    width: z.number().int().min(0).max(16384),
    height: z.number().int().min(0).max(16384),
    hasAudio: z.boolean(),
  })
  .strict();
export type Asset = z.infer<typeof Asset>;

/** How text comes in and goes out (Phase 1 set; more styles come with motion design). */
export const TextAnimIn = z.enum(['none', 'fade', 'pop', 'slide-up', 'typewriter', 'blur-in', 'words']);
export const TextAnimOut = z.enum(['none', 'fade', 'pop', 'slide-down', 'blur-out']);

export const TextStyle = z
  .object({
    font: z.string().trim().min(1).max(80).default('Segoe UI'),
    /** Height of a line as a percentage of the frame's height. */
    sizePct: z.number().min(1).max(40).default(6),
    weight: z.enum(['normal', 'bold', 'black']).default('bold'),
    color: Hex.default('#FFFFFF'),
    /** A second colour for a left-to-right gradient fill (none: solid). */
    color2: Hex.nullable().default(null),
    align: z.enum(['left', 'center', 'right']).default('center'),
    /** Widest a line may get, as a fraction of the frame's width (it wraps after that). */
    maxWidth: z.number().min(0.1).max(1).default(0.86),
    outline: z.number().min(0).max(20).default(0),
    outlineColor: Hex.default('#000000'),
    /** A soft shadow (0: none). */
    shadow: z.number().min(0).max(60).default(8),
    /** A glow around the letters in this colour (0: none). */
    glow: z.number().min(0).max(80).default(0),
    glowColor: Hex.default('#FFFFFF'),
    /** A box behind the text. */
    box: z.boolean().default(false),
    boxColor: Hex.default('#000000B3'),
    uppercase: z.boolean().default(false),
    letterSpacing: z.number().min(-5).max(40).default(0),
    lineHeight: z.number().min(0.6).max(3).default(1.15),
  })
  .strict();
export type TextStyle = z.infer<typeof TextStyle>;

const Fades = { fadeIn: z.number().min(0).max(30).default(0), fadeOut: z.number().min(0).max(30).default(0) };

export const MediaClip = z
  .object({
    id: Id,
    type: z.literal('media'),
    assetId: Id,
    start: Sec,
    duration: z.number().min(0.04).max(24 * 3600),
    /** Where in the source the clip starts (seconds; ignored for pictures). */
    in: Sec.default(0),
    speed: z.number().min(0.1).max(8).default(1),
    volume: z.number().min(0).max(4).default(1),
    ...Fades,
    /** cover: fill the frame (cropping); contain: show all of it. */
    fit: z.enum(['cover', 'contain']).default('cover'),
    transform: Transform.prefault({}),
  })
  .strict();
export type MediaClip = z.infer<typeof MediaClip>;

export const TextClip = z
  .object({
    id: Id,
    type: z.literal('text'),
    start: Sec,
    duration: z.number().min(0.04).max(24 * 3600),
    text: z.string().min(1).max(2000),
    style: TextStyle.prefault({}),
    transform: Transform.prefault({}),
    animIn: TextAnimIn.default('fade'),
    animOut: TextAnimOut.default('fade'),
    /** Seconds the in/out animations take. */
    animSeconds: z.number().min(0).max(5).default(0.3),
    /** Word timings for captions (seconds on the timeline), for word-by-word highlighting. */
    words: z.array(z.object({ text: z.string().min(1).max(80), start: Sec, end: Sec }).strict()).max(400).optional(),
    /** Captions: the word being spoken is drawn in this colour. */
    highlight: Hex.nullable().default(null),
  })
  .strict();
export type TextClip = z.infer<typeof TextClip>;

export const AudioClip = z
  .object({
    id: Id,
    type: z.literal('audio'),
    assetId: Id,
    start: Sec,
    duration: z.number().min(0.04).max(24 * 3600),
    in: Sec.default(0),
    volume: z.number().min(0).max(4).default(1),
    ...Fades,
  })
  .strict();
export type AudioClip = z.infer<typeof AudioClip>;

export const Clip = z.discriminatedUnion('type', [MediaClip, TextClip, AudioClip]);
export type Clip = z.infer<typeof Clip>;

export const TrackKind = z.enum(['video', 'text', 'audio']);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z
  .object({
    id: Id,
    kind: TrackKind,
    name: z.string().min(1).max(60),
    hidden: z.boolean().default(false),
    muted: z.boolean().default(false),
    clips: z.array(Clip).max(5000).default([]),
  })
  .strict();
export type Track = z.infer<typeof Track>;

export const Project = z
  .object({
    version: z.literal(STUDIO_VERSION),
    id: Id,
    name: z.string().trim().min(1).max(120),
    createdAt: z.string(),
    updatedAt: z.string(),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
    fps: z.number().int().min(1).max(120),
    background: Hex.default('#000000'),
    assets: z.array(Asset).max(2000).default([]),
    tracks: z.array(Track).max(60).default([]),
  })
  .strict();
export type Project = z.infer<typeof Project>;

/** A project in the Studio list. */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  width: number;
  height: number;
  duration: number;
  clips: number;
}

/** A job for Keo's render window: an export, frames for Keo to look at, or measuring a file. */
export type RenderJob =
  | { kind: 'export'; projectId: string; exportId: string }
  | { kind: 'frames'; projectId: string; times: number[]; width: number }
  | { kind: 'probe'; url: string }
  | { kind: 'audio'; projectId: string; sampleRate: number };

export const FORMATS = {
  vertical: { width: 1080, height: 1920, label: 'Vertical 9:16 (TikTok, Reels, Shorts)' },
  landscape: { width: 1920, height: 1080, label: 'Landscape 16:9 (YouTube)' },
  square: { width: 1080, height: 1080, label: 'Square 1:1' },
  portrait: { width: 1080, height: 1350, label: 'Portrait 4:5 (Instagram)' },
} as const;
export type FormatId = keyof typeof FORMATS;

/** The text track auto-captions go on (made on top of the others when missing). */
export const CAPTIONS_TRACK = 'Captions';
/** Short-form caption look: bold white words with an outline; the spoken word lights up. */
export const CAPTION_STYLE: Partial<TextStyle> = { sizePct: 5.6, weight: 'black', color: '#FFFFFF', outline: 6, outlineColor: '#000000', shadow: 10, uppercase: true, maxWidth: 0.84 };

// ---------------------------------------------------------------- edit operations

const ClipRef = z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/);
const TrackRef = z.string().regex(/^tr_[A-Za-z0-9]{4,24}$/);
const AssetRef = z.string().regex(/^as_[A-Za-z0-9]{4,24}$/);
/** Where a new clip goes in time: a number, or "end" (after the last clip of its track). */
const At = z.union([Sec, z.literal('end')]);

const StylePatch = TextStyle.partial();
const TransformPatch = Transform.partial();

export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_media'), assetId: AssetRef, track: TrackRef.optional(), start: At.optional(), in: Sec.optional(), duration: z.number().min(0.04).optional(), fit: z.enum(['cover', 'contain']).optional(), transform: TransformPatch.optional() }).strict(),
  z
    .object({
      op: z.literal('add_text'),
      text: z.string().min(1).max(2000),
      start: Sec,
      duration: z.number().min(0.04).max(3600),
      track: TrackRef.optional(),
      style: StylePatch.optional(),
      transform: TransformPatch.optional(),
      animIn: TextAnimIn.optional(),
      animOut: TextAnimOut.optional(),
    })
    .strict(),
  z.object({ op: z.literal('add_audio'), assetId: AssetRef, track: TrackRef.optional(), start: At.optional(), in: Sec.optional(), duration: z.number().min(0.04).optional(), volume: z.number().min(0).max(4).optional() }).strict(),
  z.object({ op: z.literal('move'), clip: ClipRef, start: Sec, track: TrackRef.optional() }).strict(),
  /** Trim a clip's start (keeps its end where it is) and/or its length. */
  z.object({ op: z.literal('trim'), clip: ClipRef, trimStart: z.number().min(-3600).max(3600).optional(), duration: z.number().min(0.04).optional() }).strict(),
  z.object({ op: z.literal('split'), clip: ClipRef, at: Sec }).strict(),
  /** Delete a clip; ripple: later clips on its track move left to close the gap. */
  z.object({ op: z.literal('delete'), clip: ClipRef, ripple: z.boolean().optional() }).strict(),
  /** Cut a time range out of the whole timeline (every track), closing the gap. */
  z.object({ op: z.literal('cut_range'), from: Sec, to: Sec }).strict(),
  z
    .object({
      op: z.literal('set'),
      clip: ClipRef,
      text: z.string().min(1).max(2000).optional(),
      style: StylePatch.optional(),
      transform: TransformPatch.optional(),
      volume: z.number().min(0).max(4).optional(),
      speed: z.number().min(0.1).max(8).optional(),
      fadeIn: z.number().min(0).max(30).optional(),
      fadeOut: z.number().min(0).max(30).optional(),
      fit: z.enum(['cover', 'contain']).optional(),
      animIn: TextAnimIn.optional(),
      animOut: TextAnimOut.optional(),
      animSeconds: z.number().min(0).max(5).optional(),
      highlight: Hex.nullable().optional(),
    })
    .strict(),
  /** Captions: one text clip per line with its words' times, on the Captions track (made if missing; replace: its old captions go). */
  z
    .object({
      op: z.literal('add_captions'),
      lines: z
        .array(z.object({ text: z.string().min(1).max(300), start: Sec, end: Sec, words: z.array(z.object({ text: z.string().min(1).max(80), start: Sec, end: Sec }).strict()).max(60).optional() }).strict())
        .min(1)
        .max(3000),
      style: StylePatch.optional(),
      transform: TransformPatch.optional(),
      highlight: Hex.nullable().optional(),
      animIn: TextAnimIn.optional(),
      replace: z.boolean().default(true),
    })
    .strict(),
  z.object({ op: z.literal('add_track'), kind: TrackKind, name: z.string().trim().min(1).max(60).optional() }).strict(),
  z.object({ op: z.literal('set_track'), track: TrackRef, hidden: z.boolean().optional(), muted: z.boolean().optional(), name: z.string().trim().min(1).max(60).optional() }).strict(),
  z.object({ op: z.literal('delete_track'), track: TrackRef }).strict(),
  z.object({ op: z.literal('set_project'), name: z.string().trim().min(1).max(120).optional(), width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(7680).optional(), fps: z.number().int().min(1).max(120).optional(), background: Hex.optional() }).strict(),
]);
export type EditOp = z.infer<typeof EditOp>;

export class EditError extends Error {}

const rid = (prefix: string, rand: () => string) => `${prefix}_${rand()}`;
const defaultRand = () => Math.random().toString(36).slice(2, 12).padEnd(8, '0');

export function clipEnd(c: { start: number; duration: number }): number {
  return c.start + c.duration;
}

/** The project's length: where its last clip ends. */
export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return Math.round(end * 1000) / 1000;
}

export function findClip(p: Project, id: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

export function newProject(o: { name: string; format?: FormatId; fps?: number; now?: Date; rand?: () => string }): Project {
  const rand = o.rand ?? defaultRand;
  const f = FORMATS[o.format ?? 'vertical'];
  const at = (o.now ?? new Date()).toISOString();
  return Project.parse({
    version: STUDIO_VERSION,
    id: rid('pr', rand),
    name: o.name,
    createdAt: at,
    updatedAt: at,
    width: f.width,
    height: f.height,
    fps: o.fps ?? 30,
    tracks: [
      { id: rid('tr', rand), kind: 'video', name: 'Video', clips: [] },
      { id: rid('tr', rand), kind: 'text', name: 'Text', clips: [] },
      { id: rid('tr', rand), kind: 'audio', name: 'Audio', clips: [] },
    ],
  });
}

const sortClips = (t: Track) => t.clips.sort((a, b) => a.start - b.start);
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Applies edits to a copy of the project (all of them, or none: any problem throws EditError and
 * the project is unchanged). Returns the new project and a short line per change.
 */
export function applyEdits(project: Project, ops: EditOp[], o: { rand?: () => string; now?: Date } = {}): { project: Project; changes: string[] } {
  const rand = o.rand ?? defaultRand;
  const p = structuredClone(project);
  const changes: string[] = [];
  const asset = (id: string) => {
    const a = p.assets.find((x) => x.id === id);
    if (!a) throw new EditError(`There is no media ${id} in this project.`);
    return a;
  };
  const track = (id: string | undefined, kind: TrackKind): Track => {
    if (id) {
      const t = p.tracks.find((x) => x.id === id);
      if (!t) throw new EditError(`There is no track ${id}.`);
      if (t.kind !== kind) throw new EditError(`Track ${t.name} holds ${t.kind}, not ${kind}.`);
      return t;
    }
    const existing = p.tracks.find((x) => x.kind === kind);
    if (existing) return existing;
    const t: Track = { id: rid('tr', rand), kind, name: kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : 'Audio', hidden: false, muted: false, clips: [] };
    p.tracks.push(t);
    return t;
  };
  const endOf = (t: Track) => t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const get = (id: string) => {
    const f = findClip(p, id);
    if (!f) throw new EditError(`There is no clip ${id}.`);
    return f;
  };
  const sourceLeft = (c: Clip) => {
    if (c.type === 'text') return Infinity;
    const a = asset(c.assetId);
    if (a.kind === 'image') return Infinity;
    return (a.duration - c.in) / (c.type === 'media' ? c.speed : 1);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add_media': {
        const a = asset(op.assetId);
        if (a.kind === 'audio') throw new EditError(`${a.name} is audio: use add_audio.`);
        const t = track(op.track, 'video');
        const start = op.start === undefined || op.start === 'end' ? endOf(t) : op.start;
        const inn = a.kind === 'image' ? 0 : Math.min(op.in ?? 0, Math.max(0, a.duration - 0.04));
        const max = a.kind === 'image' ? Infinity : a.duration - inn;
        const duration = round(Math.min(op.duration ?? (a.kind === 'image' ? 3 : max), max));
        if (duration < 0.04) throw new EditError(`${a.name} has nothing left after ${inn}s.`);
        const c = MediaClip.parse({ id: rid('cl', rand), type: 'media', assetId: a.id, start: round(start), duration, in: round(inn), ...(op.fit ? { fit: op.fit } : {}), transform: op.transform ?? {} });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added ${a.name} at ${round(start)}s for ${duration}s (${c.id}).`);
        break;
      }
      case 'add_text': {
        const t = track(op.track, 'text');
        const c = TextClip.parse({ id: rid('cl', rand), type: 'text', start: round(op.start), duration: round(op.duration), text: op.text, style: op.style ?? {}, transform: op.transform ?? {}, ...(op.animIn ? { animIn: op.animIn } : {}), ...(op.animOut ? { animOut: op.animOut } : {}) });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added text “${op.text.slice(0, 40)}” at ${c.start}s (${c.id}).`);
        break;
      }
      case 'add_audio': {
        const a = asset(op.assetId);
        if (a.kind === 'image') throw new EditError(`${a.name} is a picture, not sound.`);
        if (!a.hasAudio) throw new EditError(`${a.name} has no sound.`);
        const t = track(op.track, 'audio');
        const start = op.start === undefined || op.start === 'end' ? endOf(t) : op.start;
        const inn = Math.min(op.in ?? 0, Math.max(0, a.duration - 0.04));
        const duration = round(Math.min(op.duration ?? a.duration - inn, a.duration - inn));
        const c = AudioClip.parse({ id: rid('cl', rand), type: 'audio', assetId: a.id, start: round(start), duration, in: round(inn), ...(op.volume !== undefined ? { volume: op.volume } : {}) });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added the sound of ${a.name} at ${c.start}s (${c.id}).`);
        break;
      }
      case 'move': {
        const f = get(op.clip);
        const kind = f.track.kind;
        const to = op.track ? track(op.track, kind) : f.track;
        f.clip.start = round(op.start);
        if (to !== f.track) {
          f.track.clips.splice(f.index, 1);
          to.clips.push(f.clip);
        }
        sortClips(to);
        changes.push(`Moved ${f.clip.id} to ${f.clip.start}s${to !== f.track ? ` on ${to.name}` : ''}.`);
        break;
      }
      case 'trim': {
        const f = get(op.clip);
        const c = f.clip;
        if (op.trimStart) {
          const d = op.trimStart;
          if (d >= c.duration - 0.04) throw new EditError(`Trimming ${d}s would remove all of ${c.id}.`);
          if (c.type !== 'text') {
            const rate = c.type === 'media' ? c.speed : 1;
            const nextIn = c.in + d * rate;
            if (nextIn < -1e-6) throw new EditError(`${c.id} cannot start earlier than its source does.`);
            c.in = round(Math.max(0, nextIn));
          }
          c.start = round(c.start + d);
          c.duration = round(c.duration - d);
        }
        if (op.duration !== undefined) {
          const max = sourceLeft(c);
          if (op.duration > max + 1e-6) throw new EditError(`${c.id} is only ${round(max)}s long from where it starts.`);
          c.duration = round(op.duration);
        }
        sortClips(f.track);
        changes.push(`Trimmed ${c.id}: ${c.start}s for ${c.duration}s.`);
        break;
      }
      case 'split': {
        const f = get(op.clip);
        const c = f.clip;
        if (op.at <= c.start + 0.04 || op.at >= clipEnd(c) - 0.04) throw new EditError(`${op.at}s is not inside ${c.id}.`);
        const first = round(op.at - c.start);
        const second = structuredClone(c);
        second.id = rid('cl', rand);
        second.start = round(op.at);
        second.duration = round(c.duration - first);
        if (second.type !== 'text') second.in = round(second.in + first * (second.type === 'media' ? second.speed : 1));
        if (second.type !== 'text') second.fadeIn = 0;
        if (c.type !== 'text') c.fadeOut = 0;
        c.duration = first;
        f.track.clips.splice(f.index + 1, 0, second);
        changes.push(`Split ${c.id} at ${op.at}s (new part ${second.id}).`);
        break;
      }
      case 'delete': {
        const f = get(op.clip);
        f.track.clips.splice(f.index, 1);
        if (op.ripple) for (const o2 of f.track.clips) if (o2.start >= clipEnd(f.clip) - 1e-6) o2.start = round(o2.start - f.clip.duration);
        changes.push(`Deleted ${f.clip.id}${op.ripple ? ' and closed the gap' : ''}.`);
        break;
      }
      case 'cut_range': {
        if (op.to <= op.from + 0.01) throw new EditError('The range to cut must end after it starts.');
        const len = op.to - op.from;
        for (const t of p.tracks) {
          const out: Clip[] = [];
          for (const c of t.clips) {
            const end = clipEnd(c);
            if (end <= op.from) out.push(c);
            else if (c.start >= op.to) {
              c.start = round(c.start - len);
              out.push(c);
            } else {
              // Overlaps the range: keep what is before it and what is after it.
              const before = op.from - c.start;
              const after = end - op.to;
              if (before >= 0.04) {
                const a = structuredClone(c);
                a.duration = round(before);
                if (a.type !== 'text') a.fadeOut = 0;
                out.push(a);
              }
              if (after >= 0.04) {
                const b = structuredClone(c);
                b.id = before >= 0.04 ? rid('cl', rand) : c.id;
                const skipped = op.to - c.start;
                b.start = round(op.from);
                b.duration = round(after);
                if (b.type !== 'text') {
                  b.in = round(b.in + skipped * (b.type === 'media' ? b.speed : 1));
                  b.fadeIn = 0;
                }
                if (b.type === 'text' && b.words) b.words = b.words.filter((w) => w.start >= op.to).map((w) => ({ ...w, start: round(w.start - len), end: round(w.end - len) }));
                out.push(b);
              }
            }
          }
          t.clips = out;
          sortClips(t);
        }
        changes.push(`Cut ${round(len)}s out (${round(op.from)}s–${round(op.to)}s).`);
        break;
      }
      case 'set': {
        const f = get(op.clip);
        const c = f.clip;
        const only = (field: string, ok: boolean) => {
          if (!ok) throw new EditError(`${c.id} is ${c.type === 'media' ? 'a video or picture' : c.type}: it has no ${field}.`);
        };
        if (op.text !== undefined) {
          only('text', c.type === 'text');
          (c as TextClip).text = op.text;
          delete (c as TextClip).words;
        }
        if (op.style) {
          only('text style', c.type === 'text');
          (c as TextClip).style = TextStyle.parse({ ...(c as TextClip).style, ...op.style });
        }
        if (op.transform) {
          only('position', c.type !== 'audio');
          (c as MediaClip | TextClip).transform = Transform.parse({ ...(c as MediaClip | TextClip).transform, ...op.transform });
        }
        if (op.volume !== undefined) {
          only('volume', c.type !== 'text');
          (c as MediaClip | AudioClip).volume = op.volume;
        }
        if (op.speed !== undefined) {
          only('speed', c.type === 'media');
          const m = c as MediaClip;
          const a = asset(m.assetId);
          // The clip keeps the same part of its source: its length changes with the speed.
          const sourceSeconds = m.duration * m.speed;
          m.speed = op.speed;
          m.duration = round(a.kind === 'image' ? m.duration : Math.max(0.04, sourceSeconds / op.speed));
        }
        for (const k of ['fadeIn', 'fadeOut'] as const)
          if (op[k] !== undefined) {
            only('fades', c.type !== 'text');
            (c as MediaClip | AudioClip)[k] = op[k]!;
          }
        if (op.fit) {
          only('fit', c.type === 'media');
          (c as MediaClip).fit = op.fit;
        }
        for (const k of ['animIn', 'animOut', 'animSeconds', 'highlight'] as const)
          if (op[k] !== undefined) {
            only('animation', c.type === 'text');
            ((c as TextClip)[k] as unknown) = op[k];
          }
        sortClips(f.track);
        changes.push(`Changed ${c.id}.`);
        break;
      }
      case 'add_captions': {
        let t = p.tracks.find((x) => x.kind === 'text' && x.name === CAPTIONS_TRACK);
        if (!t) {
          t = { id: rid('tr', rand), kind: 'text', name: CAPTIONS_TRACK, hidden: false, muted: false, clips: [] };
          p.tracks.push(t);
        } else if (op.replace) t.clips = [];
        const style = { ...CAPTION_STYLE, ...(op.style ?? {}) };
        const transform = { y: 0.74, ...(op.transform ?? {}) };
        for (const l of op.lines) {
          const start = round(l.start);
          const duration = round(Math.max(0.1, l.end - l.start));
          t.clips.push(
            TextClip.parse({
              id: rid('cl', rand),
              type: 'text',
              start,
              duration,
              text: l.text,
              style,
              transform,
              animIn: op.animIn ?? 'pop',
              animOut: 'none',
              animSeconds: 0.12,
              ...(l.words?.length ? { words: l.words.map((w) => ({ text: w.text, start: round(w.start), end: round(Math.max(w.start, w.end)) })) } : {}),
              highlight: op.highlight === undefined ? '#FFD400' : op.highlight,
            }),
          );
        }
        sortClips(t);
        changes.push(`Added ${op.lines.length} caption line${op.lines.length === 1 ? '' : 's'} on the ${CAPTIONS_TRACK} track (${t.id}).`);
        break;
      }
      case 'add_track': {
        const t: Track = { id: rid('tr', rand), kind: op.kind, name: op.name ?? (op.kind === 'video' ? 'Video' : op.kind === 'text' ? 'Text' : 'Audio'), hidden: false, muted: false, clips: [] };
        // A new video or text track goes on top of the others of its kind.
        p.tracks.push(t);
        changes.push(`Added the ${op.kind} track ${t.name} (${t.id}).`);
        break;
      }
      case 'set_track': {
        const t = p.tracks.find((x) => x.id === op.track);
        if (!t) throw new EditError(`There is no track ${op.track}.`);
        if (op.hidden !== undefined) t.hidden = op.hidden;
        if (op.muted !== undefined) t.muted = op.muted;
        if (op.name) t.name = op.name;
        changes.push(`Changed the track ${t.name}.`);
        break;
      }
      case 'delete_track': {
        const i = p.tracks.findIndex((x) => x.id === op.track);
        if (i < 0) throw new EditError(`There is no track ${op.track}.`);
        changes.push(`Deleted the track ${p.tracks[i]!.name} and its ${p.tracks[i]!.clips.length} clip(s).`);
        p.tracks.splice(i, 1);
        break;
      }
      case 'set_project': {
        if (op.name) p.name = op.name;
        if (op.width) p.width = op.width;
        if (op.height) p.height = op.height;
        if (op.fps) p.fps = op.fps;
        if (op.background) p.background = op.background;
        changes.push('Changed the project settings.');
        break;
      }
    }
  }
  p.updatedAt = (o.now ?? new Date()).toISOString();
  // Whatever happened, the result must still be a valid project.
  const checked = Project.safeParse(p);
  if (!checked.success) throw new EditError(`That edit would make the project invalid: ${checked.error.issues[0]?.message ?? 'unknown problem'}.`);
  return { project: checked.data, changes };
}

/** A short text view of the timeline, for Keo to read. */
export function describeProject(p: Project): string {
  const lines = [`${p.name}: ${p.width}x${p.height}, ${p.fps} fps, ${projectDuration(p)}s.`, `Media: ${p.assets.map((a) => `${a.id} ${a.name} (${a.kind}${a.kind !== 'image' ? `, ${round(a.duration)}s` : ''}${a.hasAudio ? ', sound' : ''})`).join('; ') || 'none'}.`];
  p.tracks.forEach((t, i) => {
    lines.push(`Track ${i + 1} ${t.id} ${t.kind} “${t.name}”${t.hidden ? ' (hidden)' : ''}${t.muted ? ' (muted)' : ''}:`);
    for (const c of t.clips) {
      const span = `${round(c.start)}–${round(clipEnd(c))}s`;
      if (c.type === 'text') lines.push(`  ${c.id} ${span} text “${c.text.slice(0, 60)}”${c.words ? ` (${c.words.length} timed words)` : ''}`);
      else {
        const a = p.assets.find((x) => x.id === c.assetId);
        lines.push(`  ${c.id} ${span} ${c.type === 'media' ? 'clip' : 'sound'} ${a?.name ?? c.assetId} from ${round(c.in)}s${c.type === 'media' && c.speed !== 1 ? ` at ${c.speed}x` : ''}${c.volume !== 1 ? ` volume ${c.volume}` : ''}`);
      }
    }
  });
  return lines.join('\n');
}
