import { z } from 'zod';

/**
 * Keo's own motion graphics: instead of only picking from ready-made pieces, Keo designs a graphic
 * as layers — text that builds itself line by line, word by word or letter by letter, shapes and SVG
 * paths that draw themselves on, particles and gradients — each with its own keyframes, easing and
 * loop. It is data (never code), drawn frame by frame by Studio's engine, so the preview, the export
 * and the frames Keo looks at match. Positions are fractions of the frame (0..1, centre 0.5);
 * sizes are in U, 1% of the frame's shorter side. Times are seconds into the clip; a negative time
 * counts back from its end (-0.5 = half a second before it ends), so a design fits any length.
 */
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
export const DesignEase = z.enum(['linear', 'in', 'out', 'in-out', 'back', 'elastic', 'bounce', 'expo', 'snap', 'hold']);
export type DesignEase = z.infer<typeof DesignEase>;
const Time = z.number().min(-600).max(600);

/** A moment of a layer: the values it has reached at time t (the ones left out keep moving between their own keys). */
export const DesignKey = z
  .object({
    t: Time,
    x: z.number().min(-2).max(3).optional(),
    y: z.number().min(-2).max(3).optional(),
    scale: z.number().min(0).max(40).optional(),
    scaleX: z.number().min(-40).max(40).optional(),
    scaleY: z.number().min(-40).max(40).optional(),
    rotation: z.number().min(-7200).max(7200).optional(),
    opacity: z.number().min(0).max(1).optional(),
    blur: z.number().min(0).max(80).optional(),
    /** Outlines and paths drawing themselves on (0..1). */
    draw: z.number().min(0).max(1).optional(),
    /** How the layer is cut: 0 = hidden, 1 = whole, revealed from `wipe` direction. */
    wipe: z.number().min(0).max(1).optional(),
    skewX: z.number().min(-80).max(80).optional(),
    /** Easing into this key from the one before. */
    ease: DesignEase.default('out'),
  })
  .strict();
export type DesignKey = z.infer<typeof DesignKey>;

const Loop = z
  .object({
    kind: z.enum(['none', 'float', 'pulse', 'spin', 'wiggle', 'flicker', 'sway']),
    /** How much (float/wiggle: U, pulse: scale fraction, spin: turns per second, sway: degrees). */
    amount: z.number().min(0).max(50).default(1),
    speed: z.number().min(0).max(20).default(1),
  })
  .strict();

const Common = {
  /** Where its centre is (fractions of the frame). */
  x: z.number().min(-2).max(3).default(0.5),
  y: z.number().min(-2).max(3).default(0.5),
  scale: z.number().min(0).max(40).default(1),
  rotation: z.number().min(-7200).max(7200).default(0),
  opacity: z.number().min(0).max(1).default(1),
  blend: z.enum(['normal', 'screen', 'multiply', 'overlay', 'lighten', 'difference', 'add']).default('normal'),
  /** Which side a wipe reveals from. */
  wipeFrom: z.enum(['left', 'right', 'top', 'bottom', 'center']).default('left'),
  keys: z.array(DesignKey).max(24).default([]),
  loop: Loop.optional(),
  /** Seen only between these times (seconds into the clip, negative from the end). */
  from: Time.optional(),
  until: Time.optional(),
};

export const DesignText = z
  .object({
    kind: z.literal('text'),
    text: z.string().min(1).max(300),
    font: z.string().min(1).max(60).default('Inter'),
    /** Letter height in U. */
    size: z.number().min(0.5).max(120).default(10),
    weight: z.number().int().min(100).max(900).default(700),
    italic: z.boolean().default(false),
    uppercase: z.boolean().default(false),
    color: Hex.default('#FFFFFF'),
    /** A second colour: a gradient across the text. */
    color2: Hex.optional(),
    /** Letter spacing in em (-0.2..1). */
    tracking: z.number().min(-0.3).max(2).default(0),
    lineHeight: z.number().min(0.6).max(3).default(1.05),
    align: z.enum(['left', 'center', 'right']).default('center'),
    /** Wrap width as a fraction of the frame's width. */
    maxWidth: z.number().min(0.05).max(2).default(0.86),
    stroke: Hex.optional(),
    strokeWidth: z.number().min(0).max(20).default(0),
    /** Outline only (hollow letters). */
    hollow: z.boolean().default(false),
    glow: z.number().min(0).max(80).default(0),
    glowColor: Hex.optional(),
    shadow: z.number().min(0).max(60).default(0),
    /** Builds itself piece by piece: none, lines, words or chars. */
    split: z.enum(['none', 'lines', 'words', 'chars']).default('none'),
    /** When the build starts (s), how far apart the pieces start, how long each takes, and in what order. */
    revealAt: Time.default(0),
    stagger: z.number().min(0).max(3).default(0.06),
    revealFor: z.number().min(0.05).max(6).default(0.6),
    order: z.enum(['start', 'end', 'center', 'random']).default('start'),
    revealEase: DesignEase.default('expo'),
    /** Where each piece comes from while it builds: offsets in U and degrees, scale, blur. */
    enter: z
      .object({ x: z.number().min(-200).max(200).default(0), y: z.number().min(-200).max(200).default(6), scale: z.number().min(0).max(10).default(1), rotation: z.number().min(-720).max(720).default(0), blur: z.number().min(0).max(60).default(0), opacity: z.number().min(0).max(1).default(0) })
      .strict()
      .prefault({}),
    /** The pieces leave the same way (reversed) from this time (negative: from the end). */
    leaveAt: Time.optional(),
    ...Common,
  })
  .strict();

export const DesignShape = z
  .object({
    kind: z.literal('shape'),
    shape: z.enum(['rect', 'circle', 'ring', 'line', 'path', 'polygon', 'star']),
    /** Size in U. */
    w: z.number().min(0).max(400).default(20),
    h: z.number().min(0).max(400).default(20),
    /** Rect corner radius in U. */
    radius: z.number().min(0).max(200).default(0),
    /** SVG path data in a 100×100 box (shape "path"), stretched to w×h. */
    path: z.string().max(4000).optional(),
    sides: z.number().int().min(3).max(24).default(6),
    fill: Hex.nullable().default('#FFFFFF'),
    fill2: Hex.optional(),
    /** Gradient angle in degrees (fill → fill2); radial when "radial" is true. */
    angle: z.number().min(-360).max(360).default(90),
    radial: z.boolean().default(false),
    stroke: Hex.optional(),
    /** Outline width in U. */
    strokeWidth: z.number().min(0).max(40).default(0),
    /** A dashed outline (dash and gap in U). */
    dash: z.array(z.number().min(0).max(100)).max(2).optional(),
    glow: z.number().min(0).max(80).default(0),
    glowColor: Hex.optional(),
    /** Starts drawn at this much (0..1): keys with draw animate it. */
    draw: z.number().min(0).max(1).default(1),
    ...Common,
  })
  .strict();

export const DesignParticles = z
  .object({
    kind: z.literal('particles'),
    count: z.number().int().min(1).max(300).default(40),
    particle: z.enum(['dot', 'square', 'star', 'line', 'ring', 'spark']).default('dot'),
    /** Size of each in U (randomised between size×0.4 and size). */
    size: z.number().min(0.05).max(30).default(1),
    colors: z.array(Hex).min(1).max(6).default(['#FFFFFF']),
    /** The area they live in, in U around the layer's centre. */
    spreadX: z.number().min(0).max(300).default(60),
    spreadY: z.number().min(0).max(300).default(40),
    motion: z.enum(['float', 'rise', 'fall', 'burst', 'orbit', 'twinkle', 'drift']).default('float'),
    speed: z.number().min(0).max(20).default(1),
    seed: z.number().int().min(0).max(1e6).default(7),
    ...Common,
  })
  .strict();

export const DesignGradient = z
  .object({
    kind: z.literal('gradient'),
    /** A full-frame colour field: 1–5 colours, linear at `angle` or radial from the layer's x, y. */
    colors: z.array(Hex).min(1).max(5),
    angle: z.number().min(-360).max(360).default(135),
    radial: z.boolean().default(false),
    /** The colours drift slowly (0 = still). */
    drift: z.number().min(0).max(5).default(0),
    ...Common,
  })
  .strict();

export const DesignLayer = z.discriminatedUnion('kind', [DesignText, DesignShape, DesignParticles, DesignGradient]);
export type DesignLayer = z.infer<typeof DesignLayer>;
export type DesignTextLayer = z.infer<typeof DesignText>;
export type DesignShapeLayer = z.infer<typeof DesignShape>;
export type DesignParticlesLayer = z.infer<typeof DesignParticles>;
export type DesignGradientLayer = z.infer<typeof DesignGradient>;

export const Design = z
  .object({
    /** Bottom first. */
    layers: z.array(DesignLayer).min(1).max(40),
    /** A full-frame background colour under the layers (the video is hidden), or none (laid over the video). */
    background: Hex.optional(),
  })
  .strict();
export type Design = z.infer<typeof Design>;

/** A time in a design (negative = from the end) as seconds into the clip. */
export function designTime(t: number, duration: number): number {
  return t < 0 ? Math.max(0, duration + t) : t;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const DESIGN_EASES: Record<DesignEase, (p: number) => number> = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - Math.pow(1 - p, 3),
  'in-out': (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  back: (p) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
  },
  elastic: (p) => (p === 0 || p === 1 ? p : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounce: (x) => {
    const n = 7.5625;
    const d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x - 1.5 / d) * (x - 1.5 / d) + 0.75;
    if (x < 2.5 / d) return n * (x - 2.25 / d) * (x - 2.25 / d) + 0.9375;
    return n * (x - 2.625 / d) * (x - 2.625 / d) + 0.984375;
  },
  expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  snap: (p) => (p >= 1 ? 1 : 1 - Math.pow(1 - p, 6)),
  hold: (p) => (p >= 1 ? 1 : 0),
};

type Prop = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity' | 'blur' | 'draw' | 'wipe' | 'skewX';

/**
 * A layer's value of one property at time t: between the keys that set it, eased into each key;
 * before the first key it holds the first value, after the last the last; no keys: `base`.
 */
export function keyValue(keys: DesignKey[], prop: Prop, t: number, duration: number, base: number): number {
  const ks = keys
    .filter((k) => k[prop] !== undefined)
    .map((k) => ({ t: designTime(k.t, duration), v: k[prop] as number, ease: k.ease }))
    .sort((a, b) => a.t - b.t);
  if (!ks.length) return base;
  if (t <= ks[0]!.t) return ks[0]!.v;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    if (t <= b.t) {
      const p = b.t > a.t ? clamp((t - a.t) / (b.t - a.t)) : 1;
      return a.v + (b.v - a.v) * DESIGN_EASES[b.ease](p);
    }
  }
  return ks[ks.length - 1]!.v;
}

/** The order the pieces of a split text build in (index → rank). */
export function revealRanks(n: number, order: 'start' | 'end' | 'center' | 'random', seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (order === 'end') return idx.map((i) => n - 1 - i);
  if (order === 'center') {
    const mid = (n - 1) / 2;
    const sorted = [...idx].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    const rank: number[] = [];
    sorted.forEach((i, r) => (rank[i] = r));
    return rank;
  }
  if (order === 'random') {
    let s = seed % 2147483647 || 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const shuffled = [...idx].sort(() => rnd() - 0.5);
    const rank: number[] = [];
    shuffled.forEach((i, r) => (rank[i] = r));
    return rank;
  }
  return idx;
}

/** How far one piece of a split text has built (0..1) at time t: in from revealAt, out (reversed) from leaveAt. */
export function pieceProgress(l: Pick<DesignTextLayer, 'revealAt' | 'stagger' | 'revealFor' | 'revealEase' | 'leaveAt'>, rank: number, count: number, t: number, duration: number): number {
  const start = designTime(l.revealAt, duration) + rank * l.stagger;
  let p = DESIGN_EASES[l.revealEase](clamp((t - start) / l.revealFor));
  if (l.leaveAt !== undefined) {
    // Every piece is gone by the clip's end: the leaving is squeezed into the time left.
    const from = designTime(l.leaveAt, duration);
    const room = Math.max(0.05, duration - from);
    const each = Math.min(l.revealFor * 0.8, room * 0.5);
    const gap = count > 1 ? Math.min(l.stagger * 0.6, (room - each) / (count - 1)) : 0;
    const leave = from + (count - 1 - rank) * gap;
    p *= 1 - DESIGN_EASES.in(clamp((t - leave) / each));
  }
  return p;
}
