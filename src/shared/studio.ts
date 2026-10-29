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

const SourceWord = z.object({ text: z.string().min(1).max(80), start: Sec, end: Sec }).strict();
export type SourceWord = z.infer<typeof SourceWord>;

/** A colour grade (0 = unchanged for all of them). */
export const ColorGrade = z
  .object({
    exposure: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(-1).max(1).default(0),
    saturation: z.number().min(-1).max(1).default(0),
    /** Warmer (+) or cooler (-). */
    temperature: z.number().min(-1).max(1).default(0),
    /** Darker corners. */
    vignette: z.number().min(0).max(1).default(0),
  })
  .strict();
export type ColorGrade = z.infer<typeof ColorGrade>;

/**
 * A zoom keyframe of a clip: from `at` seconds into the clip, this scale centred on x, y (fractions
 * of the frame). cut: jumps there; smooth: eases there in under half a second; ramp: moves there
 * steadily from the keyframe before (a slow push or pull).
 */
export const Zoom = z
  .object({ at: Sec, scale: z.number().min(0.5).max(4), x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5), ease: z.enum(['cut', 'smooth', 'ramp']).default('cut') })
  .strict();
export type Zoom = z.infer<typeof Zoom>;

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
    /** Where there is speech (or other sound) in the source, in source seconds (Keo's own analysis, on this PC). */
    speech: z.array(z.object({ start: Sec, end: Sec }).strict()).max(20000).optional(),
    /** The spoken words with their source times (speech-to-text); exact: word times from the service. */
    words: z.array(SourceWord).max(80000).optional(),
    wordsExact: z.boolean().optional(),
    /** Music: the beat (source seconds) and tempo, from Keo's own analysis on this PC. */
    beats: z.array(Sec).max(20000).optional(),
    bpm: z.number().min(20).max(400).nullable().optional(),
  })
  .strict();
export type Asset = z.infer<typeof Asset>;

/** How text comes in and goes out (Phase 1 set; more styles come with motion design). */
export const TextAnimIn = z.enum(['none', 'fade', 'pop', 'slide-up', 'typewriter', 'blur-in', 'words', 'letters', 'drop', 'zoom', 'wipe', 'glitch', 'wave']);
export const TextAnimOut = z.enum(['none', 'fade', 'pop', 'slide-down', 'blur-out', 'zoom', 'wipe']);

// ---------------------------------------------------------------- motion (any visible layer)

/** How a keyframe's value is reached from the keyframe before (hold: jumps at the keyframe). */
export const Ease = z.enum(['linear', 'in', 'out', 'in-out', 'back', 'elastic', 'bounce', 'hold']);
export type Ease = z.infer<typeof Ease>;
/** A keyframe: at `at` seconds into the clip the property is `value`. */
export const Key = z.object({ at: Sec, value: z.number().min(-10000).max(10000), ease: Ease.default('in-out') }).strict();
export type Key = z.infer<typeof Key>;
/**
 * The properties keyframes animate: x, y (fractions of the frame, like the position), scale,
 * scaleX, scaleY (1 = normal), rotation (degrees), opacity (0..1), blur (percent of the frame
 * height). A keyframed property replaces the clip's own value.
 */
export const KEY_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'blur'] as const;
export type KeyProp = (typeof KEY_PROPS)[number];
export const Keys = z.object(Object.fromEntries(KEY_PROPS.map((k) => [k, z.array(Key).max(300).optional()])) as Record<KeyProp, z.ZodOptional<z.ZodArray<typeof Key>>>).strict();
export type Keys = z.infer<typeof Keys>;

/** How a layer comes in or goes out (wipes and iris reveal it through a moving edge). */
export const MOTIONS = ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'pop', 'spin', 'blur', 'whip', 'flash', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'iris'] as const;
export const Entrance = z.object({ kind: z.enum(MOTIONS), seconds: z.number().min(0.05).max(5).default(0.45) }).strict();
export type Entrance = z.infer<typeof Entrance>;
/** A movement that repeats while the layer is on screen. */
export const Loop = z.object({ kind: z.enum(['float', 'pulse', 'shake', 'spin', 'sway', 'flicker']), amount: z.number().min(0).max(1).default(0.3), period: z.number().min(0.1).max(30).default(2) }).strict();
export type Loop = z.infer<typeof Loop>;
const Motion = { keys: Keys.optional(), enter: Entrance.optional(), exit: Entrance.optional(), loop: Loop.optional() };

/** A number that counts up (or down) while the text is in (like "0 → 10,000 followers"). */
export const Counter = z
  .object({ from: z.number().min(-1e12).max(1e12), to: z.number().min(-1e12).max(1e12), decimals: z.number().int().min(0).max(4).default(0), prefix: z.string().max(20).default(''), suffix: z.string().max(40).default(''), separator: z.boolean().default(true), seconds: z.number().min(0.1).max(60).optional() })
  .strict();
export type Counter = z.infer<typeof Counter>;

/** A video or picture shown in a shape (rounded corners, a circle for avatars). */
export const Mask = z.object({ shape: z.enum(['rounded', 'circle']), radius: z.number().min(0).max(0.5).default(0.08) }).strict();
export type Mask = z.infer<typeof Mask>;
/** Shown inside a device: a phone, a browser window or a floating card. */
export const DeviceFrame = z.enum(['phone', 'browser', 'card']);

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

/** Green screen (chroma key) settings. */
export const Chroma = z
  .object({ color: Hex.default('#00FF00'), similarity: z.number().min(0).max(1).default(0.4), smoothness: z.number().min(0).max(1).default(0.25), spill: z.number().min(0).max(1).default(0.5) })
  .strict();
export type Chroma = z.infer<typeof Chroma>;

/** Effects on a video or picture, each with its strength (0..1). */
export const Effects = z
  .object({
    grain: z.number().min(0).max(1).optional(),
    vhs: z.number().min(0).max(1).optional(),
    glow: z.number().min(0).max(1).optional(),
    rgbSplit: z.number().min(0).max(1).optional(),
    lightLeak: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Effects = z.infer<typeof Effects>;

/** A point of a speed curve: at fraction x of the clip, this speed (1 = normal). */
export const SpeedPoint = z.object({ x: z.number().min(0).max(1), speed: z.number().min(0.1).max(10) }).strict();
export type SpeedPoint = z.infer<typeof SpeedPoint>;

/** Ready-made speed curves (like the ones short-form editors use). */
export const SPEED_PRESETS: Record<'montage' | 'hero' | 'bullet' | 'flash-in' | 'flash-out' | 'jump-cut', SpeedPoint[]> = {
  montage: [
    { x: 0, speed: 1 },
    { x: 0.25, speed: 3 },
    { x: 0.5, speed: 0.4 },
    { x: 0.75, speed: 3 },
    { x: 1, speed: 1 },
  ],
  hero: [
    { x: 0, speed: 1.4 },
    { x: 0.35, speed: 1.4 },
    { x: 0.45, speed: 0.2 },
    { x: 0.65, speed: 0.2 },
    { x: 0.75, speed: 1.4 },
    { x: 1, speed: 1.4 },
  ],
  bullet: [
    { x: 0, speed: 3 },
    { x: 0.4, speed: 3 },
    { x: 0.5, speed: 0.15 },
    { x: 0.6, speed: 3 },
    { x: 1, speed: 3 },
  ],
  'flash-in': [
    { x: 0, speed: 6 },
    { x: 0.3, speed: 1 },
    { x: 1, speed: 1 },
  ],
  'flash-out': [
    { x: 0, speed: 1 },
    { x: 0.7, speed: 1 },
    { x: 1, speed: 6 },
  ],
  'jump-cut': [
    { x: 0, speed: 1 },
    { x: 0.45, speed: 1 },
    { x: 0.5, speed: 5 },
    { x: 0.55, speed: 1 },
    { x: 1, speed: 1 },
  ],
};

/** The speed at fraction x of a curve (straight lines between its points). */
export function curveAt(points: SpeedPoint[], x: number): number {
  if (x <= points[0]!.x) return points[0]!.speed;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x <= b.x) return a.speed + ((b.speed - a.speed) * (x - a.x)) / Math.max(1e-9, b.x - a.x);
  }
  return points.at(-1)!.speed;
}

/** The area under a curve from x0 to x1 (exact for straight segments). */
export function curveArea(points: SpeedPoint[], x0: number, x1: number): number {
  if (x1 <= x0) return 0;
  const xs = [x0, ...points.map((p) => p.x).filter((x) => x > x0 && x < x1), x1];
  let area = 0;
  for (let i = 1; i < xs.length; i++) area += ((curveAt(points, xs[i - 1]!) + curveAt(points, xs[i]!)) / 2) * (xs[i]! - xs[i - 1]!);
  return area;
}

/** The part of a curve from x0 to x1, stretched to 0..1. */
export function subCurve(points: SpeedPoint[], x0: number, x1: number): SpeedPoint[] {
  const span = Math.max(1e-6, x1 - x0);
  const inner = points.filter((p) => p.x > x0 + 1e-6 && p.x < x1 - 1e-6).map((p) => ({ x: (p.x - x0) / span, speed: p.speed }));
  return [{ x: 0, speed: curveAt(points, x0) }, ...inner, { x: 1, speed: curveAt(points, x1) }].map((p) => ({ x: Math.round(p.x * 10000) / 10000, speed: Math.round(p.speed * 1000) / 1000 }));
}

/** Seconds of the source a video clip shows in its first rt seconds (its speed, or its speed curve). */
export function sourceSpan(c: { duration: number; speed: number; speedCurve?: SpeedPoint[] | undefined }, rt: number): number {
  if (!c.speedCurve?.length) return rt * c.speed;
  return c.duration * curveArea(c.speedCurve, 0, Math.max(0, Math.min(1, rt / Math.max(1e-6, c.duration))));
}

/** Edges cut off a video or picture: fractions of its width (left, right) and height (top, bottom). */
export const Crop = z
  .object({ left: z.number().min(0).max(0.45).default(0), top: z.number().min(0).max(0.45).default(0), right: z.number().min(0).max(0.45).default(0), bottom: z.number().min(0).max(0.45).default(0) })
  .strict();
export type Crop = z.infer<typeof Crop>;

/** Transitions between two clips that touch on a track: the change is centred on the cut. */
export const TRANSITIONS = ['crossfade', 'slide', 'push', 'zoom', 'whip', 'wipe', 'blur', 'flash', 'dip'] as const;
export const Transition = z.object({ kind: z.enum(TRANSITIONS), seconds: z.number().min(0.1).max(3).default(0.5) }).strict();
export type Transition = z.infer<typeof Transition>;

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
    color: ColorGrade.optional(),
    /** Punch-ins and slow pushes: zoom keyframes (sorted by at). */
    zooms: z.array(Zoom).max(400).optional(),
    /** Voice clean-up on this clip's sound (low rumble cut, clearer voice, even loudness). */
    voice: z.boolean().default(false),
    /** Noise gate: this many dB quieter between the clip's own sentences (null: off). */
    gate: z.number().min(-40).max(0).nullable().optional(),
    /** A still: the frame at `in` held for the whole clip (no sound). */
    freeze: z.boolean().optional(),
    /** How this clip takes over from the clip just before it on its track (both show during the change). */
    transition: Transition.optional(),
    /** Edges cut off the picture (fractions of its width and height). */
    crop: Crop.optional(),
    /** Green screen: this colour made transparent (similarity, edge smoothness, spill removal 0..1). */
    chroma: Chroma.optional(),
    /** Behind a picture that does not fill the frame: a blurred, darker copy of it fills the rest. */
    backdrop: z.enum(['blur']).optional(),
    /** Looks laid over the picture (film grain, VHS, glow, RGB split, light leak), each 0..1. */
    effects: Effects.optional(),
    /** A speed curve over the clip (x: fraction of the clip); replaces `speed` while set. */
    speedCurve: z.array(SpeedPoint).min(2).max(16).optional(),
    mask: Mask.optional(),
    frame: DeviceFrame.optional(),
    /** A drop shadow under the layer (0: none). */
    shadow: z.number().min(0).max(60).default(0),
    ...Motion,
  })
  .strict();
export type MediaClip = z.infer<typeof MediaClip>;

// ---------------------------------------------------------------- elements (shapes)

export const ShapeKind = z.enum(['rect', 'circle', 'ring', 'line', 'arrow', 'star', 'triangle']);
export type ShapeKind = z.infer<typeof ShapeKind>;
export const ShapeStyle = z
  .object({
    /** Size as fractions of the frame's width and height. */
    width: z.number().min(0.001).max(4).default(0.5),
    height: z.number().min(0.001).max(4).default(0.1),
    /** Corner rounding of rectangles (0..0.5 of the shorter side). */
    radius: z.number().min(0).max(0.5).default(0.12),
    fill: Hex.nullable().default('#FFFFFF'),
    /** A second colour: a gradient at `angle` degrees. */
    fill2: Hex.nullable().default(null),
    angle: z.number().min(-360).max(360).default(90),
    stroke: Hex.nullable().default(null),
    /** Outline thickness in thousandths of the frame height. */
    strokeWidth: z.number().min(0).max(100).default(8),
    glow: z.number().min(0).max(80).default(0),
    glowColor: Hex.default('#FFFFFF'),
    shadow: z.number().min(0).max(60).default(0),
    /** Lines, rings and outlines draw themselves on while the layer comes in. */
    draw: z.boolean().default(false),
  })
  .strict();
export type ShapeStyle = z.infer<typeof ShapeStyle>;

export const ShapeClip = z
  .object({
    id: Id,
    type: z.literal('shape'),
    start: Sec,
    duration: z.number().min(0.04).max(24 * 3600),
    shape: ShapeKind,
    style: ShapeStyle.prefault({}),
    transform: Transform.prefault({}),
    ...Motion,
  })
  .strict();
export type ShapeClip = z.infer<typeof ShapeClip>;

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
    /** Word timings for captions (seconds from the clip's start), for word-by-word highlighting. */
    words: z.array(z.object({ text: z.string().min(1).max(80), start: Sec, end: Sec }).strict()).max(400).optional(),
    /** Captions: the word being spoken is drawn in this colour. */
    highlight: Hex.nullable().default(null),
    counter: Counter.optional(),
    keys: Keys.optional(),
    loop: Loop.optional(),
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
    voice: z.boolean().default(false),
    /** Noise gate: this many dB quieter between the clip's own sentences (null: off). */
    gate: z.number().min(-40).max(0).nullable().optional(),
    /** Music: this many dB quieter while someone speaks (null: never ducked). */
    duck: z.number().min(-40).max(0).nullable().default(null),
  })
  .strict();
export type AudioClip = z.infer<typeof AudioClip>;

export const Clip = z.discriminatedUnion('type', [MediaClip, TextClip, AudioClip, ShapeClip]);
export type Clip = z.infer<typeof Clip>;
/** Clips with media behind them (video, picture or sound). */
export const isAV = (c: Clip): c is MediaClip | AudioClip => c.type === 'media' || c.type === 'audio';

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
    /** social: the export's loudness is evened out for phones and social apps (about -14 LUFS). */
    loudness: z.enum(['off', 'social']).default('off'),
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
  /** The first video or picture (for a thumbnail), null when there is none. */
  cover: Asset | null;
}

/** A job for Keo's render window: an export, frames for Keo to look at, or measuring a file. */
export type RenderJob =
  | { kind: 'export'; projectId: string; exportId: string; size?: { width: number; height: number; fps: number; quality: ExportQuality } }
  | { kind: 'frames'; projectId: string; times: number[]; width: number }
  | { kind: 'probe'; url: string }
  | { kind: 'audio'; projectId: string; sampleRate: number }
  | { kind: 'cancel'; exportId: string }
  | { kind: 'asset_audio'; projectId: string; assetId: string; sampleRate: number };

/** Export choices: the shorter side in pixels (or the project's own size), frame rate, quality, file name. */
export const ExportQuality = z.enum(['standard', 'high', 'best']);
export type ExportQuality = z.infer<typeof ExportQuality>;
export const ExportOptions = z
  .object({
    resolution: z.enum(['project', '720', '1080', '1440', '2160']).default('project'),
    fps: z.union([z.literal('project'), z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default('project'),
    quality: ExportQuality.default('high'),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type ExportOptions = z.infer<typeof ExportOptions>;

/** The pixel size and frame rate an export with these options has (even numbers, the project's shape). */
export function exportSize(p: { width: number; height: number; fps: number }, o: Pick<ExportOptions, 'resolution' | 'fps'>): { width: number; height: number; fps: number } {
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  const fps = o.fps === 'project' ? p.fps : o.fps;
  if (o.resolution === 'project') return { width: even(p.width), height: even(p.height), fps };
  const short = Number(o.resolution);
  const k = short / Math.min(p.width, p.height);
  return { width: even(p.width * k), height: even(p.height * k), fps };
}

/** Bits per pixel per frame for each quality (H.264). */
export const QUALITY_BPP: Record<ExportQuality, number> = { standard: 0.09, high: 0.16, best: 0.26 };

export const FORMATS = {
  vertical: { width: 1080, height: 1920, label: 'Vertical 9:16 (TikTok, Reels, Shorts)' },
  landscape: { width: 1920, height: 1080, label: 'Landscape 16:9 (YouTube)' },
  square: { width: 1080, height: 1080, label: 'Square 1:1' },
  portrait: { width: 1080, height: 1350, label: 'Portrait 4:5 (Instagram)' },
} as const;
export type FormatId = keyof typeof FORMATS;

/** Ready-made colour looks (a starting point; every value can be changed after). */
export const LOOKS = {
  natural: { exposure: 0.05, contrast: 0.1, saturation: 0.08, temperature: 0.03, vignette: 0 },
  warm: { exposure: 0.04, contrast: 0.12, saturation: 0.12, temperature: 0.35, vignette: 0.15 },
  cool: { exposure: 0.02, contrast: 0.14, saturation: -0.05, temperature: -0.3, vignette: 0.15 },
  punchy: { exposure: 0.06, contrast: 0.3, saturation: 0.3, temperature: 0.05, vignette: 0.1 },
  cinematic: { exposure: -0.04, contrast: 0.25, saturation: -0.15, temperature: 0.12, vignette: 0.4 },
  'black-white': { exposure: 0.02, contrast: 0.3, saturation: -1, temperature: 0, vignette: 0.2 },
} as const satisfies Record<string, ColorGrade>;
export type LookId = keyof typeof LOOKS;

/** The overlay track elements go on by default. */
export const GRAPHICS_TRACK = 'Graphics';

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
  z
    .object({
      op: z.literal('add_media'),
      assetId: AssetRef,
      track: TrackRef.optional(),
      /** A video track by name (made on top if there is none): e.g. B-roll. */
      trackName: z.string().trim().min(1).max(60).optional(),
      start: At.optional(),
      in: Sec.optional(),
      duration: z.number().min(0.04).optional(),
      fit: z.enum(['cover', 'contain']).optional(),
      transform: TransformPatch.optional(),
      zooms: z.array(Zoom).max(400).optional(),
      mask: Mask.optional(),
      frame: DeviceFrame.optional(),
      shadow: z.number().min(0).max(60).optional(),
      keys: Keys.optional(),
      enter: Entrance.optional(),
      exit: Entrance.optional(),
      loop: Loop.optional(),
    })
    .strict(),
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
      animSeconds: z.number().min(0).max(5).optional(),
      counter: Counter.optional(),
      keys: Keys.optional(),
      loop: Loop.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_audio'),
      assetId: AssetRef,
      track: TrackRef.optional(),
      /** An audio track by name (made if there is none): e.g. Music, Effects. */
      trackName: z.string().trim().min(1).max(60).optional(),
      start: At.optional(),
      in: Sec.optional(),
      duration: z.number().min(0.04).optional(),
      volume: z.number().min(0).max(4).optional(),
      duck: z.number().min(-40).max(0).nullable().optional(),
    })
    .strict(),
  z.object({ op: z.literal('move'), clip: ClipRef, start: Sec, track: TrackRef.optional() }).strict(),
  /** Trim a clip's start (keeps its end where it is) and/or its length. */
  z.object({ op: z.literal('trim'), clip: ClipRef, trimStart: z.number().min(-3600).max(3600).optional(), duration: z.number().min(0.04).optional() }).strict(),
  z.object({ op: z.literal('split'), clip: ClipRef, at: Sec }).strict(),
  /** A video's sound as its own clip on an audio track (the video itself goes quiet), to move or edit apart. */
  z.object({ op: z.literal('detach_audio'), clip: ClipRef }).strict(),
  /** Holds a video's frame at `at` for `duration` seconds; what comes after on its track moves later. */
  z.object({ op: z.literal('freeze'), clip: ClipRef, at: Sec, duration: z.number().min(0.1).max(60).default(2) }).strict(),
  /** A copy of a clip (default: right after it, on the same track). */
  z.object({ op: z.literal('duplicate'), clip: ClipRef, start: At.optional(), track: TrackRef.optional() }).strict(),
  /** Delete a clip; ripple: later clips on its track move left to close the gap. */
  z.object({ op: z.literal('delete'), clip: ClipRef, ripple: z.boolean().optional() }).strict(),
  /** Cut a time range out of the whole timeline (every track), closing the gap. */
  z.object({ op: z.literal('cut_range'), from: Sec, to: Sec }).strict(),
  /** Cut several time ranges out of the whole timeline at once (times as they are before any of them is cut). */
  z.object({ op: z.literal('cut_ranges'), ranges: z.array(z.object({ from: Sec, to: Sec }).strict()).min(1).max(5000) }).strict(),
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
      color: ColorGrade.partial().nullable().optional(),
      zooms: z.array(Zoom).max(400).nullable().optional(),
      voice: z.boolean().optional(),
      gate: z.number().min(-40).max(0).nullable().optional(),
      duck: z.number().min(-40).max(0).nullable().optional(),
      /** Keyframes per property (each list replaces that property's keyframes; null or [] removes them). */
      keys: z.partialRecord(z.enum(KEY_PROPS), z.array(Key).max(300).nullable()).optional(),
      enter: Entrance.nullable().optional(),
      exit: Entrance.nullable().optional(),
      loop: Loop.nullable().optional(),
      mask: Mask.nullable().optional(),
      frame: DeviceFrame.nullable().optional(),
      shadow: z.number().min(0).max(60).optional(),
      counter: Counter.nullable().optional(),
      shapeStyle: ShapeStyle.partial().optional(),
      shape: ShapeKind.optional(),
      transition: Transition.nullable().optional(),
      crop: Crop.partial().nullable().optional(),
      backdrop: z.enum(['blur']).nullable().optional(),
      chroma: Chroma.partial().nullable().optional(),
      /** Effects: each strength replaces that effect's (0 or null removes it); null removes them all. */
      effects: z.partialRecord(z.enum(['grain', 'vhs', 'glow', 'rgbSplit', 'lightLeak']), z.number().min(0).max(1).nullable()).nullable().optional(),
      /** A speed curve: points, a preset's name, or null for steady speed again. */
      speedCurve: z.union([z.array(SpeedPoint).min(2).max(16), z.enum(['montage', 'hero', 'bullet', 'flash-in', 'flash-out', 'jump-cut'])]).nullable().optional(),
    })
    .strict(),
  /** An element (shape) on an overlay track: by default the Graphics track, made above the videos when missing. */
  z
    .object({
      op: z.literal('add_shape'),
      shape: ShapeKind,
      start: Sec,
      duration: z.number().min(0.04).max(3600),
      track: TrackRef.optional(),
      trackName: z.string().trim().min(1).max(60).optional(),
      style: ShapeStyle.partial().optional(),
      transform: TransformPatch.optional(),
      keys: Keys.optional(),
      enter: Entrance.optional(),
      exit: Entrance.optional(),
      loop: Loop.optional(),
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
  z.object({ op: z.literal('set_project'), name: z.string().trim().min(1).max(120).optional(), width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(7680).optional(), fps: z.number().int().min(1).max(120).optional(), background: Hex.optional(), loudness: z.enum(['off', 'social']).optional() }).strict(),
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

/** A stretch of time (seconds). */
export interface Span {
  start: number;
  end: number;
}

/**
 * Where a source time of a clip's media lands on the timeline (null: that part of the source is
 * not in the clip).
 */
function sourceToTimeline(c: MediaClip | AudioClip, sourceSec: number): number | null {
  const rate = c.type === 'media' ? c.speed : 1;
  const t = c.start + (sourceSec - c.in) / rate;
  return t < c.start - 1e-6 || t > clipEnd(c) + 1e-6 ? null : t;
}

/** The clips that carry someone's voice: sound clips on tracks that are heard, not music (ducked). */
function voiceClips(p: Project): Array<{ clip: MediaClip | AudioClip; asset: Asset }> {
  const out: Array<{ clip: MediaClip | AudioClip; asset: Asset }> = [];
  for (const t of p.tracks) {
    if (t.muted) continue;
    for (const c of t.clips) {
      if (!isAV(c) || c.volume <= 0 || (c.type === 'audio' && c.duck !== null)) continue;
      const a = p.assets.find((x) => x.id === c.assetId);
      if (a && a.hasAudio && a.kind !== 'image') out.push({ clip: c, asset: a });
    }
  }
  return out;
}

/** Where people speak on the timeline (from the media's speech analysis), joined and sorted. */
export function timelineSpeech(p: Project): Span[] {
  const spans: Span[] = [];
  for (const { clip, asset } of voiceClips(p)) {
    if (!asset.speech) continue;
    const rate = clip.type === 'media' ? clip.speed : 1;
    const srcEnd = clip.in + clip.duration * rate;
    for (const s of asset.speech) {
      const a = Math.max(s.start, clip.in);
      const b = Math.min(s.end, srcEnd);
      if (b <= a) continue;
      spans.push({ start: clip.start + (a - clip.in) / rate, end: clip.start + (b - clip.in) / rate });
    }
  }
  return mergeRanges(spans.map((s) => ({ from: s.start, to: s.end }))).map((r) => ({ start: round(r.from), end: round(r.to) }));
}

/** Every transcribed word on the timeline, in order, with timeline times. */
export function timelineWords(p: Project): Array<{ text: string; start: number; end: number; exact: boolean }> {
  const out: Array<{ text: string; start: number; end: number; exact: boolean }> = [];
  for (const { clip, asset } of voiceClips(p)) {
    if (!asset.words) continue;
    for (const w of asset.words) {
      const a = sourceToTimeline(clip, w.start);
      const b = sourceToTimeline(clip, w.end);
      if (a === null || b === null) continue;
      out.push({ text: w.text, start: round(a), end: round(b), exact: !!asset.wordsExact });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Media with sound in the timeline that has no speech analysis (or transcript) yet. */
export function needsAnalysis(p: Project, what: 'speech' | 'words'): Asset[] {
  const ids = new Set(voiceClips(p).map((v) => v.asset.id));
  return p.assets.filter((a) => ids.has(a.id) && !a[what]);
}

/**
 * How loud a ducked clip is at t (1 = full): `db` quieter while someone speaks, easing down just
 * before and back up after, with short pauses bridged so the music does not pump.
 */
export function duckGain(speech: Span[], t: number, db: number): number {
  const low = Math.pow(10, db / 20);
  let g = 1;
  for (const s of speech) {
    if (t < s.start - 0.25) break;
    if (t <= s.end + 0.45) {
      const down = t < s.start ? (s.start - t) / 0.25 : 0;
      const up = t > s.end ? (t - s.end) / 0.45 : 0;
      g = Math.min(g, low + (1 - low) * Math.max(down, up));
    }
  }
  return g;
}

/** Where one clip's own sound has speech, on the timeline (from its media's speech analysis). */
export function clipSpeech(p: Project, clip: MediaClip | AudioClip): Span[] {
  const a = p.assets.find((x) => x.id === clip.assetId);
  if (!a?.speech) return [];
  const rate = clip.type === 'media' ? clip.speed : 1;
  const srcEnd = clip.in + clip.duration * rate;
  const out: Span[] = [];
  for (const s of a.speech) {
    const from = Math.max(s.start, clip.in);
    const to = Math.min(s.end, srcEnd);
    if (to > from) out.push({ start: clip.start + (from - clip.in) / rate, end: clip.start + (to - clip.in) / rate });
  }
  return out;
}

/**
 * How loud a gated clip is at t (1 = full): full while its speech goes on (opening just before a
 * sentence and closing a moment after it), `db` quieter in the gaps.
 */
export function gateGain(speech: Span[], t: number, db: number): number {
  const low = Math.pow(10, db / 20);
  let g = low;
  for (const s of speech) {
    if (t < s.start - 0.08) break;
    if (t <= s.end + 0.25) {
      const open = t < s.start ? 1 - (s.start - t) / 0.08 : t > s.end ? 1 - (t - s.end) / 0.25 : 1;
      g = Math.max(g, low + (1 - low) * open);
    }
  }
  return g;
}

/** Speech spans with pauses shorter than `gap` bridged (for ducking). */
export function bridged(speech: Span[], gap = 0.7): Span[] {
  const out: Span[] = [];
  for (const s of speech) {
    const last = out.at(-1);
    if (last && s.start - last.end < gap) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
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
 * A clip's own timed things (caption words, zoom keyframes) after its start moves `by` seconds
 * into it (split, trim, cut): earlier ones go (a keyframe still in effect stays, at 0); length limits
 * what is kept.
 */
function shiftInto(c: Clip, by: number, length: number): void {
  if (c.type !== 'audio' && c.keys) {
    // Each keyframed property: its value at the new start, then the keyframes after it.
    const keys: Keys = {};
    for (const k of KEY_PROPS) {
      const list = c.keys[k];
      if (!list?.length) continue;
      const later = list.filter((x) => x.at > by + 1e-6 && x.at <= by + length + 1e-6).map((x) => ({ ...x, at: round(x.at - by) }));
      const next = list.find((x) => x.at > by + length + 1e-6);
      keys[k] = [{ at: 0, value: round(keyValue(list, by)), ease: 'hold' as const }, ...later, ...(next ? [{ ...next, at: round(next.at - by) }] : [])];
    }
    c.keys = keys;
  }
  if (c.type === 'text' && c.words) {
    c.words = c.words.filter((w) => w.end > by + 1e-6 && w.start < by + length).map((w) => ({ ...w, start: round(Math.max(0, w.start - by)), end: round(Math.max(0, w.end - by)) }));
    if (!c.words.length) delete c.words;
  }
  if (c.type === 'media' && c.zooms?.length) {
    // Where the zoom is at the new start, then what comes after (a ramp still under way keeps its target).
    const now = zoomAt(c.zooms, by);
    const later = c.zooms.filter((z) => z.at > by + 1e-6);
    const inside = later.filter((z) => z.at <= by + length + 1e-6);
    const target = later.find((z) => z.at > by + length + 1e-6 && z.ease === 'ramp');
    const after = [...inside, ...(inside.length || !target ? [] : [target])].map((z) => ({ ...z, at: round(z.at - by) }));
    const moved = now.scale !== 1 || now.x !== 0.5 || now.y !== 0.5;
    c.zooms = moved || after[0]?.ease === 'ramp' ? [{ at: 0, scale: round(now.scale), x: round(now.x), y: round(now.y), ease: 'cut' as const }, ...after] : after;
    if (!c.zooms.length) delete c.zooms;
  }
}

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** Easing curves: progress 0..1 to 0..1 (back and elastic overshoot a little). */
export const EASES: Record<Ease, (p: number) => number> = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - Math.pow(1 - p, 3),
  'in-out': easeInOut,
  back: (p) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
  },
  elastic: (p) => (p === 0 || p === 1 ? p : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounce: (x) => {
    const n = 7.5625;
    const d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) {
      const y = x - 1.5 / d;
      return n * y * y + 0.75;
    }
    if (x < 2.5 / d) {
      const y = x - 2.25 / d;
      return n * y * y + 0.9375;
    }
    const y = x - 2.625 / d;
    return n * y * y + 0.984375;
  },
  hold: (p) => (p >= 1 ? 1 : 0),
};

/** A keyframed value at rt seconds into the clip (before the first keyframe: its value). */
export function keyValue(keys: Key[], rt: number): number {
  if (!keys.length) return 0;
  if (rt <= keys[0]!.at) return keys[0]!.value;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (rt < b.at) {
      const a = keys[i - 1]!;
      const p = (rt - a.at) / Math.max(1e-6, b.at - a.at);
      return a.value + (b.value - a.value) * EASES[b.ease](Math.min(1, Math.max(0, p)));
    }
  }
  return keys.at(-1)!.value;
}
/** Seconds a smooth zoom takes to reach its keyframe. */
const ZOOM_EASE = 0.45;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A clip's zoom (scale and its centre) at rt seconds into the clip. */
export function zoomAt(zooms: Zoom[] | undefined, rt: number): { scale: number; x: number; y: number } {
  const none = { scale: 1, x: 0.5, y: 0.5 };
  if (!zooms?.length) return none;
  let i = -1;
  for (let k = 0; k < zooms.length; k++) if (zooms[k]!.at <= rt + 1e-6) i = k;
  const next = zooms[i + 1];
  if (next?.ease === 'ramp') {
    // Moving steadily towards the next keyframe.
    const from = i >= 0 ? zooms[i]! : { ...none, at: 0 };
    const p = easeInOut(clamp01((rt - from.at) / Math.max(0.01, next.at - from.at)));
    return { scale: from.scale + (next.scale - from.scale) * p, x: from.x + (next.x - from.x) * p, y: from.y + (next.y - from.y) * p };
  }
  if (i < 0) return none;
  const z = zooms[i]!;
  const prev = i > 0 ? zooms[i - 1]! : none;
  if (z.ease !== 'smooth') return { scale: z.scale, x: z.x, y: z.y };
  const p = easeInOut(clamp01((rt - z.at) / ZOOM_EASE));
  return { scale: prev.scale + (z.scale - prev.scale) * p, x: prev.x + (z.x - prev.x) * p, y: prev.y + (z.y - prev.y) * p };
}

/** Keyframe lists sorted by time. */
function sortKeys(keys: Keys): Keys {
  const out: Keys = {};
  for (const k of KEY_PROPS) if (keys[k]?.length) out[k] = [...keys[k]!].sort((a, b) => a.at - b.at).map((x) => ({ ...x, at: round(x.at) }));
  return out;
}

/** Overlapping or touching ranges joined, sorted. */
export function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1e-6) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

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
  /** A new track on top of the others. */
  const addTrack = (kind: TrackKind, name: string): Track => {
    const t: Track = { id: rid('tr', rand), kind, name, hidden: false, muted: false, clips: [] };
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
    if (!isAV(c)) return Infinity;
    const a = asset(c.assetId);
    if (a.kind === 'image') return Infinity;
    if (c.type === 'media' && c.speedCurve) return (a.duration - c.in) / Math.max(0.1, curveArea(c.speedCurve, 0, 1));
    return (a.duration - c.in) / (c.type === 'media' ? c.speed : 1);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add_media': {
        const a = asset(op.assetId);
        if (a.kind === 'audio') throw new EditError(`${a.name} is audio: use add_audio.`);
        let t = op.trackName && !op.track ? p.tracks.find((x) => x.kind === 'video' && x.name === op.trackName) : undefined;
        if (!t && op.trackName && !op.track) {
          t = { id: rid('tr', rand), kind: 'video', name: op.trackName, hidden: false, muted: false, clips: [] };
          // Above the other videos, below text and captions.
          const firstText = p.tracks.findIndex((x) => x.kind === 'text');
          p.tracks.splice(firstText < 0 ? p.tracks.length : firstText, 0, t);
        }
        t ??= track(op.track, 'video');
        const start = op.start === undefined || op.start === 'end' ? endOf(t) : op.start;
        const inn = a.kind === 'image' ? 0 : Math.min(op.in ?? 0, Math.max(0, a.duration - 0.04));
        const max = a.kind === 'image' ? Infinity : a.duration - inn;
        const duration = round(Math.min(op.duration ?? (a.kind === 'image' ? 3 : max), max));
        if (duration < 0.04) throw new EditError(`${a.name} has nothing left after ${inn}s.`);
        const c = MediaClip.parse({ id: rid('cl', rand), type: 'media', assetId: a.id, start: round(start), duration, in: round(inn), ...(op.fit ? { fit: op.fit } : {}), transform: op.transform ?? {}, ...(op.zooms?.length ? { zooms: [...op.zooms].sort((x, y) => x.at - y.at) } : {}),
          ...(op.mask ? { mask: op.mask } : {}),
          ...(op.frame ? { frame: op.frame } : {}),
          ...(op.shadow !== undefined ? { shadow: op.shadow } : {}),
          ...(op.keys ? { keys: sortKeys(op.keys) } : {}),
          ...(op.enter ? { enter: op.enter } : {}),
          ...(op.exit ? { exit: op.exit } : {}),
          ...(op.loop ? { loop: op.loop } : {}),
        });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added ${a.name} at ${round(start)}s for ${duration}s (${c.id}).`);
        break;
      }
      case 'add_text': {
        // Text goes on the Text track by default (not Graphics or Captions).
        const t = op.track ? track(op.track, 'text') : (p.tracks.find((x) => x.kind === 'text' && x.name === 'Text') ?? p.tracks.find((x) => x.kind === 'text' && x.name !== GRAPHICS_TRACK && x.name !== CAPTIONS_TRACK) ?? addTrack('text', 'Text'));
        const c = TextClip.parse({
          id: rid('cl', rand),
          type: 'text',
          start: round(op.start),
          duration: round(op.duration),
          text: op.text,
          style: op.style ?? {},
          transform: op.transform ?? {},
          ...(op.animIn ? { animIn: op.animIn } : {}),
          ...(op.animOut ? { animOut: op.animOut } : {}),
          ...(op.animSeconds !== undefined ? { animSeconds: op.animSeconds } : {}),
          ...(op.counter ? { counter: op.counter } : {}),
          ...(op.keys ? { keys: sortKeys(op.keys) } : {}),
          ...(op.loop ? { loop: op.loop } : {}),
        });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added text “${op.text.slice(0, 40)}” at ${c.start}s (${c.id}).`);
        break;
      }
      case 'add_audio': {
        const a = asset(op.assetId);
        if (a.kind === 'image') throw new EditError(`${a.name} is a picture, not sound.`);
        if (!a.hasAudio) throw new EditError(`${a.name} has no sound.`);
        let t = op.trackName && !op.track ? p.tracks.find((x) => x.kind === 'audio' && x.name === op.trackName) : undefined;
        if (!t && op.trackName && !op.track) {
          t = { id: rid('tr', rand), kind: 'audio', name: op.trackName, hidden: false, muted: false, clips: [] };
          p.tracks.push(t);
        }
        t ??= track(op.track, 'audio');
        const start = op.start === undefined || op.start === 'end' ? endOf(t) : op.start;
        const inn = Math.min(op.in ?? 0, Math.max(0, a.duration - 0.04));
        const duration = round(Math.min(op.duration ?? a.duration - inn, a.duration - inn));
        const c = AudioClip.parse({ id: rid('cl', rand), type: 'audio', assetId: a.id, start: round(start), duration, in: round(inn), ...(op.volume !== undefined ? { volume: op.volume } : {}), ...(op.duck !== undefined ? { duck: op.duck } : {}) });
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
          if (isAV(c)) {
            const nextIn = c.in + (c.type === 'media' ? sourceSpan(c, d) : d);
            if (nextIn < -1e-6) throw new EditError(`${c.id} cannot start earlier than its source does.`);
            c.in = round(Math.max(0, nextIn));
            if (c.type === 'media' && c.speedCurve) {
              if (d < 0) throw new EditError('Remove the speed curve before making this clip start earlier.');
              c.speedCurve = subCurve(c.speedCurve, d / c.duration, 1);
            }
          }
          c.start = round(c.start + d);
          c.duration = round(c.duration - d);
          if (d > 0) shiftInto(c, d, c.duration);
        }
        if (op.duration !== undefined) {
          const max = sourceLeft(c);
          if (op.duration > max + 1e-6) throw new EditError(`${c.id} is only ${round(max)}s long from where it starts.`);
          // Shorter: the curve ends where the clip now ends. Longer: the curve stretches.
          if (c.type === 'media' && c.speedCurve && op.duration < c.duration) c.speedCurve = subCurve(c.speedCurve, 0, op.duration / c.duration);
          c.duration = round(op.duration);
        }
        sortClips(f.track);
        changes.push(`Trimmed ${c.id}: ${c.start}s for ${c.duration}s.`);
        break;
      }
      case 'detach_audio': {
        const f = get(op.clip);
        const c = f.clip;
        if (c.type !== 'media') throw new EditError(`${c.id} is not a video.`);
        const a = asset(c.assetId);
        if (!a.hasAudio || a.kind !== 'video') throw new EditError(`${a.name} has no sound to detach.`);
        if (c.speed !== 1 || c.speedCurve) throw new EditError('Detach the sound before changing the speed (set the speed back to 1× with no speed curve).');
        if (c.volume === 0) throw new EditError(`The sound of ${c.id} is already off or detached.`);
        let t = p.tracks.find((x) => x.kind === 'audio' && x.name === 'Detached audio');
        if (!t) {
          t = { id: rid('tr', rand), kind: 'audio', name: 'Detached audio', hidden: false, muted: false, clips: [] };
          p.tracks.push(t);
        }
        const s = AudioClip.parse({ id: rid('cl', rand), type: 'audio', assetId: a.id, start: c.start, duration: c.duration, in: c.in, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, voice: c.voice });
        t.clips.push(s);
        sortClips(t);
        c.volume = 0;
        changes.push(`Detached the sound of ${c.id} (${s.id}).`);
        break;
      }
      case 'freeze': {
        const f = get(op.clip);
        const c = f.clip;
        if (c.type !== 'media' || asset(c.assetId).kind !== 'video') throw new EditError(`${c.id} is not a video.`);
        if (op.at < c.start - 1e-6 || op.at > clipEnd(c) + 1e-6) throw new EditError(`${op.at}s is not inside ${c.id}.`);
        if (c.speedCurve) throw new EditError('Remove the speed curve before freezing a frame of this clip.');
        const d = round(op.duration);
        const at = round(op.at);
        const frameAt = round(c.in + (at - c.start) * c.speed);
        // Everything on this track after the frame moves later to make room.
        for (const o of f.track.clips) if (o.id !== c.id && o.start >= at - 1e-6) o.start = round(o.start + d);
        let after: Clip | null = null;
        if (at > c.start + 0.04 && at < clipEnd(c) - 0.04) {
          after = structuredClone(c);
          after.id = rid('cl', rand);
          after.start = round(at + d);
          after.duration = round(clipEnd(c) - at);
          (after as MediaClip).in = frameAt;
          (after as MediaClip).fadeIn = 0;
          shiftInto(after, at - c.start, after.duration);
          c.duration = round(at - c.start);
          c.fadeOut = 0;
        } else if (at <= c.start + 0.04) c.start = round(c.start + d);
        const still = MediaClip.parse({ ...structuredClone(c), id: rid('cl', rand), start: at, duration: d, in: frameAt, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, freeze: true, zooms: undefined, keys: undefined, enter: undefined, exit: undefined });
        f.track.clips.push(still, ...(after ? [after] : []));
        sortClips(f.track);
        changes.push(`Froze the frame at ${at}s for ${d}s (${still.id}).`);
        break;
      }
      case 'duplicate': {
        const f = get(op.clip);
        const to = op.track ? track(op.track, f.track.kind) : f.track;
        const copy = structuredClone(f.clip);
        copy.id = rid('cl', rand);
        copy.start = round(op.start === undefined || op.start === 'end' ? (op.start === 'end' ? endOf(to) : clipEnd(f.clip)) : op.start);
        to.clips.push(copy);
        sortClips(to);
        changes.push(`Copied ${f.clip.id} to ${copy.start}s (${copy.id}).`);
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
        if (isAV(second)) second.in = round(second.in + (c.type === 'media' ? sourceSpan(c, first) : first));
        if (c.type === 'media' && c.speedCurve && second.type === 'media') {
          second.speedCurve = subCurve(c.speedCurve, first / c.duration, 1);
          c.speedCurve = subCurve(c.speedCurve, 0, first / c.duration);
        }
        if (isAV(second)) second.fadeIn = 0;
        if (isAV(c)) c.fadeOut = 0;
        c.duration = first;
        shiftInto(second, first, second.duration);
        if (second.type === 'media') delete second.transition;
        shiftInto(c, 0, first);
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
        cut(op.from, op.to);
        changes.push(`Cut ${round(op.to - op.from)}s out (${round(op.from)}s–${round(op.to)}s).`);
        break;
      }
      case 'cut_ranges': {
        const ranges = mergeRanges(op.ranges).filter((r) => r.to - r.from >= 0.02);
        if (!ranges.length) throw new EditError('There is nothing to cut in those ranges.');
        // From the last to the first, so the earlier times stay where they were.
        for (const r of [...ranges].reverse()) cut(r.from, r.to);
        const total = ranges.reduce((t, r) => t + r.to - r.from, 0);
        changes.push(`Cut ${ranges.length} part${ranges.length === 1 ? '' : 's'} out (${round(total)}s in all).`);
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
          only('volume', isAV(c));
          (c as MediaClip | AudioClip).volume = op.volume;
        }
        if (op.speed !== undefined) {
          only('speed', c.type === 'media');
          const m = c as MediaClip;
          const a = asset(m.assetId);
          // The clip keeps the same part of its source: its length changes with the speed.
          const sourceSeconds = sourceSpan(m, m.duration);
          m.speed = op.speed;
          delete m.speedCurve;
          m.duration = round(a.kind === 'image' ? m.duration : Math.max(0.04, sourceSeconds / op.speed));
        }
        if (op.chroma !== undefined) {
          only('green screen (videos and pictures)', c.type === 'media');
          const m = c as MediaClip;
          if (op.chroma === null) delete m.chroma;
          else m.chroma = Chroma.parse({ ...(m.chroma ?? {}), ...op.chroma });
        }
        if (op.backdrop !== undefined) {
          only('backdrop (videos and pictures)', c.type === 'media');
          const m = c as MediaClip;
          if (op.backdrop === null) delete m.backdrop;
          else m.backdrop = op.backdrop;
        }
        if (op.effects !== undefined) {
          only('effects (videos and pictures)', c.type === 'media');
          const m = c as MediaClip;
          const next: Record<string, number> = op.effects === null ? {} : { ...(m.effects ?? {}) };
          if (op.effects) for (const [k, v] of Object.entries(op.effects)) if (v) next[k] = v;
          else delete next[k];
          if (Object.keys(next).length) m.effects = Effects.parse(next);
          else delete m.effects;
        }
        if (op.speedCurve !== undefined) {
          only('speed curve', c.type === 'media');
          const m = c as MediaClip;
          if (asset(m.assetId).kind !== 'video') throw new EditError('Speed curves are for videos.');
          const sourceSeconds = sourceSpan(m, m.duration);
          if (op.speedCurve === null) {
            delete m.speedCurve;
            m.speed = 1;
            m.duration = round(Math.max(0.04, sourceSeconds));
          } else {
            const pts = (typeof op.speedCurve === 'string' ? SPEED_PRESETS[op.speedCurve] : [...op.speedCurve]).sort((p1, p2) => p1.x - p2.x);
            if (pts[0]!.x !== 0 || pts.at(-1)!.x !== 1) throw new EditError('A speed curve starts at x 0 and ends at x 1.');
            m.speedCurve = pts.map((p) => ({ ...p }));
            m.speed = 1;
            // The same part of the source, now on the curve.
            m.duration = round(Math.max(0.04, sourceSeconds / curveArea(pts, 0, 1)));
          }
        }
        for (const k of ['fadeIn', 'fadeOut'] as const)
          if (op[k] !== undefined) {
            only('fades', isAV(c));
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
        if (op.color !== undefined) {
          only('colour', c.type === 'media');
          const m = c as MediaClip;
          if (op.color === null) delete m.color;
          else m.color = ColorGrade.parse({ ...(m.color ?? {}), ...op.color });
        }
        if (op.zooms !== undefined) {
          only('zooms', c.type === 'media');
          const m = c as MediaClip;
          if (!op.zooms?.length) delete m.zooms;
          else m.zooms = [...op.zooms].filter((z) => z.at <= m.duration + 1e-6).sort((a, b) => a.at - b.at).map((z) => ({ ...z, at: round(z.at) }));
        }
        if (op.voice !== undefined) {
          only('sound', isAV(c));
          (c as MediaClip | AudioClip).voice = op.voice;
        }
        if (op.gate !== undefined) {
          only('noise gate', isAV(c));
          const v = c as MediaClip | AudioClip;
          if (op.gate === null) delete v.gate;
          else v.gate = op.gate;
        }
        if (op.duck !== undefined) {
          only('music ducking (only sound clips on an audio track)', c.type === 'audio');
          (c as AudioClip).duck = op.duck;
        }
        if (op.keys) {
          only('keyframes', c.type !== 'audio');
          const v = c as MediaClip | TextClip | ShapeClip;
          const keys: Keys = { ...(v.keys ?? {}) };
          for (const [k, list] of Object.entries(op.keys) as Array<[KeyProp, Key[] | null]>) {
            if (!list?.length) delete keys[k];
            else keys[k] = [...list].sort((a, b) => a.at - b.at).map((x) => ({ ...x, at: round(x.at) }));
          }
          if (Object.keys(keys).length) v.keys = keys;
          else delete v.keys;
        }
        for (const k of ['enter', 'exit'] as const)
          if (op[k] !== undefined) {
            only(k === 'enter' ? 'entrance (use animIn for text)' : 'exit (use animOut for text)', c.type === 'media' || c.type === 'shape');
            const v = c as MediaClip | ShapeClip;
            if (op[k] === null) delete v[k];
            else v[k] = op[k]!;
          }
        if (op.loop !== undefined) {
          only('loop', c.type !== 'audio');
          const v = c as MediaClip | TextClip | ShapeClip;
          if (op.loop === null) delete v.loop;
          else v.loop = op.loop;
        }
        for (const k of ['mask', 'frame'] as const)
          if (op[k] !== undefined) {
            only(k === 'mask' ? 'mask' : 'device frame', c.type === 'media');
            const m = c as MediaClip;
            if (op[k] === null) delete m[k];
            else (m[k] as unknown) = op[k];
          }
        if (op.shadow !== undefined) {
          only('shadow (for shapes use shapeStyle.shadow, for text style.shadow)', c.type === 'media');
          (c as MediaClip).shadow = op.shadow;
        }
        if (op.counter !== undefined) {
          only('counter', c.type === 'text');
          const tc = c as TextClip;
          if (op.counter === null) delete tc.counter;
          else tc.counter = op.counter;
        }
        if (op.crop !== undefined) {
          only('crop (videos and pictures)', c.type === 'media');
          const m = c as MediaClip;
          const next = op.crop === null ? null : Crop.parse({ ...(m.crop ?? {}), ...op.crop });
          if (!next || (!next.left && !next.top && !next.right && !next.bottom)) delete m.crop;
          else m.crop = next;
        }
        if (op.transition !== undefined) {
          only('transition (videos and pictures)', c.type === 'media');
          const m = c as MediaClip;
          if (op.transition === null) delete m.transition;
          else m.transition = op.transition;
        }
        if (op.shapeStyle || op.shape) {
          only('shape', c.type === 'shape');
          const sc = c as ShapeClip;
          if (op.shape) sc.shape = op.shape;
          if (op.shapeStyle) sc.style = ShapeStyle.parse({ ...sc.style, ...op.shapeStyle });
        }
        sortClips(f.track);
        changes.push(`Changed ${c.id}.`);
        break;
      }
      case 'add_shape': {
        let t = op.trackName && !op.track ? p.tracks.find((x) => x.kind === 'text' && x.name === op.trackName) : op.track ? track(op.track, 'text') : p.tracks.find((x) => x.kind === 'text' && x.name === GRAPHICS_TRACK);
        if (!t) {
          // Graphics sit above the videos, under text and captions.
          t = { id: rid('tr', rand), kind: 'text', name: op.trackName ?? GRAPHICS_TRACK, hidden: false, muted: false, clips: [] };
          const firstText = p.tracks.findIndex((x) => x.kind === 'text');
          p.tracks.splice(firstText < 0 ? p.tracks.length : firstText, 0, t);
        }
        const c = ShapeClip.parse({
          id: rid('cl', rand),
          type: 'shape',
          start: round(op.start),
          duration: round(op.duration),
          shape: op.shape,
          style: op.style ?? {},
          transform: op.transform ?? {},
          ...(op.keys ? { keys: sortKeys(op.keys) } : {}),
          ...(op.enter ? { enter: op.enter } : {}),
          ...(op.exit ? { exit: op.exit } : {}),
          ...(op.loop ? { loop: op.loop } : {}),
        });
        t.clips.push(c);
        sortClips(t);
        changes.push(`Added a ${op.shape} at ${c.start}s on ${t.name} (${c.id}).`);
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
              ...(l.words?.length ? { words: l.words.map((w) => ({ text: w.text, start: round(Math.max(0, w.start - start)), end: round(Math.max(0, Math.max(w.start, w.end) - start)) })) } : {}),
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
        if (op.loudness) p.loudness = op.loudness;
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

  /** Removes from..to from every track and closes the gap. */
  function cut(from: number, to: number): void {
    const len = to - from;
    const op = { from, to };
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
            if (c.type === 'media' && c.speedCurve && a.type === 'media') a.speedCurve = subCurve(c.speedCurve, 0, before / c.duration);
            a.duration = round(before);
            if (isAV(a)) a.fadeOut = 0;
            shiftInto(a, 0, a.duration);
            out.push(a);
          }
          if (after >= 0.04) {
            const b = structuredClone(c);
            b.id = before >= 0.04 ? rid('cl', rand) : c.id;
            const skipped = op.to - c.start;
            b.start = round(op.from);
            b.duration = round(after);
            if (isAV(b)) {
              b.in = round(b.in + (c.type === 'media' ? sourceSpan(c, skipped) : skipped));
              b.fadeIn = 0;
              if (c.type === 'media' && c.speedCurve && b.type === 'media') b.speedCurve = subCurve(c.speedCurve, skipped / c.duration, 1);
            }
            shiftInto(b, skipped, b.duration);
            if (b.type === 'media' && before >= 0.04) delete b.transition;
            out.push(b);
          }
        }
      }
      t.clips = out;
      sortClips(t);
    }
  }
}

/** Motion and look of a layer, briefly (for describeProject). */
function motionNote(c: MediaClip | TextClip | ShapeClip): string {
  const parts: string[] = [];
  if (c.type !== 'text' && c.enter) parts.push(`in ${c.enter.kind}`);
  if (c.type !== 'text' && c.exit) parts.push(`out ${c.exit.kind}`);
  if (c.loop) parts.push(`loop ${c.loop.kind}`);
  const keyed = c.keys ? KEY_PROPS.filter((k) => c.keys?.[k]?.length) : [];
  if (keyed.length) parts.push(`keyframes ${keyed.join('/')}`);
  if (c.type === 'media' && c.mask) parts.push(`${c.mask.shape} mask`);
  if (c.type === 'media' && c.frame) parts.push(`in a ${c.frame}`);
  if (c.type === 'media' && c.transition) parts.push(`${c.transition.kind} transition in`);
  if (c.type === 'media' && c.crop) parts.push('cropped');
  if (c.type === 'media' && c.freeze) parts.push('freeze frame');
  return parts.length ? ` [${parts.join(', ')}]` : '';
}

/** A short text view of the timeline, for Keo to read. */
export function describeProject(p: Project): string {
  const lines = [`${p.name}: ${p.width}x${p.height}, ${p.fps} fps, ${projectDuration(p)}s.`, `Media: ${p.assets.map((a) => `${a.id} ${a.name} (${a.kind}${a.kind !== 'image' ? `, ${round(a.duration)}s` : ''}${a.hasAudio ? ', sound' : ''})`).join('; ') || 'none'}.`];
  p.tracks.forEach((t, i) => {
    lines.push(`Track ${i + 1} ${t.id} ${t.kind} “${t.name}”${t.hidden ? ' (hidden)' : ''}${t.muted ? ' (muted)' : ''}:`);
    for (const c of t.clips) {
      const span = `${round(c.start)}–${round(clipEnd(c))}s`;
      if (c.type === 'text') lines.push(`  ${c.id} ${span} text “${c.text.slice(0, 60)}”${c.words ? ` (${c.words.length} timed words)` : ''}${c.counter ? ` counter ${c.counter.from}→${c.counter.to}` : ''}${motionNote(c)}`);
      else if (c.type === 'shape') lines.push(`  ${c.id} ${span} ${c.shape} ${round(c.style.width)}x${round(c.style.height)} at ${round(c.transform.x)},${round(c.transform.y)}${c.style.fill ? ` ${c.style.fill}` : ''}${motionNote(c)}`);
      else {
        const a = p.assets.find((x) => x.id === c.assetId);
        lines.push(`  ${c.id} ${span} ${c.type === 'media' ? 'clip' : 'sound'} ${a?.name ?? c.assetId} from ${round(c.in)}s${c.type === 'media' && c.speed !== 1 ? ` at ${c.speed}x` : ''}${c.volume !== 1 ? ` volume ${c.volume}` : ''}${c.type === 'media' ? motionNote(c) : ''}`);
      }
    }
  });
  return lines.join('\n');
}

/**
 * The transition under way on a track at t: the clip going out, the clip coming in, and how far
 * along it is (0..1). Both clips show for the transition's length, centred on the cut.
 */
export function trackTransition(tr: Track, t: number): { out: MediaClip; in: MediaClip; p: number; kind: Transition['kind'] } | null {
  for (const c of tr.clips) {
    if (c.type !== 'media' || !c.transition) continue;
    const prev = tr.clips.find((o) => o.type === 'media' && o.id !== c.id && Math.abs(o.start + o.duration - c.start) < 0.05) as MediaClip | undefined;
    if (!prev) continue;
    const d = Math.min(c.transition.seconds, prev.duration, c.duration);
    const from = c.start - d / 2;
    if (t >= from && t < from + d) return { out: prev, in: c, p: (t - from) / d, kind: c.transition.kind };
  }
  return null;
}
