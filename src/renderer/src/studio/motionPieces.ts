import type { MotionClip } from '@shared/studio';
import type { MotionState } from '@shared/studioMotion';
import { placeLayer } from './motion';
import { drawScene3d } from './scene3d';
import { drawDesign } from './designPiece';

/**
 * Motion clips: ready-made motion graphics drawn frame by frame (the same frame for the same time,
 * so the preview, the export and the frames Keo looks at all match). Every piece is laid out around
 * the layer's centre in units of U (1% of the frame's shorter side, times the layer's scale), comes
 * in, floats while it is on, and goes out on its own. `beats` (seconds into the clip) time its
 * words or items to the speech.
 */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const expoOut = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(p)));
const cubicOut = (p: number) => 1 - Math.pow(1 - clamp(p), 3);
const cubicIn = (p: number) => Math.pow(clamp(p), 3);
const cubicInOut = (p: number) => {
  const x = clamp(p);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const backOut = (p: number, s = 1.8) => {
  const x = clamp(p) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** A seeded random stream (the same clip always gets the same sparkles). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let s = (h >>> 0) % 2147483647 || 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 24×24 line icons (stroked). */
const ICON_PATHS: Record<string, string> = {
  chat: 'M4 5h16v10H8l-4 4V5z',
  phone: 'M6.6 3.5h3l1.6 4.4-2.1 1.4a11.5 11.5 0 0 0 5.6 5.6l1.4-2.1 4.4 1.6v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z',
  memory: 'M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3zM9 21h6',
  folder: 'M3 7h6l2 2h10v10H3V7z',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  rocket: 'M5 15c-1 1-2 5-2 5s4-1 5-2M9 15l-3-3c1-4 5-9 12-9 0 7-5 11-9 12zM14.5 9.5h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  check: 'M5 12l5 5L20 7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  scissors: 'M6 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M6 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M8 7.5L20 18M8 16.5L20 6',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  window: 'M3 5h18v14H3zM3 9h18',
  image: 'M4 5h16v14H4V5zM4 16l5-5 4 4 3-3 4 4M15.5 8.5h.01',
  play: 'M7 5l12 7-12 7z',
  pin: 'M12 17v4M8 3h8l-1 6 3 4H6l3-4-1-6z',
  speaker: 'M4 9h4l5-4v14l-5-4H4V9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  captions: 'M3 6h18v12H3zM7 11h4M13 11h4M7 14.5h8',
  magic: 'M4 20L15 9M14 4v2M19 9h2M17.5 5.5l-1.4 1.4M18 13l1.4 1.4M9 4l1.4 1.4',
  send: 'M4 12l16-8-6 16-3-7-7-1z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  heart: 'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9L12 3z',
  fire: 'M12 21c-4 0-6.5-2.7-6.5-6.3 0-3.7 3.2-5.6 3.5-9.7 2.4 1.4 4 3.7 4 6.4 1-.8 1.6-2 1.7-3.4 2.3 1.8 3.8 4.3 3.8 6.9 0 3.5-2.6 6.1-6.5 6.1z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  money: 'M12 2v20M17 6.5c-1-1.3-2.8-2-5-2-2.8 0-4.5 1.4-4.5 3.4 0 4.7 9.5 2.6 9.5 7.5 0 2-1.9 3.6-5 3.6-2.4 0-4.2-.8-5.2-2.2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  user: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM4 21v-1a8 8 0 0 1 16 0v1',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
  camera: 'M3 8h4l2-3h6l2 3h4v12H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  gift: 'M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8C10 4 6 4 6.5 6.5S12 8 12 8zM12 8c2-4 6-4 5.5-1.5S12 8 12 8z',
  cart: 'M3 4h3l2.5 11h10L21 7H7M9 20h.01M18 20h.01',
  calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
  book: 'M4 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4zM20 4h-6M20 4v15h-6',
  home: 'M3 11l9-8 9 8M5 9.5V21h14V9.5',
  like: 'M7 10v11H3V10zM7 10l4-8a2.5 2.5 0 0 1 2.5 2.8L13 9h6.5a2 2 0 0 1 2 2.4l-1.6 7.8a2 2 0 0 1-2 1.8H7',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  warning: 'M12 3L2 20h20L12 3zM12 9v5M12 17h.01',
  cross: 'M6 6l12 12M18 6L6 18',
  arrow: 'M4 12h16M14 6l6 6-6 6',
  trophy: 'M8 4h8v6a4 4 0 0 1-8 0V4zM8 6H4c0 3 1.8 5 4 5M16 6h4c0 3-1.8 5-4 5M12 14v4M8 21h8M9 18h6',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  coffee: 'M4 9h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9zM16 10h2a2.5 2.5 0 0 1 0 5h-2M8 3v3M12 3v3',
};
const pathCache = new Map<string, Path2D>();
function iconPath(name: string): Path2D | null {
  const d = ICON_PATHS[name.toLowerCase()];
  if (!d || typeof Path2D === 'undefined') return null;
  let p = pathCache.get(d);
  if (!p) pathCache.set(d, (p = new Path2D(d)));
  return p;
}

interface Ctx {
  ctx: CanvasRenderingContext2D;
  c: MotionClip;
  /** Seconds into the clip, and the clip's length. */
  t: number;
  d: number;
  U: number;
  W: number;
  H: number;
  /** How wide the piece may be (in its own units): what fits between its centre and the nearer edge of the frame. */
  room: number;
  rand: () => number;
}

const font = (weight: number, px: number, family: string) => `${weight} ${Math.max(1, px)}px "${family}", "Inter", "Segoe UI", sans-serif`;
const BODY = 'Inter';

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${clamp(a)})`;
}

/** When the i-th of n words or items appears (seconds into the clip). */
function beat(k: Ctx, i: number, n: number, from = 0.15, span?: number): number {
  const b = k.c.beats?.[i];
  if (b !== undefined) return b;
  const room = span ?? Math.min(k.d * 0.45, 0.22 * n + 0.2);
  return from + (n <= 1 ? 0 : (room * i) / n);
}

/** 0 → 1 over the exit (the last moments of the clip). */
function exitP(k: Ctx, seconds = 0.4): number {
  return cubicIn((k.t - (k.d - seconds)) / seconds);
}

/** A gentle bob (in U) while the piece is on screen. */
const bob = (k: Ctx, amp = 0.6, speed = 1.3, phase = 0) => Math.sin(k.t * speed + phase) * amp * k.U;

function setLetterSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

/** Fills text with a left-to-right gradient of the accents (or plain colour when grad is false). */
function fillText(k: Ctx, text: string, x: number, y: number, grad: boolean | [string, string, string?] = false): void {
  const { ctx } = k;
  if (grad) {
    const w = ctx.measureText(text).width;
    const left = ctx.textAlign === 'center' ? x - w / 2 : ctx.textAlign === 'right' ? x - w : x;
    const g = ctx.createLinearGradient(left, y - w * 0.15, left + w, y + w * 0.15);
    const [a, b, c] = Array.isArray(grad) ? grad : [k.c.color, k.c.accent, k.c.accent2];
    g.addColorStop(0, a);
    g.addColorStop(c ? 0.55 : 1, b);
    if (c) g.addColorStop(1, c);
    ctx.fillStyle = g;
  }
  ctx.fillText(text, x, y);
}

/** A rounded glass panel (dark, a thin light edge, a soft shadow and a faint glow of the accent). */
function glass(k: Ctx, x: number, y: number, w: number, h: number, r: number, alpha = 1): void {
  const { ctx, U } = k;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 5 * U;
  ctx.shadowOffsetY = 1.6 * U;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = `rgba(14, 12, 24, ${0.84 * alpha})`;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, `rgba(255,255,255,${0.1 * alpha})`);
  g.addColorStop(0.35, 'rgba(255,255,255,0)');
  g.addColorStop(1, rgba(k.c.accent, 0.12 * alpha));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.lineWidth = Math.max(1, 0.18 * U);
  ctx.strokeStyle = `rgba(255,255,255,${0.16 * alpha})`;
  ctx.stroke();
  ctx.restore();
}

/** A round glowing chip with a line icon (or an emoji) in it. */
function chip(k: Ctx, name: string, x: number, y: number, size: number, alpha = 1): void {
  const { ctx } = k;
  const r = size / 2;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = rgba(k.c.accent, 0.7);
  ctx.shadowBlur = size * 0.45;
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, r * 0.1, x, y, r);
  g.addColorStop(0, rgba(k.c.accent2, 0.95));
  g.addColorStop(0.55, rgba(k.c.accent, 0.95));
  g.addColorStop(1, rgba(k.c.accent, 0.75));
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
  const p = iconPath(name);
  if (p) {
    const s = (size * 0.48) / 24;
    ctx.translate(x - 12 * s, y - 12 * s);
    ctx.scale(s, s);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.shadowBlur = 3;
    ctx.stroke(p);
  } else {
    ctx.font = `${size * 0.5}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(name, x, y + size * 0.03);
  }
  ctx.restore();
}

/** Breaks words into lines no wider than max (in the current font). */
function wrap(ctx: CanvasRenderingContext2D, words: string[], max: number): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  for (const w of words) {
    const next = [...line, w].join(' ');
    if (line.length && ctx.measureText(next).width > max) {
      lines.push(line);
      line = [w];
    } else line.push(w);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** The biggest font size (≤ want) at which the text fits in max width on at most `lines` lines. */
function fitSize(ctx: CanvasRenderingContext2D, text: string, weight: number, family: string, want: number, max: number, lines = 2): number {
  let px = want;
  for (let i = 0; i < 12; i++) {
    ctx.font = font(weight, px, family);
    const l = wrap(ctx, text.split(/\s+/), max);
    if (l.length <= lines && l.every((x) => ctx.measureText(x.join(' ')).width <= max)) return px;
    px *= 0.88;
  }
  return px;
}

/** A small kicker line (spaced capitals in the light accent). */
function kicker(k: Ctx, text: string, x: number, y: number, p: number, align: CanvasTextAlign = 'center'): void {
  const { ctx, U } = k;
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(p * 1.4);
  ctx.font = font(650, 2.6 * U, BODY);
  setLetterSpacing(ctx, 0.75 * U);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(k.c.accent2, 1);
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 1.5 * U;
  ctx.fillText(text.toUpperCase(), x + (align === 'left' ? (1 - cubicOut(p)) * -4 * U : 0), y);
  ctx.restore();
}

// ---------------------------------------------------------------- the pieces

/** Headline: a kicker, words rising out of masks one by one (the last glows), an underline that grows. */
function headline(k: Ctx): void {
  const { ctx, c, U } = k;
  const words = c.text.split(/\s+/);
  const max = Math.min(k.room, 90 * U);
  const px = fitSize(ctx, c.text, 800, c.font, 9.5 * U, max, 3);
  ctx.font = font(800, px, c.font);
  const lines = wrap(ctx, words, max);
  const lh = px * 1.12;
  const top = -(lines.length * lh) / 2 + (c.sub ? 1.6 * U : 0);
  if (c.sub) kicker(k, c.sub, 0, top - 2.4 * U, (k.t - 0.05) / 0.5);
  let wi = 0;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, li) => {
    const lineW = ctx.measureText(line.join(' ')).width;
    let x = -lineW / 2;
    const base = top + (li + 1) * lh - px * 0.2;
    for (const w of line) {
      const ww = ctx.measureText(w).width;
      const p = expoOut((k.t - beat(k, wi, words.length)) / 0.75);
      const last = wi === words.length - 1;
      if (p > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - px * 0.1, base - px * 1.05, ww + px * 0.2, px * 1.35);
        ctx.clip();
        ctx.textAlign = 'left';
        ctx.fillStyle = c.color;
        ctx.shadowColor = last ? rgba(c.accent, 0.8) : 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = last ? 2.5 * U : 1.6 * U;
        ctx.font = font(800, px, c.font);
        fillText(k, w, x, base + (1 - p) * px * 1.2, last ? [c.color, c.accent2, c.accent] : false);
        ctx.restore();
      }
      x += ww + ctx.measureText(' ').width;
      wi++;
    }
  });
  // The underline grows once the words are in.
  const bp = cubicInOut((k.t - beat(k, words.length - 1, words.length) - 0.15) / 0.8);
  if (bp > 0) {
    const bw = Math.min(28 * U, max * 0.4) * bp;
    const y = top + lines.length * lh + 1.6 * U;
    const g = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
    g.addColorStop(0, c.accent);
    g.addColorStop(1, c.accent2);
    ctx.save();
    ctx.shadowColor = rgba(c.accent, 0.9);
    ctx.shadowBlur = 2 * U;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-bw / 2, y, bw, 0.75 * U, 0.4 * U);
    ctx.fill();
    ctx.restore();
  }
}

/** Word pop: a big word slammed in (overshoot and settle), rings that burst out, sparkles that fly. */
function wordPop(k: Ctx): void {
  const { ctx, c, U } = k;
  const t0 = c.beats?.[0] ?? 0.05;
  const lt = k.t - t0;
  if (lt < 0) return;
  const max = Math.min(k.room, 95 * U);
  const px = fitSize(ctx, c.text.toUpperCase(), 900, c.font, 17 * U, max, 2);
  const s = lerp(2.2, 1, backOut(lt / 0.45, 2.2));
  const a = clamp(lt / 0.12);
  // Rings.
  for (let i = 0; i < 2; i++) {
    const p = clamp((lt - i * 0.08) / 0.9);
    if (p <= 0 || p >= 1) continue;
    ctx.save();
    ctx.globalAlpha *= (1 - p) * 0.9;
    ctx.lineWidth = (1 - p) * 1.2 * U + 0.2 * U;
    ctx.strokeStyle = i ? c.accent : c.accent2;
    ctx.shadowColor = i ? c.accent : c.accent2;
    ctx.shadowBlur = 2.5 * U;
    ctx.beginPath();
    ctx.arc(0, 0, lerp(px * 0.6, px * 2.6, cubicOut(p)), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Sparkles.
  const r = rng(c.id);
  for (let i = 0; i < 14; i++) {
    const ang = r() * Math.PI * 2;
    const dist = (0.9 + r() * 1.6) * px;
    const p = cubicOut(clamp((lt - 0.05) / (0.7 + r() * 0.5)));
    if (p <= 0 || p >= 1) continue;
    const x = Math.cos(ang) * dist * p;
    const y = Math.sin(ang) * dist * p * 0.7;
    const size = (0.5 + r() * 1.1) * U * (1 - p);
    ctx.save();
    ctx.globalAlpha *= 1 - p;
    ctx.fillStyle = r() > 0.5 ? c.accent2 : '#FFFFFF';
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 1.5 * U;
    star4(ctx, x, y, size);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.scale(s, s);
  ctx.rotate(((1 - expoOut(lt / 0.5)) * -6 * Math.PI) / 180);
  ctx.font = font(900, px, c.font);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrap(ctx, c.text.toUpperCase().split(/\s+/), max);
  const lh = px * 1.02;
  lines.forEach((l, i) => {
    const y = (i - (lines.length - 1) / 2) * lh + bob(k, 0.3, 2);
    ctx.shadowColor = rgba(c.accent, 0.9);
    ctx.shadowBlur = 3.5 * U;
    fillText(k, l.join(' '), 0, y, [c.color, c.color, c.accent2]);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 0.25 * U;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeText(l.join(' '), 0, y);
  });
  if (c.icon) chip(k, c.icon, 0, -(lines.length * lh) / 2 - 6 * U, 8 * U, clamp((lt - 0.2) / 0.3));
  ctx.restore();
}

function star4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

/** Icon burst: glowing icon chips pop out around a label on a dashed orbit, then float. */
function iconBurst(k: Ctx): void {
  const { ctx, c, U } = k;
  const items = c.items?.length ? c.items : [c.icon ?? 'sparkle', 'bolt', 'star'];
  const n = items.length;
  const R = 19 * U;
  // The orbit.
  const op = cubicOut((k.t - 0.05) / 0.8);
  if (op > 0) {
    ctx.save();
    ctx.globalAlpha *= 0.4 * op;
    ctx.setLineDash([1 * U, 1.2 * U]);
    ctx.lineDashOffset = -k.t * 4 * U;
    ctx.lineWidth = 0.25 * U;
    ctx.strokeStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.ellipse(0, 0, R * op, R * 0.72 * op, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  items.forEach((name, i) => {
    const p = backOut((k.t - beat(k, i, n, 0.15)) / 0.6, 2);
    if (p <= 0) return;
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2 + k.t * 0.15;
    const x = Math.cos(ang) * R * Math.min(1, p);
    const y = Math.sin(ang) * R * 0.72 * Math.min(1, p) + bob(k, 0.8, 1.6, i * 1.7);
    chip(k, name, x, y, 9 * U * Math.max(0.2, p), clamp(p * 2));
  });
  // The label in the middle.
  const lp = cubicOut((k.t - 0.1) / 0.5);
  if (lp > 0) {
    ctx.save();
    ctx.globalAlpha *= lp;
    ctx.font = font(800, 4.4 * U, c.font);
    const w = ctx.measureText(c.text).width + 6 * U;
    const h = 8 * U;
    ctx.translate(0, (1 - lp) * 2 * U);
    glass(k, -w / 2, -h / 2, w, h, h / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.color;
    fillText(k, c.text, 0, 0.2 * U, true);
    ctx.restore();
  }
}

/** Pills: short points in glass pills with an icon dot, sliding in one by one and floating. */
function chips(k: Ctx): void {
  const { ctx, c, U } = k;
  const items = c.items?.length ? c.items : [c.text];
  const n = items.length;
  const h = 8.4 * U;
  const gap = 2.2 * U;
  const total = n * h + (n - 1) * gap + (c.items?.length ? 6 * U : 0);
  let y = -total / 2;
  if (c.items?.length) {
    kicker(k, c.text, 0, y + 3 * U, (k.t - 0.05) / 0.5);
    y += 6 * U;
  }
  ctx.font = font(700, 3.5 * U, BODY);
  const widest = Math.max(...items.map((x) => ctx.measureText(x).width));
  items.forEach((label, i) => {
    const p = backOut((k.t - beat(k, i, n, 0.2)) / 0.6, 1.6);
    const yy = y + i * (h + gap);
    if (p > 0) {
      const w = widest + 15 * U;
      const side = i % 2 ? 1 : -1;
      ctx.save();
      ctx.globalAlpha *= clamp(p * 1.5);
      ctx.translate(side * (1 - Math.min(1, p)) * 18 * U + (i % 2 ? 3 * U : -3 * U), yy + bob(k, 0.5, 1.4, i));
      glass(k, -w / 2, 0, w, h, h / 2);
      chip(k, c.icon ?? 'check', -w / 2 + h / 2 + 0.3 * U, h / 2, h * 0.72);
      ctx.font = font(700, 3.5 * U, BODY);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.color;
      ctx.fillText(label, -w / 2 + h + 1.8 * U, h / 2 + 0.2 * U);
      ctx.restore();
    }
  });
}

/** Counter: a big number counting up to its value (with its unit), a ring for percentages, a label under it. */
function stat(k: Ctx): void {
  const { ctx, c, U } = k;
  const value = c.value ?? (Number(c.text.replace(/[^0-9.-]/g, '')) || 100);
  const t0 = c.beats?.[0] ?? 0.1;
  const p = expoOut((k.t - t0) / Math.min(1.6, Math.max(0.6, k.d * 0.4)));
  const a = cubicOut((k.t - t0 + 0.1) / 0.4);
  if (a <= 0) return;
  const unit = c.unit ?? '';
  const prefix = /^[$€£₦¥₹#]/.test(unit);
  const decimals = Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0;
  const shown = (value * p).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const num = prefix ? `${unit}${shown}` : `${shown}${unit}`;
  ctx.save();
  ctx.globalAlpha *= a;
  const px = 15 * U;
  const ring = unit.trim() === '%';
  if (ring) {
    const R = 16 * U;
    ctx.lineWidth = 1.4 * U;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(0, -1 * U, R, 0, Math.PI * 2);
    ctx.stroke();
    const g = ctx.createLinearGradient(-R, -R, R, R);
    g.addColorStop(0, c.accent2);
    g.addColorStop(1, c.accent);
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 2.5 * U;
    ctx.beginPath();
    ctx.arc(0, -1 * U, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp((value / 100) * p));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  if (c.sub) kicker(k, c.sub, 0, (ring ? -21 : -11) * U, (k.t - t0) / 0.5);
  ctx.font = font(900, ring ? px * 0.62 : px, c.font);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = rgba(c.accent, 0.85);
  ctx.shadowBlur = 3 * U;
  const s = lerp(0.7, 1, backOut((k.t - t0) / 0.5, 1.6));
  ctx.save();
  ctx.translate(0, -1 * U);
  ctx.scale(s, s);
  fillText(k, num, 0, 0, [c.color, c.accent2, c.accent]);
  ctx.restore();
  const lp = cubicOut((k.t - t0 - 0.3) / 0.5);
  if (lp > 0 && c.text && c.value !== undefined) {
    ctx.globalAlpha *= lp;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 1.5 * U;
    ctx.font = font(650, 3.6 * U, BODY);
    ctx.fillStyle = c.color;
    ctx.fillText(c.text, 0, (ring ? 21 : 11) * U + (1 - lp) * 2 * U);
  }
  ctx.restore();
}

/** List: a title on a glass card, rows that slide in and tick off one by one. */
function list(k: Ctx): void {
  const { ctx, c, U } = k;
  const rows = c.items?.length ? c.items : [c.text];
  const n = rows.length;
  ctx.font = font(650, 3.5 * U, BODY);
  const widest = Math.max(...rows.map((x) => ctx.measureText(x).width));
  ctx.font = font(800, 4.8 * U, c.font);
  const w = Math.max(widest + 14 * U, ctx.measureText(c.text).width + 10 * U, 42 * U);
  const rowH = 7 * U;
  const h = 12 * U + n * rowH + 3 * U;
  const p = expoOut((k.t - 0.02) / 0.7);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(p * 1.3);
  ctx.translate(0, (1 - p) * 5 * U + bob(k, 0.4, 1.1));
  glass(k, -w / 2, -h / 2, w, h, 3 * U);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(800, 4.8 * U, c.font);
  ctx.fillStyle = c.color;
  fillText(k, c.text, -w / 2 + 5 * U, -h / 2 + 8.6 * U, true);
  rows.forEach((row, i) => {
    const rp = expoOut((k.t - beat(k, i, n, 0.45)) / 0.55);
    if (rp <= 0) return;
    const y = -h / 2 + 12 * U + i * rowH + rowH / 2;
    ctx.save();
    ctx.globalAlpha *= clamp(rp * 1.4);
    ctx.translate((1 - rp) * -4 * U, 0);
    // The tick draws itself.
    const x0 = -w / 2 + 5 * U;
    ctx.beginPath();
    ctx.arc(x0 + 1.8 * U, y, 1.9 * U, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(x0, y - 2 * U, x0 + 3.6 * U, y + 2 * U);
    g.addColorStop(0, c.accent2);
    g.addColorStop(1, c.accent);
    ctx.fillStyle = g;
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 1.5 * U;
    ctx.fill();
    ctx.shadowBlur = 0;
    const tp = clamp((rp - 0.3) / 0.7);
    ctx.lineWidth = 0.5 * U;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.setLineDash([4 * U, 4 * U]);
    ctx.lineDashOffset = 4 * U * (1 - tp);
    ctx.beginPath();
    ctx.moveTo(x0 + 0.9 * U, y + 0.1 * U);
    ctx.lineTo(x0 + 1.6 * U, y + 0.8 * U);
    ctx.lineTo(x0 + 2.8 * U, y - 0.8 * U);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = font(650, 3.5 * U, BODY);
    ctx.fillStyle = c.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(row, x0 + 5.4 * U, y + 0.2 * U);
    ctx.restore();
  });
  ctx.restore();
}

/** Lower third: an accent bar sweeps in, a glass tag slides out of it with the name and role. */
function lowerThird(k: Ctx): void {
  const { ctx, c, U } = k;
  ctx.font = font(800, 4.6 * U, c.font);
  const nameW = ctx.measureText(c.text).width;
  ctx.font = font(600, 2.9 * U, BODY);
  const subW = c.sub ? ctx.measureText(c.sub).width : 0;
  const w = Math.max(nameW, subW) + 9 * U;
  const h = c.sub ? 13 * U : 9 * U;
  const left = -w / 2;
  const bp = cubicInOut((k.t - 0.02) / 0.45);
  const pp = expoOut((k.t - 0.25) / 0.7);
  ctx.save();
  ctx.translate(0, bob(k, 0.25, 1));
  // The tag.
  if (pp > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, -h / 2 - 2 * U, w + 4 * U, h + 4 * U);
    ctx.clip();
    ctx.translate((pp - 1) * w, 0);
    glass(k, left, -h / 2, w, h, 1.6 * U);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(800, 4.6 * U, c.font);
    ctx.fillStyle = c.color;
    fillText(k, c.text, left + 4.5 * U, -h / 2 + (c.sub ? 6.4 : 6) * U);
    if (c.sub) {
      ctx.font = font(600, 2.9 * U, BODY);
      ctx.fillStyle = rgba(c.accent2, 1);
      ctx.fillText(c.sub, left + 4.5 * U, -h / 2 + 10.4 * U);
    }
    ctx.restore();
  }
  // The bar.
  if (bp > 0) {
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, c.accent2);
    g.addColorStop(1, c.accent);
    ctx.fillStyle = g;
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 2 * U;
    ctx.beginPath();
    ctx.roundRect(left - 0.4 * U, -h / 2 + (h * (1 - bp)) / 2, 1.1 * U, h * bp, 0.5 * U);
    ctx.fill();
  }
  ctx.restore();
}

/** Quote card: a glass card with a big glowing quote mark; the quote is typed in word by word. */
function quote(k: Ctx): void {
  const { ctx, c, U } = k;
  const words = c.text.split(/\s+/);
  const max = Math.min(k.room, 72 * U);
  const px = fitSize(ctx, c.text, 700, c.font, 5.4 * U, max - 10 * U, 5);
  ctx.font = font(700, px, c.font);
  const lines = wrap(ctx, words, max - 10 * U);
  const lh = px * 1.3;
  const w = Math.min(max, Math.max(...lines.map((l) => ctx.measureText(l.join(' ')).width)) + 12 * U);
  const h = lines.length * lh + 12 * U + (c.sub ? 6 * U : 0);
  const p = expoOut((k.t - 0.02) / 0.7);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(p * 1.3);
  ctx.translate(0, (1 - p) * 4 * U + bob(k, 0.4, 1.1));
  ctx.scale(lerp(0.92, 1, p), lerp(0.92, 1, p));
  glass(k, -w / 2, -h / 2, w, h, 3.2 * U);
  // The quote mark.
  quoteMarks(k, -w / 2 + 4.5 * U, -h / 2 - 2.2 * U, 3.4 * U);
  // The words, typed in over the first part of the clip (or on their beats).
  ctx.font = font(700, px, c.font);
  const span = Math.max(0.6, Math.min(k.d * 0.55, words.length * 0.28));
  let wi = 0;
  lines.forEach((line, li) => {
    let x = -w / 2 + 6 * U;
    const y = -h / 2 + 7 * U + (li + 1) * lh - px * 0.3;
    for (const word of line) {
      const wp = cubicOut((k.t - beat(k, wi, words.length, 0.35, span)) / 0.3);
      if (wp > 0) {
        ctx.save();
        ctx.globalAlpha *= wp;
        ctx.fillStyle = c.color;
        ctx.fillText(word, x, y + (1 - wp) * 1.2 * U);
        ctx.restore();
      }
      x += ctx.measureText(`${word} `).width;
      wi++;
    }
  });
  if (c.sub) {
    const sp = cubicOut((k.t - beat(k, words.length - 1, words.length, 0.35, span) - 0.2) / 0.5);
    if (sp > 0) {
      ctx.globalAlpha *= sp;
      ctx.font = font(600, 3 * U, BODY);
      ctx.fillStyle = rgba(c.accent2, 1);
      ctx.fillText(`— ${c.sub}`, -w / 2 + 6 * U, h / 2 - 4 * U);
    }
  }
  ctx.restore();
}

/** Two round quote marks (66-shaped), top-left at x, y, each about s wide. */
function quoteMarks(k: Ctx, x: number, y: number, s: number): void {
  const { ctx, c, U } = k;
  const g = ctx.createLinearGradient(x, y, x + s * 2.6, y + s * 2);
  g.addColorStop(0, c.accent2);
  g.addColorStop(1, c.accent);
  ctx.save();
  ctx.fillStyle = g;
  ctx.shadowColor = c.accent;
  ctx.shadowBlur = 2.5 * U;
  for (const dx of [0, s * 1.45]) {
    const cx = x + dx + s / 2;
    const cy = y + s * 1.45;
    ctx.beginPath();
    ctx.arc(cx, cy, s / 2, 0, Math.PI * 2);
    ctx.fill();
    // The tail curls up from the left of the dot.
    ctx.beginPath();
    ctx.moveTo(cx - s / 2, cy);
    ctx.quadraticCurveTo(cx - s / 2, cy - s * 1.15, cx + s * 0.35, cy - s * 1.3);
    ctx.lineTo(cx + s * 0.38, cy - s * 0.98);
    ctx.quadraticCurveTo(cx - s * 0.1, cy - s * 0.85, cx - s * 0.05, cy - s * 0.3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** 3D card: swings in on its vertical axis, settles with a slow sway and a moving glare. */
function card3d(k: Ctx): void {
  const { ctx, c, U } = k;
  ctx.font = font(800, 5.2 * U, c.font);
  const titleW = ctx.measureText(c.text).width;
  ctx.font = font(600, 3 * U, BODY);
  const subW = c.sub ? ctx.measureText(c.sub).width : 0;
  const w = Math.max(titleW, subW, 26 * U) + 12 * U;
  const h = (c.icon ? 34 : 22) * U + (c.sub ? 4 * U : 0);
  const p = expoOut((k.t - 0.02) / 1.1);
  if (p <= 0) return;
  // Turning on the vertical axis: narrower and sheared while it turns.
  const angle = lerp(70, 0, p) + Math.sin(k.t * 0.9) * 7 * p;
  const rad = (angle * Math.PI) / 180;
  const sx = Math.max(0.05, Math.cos(rad));
  const shear = Math.sin(rad) * 0.18;
  ctx.save();
  ctx.globalAlpha *= clamp(p * 1.6);
  ctx.translate((1 - p) * 10 * U, bob(k, 0.8, 1.2));
  ctx.transform(sx, shear, 0, 1, 0, 0);
  glass(k, -w / 2, -h / 2, w, h, 3.4 * U);
  // Glare.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 3.4 * U);
  ctx.clip();
  const gx = lerp(-w, w, ((k.t * 0.35) % 1.6) / 1.6);
  const g = ctx.createLinearGradient(gx - 10 * U, -h / 2, gx + 10 * U, h / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.13)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
  let y = -h / 2 + 5 * U;
  if (c.icon) {
    chip(k, c.icon, 0, y + 6 * U, 12 * U);
    y += 15 * U;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(800, 5.2 * U, c.font);
  ctx.fillStyle = c.color;
  fillText(k, c.text, 0, y + 6 * U, true);
  if (c.sub) {
    ctx.font = font(600, 3 * U, BODY);
    ctx.fillStyle = 'rgba(235,232,255,0.85)';
    ctx.fillText(c.sub, 0, y + 11.5 * U);
  }
  ctx.restore();
}

/** Highlight: a line of text whose key words get a marker swept behind them, one after another. */
function highlight(k: Ctx): void {
  const { ctx, c, U } = k;
  const words = c.text.split(/\s+/);
  const max = Math.min(k.room, 88 * U);
  const px = fitSize(ctx, c.text, 800, c.font, 7.5 * U, max, 3);
  ctx.font = font(800, px, c.font);
  const lines = wrap(ctx, words, max);
  const lh = px * 1.3;
  const marks = (c.items?.length ? c.items : [words.at(-1)!]).map((m) => m.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const p = cubicOut((k.t - 0.02) / 0.5);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= p;
  ctx.translate(0, (1 - p) * 2 * U + bob(k, 0.25, 1));
  let mi = 0;
  const top = -(lines.length * lh) / 2;
  lines.forEach((line, li) => {
    const lw = ctx.measureText(line.join(' ')).width;
    let x = -lw / 2;
    const y = top + li * lh + lh / 2;
    for (const w of line) {
      const ww = ctx.measureText(w).width;
      if (marks.includes(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) {
        const mp = cubicInOut((k.t - beat(k, mi, marks.length, 0.45)) / 0.45);
        if (mp > 0) {
          ctx.save();
          const g = ctx.createLinearGradient(x, 0, x + ww, 0);
          g.addColorStop(0, rgba(c.accent, 0.95));
          g.addColorStop(1, rgba(c.accent2, 0.95));
          ctx.fillStyle = g;
          ctx.shadowColor = c.accent;
          ctx.shadowBlur = 2 * U;
          ctx.beginPath();
          ctx.roundRect(x - px * 0.12, y - px * 0.5, (ww + px * 0.24) * mp, px * 1.05, px * 0.16);
          ctx.fill();
          ctx.restore();
        }
        mi++;
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.color;
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 1.5 * U;
      ctx.fillText(w, x, y + px * 0.04);
      ctx.shadowBlur = 0;
      x += ww + ctx.measureText(' ').width;
    }
  });
  ctx.restore();
}

/** Callout: a hand-drawn arrow draws itself on, then a note pops in a pill at its tail. */
function callout(k: Ctx): void {
  const { ctx, c, U } = k;
  ctx.font = font(700, 3.8 * U, c.font);
  const tw = ctx.measureText(c.text).width;
  const w = tw + 7 * U;
  const h = 8 * U;
  const ap = cubicInOut((k.t - 0.05) / 0.6);
  const np = backOut((k.t - 0.35) / 0.5, 1.6);
  ctx.save();
  ctx.translate(0, bob(k, 0.35, 1.4));
  if (ap > 0) {
    ctx.save();
    ctx.lineWidth = 0.7 * U;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = c.accent2;
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 1.8 * U;
    const len = 60 * U;
    ctx.setLineDash([len, len]);
    ctx.lineDashOffset = len * (1 - ap);
    ctx.beginPath();
    ctx.moveTo(0, -h / 2 - 1 * U);
    ctx.bezierCurveTo(2 * U, -12 * U, 12 * U, -18 * U, 20 * U, -16 * U);
    ctx.stroke();
    ctx.setLineDash([]);
    if (ap > 0.92) {
      ctx.beginPath();
      ctx.moveTo(15.5 * U, -19.5 * U);
      ctx.lineTo(20 * U, -16 * U);
      ctx.lineTo(15.8 * U, -12.6 * U);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (np > 0) {
    ctx.save();
    ctx.globalAlpha *= clamp(np * 1.5);
    ctx.scale(Math.max(0.2, np), Math.max(0.2, np));
    glass(k, -w / 2, -h / 2, w, h, h / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.color;
    ctx.fillText(c.text, 0, 0.2 * U);
    ctx.restore();
  }
  ctx.restore();
}

/** Light sweep: a band of light crosses the whole frame with dust, and a word flashes in its wake. */
function lightSweep(k: Ctx, frame: { W: number; H: number }): void {
  const { ctx, c, U } = k;
  const { W, H } = frame;
  const p = cubicInOut(k.t / Math.max(0.3, k.d * 0.75));
  ctx.save();
  // Full frame: ignore the layer's place (the band crosses everything).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cx = lerp(-W * 0.4, W * 1.4, p);
  const band = W * 0.35;
  const g = ctx.createLinearGradient(cx - band, 0, cx + band, H * 0.25);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, rgba(c.accent, 0.35));
  g.addColorStop(0.5, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.55, rgba(c.accent2, 0.35));
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const r = rng(c.id);
  for (let i = 0; i < 40; i++) {
    const x = cx + (r() - 0.5) * band * 1.6;
    const y = r() * H;
    const s = (0.2 + r() * 0.6) * U;
    ctx.globalAlpha = clamp(1 - Math.abs(x - cx) / band) * 0.9;
    ctx.fillStyle = r() > 0.5 ? c.accent2 : '#FFFFFF';
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (c.text.trim() && c.text.trim() !== '-') {
    const tp = clamp((k.t - k.d * 0.25) / 0.25);
    const out = clamp((k.t - k.d * 0.7) / (k.d * 0.3));
    if (tp > 0 && out < 1) {
      ctx.save();
      ctx.globalAlpha *= tp * (1 - out);
      const s = lerp(1.25, 1, expoOut(tp));
      ctx.scale(s, s);
      ctx.font = font(900, 12 * U, c.font);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 4 * U;
      fillText(k, c.text.toUpperCase(), 0, 0, true);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- full-screen pieces

/** How light a colour is (0 black … 1 white). */
function lightness(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
const plainWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A living background: the colour, two soft glows of the accents drifting, a moving dot grid. */
function sceneBackground(k: Ctx, bg: string, ink: string, strength = 1): void {
  const { ctx, U, W, H, t } = k;
  const dark = lightness(bg) < 0.45;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = (hex: string, x: number, y: number, r: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(hex, a));
    g.addColorStop(1, rgba(hex, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  const a = (dark ? 0.38 : 0.2) * strength;
  glow(k.c.accent, W * (0.22 + 0.06 * Math.sin(t * 0.7)), H * (0.28 + 0.05 * Math.cos(t * 0.5)), Math.max(W, H) * 0.55, a);
  // On a dark background the second glow stays faint (two strong hues mixed turn muddy).
  glow(k.c.accent2, W * (0.8 + 0.05 * Math.cos(t * 0.6)), H * (0.76 + 0.04 * Math.sin(t * 0.8)), Math.max(W, H) * 0.5, a * (dark ? 0.3 : 0.8));
  // The dot grid drifts slowly up and to the left.
  const gap = 4.2 * U;
  const ox = (t * 1.2 * U) % gap;
  const oy = (t * 2 * U) % gap;
  ctx.fillStyle = rgba(ink, dark ? 0.11 : 0.09);
  for (let y = -oy; y < H + gap; y += gap)
    for (let x = -ox; x < W + gap; x += gap) {
      ctx.beginPath();
      ctx.arc(x, y, 0.17 * U, 0, Math.PI * 2);
      ctx.fill();
    }
}

/** A few small shapes (rings, plus signs, dots) floating around the edges. */
function floaters(k: Ctx, ink: string, alpha: number): void {
  const { ctx, U, W, H, t } = k;
  const r = rng(`${k.c.id}:f`);
  ctx.save();
  ctx.lineWidth = 0.35 * U;
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? r() * 0.2 : 0.8 + r() * 0.2;
    const x = W * (i < 4 ? side : 0.15 + r() * 0.7);
    const y = H * (i < 4 ? 0.1 + r() * 0.8 : r() < 0.5 ? 0.05 + r() * 0.1 : 0.85 + r() * 0.1);
    const s = (1 + r() * 1.6) * U;
    const p = clamp((t - 0.15 - i * 0.05) / 0.5);
    if (p <= 0) continue;
    const dx = Math.sin(t * 0.9 + i) * 1.2 * U;
    const dy = Math.cos(t * 0.7 + i * 2) * 1.2 * U - (1 - cubicOut(p)) * 4 * U;
    const color = i % 3 === 0 ? k.c.accent : i % 3 === 1 ? k.c.accent2 : ink;
    ctx.globalAlpha = alpha * cubicOut(p) * 0.75;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (i % 3 === 0) ctx.arc(x + dx, y + dy, s, 0, Math.PI * 2);
    else if (i % 3 === 1) {
      ctx.moveTo(x + dx - s, y + dy);
      ctx.lineTo(x + dx + s, y + dy);
      ctx.moveTo(x + dx, y + dy - s);
      ctx.lineTo(x + dx, y + dy + s);
    } else ctx.arc(x + dx, y + dy, s * 0.35, 0, Math.PI * 2);
    if (i % 3 === 2) ctx.fill();
    else ctx.stroke();
  }
  ctx.restore();
}

/** The scene's small line above the words: spaced capitals, a little lighter than the words. */
function sceneKicker(k: Ctx, text: string, y: number, ink: string, p: number): void {
  const { ctx, U } = k;
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(p * 1.4) * 0.75;
  ctx.font = font(700, 2.8 * U, BODY);
  setLetterSpacing(ctx, 0.8 * U);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  ctx.fillText(text.toUpperCase(), 0, y + (1 - cubicOut(p)) * 2 * U);
  ctx.restore();
}

/** A big counter for a scene: the number counts up, the unit in the accent italic, the words under it. */
function sceneCounter(k: Ctx, ink: string, maxW: number): void {
  const { ctx, c, U } = k;
  const fam = c.font;
  const b = beat(k, 0, 1, 0.15);
  const p = expoOut((k.t - b) / 1.1);
  const value = c.value ?? 0;
  const v = value * p;
  const num = Number.isInteger(value) ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
  const unit = c.unit ?? '';
  const unitBefore = ['$', '£', '€', '₦'].includes(unit);
  const big = fitSize(ctx, `${unit}${num}`, 900, fam, 26 * U, maxW, 1);
  const s = lerp(1.25, 1, backOut((k.t - b) / 0.45));
  ctx.save();
  ctx.globalAlpha *= clamp((k.t - b) / 0.15);
  ctx.scale(s, s);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(900, big, fam);
  const nW = ctx.measureText(num).width;
  const unitFont = `italic ${font(400, big * 0.9, 'Instrument Serif')}`;
  ctx.font = unitFont;
  const uW = unit ? ctx.measureText(unit).width : 0;
  let x = -(nW + uW) / 2;
  const y = big * 0.32;
  if (unit && unitBefore) {
    ctx.fillStyle = c.accent;
    ctx.fillText(unit, x, y);
    x += uW;
  }
  ctx.font = font(900, big, fam);
  ctx.fillStyle = ink;
  ctx.fillText(num, x, y);
  x += nW;
  if (unit && !unitBefore) {
    ctx.font = unitFont;
    ctx.fillStyle = c.accent;
    ctx.fillText(unit, x, y);
  }
  ctx.restore();
  const lp = cubicOut((k.t - b - 0.35) / 0.5);
  if (lp > 0) {
    ctx.save();
    ctx.globalAlpha *= lp;
    ctx.font = font(700, fitSize(ctx, c.text, 700, fam, 5.2 * U, maxW, 2), fam);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink;
    ctx.fillText(c.text, 0, big * 0.32 + 8 * U + (1 - lp) * 3 * U);
    ctx.restore();
  }
  if (c.sub) sceneKicker(k, c.sub, -big * 0.75, ink, (k.t - 0.1) / 0.5);
}

/** A scene's words: they slam in as they are said, the key word in the accent serif italic with a hand-drawn underline. */
function sceneWords(k: Ctx, ink: string, dark: boolean, maxW: number): void {
  const { ctx, c, U, W } = k;
  const fam = c.font;
  const words = c.text.split(/\s+/).filter(Boolean);
  const keys = new Set((c.items?.length ? c.items.flatMap((x) => x.split(/\s+/)) : [words.at(-1) ?? '']).map(plainWord));
  const isKey = words.map((w) => keys.has(plainWord(w)));
  const shown = (i: number) => (isKey[i] ? words[i]! : words[i]!.toUpperCase());
  const fontOf = (i: number, size: number) => (isKey[i] ? `italic ${font(400, size * 1.18, 'Instrument Serif')}` : font(900, size, fam));
  const measure = (i: number, size: number) => {
    ctx.font = fontOf(i, size);
    return ctx.measureText(shown(i)).width;
  };
  // One size for the whole phrase: as big as fits on at most three lines.
  // Short phrases go big: one or two words fill the frame.
  const cap = words.length <= 2 ? 26 * U : words.length === 3 ? 20 * U : 15 * U;
  let px = Math.min(cap, (W * 0.9) / Math.max(3, Math.max(...words.map((w) => w.length)) * 0.6));
  let lines: number[][] = [];
  for (let tries = 0; tries < 14; tries++) {
    lines = [];
    let line: number[] = [];
    let lw = 0;
    const space = px * 0.28;
    words.forEach((_, i) => {
      const w = measure(i, px);
      if (line.length && lw + space + w > maxW) {
        lines.push(line);
        line = [i];
        lw = w;
      } else {
        lw += (line.length ? space : 0) + w;
        line.push(i);
      }
    });
    if (line.length) lines.push(line);
    if (lines.length <= 3 && words.every((_, i) => measure(i, px) <= maxW)) break;
    px *= 0.9;
  }
  const lh = px * 1.08;
  const top = -(lines.length * lh) / 2;
  if (c.icon) {
    const ip = backOut((k.t - beat(k, 0, words.length, 0.12) + 0.05) / 0.45);
    if (ip > 0) chip(k, c.icon, 0, top - 9 * U, 12 * U * clamp(ip, 0, 1.2), clamp(ip));
  }
  if (c.sub) sceneKicker(k, c.sub, top - (c.icon ? 18 * U : 3.5 * U), ink, (k.t - 0.08) / 0.5);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  lines.forEach((line, li) => {
    const space = px * 0.28;
    const widths = line.map((i) => measure(i, px));
    const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    let x = -total / 2;
    const base = top + (li + 1) * lh - px * 0.18;
    line.forEach((i, j) => {
      const w = widths[j]!;
      const b = beat(k, i, words.length, 0.12);
      const p = (k.t - b) / 0.32;
      if (p > 0) {
        const s = lerp(1.7, 1, backOut(p, 1.4));
        ctx.save();
        ctx.globalAlpha *= clamp(p * 3);
        ctx.translate(x + w / 2, base - px * 0.35);
        ctx.rotate((1 - clamp(p)) * (i % 2 ? 0.08 : -0.08));
        ctx.scale(s, s);
        ctx.font = fontOf(i, px);
        ctx.fillStyle = isKey[i] ? c.accent : ink;
        if (dark) {
          ctx.shadowColor = isKey[i] ? rgba(c.accent, 0.8) : 'rgba(0,0,0,0.4)';
          ctx.shadowBlur = 2.5 * U;
        }
        ctx.fillText(shown(i), -w / 2, px * 0.35);
        ctx.restore();
        // The key word gets a hand-drawn underline once it has landed.
        const up = cubicInOut((k.t - b - 0.2) / 0.45);
        if (isKey[i] && up > 0) {
          ctx.save();
          ctx.strokeStyle = c.accent2;
          ctx.lineWidth = 0.9 * U;
          ctx.lineCap = 'round';
          ctx.beginPath();
          const y = base + px * 0.14;
          const x1 = x + w * up;
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo((x + x1) / 2, y + px * 0.12, x1, y - px * 0.04);
          ctx.stroke();
          ctx.restore();
        }
      }
      x += w + space;
    });
  });
}

/**
 * Keyword scene: the video cuts away to a clean, living background (it comes in with an iris, a
 * panel rising or a diagonal wipe) and the words slam in as they are said; a counter when it has a
 * value. It leaves by sliding up, uncovering the video.
 */
function scene(k: Ctx): void {
  const { ctx, c, W, H } = k;
  const bg = c.background ?? '#F4F1EA';
  const dark = lightness(bg) < 0.45;
  // Words that would vanish on the background get a colour that reads.
  const ink = Math.abs(lightness(c.color) - lightness(bg)) < 0.35 ? (dark ? '#FFFFFF' : '#121212') : c.color;
  const inS = Math.min(0.32, k.d * 0.25);
  const outS = Math.min(0.3, k.d * 0.2);
  const pin = cubicOut(k.t / inS);
  const pout = cubicIn((k.t - (k.d - outS)) / outS);
  const variant = rng(`${c.id}:v`)() * 3;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Leaving: everything slides up and off.
  if (pout > 0) ctx.translate(0, -H * pout);
  ctx.beginPath();
  if (variant < 1) ctx.arc(W / 2, H / 2, Math.hypot(W, H) * 0.52 * pin, 0, Math.PI * 2);
  else if (variant < 2) ctx.rect(0, H * (1 - pin), W, H * pin);
  else {
    const x = lerp(-W * 0.6, W * 1.05, pin);
    ctx.moveTo(-W, 0);
    ctx.lineTo(x + W * 0.5, 0);
    ctx.lineTo(x, H);
    ctx.lineTo(-W, H);
    ctx.closePath();
  }
  ctx.clip();
  sceneBackground(k, bg, ink);
  floaters(k, ink, 1);
  // A slow push on the words while they are on.
  const push = 1 + 0.04 * clamp(k.t / Math.max(0.5, k.d));
  ctx.translate(W / 2, H / 2);
  ctx.scale(push, push);
  const maxW = W * 0.84;
  if (c.value !== undefined) sceneCounter(k, ink, maxW);
  else sceneWords(k, ink, dark, maxW);
  ctx.restore();
}

/** Backdrop: a full-screen living background (under a framed video or a graphic), with the words as a giant faint drift behind. */
function backdrop(k: Ctx): void {
  const { ctx, c, U, W, H } = k;
  const bg = c.background ?? '#0D0C12';
  const dark = lightness(bg) < 0.45;
  const ink = dark ? '#FFFFFF' : '#121212';
  const a = clamp(k.t / 0.3) * (1 - clamp((k.t - (k.d - 0.3)) / 0.3));
  if (a <= 0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= a;
  sceneBackground(k, bg, ink, 1.2);
  const word = c.text.trim().toUpperCase();
  if (word && word !== '-') {
    ctx.font = font(900, 30 * U, c.font);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const w = ctx.measureText(word).width + 20 * U;
    const x = -((k.t * 6 * U) % w);
    ctx.lineWidth = 0.3 * U;
    ctx.strokeStyle = rgba(ink, 0.13);
    for (let dx = x; dx < W; dx += w) ctx.strokeText(word, dx, H * 0.88);
  }
  floaters(k, ink, 0.8);
  ctx.restore();
}


// ---------------------------------------------------------------- newer pieces (2026 set)

/** News ticker: a label block and a band of text scrolling past. */
function ticker(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const w = Math.min(k.room, 92 * U);
  const h = 7.2 * U;
  const p = expoOut((t - 0.05) / 0.5);
  if (p <= 0) return;
  ctx.save();
  ctx.translate(0, bob(k, 0.15, 1));
  ctx.beginPath();
  ctx.rect(-w / 2, -h, w * p, h * 2);
  ctx.clip();
  ctx.fillStyle = 'rgba(10,10,16,0.88)';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.font = font(800, 3.2 * U, c.font);
  const label = (c.sub ?? 'LIVE').toUpperCase();
  const lw = ctx.measureText(label).width + 5 * U;
  ctx.fillStyle = c.accent;
  ctx.fillRect(-w / 2, -h / 2, lw, h);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, -w / 2 + 2.5 * U, 0.2 * U);
  // The scrolling words, looping, clipped to the band.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2 + lw, -h / 2, w - lw, h);
  ctx.clip();
  ctx.font = font(600, 3.1 * U, BODY);
  const line = `${[c.text, ...(c.items ?? [])].join('   •   ')}   •   `;
  const lineW = ctx.measureText(line).width;
  const off = ((t * 9 * U) % lineW) || 0;
  ctx.fillStyle = c.color;
  for (let x = -w / 2 + lw + 2 * U - off; x < w / 2; x += lineW) ctx.fillText(line, x, 0.2 * U);
  ctx.restore();
  ctx.fillStyle = c.accent2;
  ctx.fillRect(-w / 2, h / 2 - 0.5 * U, w, 0.5 * U);
  ctx.restore();
}

/** Countdown: a big number counting down from value (default 3) inside a ring that empties. */
function countdown(k: Ctx): void {
  const { ctx, c, U, t, d } = k;
  const from = Math.max(1, Math.round(c.value ?? 3));
  const per = Math.max(0.3, (d - 0.4) / from);
  const i = Math.min(from - 1, Math.floor(t / per));
  const local = (t - i * per) / per;
  const n = from - i;
  const r = 15 * U;
  ctx.save();
  ctx.lineWidth = 1.6 * U;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = c.accent;
  ctx.shadowColor = c.accent;
  ctx.shadowBlur = 3 * U;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - local));
  ctx.stroke();
  ctx.shadowBlur = 0;
  const pop = backOut(Math.min(1, local / 0.3));
  ctx.scale(pop, pop);
  ctx.font = font(900, 16 * U, c.font);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.color;
  fillText(k, String(n), 0, 1 * U, true);
  ctx.restore();
  if (c.text && c.text !== String(from)) kicker(k, c.text, 0, r + 6 * U, cubicOut(t / 0.4));
}

/** Location: a map pin drops in, a ring ripples, and the place name slides out beside it. */
function location(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const drop = backOut(Math.min(1, t / 0.5), 2.2);
  const pinY = (1 - drop) * -18 * U;
  ctx.save();
  ctx.translate(-12 * U, bob(k, 0.3, 1.2));
  // Ripple on the ground.
  const rp = ((t - 0.4) % 1.6) / 1.6;
  if (t > 0.4) {
    ctx.strokeStyle = rgba(c.accent, 0.6 * (1 - rp));
    ctx.lineWidth = 0.5 * U;
    ctx.beginPath();
    ctx.ellipse(0, 6 * U, 3 * U + rp * 8 * U, (3 * U + rp * 8 * U) * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The pin.
  ctx.translate(0, pinY);
  ctx.fillStyle = c.accent;
  ctx.shadowColor = rgba(c.accent, 0.8);
  ctx.shadowBlur = 3 * U;
  ctx.beginPath();
  ctx.arc(0, -4 * U, 4 * U, Math.PI * 0.85, Math.PI * 0.15);
  ctx.lineTo(0, 6 * U);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(0, -4 * U, 1.6 * U, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // The label.
  const lp = expoOut((t - 0.45) / 0.6);
  if (lp <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-6 * U, -10 * U, 80 * U, 20 * U);
  ctx.clip();
  ctx.translate(-6 * U + (lp - 1) * 40 * U, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(800, 5 * U, c.font);
  ctx.fillStyle = c.color;
  fillText(k, c.text, 0, 0);
  if (c.sub) {
    ctx.font = font(600, 2.8 * U, BODY);
    ctx.fillStyle = rgba(c.color, 0.7);
    setLetterSpacing(ctx, 0.4 * U);
    ctx.fillText(c.sub.toUpperCase(), 0, 4.6 * U);
  }
  ctx.restore();
}

/** Subscribe: a pill button pops in, a pointer taps it, it turns to "Subscribed" with a bell ring. */
function subscribe(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const label = c.text || 'Subscribe';
  const pressed = t > 1.1;
  ctx.font = font(800, 4.2 * U, c.font);
  const tw = ctx.measureText(pressed ? (c.sub ?? 'Subscribed') : label).width;
  const w = tw + 16 * U;
  const h = 10 * U;
  const pop = backOut(Math.min(1, t / 0.45));
  const press = t > 0.95 && t < 1.15 ? 0.92 : 1;
  ctx.save();
  ctx.scale(pop * press, pop * press);
  ctx.shadowColor = rgba(pressed ? '#444444' : c.accent, 0.6);
  ctx.shadowBlur = 3 * U;
  ctx.fillStyle = pressed ? '#2A2A33' : c.accent;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pressed ? (c.sub ?? 'Subscribed') : label, 3 * U, 0.3 * U);
  // The bell, ringing once pressed.
  const ring = pressed ? Math.sin((t - 1.1) * 30) * Math.max(0, 1 - (t - 1.1) * 1.5) * 0.4 : 0;
  ctx.save();
  ctx.translate(-w / 2 + 5.5 * U, 0);
  ctx.rotate(ring);
  const p = iconPath('bell') ?? iconPath('speaker');
  if (p) {
    const s = (4.4 * U) / 24;
    ctx.translate(-12 * s, -12 * s);
    ctx.scale(s, s);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke(p);
  }
  ctx.restore();
  ctx.restore();
  // The pointer that taps it.
  const cp = cubicInOut((t - 0.4) / 0.55);
  if (t > 0.4 && t < 1.8) {
    const px = lerp(w * 0.9, w * 0.15, cp);
    const py = lerp(h * 1.6, h * 0.15, cp);
    ctx.save();
    ctx.translate(px, py);
    ctx.globalAlpha *= t > 1.5 ? Math.max(0, 1 - (t - 1.5) / 0.3) : 1;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 0.35 * U;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 6 * U);
    ctx.lineTo(1.6 * U, 4.6 * U);
    ctx.lineTo(3 * U, 7.4 * U);
    ctx.lineTo(4 * U, 6.9 * U);
    ctx.lineTo(2.6 * U, 4.2 * U);
    ctx.lineTo(4.6 * U, 4.2 * U);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (t > 0.95 && t < 1.35) {
      ctx.strokeStyle = rgba('#FFFFFF', 1 - (t - 0.95) / 0.4);
      ctx.beginPath();
      ctx.arc(0, 0, (t - 0.95) * 14 * U, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Chapters: the steps of the video as a row, the current one lit, a bar filling across. */
function progress(k: Ctx): void {
  const { ctx, c, U, t, d } = k;
  const items = c.items?.length ? c.items : ['Intro', 'Part 1', 'Part 2', 'End'];
  const cur = Math.max(0, Math.min(items.length - 1, Math.round(c.value ?? 1) - 1));
  const w = Math.min(k.room, 86 * U);
  const seg = w / items.length;
  const p = expoOut(t / 0.6);
  ctx.save();
  ctx.translate(0, bob(k, 0.2, 1));
  ctx.globalAlpha *= p;
  for (let i = 0; i < items.length; i++) {
    const x = -w / 2 + i * seg;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.roundRect(x + 0.6 * U, -0.8 * U, seg - 1.2 * U, 1.6 * U, 0.8 * U);
    ctx.fill();
    const fill = i < cur ? 1 : i === cur ? cubicInOut((t - 0.3) / Math.max(0.5, d - 0.9)) : 0;
    if (fill > 0) {
      ctx.fillStyle = c.accent;
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 2 * U;
      ctx.beginPath();
      ctx.roundRect(x + 0.6 * U, -0.8 * U, (seg - 1.2 * U) * fill, 1.6 * U, 0.8 * U);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.font = font(i === cur ? 800 : 600, 2.8 * U, i === cur ? c.font : BODY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = i === cur ? c.color : rgba(c.color, 0.55);
    ctx.fillText(items[i]!, x + 0.8 * U, -3 * U);
  }
  ctx.restore();
}

/** Split title: the top line slides in from the left, the bottom from the right, a bar between. */
function splitTitle(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const top = c.text;
  const bottom = c.sub ?? '';
  const size = fitSize(ctx, top.length > bottom.length ? top : bottom, 900, c.font, 9 * U, Math.min(k.room, 90 * U), 1);
  const a = expoOut((t - 0.05) / 0.6);
  const b = expoOut((t - 0.2) / 0.6);
  const bar = cubicInOut((t - 0.1) / 0.5);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(900, size, c.font);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-60 * U, -size * 1.1, 120 * U, size * 1.1);
  ctx.clip();
  ctx.fillStyle = c.color;
  ctx.fillText(top.toUpperCase(), (a - 1) * 50 * U, -1.2 * U);
  ctx.restore();
  ctx.fillStyle = c.accent;
  ctx.shadowColor = c.accent;
  ctx.shadowBlur = 2 * U;
  const bw = Math.min(k.room, 70 * U) * bar;
  ctx.fillRect(-bw / 2, -0.4 * U, bw, 0.8 * U);
  ctx.shadowBlur = 0;
  if (bottom) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-60 * U, 0, 120 * U, size * 1.2);
    ctx.clip();
    ctx.font = font(400, size * 0.82, 'Instrument Serif');
    ctx.fillStyle = c.accent2;
    ctx.fillText(bottom, (1 - b) * 50 * U, size * 0.95);
    ctx.restore();
  }
  ctx.restore();
}

/** Price tag: a starburst badge pops in with the price; the old price (sub) is struck through. */
function priceTag(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const pop = backOut(Math.min(1, t / 0.5), 2);
  const r = 16 * U;
  ctx.save();
  ctx.rotate(-0.12 + Math.sin(t * 1.4) * 0.03);
  ctx.scale(pop, pop);
  ctx.fillStyle = c.accent;
  ctx.shadowColor = rgba(c.accent, 0.7);
  ctx.shadowBlur = 4 * U;
  ctx.beginPath();
  for (let i = 0; i < 32; i++) {
    const rr = i % 2 ? r * 0.86 : r;
    const a = (i / 32) * Math.PI * 2 + t * 0.4;
    if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.color;
  ctx.font = font(900, 8 * U, c.font);
  const price = c.value !== undefined ? `${c.unit ?? '$'}${c.value}` : c.text;
  ctx.fillText(price, 0, c.sub ? 1 * U : 0.5 * U);
  if (c.sub) {
    ctx.font = font(700, 3 * U, BODY);
    ctx.fillStyle = rgba(c.color, 0.75);
    const ow = ctx.measureText(c.sub).width;
    ctx.fillText(c.sub, 0, -6.5 * U);
    ctx.strokeStyle = rgba(c.color, 0.9);
    ctx.lineWidth = 0.4 * U;
    ctx.beginPath();
    ctx.moveTo(-ow / 2, -6.5 * U);
    ctx.lineTo(ow / 2, -6.5 * U);
    ctx.stroke();
  }
  if (c.value !== undefined && c.text) {
    ctx.font = font(700, 2.6 * U, BODY);
    ctx.fillStyle = c.color;
    ctx.fillText(c.text.toUpperCase(), 0, 7.6 * U);
  }
  ctx.restore();
}

/** Social post: a glass card with an avatar, the handle, the post and a like count ticking up. */
function socialCard(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const w = Math.min(k.room, 64 * U);
  ctx.font = font(500, 3.4 * U, BODY);
  const lines = wrap(ctx, c.text.split(/\s+/), w - 10 * U).slice(0, 4);
  const h = 21 * U + lines.length * 4.6 * U;
  const p = backOut(Math.min(1, t / 0.55), 1.4);
  ctx.save();
  ctx.translate(0, (1 - p) * 10 * U + bob(k, 0.4, 1.1));
  ctx.globalAlpha *= Math.min(1, t / 0.3);
  glass(k, -w / 2, -h / 2, w, h, 3 * U);
  const ax = -w / 2 + 7 * U;
  const ay = -h / 2 + 7 * U;
  const g = ctx.createLinearGradient(ax - 3 * U, ay - 3 * U, ax + 3 * U, ay + 3 * U);
  g.addColorStop(0, c.accent2);
  g.addColorStop(1, c.accent);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(ax, ay, 3.4 * U, 0, Math.PI * 2);
  ctx.fill();
  const handle = c.sub ?? '@you';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(800, 2.6 * U, BODY);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(handle.replace(/^@/, '').slice(0, 1).toUpperCase(), ax, ay + 0.2 * U);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(800, 3.2 * U, c.font);
  ctx.fillText(handle, ax + 5 * U, ay + 1 * U);
  ctx.font = font(500, 3.4 * U, BODY);
  ctx.fillStyle = rgba(c.color, 0.92);
  lines.forEach((l, i) => ctx.fillText(l.join(' '), -w / 2 + 5 * U, ay + 9 * U + i * 4.6 * U));
  // Likes counting up.
  const likes = Math.round((c.value ?? 1200) * cubicOut((t - 0.5) / 1.4));
  ctx.font = font(700, 3 * U, BODY);
  ctx.fillStyle = '#FF4D8D';
  ctx.fillText(`♥ ${likes.toLocaleString('en-US')}`, -w / 2 + 5 * U, h / 2 - 3.4 * U);
  ctx.restore();
}

/** Camera viewfinder: corner brackets, a blinking REC dot and a running timecode over the shot. */
function viewfinder(k: Ctx, frame: { W: number; H: number }): void {
  const { ctx, c, U, t } = k;
  const w = frame.W * 0.86;
  const h = frame.H * 0.82;
  const a = Math.min(1, t / 0.4);
  const L = 6 * U;
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 0.5 * U;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.beginPath();
    ctx.moveTo((sx * w) / 2, (sy * h) / 2 - sy * L);
    ctx.lineTo((sx * w) / 2, (sy * h) / 2);
    ctx.lineTo((sx * w) / 2 - sx * L, (sy * h) / 2);
    ctx.stroke();
  }
  ctx.font = font(700, 3 * U, 'JetBrains Mono');
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (Math.floor(t * 2) % 2 === 0) {
    ctx.fillStyle = '#FF3B30';
    ctx.beginPath();
    ctx.arc(-w / 2 + 4 * U, -h / 2 + 4 * U, 1.1 * U, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = c.color;
  ctx.fillText(c.text || 'REC', -w / 2 + 6.5 * U, -h / 2 + 4.2 * U);
  const s = Math.floor(t);
  const tc = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(Math.floor((t % 1) * 30)).padStart(2, '0')}`;
  ctx.textAlign = 'right';
  ctx.fillText(tc, w / 2 - 3 * U, -h / 2 + 4.2 * U);
  if (c.sub) {
    ctx.textAlign = 'left';
    ctx.fillText(c.sub, -w / 2 + 3 * U, h / 2 - 4 * U);
  }
  // A small centre cross.
  ctx.globalAlpha *= 0.6;
  ctx.beginPath();
  ctx.moveTo(-2 * U, 0);
  ctx.lineTo(2 * U, 0);
  ctx.moveTo(0, -2 * U);
  ctx.lineTo(0, 2 * U);
  ctx.stroke();
  ctx.restore();
}

/** Glitch title: big words that arrive in digital slices with red and cyan fringes, then settle. */
function glitchTitle(k: Ctx): void {
  const { ctx, c, U, t } = k;
  const size = fitSize(ctx, c.text, 900, c.font, 11 * U, Math.min(k.room, 92 * U), 2);
  ctx.font = font(900, size, c.font);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const settle = Math.min(1, t / 0.7);
  const burst = t < 0.7 || (t % 2.2 > 2.0 && t < k.d - 0.4);
  const text = c.text.toUpperCase();
  ctx.save();
  if (burst) {
    const off = (1 - settle * 0.7) * 1.4 * U;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,40,90,0.85)';
    ctx.fillText(text, -off, 0);
    ctx.fillStyle = 'rgba(40,230,255,0.85)';
    ctx.fillText(text, off, 0);
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 4; i++) {
      const sy = (k.rand() - 0.5) * size;
      const sh = size * (0.06 + k.rand() * 0.12);
      ctx.save();
      ctx.beginPath();
      ctx.rect(-80 * U, sy, 160 * U, sh);
      ctx.clip();
      ctx.fillStyle = c.color;
      ctx.fillText(text, (k.rand() - 0.5) * 6 * U, 0);
      ctx.restore();
    }
  }
  ctx.globalAlpha *= settle;
  ctx.fillStyle = c.color;
  ctx.fillText(text, 0, 0);
  if (c.sub) kicker(k, c.sub, 0, size * 0.85, cubicOut((t - 0.4) / 0.4));
  ctx.restore();
}

const PIECES: Record<MotionClip['piece'], (k: Ctx, frame: { W: number; H: number }) => void> = {
  headline,
  word_pop: wordPop,
  icon_burst: iconBurst,
  chips,
  stat,
  list,
  lower_third: lowerThird,
  quote,
  card3d,
  highlight,
  callout,
  light_sweep: lightSweep,
  scene,
  backdrop,
  ticker,
  countdown,
  location,
  subscribe,
  progress,
  split_title: splitTitle,
  price_tag: priceTag,
  social_card: socialCard,
  viewfinder,
  glitch_title: glitchTitle,
  // A 3D explanation: Keo's scene viewer draws it; here it is copied onto the frame.
  scene3d: (k, frame) => drawScene3d(k.ctx, k.c, k.t, frame.W, frame.H),
  // Keo's own design: its layers carry their own entrances and exits.
  design: (k, frame) => {
    if (k.c.design) drawDesign(k.ctx, k.c.design, k.t, k.d, frame.W, frame.H, k.c.id);
  },
};

/** Draws a motion clip at timeline time t (m: its place and motion from motionAt). */
export function drawMotionClip(ctx: CanvasRenderingContext2D, c: MotionClip, m: MotionState, t: number, W: number, H: number): void {
  const lt = t - c.start;
  const scale = Math.max(0.05, Math.abs(m.scaleX));
  // Beside the speaker (off the middle of a wide frame): it keeps out of the middle too.
  const off = Math.abs(m.x - 0.5);
  const half = W > H * 1.1 && off > 0.12 ? Math.min(off - 0.06, m.x, 1 - m.x) : Math.min(m.x, 1 - m.x);
  const room = (Math.max(0.3, 2 * half) * W * 0.92) / scale;
  const k: Ctx = { ctx, c, t: lt, d: c.duration, U: Math.min(W, H) / 100, W, H, room: Math.min(room, (W * 0.9) / scale), rand: rng(c.id) };
  // Every piece goes out the same way: up and away, fading (light sweeps end on their own).
  const out = c.piece === 'light_sweep' || c.piece === 'scene' || c.piece === 'backdrop' || c.piece === 'scene3d' || c.piece === 'design' ? 0 : exitP(k);
  const alpha = m.opacity * (1 - out);
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (m.blur > 0.3) ctx.filter = `blur(${m.blur.toFixed(1)}px)`;
  placeLayer(ctx, m, W, H);
  if (out > 0) {
    ctx.translate(0, -out * 4 * k.U);
    const s = 1 - out * 0.06;
    ctx.scale(s, s);
  }
  PIECES[c.piece](k, { W, H });
  ctx.restore();
}

/** Roughly how big a motion clip is at its full size (for selecting and moving it on the preview). */
export function motionBox(c: MotionClip, W: number, H: number): { w: number; h: number } {
  const U = Math.min(W, H) / 100;
  const len = c.text.length;
  switch (c.piece) {
    case 'light_sweep':
    case 'scene':
    case 'backdrop':
    case 'scene3d':
    case 'viewfinder':
    case 'design':
      return { w: W / Math.max(0.01, c.transform.scale), h: H / Math.max(0.01, c.transform.scale) };
    case 'ticker':
    case 'progress':
      return { w: Math.min(W * 0.92, 92 * U), h: 12 * U };
    case 'countdown':
    case 'price_tag':
      return { w: 36 * U, h: 40 * U };
    case 'social_card':
      return { w: 66 * U, h: 36 * U };
    case 'word_pop':
      return { w: Math.min(W * 0.9, len * 9 * U + 10 * U), h: 26 * U };
    case 'icon_burst':
      return { w: 50 * U, h: 40 * U };
    case 'chips':
    case 'list':
      return { w: 55 * U, h: (c.items?.length ?? 1) * 10 * U + 14 * U };
    case 'stat':
      return { w: 50 * U, h: 40 * U };
    case 'lower_third':
      return { w: Math.max(30 * U, len * 2.8 * U + 10 * U), h: 14 * U };
    case 'quote':
      return { w: Math.min(W * 0.78, 72 * U), h: 34 * U };
    case 'card3d':
      return { w: Math.max(38 * U, len * 3 * U + 12 * U), h: 40 * U };
    case 'callout':
      return { w: len * 2.3 * U + 30 * U, h: 30 * U };
    default:
      return { w: Math.min(W * 0.86, len * 5 * U + 10 * U), h: 24 * U };
  }
}
