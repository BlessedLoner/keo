import { clipEnd, EASES, keyValue, type Counter, type Entrance, type MediaClip, type ShapeClip, type TextClip } from './studio';

/**
 * Where a layer is and how it looks at one moment: its position and size (with keyframes), its
 * entrance and exit, and its loop. The same for videos, pictures, text and shapes.
 */
export interface MotionState {
  /** Centre, in fractions of the frame. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Degrees. */
  rotation: number;
  opacity: number;
  /** Blur in pixels. */
  blur: number;
  /** How much of the layer shows through a moving edge (wipes, iris), or null: all of it. */
  reveal: { kind: 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down' | 'iris'; p: number } | null;
  /** A white flash over the layer (0..1). */
  flash: number;
  /** Lines and outlines drawing themselves on (0..1). */
  draw: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** A smooth pseudo-random wobble in -1..1 (for shake and flicker). */
const wobble = (t: number, seed: number) => Math.sin(t * 12.9898 + seed) * 0.6 + Math.sin(t * 7.233 + seed * 3.1) * 0.4;

function applyMotion(m: MotionState, e: Entrance, p: number, entering: boolean, H: number): void {
  // p: 0 = fully out, 1 = fully in.
  const ease = EASES.out(p);
  const away = 1 - ease;
  const dir = entering ? 1 : -1;
  switch (e.kind) {
    case 'fade':
      m.opacity *= ease;
      break;
    case 'slide-left':
      m.x += away * 0.7 * dir;
      break;
    case 'slide-right':
      m.x -= away * 0.7 * dir;
      break;
    case 'slide-up':
      m.y += away * 0.5 * dir;
      break;
    case 'slide-down':
      m.y -= away * 0.5 * dir;
      break;
    case 'zoom-in':
      m.scaleX *= 0.25 + 0.75 * ease;
      m.scaleY *= 0.25 + 0.75 * ease;
      m.opacity *= clamp(p * 2);
      break;
    case 'zoom-out':
      m.scaleX *= 1 + away * 1.2;
      m.scaleY *= 1 + away * 1.2;
      m.opacity *= ease;
      break;
    case 'pop': {
      const s = p >= 1 ? 1 : 0.4 + 0.6 * EASES.back(p);
      m.scaleX *= s;
      m.scaleY *= s;
      m.opacity *= clamp(p * 3);
      break;
    }
    case 'spin':
      m.rotation += away * -200 * dir;
      m.scaleX *= 0.3 + 0.7 * ease;
      m.scaleY *= 0.3 + 0.7 * ease;
      m.opacity *= clamp(p * 2);
      break;
    case 'blur':
      m.blur += away * H * 0.03;
      m.opacity *= ease;
      break;
    case 'whip':
      // Fast sideways move with motion blur, as if the camera whipped round.
      m.x += away * away * 1.1 * dir;
      m.blur += away * H * 0.04;
      break;
    case 'flash':
      m.flash = Math.max(m.flash, 1 - p);
      m.opacity *= clamp(p * 4);
      break;
    case 'wipe-left':
    case 'wipe-right':
    case 'wipe-up':
    case 'wipe-down':
    case 'iris':
      m.reveal = { kind: e.kind, p: Math.min(m.reveal?.p ?? 1, EASES['in-out'](p)) };
      break;
  }
}

/** The motion of a layer at timeline time t (W, H: the frame in pixels). */
export function motionAt(c: MediaClip | TextClip | ShapeClip, t: number, H: number): MotionState {
  const rt = t - c.start;
  const tr = c.transform;
  const k = c.keys;
  const val = (prop: keyof NonNullable<typeof k>, base: number) => (k?.[prop]?.length ? keyValue(k[prop]!, rt) : base);
  const scale = val('scale', tr.scale);
  const m: MotionState = {
    x: val('x', tr.x),
    y: val('y', tr.y),
    scaleX: scale * val('scaleX', 1),
    scaleY: scale * val('scaleY', 1),
    rotation: val('rotation', tr.rotation),
    opacity: val('opacity', tr.opacity),
    blur: (val('blur', 0) / 100) * H,
    reveal: null,
    flash: 0,
    draw: 1,
  };
  if (c.type !== 'text') {
    if (c.enter && rt < c.enter.seconds) applyMotion(m, c.enter, clamp(rt / c.enter.seconds), true, H);
    const left = clipEnd(c) - t;
    if (c.exit && left < c.exit.seconds) applyMotion(m, c.exit, clamp(left / c.exit.seconds), false, H);
    // Lines and outlines draw on over the entrance (or the first 0.8 s).
    if (c.type === 'shape' && c.style.draw) m.draw = clamp(rt / (c.enter?.seconds ?? 0.8));
  }
  const l = c.loop;
  if (l) {
    const ph = (rt / l.period) * Math.PI * 2;
    switch (l.kind) {
      case 'float':
        m.y += Math.sin(ph) * l.amount * 0.03;
        break;
      case 'pulse': {
        const s = 1 + Math.sin(ph) * l.amount * 0.08;
        m.scaleX *= s;
        m.scaleY *= s;
        break;
      }
      case 'shake':
        m.x += wobble(rt * 4, 1) * l.amount * 0.012;
        m.y += wobble(rt * 4, 2) * l.amount * 0.012;
        m.rotation += wobble(rt * 4, 3) * l.amount * 2;
        break;
      case 'spin':
        m.rotation += (rt / l.period) * 360;
        break;
      case 'sway':
        m.rotation += Math.sin(ph) * l.amount * 10;
        break;
      case 'flicker':
        if (wobble(rt * 3, 5) > 1 - l.amount * 0.8) m.opacity *= 0.35;
        break;
    }
  }
  m.opacity = clamp(m.opacity);
  return m;
}

/** A counter's number at rt seconds into its clip (counting with an ease-out, then holding). */
export function counterText(c: Counter, rt: number, duration: number): string {
  const p = EASES.out(clamp(rt / (c.seconds ?? Math.max(0.1, duration * 0.8))));
  const v = c.from + (c.to - c.from) * p;
  const n = c.separator ? v.toLocaleString('en-US', { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }) : v.toFixed(c.decimals);
  return `${c.prefix}${n}${c.suffix}`;
}
