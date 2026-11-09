import { clipEnd, EASES, sourceSpan, trackTransition, zoomAt, type AdjustClip, type Asset, type Blend, type MediaClip, type MotionClip, type Project, type ShapeClip, type TextClip, type Transition } from '@shared/studio';
import { drawTilted, glassSheen } from './perspective';
import { counterText, motionAt, type MotionState } from '@shared/studioMotion';
import { clipReveal, placeLayer } from './motion';
import { chromaKey } from './chroma';
import { cutout } from './cutout';
import { drawEffects } from './effects';
import { drawMotionClip, motionBox } from './motionPieces';
import { drawDevice, drawNotch, drawShape } from './shapes';

/**
 * Keo Studio's picture engine: draws the project as it looks at one moment. The Studio preview and
 * the export (and the frames Keo looks at to check its work) all draw with this, so what the user
 * sees is exactly what is exported.
 *
 * Everything is relative to the canvas: positions are fractions of its size and text sizes a
 * percentage of its height, so a small preview and a full-size export look the same.
 */

/** Something drawable for a media clip at a moment of its source (a video frame, a picture). */
export type Drawable = CanvasImageSource & { readonly displayWidth?: number; readonly displayHeight?: number };

export interface SourceProvider {
  /** The picture of `clip` at `sourceTime` seconds into its media, or null if not ready yet. */
  frame(clip: MediaClip, asset: Asset, sourceTime: number): Drawable | null;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const backOut = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

function sizeOf(src: Drawable): { w: number; h: number } {
  const s = src as unknown as { displayWidth?: number; displayHeight?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  return { w: s.displayWidth || s.videoWidth || s.naturalWidth || (s.width as number) || 1, h: s.displayHeight || s.videoHeight || s.naturalHeight || (s.height as number) || 1 };
}

/** Where in its source a media clip is at timeline time t. */
export function sourceTime(c: MediaClip, asset: Asset, t: number): number {
  if (asset.kind === 'image') return 0;
  if (c.freeze) return Math.max(0, Math.min(asset.duration, c.in));
  // Backwards: the clip's last frame first (a hair before each frame's end, so it is that frame).
  if (c.reversed) return Math.max(c.in, Math.min(asset.duration, c.in + sourceSpan(c, c.duration) - sourceSpan(c, t - c.start) - 0.001));
  return Math.max(0, Math.min(asset.duration, c.in + sourceSpan(c, t - c.start)));
}

/** The fade (0..1) of a clip with fade-in/out seconds at timeline time t. */
export function fadeAt(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, t: number): number {
  let a = 1;
  if (c.fadeIn > 0) a = Math.min(a, clamp((t - c.start) / c.fadeIn));
  if (c.fadeOut > 0) a = Math.min(a, clamp((clipEnd(c) - t) / c.fadeOut));
  return a;
}

/** The visible clips at time t, bottom layer first. */
export function visibleAt(p: Project, t: number): Array<MediaClip | TextClip | ShapeClip | MotionClip> {
  return layersAt(p, t).filter((c): c is MediaClip | TextClip | ShapeClip | MotionClip => c.type !== 'adjust');
}

/** Everything drawn at time t, bottom layer first: the visible clips and adjustment layers. */
export function layersAt(p: Project, t: number): Array<MediaClip | TextClip | ShapeClip | AdjustClip | MotionClip> {
  const out: Array<MediaClip | TextClip | ShapeClip | AdjustClip | MotionClip> = [];
  for (const tr of p.tracks) {
    if (tr.hidden || tr.kind === 'audio') continue;
    // During a transition both clips show: the one going out under the one coming in.
    const x = tr.kind === 'video' ? trackTransition(tr, t) : null;
    for (const c of tr.clips) if (c.type !== 'audio' && c !== x?.out && c !== x?.in && t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) out.push(c);
    if (x) out.push(x.out, x.in);
  }
  return out;
}

/** Each clip's part in a transition under way at t (going out or coming in, and how far along). */
export function transitionRoles(p: Project, t: number): Map<string, { as: 'out' | 'in'; p: number; kind: Transition['kind'] }> {
  const roles = new Map<string, { as: 'out' | 'in'; p: number; kind: Transition['kind'] }>();
  for (const tr of p.tracks) {
    if (tr.hidden || tr.kind !== 'video') continue;
    const x = trackTransition(tr, t);
    if (!x) continue;
    roles.set(x.out.id, { as: 'out', p: x.p, kind: x.kind });
    roles.set(x.in.id, { as: 'in', p: x.p, kind: x.kind });
  }
  return roles;
}

export function drawFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, sources: SourceProvider): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = p.background.slice(0, 7);
  ctx.fillRect(0, 0, W, H);
  const roles = transitionRoles(p, t);
  let flash = 0;
  for (const c of layersAt(p, t)) {
    if (c.type === 'adjust') drawAdjust(ctx, c, t, W, H);
    else if (c.type === 'media') {
      const a = p.assets.find((x) => x.id === c.assetId);
      if (!a) continue;
      const role = roles.get(c.id);
      // Flash and dip change over at the middle: before it only the old clip, after it only the new one.
      if (role && (role.kind === 'flash' || role.kind === 'dip') && ((role.as === 'out' && role.p >= 0.5) || (role.as === 'in' && role.p < 0.5))) continue;
      const src = sources.frame(c, a, sourceTime(c, a, t));
      if (src) drawMedia(ctx, c, src, role ? 1 : fadeAt(c, t), t, W, H, role);
      if (role?.as === 'in' && (role.kind === 'flash' || role.kind === 'dip')) flash = role.kind === 'flash' ? 1 - Math.abs(role.p - 0.5) * 2 : -(1 - Math.abs(role.p - 0.5) * 2);
    } else if (c.type === 'shape') drawShape(ctx, c, motionAt(c, t, H), W, H);
    else if (c.type === 'motion') drawMotionClip(ctx, c, motionAt(c, t, H), t, W, H);
    else drawText(ctx, c, t, W, H);
  }
  // Flash: white at the cut; dip: black at the cut.
  if (flash !== 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.abs(flash));
    ctx.fillStyle = flash > 0 ? '#FFFFFF' : '#000000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  ctx.restore();
}

/** Where a picture of w×h goes: its drawn size, and (cover) the part of it that is shown. */
function fitBox(fit: MediaClip['fit'], w: number, h: number, bw: number, bh: number): { dw: number; dh: number } {
  const k = fit === 'cover' ? Math.max(bw / w, bh / h) : Math.min(bw / w, bh / h);
  return { dw: w * k, dh: h * k };
}

/**
 * A video or picture of w×h in a W×H frame: the size it is drawn at (dw×dh), the part that shows
 * (vw×vh: a device's screen or a mask cuts it), before the layer's own scale.
 */
function mediaBox(c: MediaClip, w: number, h: number, W: number, H: number): { dw: number; dh: number; vw: number; vh: number; inDevice: boolean } {
  let bw = W;
  let bh = H;
  if (c.frame === 'phone') {
    bh = H * 0.78;
    bw = (bh * 9) / 19.5;
  } else if (c.frame === 'browser' || c.frame === 'card') {
    const f = fitBox('contain', w, h, W * 0.82, H * 0.7);
    bw = f.dw;
    bh = f.dh;
  }
  const inDevice = !!c.frame;
  const fit = inDevice ? (c.frame === 'phone' ? 'cover' : 'contain') : c.fit;
  let { dw, dh } = fitBox(fit, w, h, bw, bh);
  // A circle mask shows a square of the picture (avatars).
  if (c.mask?.shape === 'circle' && !inDevice) {
    // The circle's size depends only on the frame and the layer's scale, whatever the photo's shape.
    const side = Math.min(W, H);
    bw = side;
    bh = side;
    ({ dw, dh } = fitBox('cover', w, h, side, side));
  }
  // The visible box (media drawn larger than it is cut to it). A rounded picture shown whole is a
  // card of its own shape (no empty frame-shaped card around it).
  const frameBox = inDevice || (!!c.mask && !(c.mask.shape === 'rounded' && fit === 'contain'));
  return { dw, dh, vw: frameBox ? bw : dw, vh: frameBox ? bh : dh, inDevice };
}

/**
 * mediaBox for a file of fw×fh with the clip's crop. A picture shown whole (contain) keeps its size
 * when cropped: the edges are cut off and the rest stays where it was (ox, oy: how far its middle
 * moves). Anything else fills its box with the part that is left, as before.
 */
function croppedBox(c: MediaClip, fw: number, fh: number, W: number, H: number): { dw: number; dh: number; vw: number; vh: number; inDevice: boolean; ox: number; oy: number } {
  const cr = c.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const keepW = Math.max(0.01, 1 - cr.left - cr.right);
  const keepH = Math.max(0.01, 1 - cr.top - cr.bottom);
  const whole = c.fit === 'contain' && !c.frame && c.mask?.shape !== 'circle';
  if (!c.crop || !whole) return { ...mediaBox(c, fw * keepW, fh * keepH, W, H), ox: 0, oy: 0 };
  const b = mediaBox(c, fw, fh, W, H);
  const dw = b.dw * keepW;
  const dh = b.dh * keepH;
  return { dw, dh, vw: dw, vh: dh, inDevice: false, ox: ((cr.left - cr.right) / 2) * b.dw, oy: ((cr.top - cr.bottom) / 2) * b.dh };
}

/** A flat card drawn before it is turned in 3D (reused between frames). */
let cardCanvas: OffscreenCanvas | null = null;

/** A copy of what is drawn so far (an adjustment layer changes it). */
let under: OffscreenCanvas | null = null;

/** An adjustment layer: everything under it, graded, blurred and with effects, mixed in by its strength. */
function drawAdjust(ctx: CanvasRenderingContext2D, c: AdjustClip, t: number, W: number, H: number): void {
  const amount = clamp(c.strength * fadeAt(c, t));
  const g = c.color;
  const graded = !!(g && (g.exposure || g.contrast || g.saturation));
  if (amount <= 0 || !(graded || c.blur > 0 || g?.temperature || g?.vignette || c.effects)) return;
  if (!under || under.width !== W || under.height !== H) under = new OffscreenCanvas(W, H);
  const u = under.getContext('2d')!;
  u.clearRect(0, 0, W, H);
  u.drawImage(ctx.canvas, 0, 0);
  const src = under as unknown as Drawable;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = amount;
  const filters: string[] = [];
  if (graded) filters.push(`brightness(${(1 + g!.exposure * 0.6).toFixed(3)}) contrast(${(1 + g!.contrast * 0.5).toFixed(3)}) saturate(${(1 + g!.saturation).toFixed(3)})`);
  if (c.blur > 0) filters.push(`blur(${((c.blur / 100) * H).toFixed(1)}px)`);
  const paint = (cx: CanvasRenderingContext2D) => cx.drawImage(under!, 0, 0, W, H);
  if (filters.length) {
    ctx.filter = filters.join(' ');
    paint(ctx);
    ctx.filter = 'none';
  }
  if (c.effects) drawEffects(ctx, c.effects, src, paint, 0, 0, W, H, t, H);
  if (g?.temperature) {
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = clamp(Math.abs(g.temperature) * 0.55 * amount);
    ctx.fillStyle = g.temperature > 0 ? '#FF8A1E' : '#1E7BFF';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (g?.vignette) {
    const r = Math.hypot(W, H) / 2;
    const v = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${(g.vignette * 0.85).toFixed(3)})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/** Blend modes as the canvas names them. */
const BLEND_OP: Record<Blend, GlobalCompositeOperation> = { normal: 'source-over', screen: 'screen', multiply: 'multiply', overlay: 'overlay', lighten: 'lighten', darken: 'darken', add: 'lighter', difference: 'difference' };

function drawMedia(ctx: CanvasRenderingContext2D, c: MediaClip, original: Drawable, fade: number, t: number, W: number, H: number, role?: { as: 'out' | 'in'; p: number; kind: Transition['kind'] }): void {
  const full = sizeOf(original);
  // Green screen: the keyed picture (same size) is drawn instead of the original.
  // AI background removal: the same, with only the people kept.
  const keyed = c.chroma ? chromaKey(original, full.w, full.h, c.chroma) : c.cutout ? cutout(original, full.w, full.h) : null;
  const src: Drawable = keyed ? (keyed as unknown as Drawable) : original;
  const kx = keyed ? keyed.width / full.w : 1;
  // Cropped: only the part inside the crop is drawn (and sized).
  const cr = c.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const sx = full.w * cr.left;
  const sy = full.h * cr.top;
  const w = Math.max(1, full.w * (1 - cr.left - cr.right));
  const h = Math.max(1, full.h * (1 - cr.top - cr.bottom));
  const rt = t - c.start;
  const m = motionAt(c, t, H);
  if (role) {
    // The change from one clip to the next.
    const e = EASES['in-out'](role.p);
    const out = role.as === 'out';
    switch (role.kind) {
      case 'crossfade':
        if (!out) m.opacity *= e;
        break;
      case 'slide':
        if (!out) m.x += 1 - e;
        break;
      case 'push':
        m.x += out ? -e : 1 - e;
        break;
      case 'zoom':
        if (out) {
          m.scaleX *= 1 + e * 0.6;
          m.scaleY *= 1 + e * 0.6;
          m.opacity *= 1 - e;
        } else {
          m.scaleX *= 0.7 + 0.3 * e;
          m.scaleY *= 0.7 + 0.3 * e;
          m.opacity *= e;
        }
        break;
      case 'whip':
        m.x += out ? -e * 1.1 : (1 - e) * 1.1;
        m.blur += Math.sin(Math.PI * role.p) * H * 0.05;
        break;
      case 'wipe':
        if (!out) m.reveal = { kind: 'wipe-right', p: e };
        break;
      case 'blur':
        m.blur += (out ? e : 1 - e) * H * 0.04;
        if (!out) m.opacity *= e;
        break;
      default:
        break;
    }
  }
  const { dw, dh, vw, vh, inDevice, ox, oy } = croppedBox(c, full.w, full.h, W, H);
  ctx.save();
  ctx.globalAlpha = clamp(m.opacity * fade);
  if (c.blend) ctx.globalCompositeOperation = BLEND_OP[c.blend];
  if (c.backdrop === 'blur' && !inDevice) {
    // The empty part of the frame: the same picture filling it, blurred and darker.
    const cover = fitBox('cover', w, h, W, H);
    ctx.save();
    ctx.filter = `blur(${Math.round(H * 0.035)}px) brightness(0.7) saturate(1.15)`;
    const grow = 1.12;
    if (c.crop) ctx.drawImage(src, sx * kx, sy * kx, w * kx, h * kx, W / 2 - (cover.dw * grow) / 2, H / 2 - (cover.dh * grow) / 2, cover.dw * grow, cover.dh * grow);
    else ctx.drawImage(src, W / 2 - (cover.dw * grow) / 2, H / 2 - (cover.dh * grow) / 2, cover.dw * grow, cover.dh * grow);
    ctx.restore();
  }
  // Punch-ins: the whole layer is scaled around the zoom's centre point of the frame.
  const z = zoomAt(c.zooms, rt);
  if (z.scale !== 1) {
    ctx.translate(z.x * W, z.y * H);
    ctx.scale(z.scale, z.scale);
    ctx.translate(-z.x * W, -z.y * H);
  }
  placeLayer(ctx, m, W, H);
  // A cropped picture shown whole: what is left stays where it was.
  if (ox || oy) ctx.translate(ox, oy);
  clipReveal(ctx, m, vw * 1.2, vh * 1.2);
  ctx.imageSmoothingQuality = 'high';
  // A turn in 3D or a glass finish: the card is drawn flat first, then turned in perspective.
  const tilted = !inDevice && (Math.abs(m.tiltX) > 0.05 || Math.abs(m.tiltY) > 0.05 || !!c.glass);
  const drawCard = (cx: CanvasRenderingContext2D, withShadow: boolean) => {
    let radius = 0;
    if (c.frame) radius = drawDevice(cx, c.frame, vw, vh, H);
    if (c.mask && !inDevice) radius = c.mask.shape === 'circle' ? vw / 2 : Math.min(vw, vh) * c.mask.radius;
    const shaped = inDevice || !!c.mask;
    if (withShadow && c.shadow > 0 && !inDevice) {
      // A drop shadow of the layer's shape.
      cx.save();
      cx.shadowColor = 'rgba(0,0,0,0.55)';
      cx.shadowBlur = (c.shadow / 40) * H * 0.05;
      cx.shadowOffsetY = (c.shadow / 160) * H * 0.05;
      cx.fillStyle = '#000000';
      cx.beginPath();
      cx.roundRect(-vw / 2, -vh / 2, vw, vh, radius);
      cx.fill();
      cx.restore();
    }
    if (shaped) {
      cx.save();
      cx.beginPath();
      cx.roundRect(-vw / 2, -vh / 2, vw, vh, radius);
      cx.clip();
    }
    const g = c.color;
    const filters: string[] = [];
    if (g && (g.exposure || g.contrast || g.saturation)) filters.push(`brightness(${(1 + g.exposure * 0.6).toFixed(3)}) contrast(${(1 + g.contrast * 0.5).toFixed(3)}) saturate(${(1 + g.saturation).toFixed(3)})`);
    if (m.blur > 0.3) filters.push(`blur(${m.blur.toFixed(1)}px)`);
    if (filters.length) cx.filter = filters.join(' ');
    const paint = (cx: CanvasRenderingContext2D) => {
      // Mirrored: only the picture flips (its frame, mask and shadow stay put).
      if (c.flipX || c.flipY) {
        cx.save();
        cx.scale(c.flipX ? -1 : 1, c.flipY ? -1 : 1);
      }
      if (c.crop) cx.drawImage(src, sx * kx, sy * kx, w * kx, h * kx, -dw / 2, -dh / 2, dw, dh);
      else cx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      if (c.flipX || c.flipY) cx.restore();
    };
    paint(cx);
    cx.filter = 'none';
    if (c.effects) drawEffects(cx, c.effects, src, paint, -(shaped ? vw : dw) / 2, -(shaped ? vh : dh) / 2, shaped ? vw : dw, shaped ? vh : dh, t, H);
    if (m.flash > 0) {
      cx.save();
      cx.globalAlpha = clamp(m.flash) * m.opacity;
      cx.fillStyle = '#FFFFFF';
      cx.fillRect(-vw / 2, -vh / 2, vw, vh);
      cx.restore();
    }
    if (g?.temperature) {
      // Warmer or cooler: an orange or blue wash, blended softly into the picture.
      cx.save();
      cx.globalCompositeOperation = 'soft-light';
      cx.globalAlpha = clamp(Math.abs(g.temperature) * 0.55 * m.opacity * fade);
      cx.fillStyle = g.temperature > 0 ? '#FF8A1E' : '#1E7BFF';
      cx.fillRect(-dw / 2, -dh / 2, dw, dh);
      cx.restore();
    }
    if (g?.vignette) {
      const r = Math.hypot(dw, dh) / 2;
      const v = cx.createRadialGradient(0, 0, r * 0.45, 0, 0, r);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, `rgba(0,0,0,${(g.vignette * 0.85).toFixed(3)})`);
      cx.fillStyle = v;
      cx.fillRect(-dw / 2, -dh / 2, dw, dh);
    }
    if (c.glass && !inDevice) glassSheen(cx, vw, vh, radius, m.tiltY);
    if (shaped) cx.restore();
    if (c.frame === 'phone') drawNotch(cx, vw, vh);
  };
  if (!tilted) drawCard(ctx, true);
  else {
    const cw = Math.ceil(vw) + 2;
    const ch = Math.ceil(vh) + 2;
    if (!cardCanvas || cardCanvas.width < cw || cardCanvas.height < ch) cardCanvas = new OffscreenCanvas(Math.max(cw, cardCanvas?.width ?? 0), Math.max(ch, cardCanvas?.height ?? 0));
    const cc = cardCanvas.getContext('2d')!;
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.clearRect(0, 0, cardCanvas.width, cardCanvas.height);
    cc.globalAlpha = 1;
    cc.translate(cw / 2, ch / 2);
    drawCard(cc as unknown as CanvasRenderingContext2D, false);
    // A soft shadow and glow under the floating panel.
    // Glass: a coloured light behind the panel, as if it glowed onto the backdrop.
    if (c.glass) {
      ctx.save();
      ctx.filter = `blur(${Math.round(H * 0.06)}px)`;
      ctx.globalAlpha *= 0.55;
      const glow = ctx.createLinearGradient(-vw / 2, 0, vw / 2, 0);
      glow.addColorStop(0, 'rgba(139,107,255,0.9)');
      glow.addColorStop(1, 'rgba(95,212,255,0.8)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.roundRect(-vw * 0.56, -vh * 0.5, vw * 1.12, vh * 1.08, Math.min(vw, vh) * 0.25);
      ctx.fill();
      ctx.restore();
    }
    if (c.shadow > 0 || c.glass) {
      ctx.save();
      ctx.filter = `blur(${Math.round(H * 0.03)}px)`;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(-vw * 0.42, -vh * 0.4 + vh * 0.06, vw * 0.84, vh * 0.84, Math.min(vw, vh) * 0.06);
      ctx.fill();
      ctx.restore();
    }
    drawTilted(ctx, cardCanvas, cw, ch, m.tiltX, m.tiltY);
  }
  ctx.restore();
}


interface Word {
  text: string;
  /** Index among the clip's spoken words (for timed captions). */
  index: number;
  x: number;
  width: number;
  /** Its own font (rich text marks), size in pixels and colour (null: the text's). */
  font: string;
  size: number;
  color: string | null;
}
interface Line {
  words: Word[];
  width: number;
  /** The biggest word's size, and where the line's baseline is below the top of the block. */
  size: number;
  y: number;
}

const FONT_WEIGHT = { normal: 400, bold: 700, black: 900 } as const;

/**
 * The fonts a project's text uses, loaded before anything is drawn (a canvas draws a font that is
 * not loaded yet in a fallback font, so an export would come out wrong).
 */
export async function fontsReady(p: Project): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const want = new Set<string>();
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type === 'motion') {
        for (const wt of [600, 700, 800, 900]) want.add(`${wt} 64px "${c.font}"`);
        want.add('600 64px "Inter"');
        continue;
      }
      if (c.type !== 'text') continue;
      want.add(`${FONT_WEIGHT[c.style.weight]} 64px "${c.style.font}"`);
      for (const m of c.marks ?? []) want.add(`${m.italic ? 'italic ' : ''}${FONT_WEIGHT[m.weight ?? c.style.weight]} 64px "${m.font ?? c.style.font}"`);
    }
  await Promise.all([...want].map((f) => document.fonts.load(f).catch(() => [])));
}

/** Word-by-word entrances that move each word (the rest of 'words' is a fade). */
const WORD_MOVES = new Set<string>(['words-left', 'words-right', 'words-up', 'words-pop']);

/** How a word of a text is drawn: the text's style, or the rich text mark it is in. */
function wordStyle(st: TextClip['style'], marks: TextClip['marks'], i: number, px: number): { font: string; size: number; color: string | null; upper: boolean } {
  const m = marks?.find((x) => i >= x.from && i < x.to);
  const size = px * (m?.scale ?? 1);
  return { font: `${m?.italic ? 'italic ' : ''}${FONT_WEIGHT[m?.weight ?? st.weight]} ${size}px "${m?.font ?? st.font}", "Segoe UI", sans-serif`, size, color: m?.color ?? null, upper: m?.uppercase ?? st.uppercase };
}

/**
 * Words laid out in lines no wider than maxWidth (a new paragraph at each line break), each in its
 * own font and size; lines share a baseline and are as tall as their biggest word.
 */
function layout(ctx: CanvasRenderingContext2D, raw: string, st: TextClip['style'], marks: TextClip['marks'], px: number, maxWidth: number): { lines: Line[]; width: number; height: number } {
  const lines: Line[] = [];
  let index = 0;
  for (const para of raw.split(/\r?\n/)) {
    let line: Line = { words: [], width: 0, size: 0, y: 0 };
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const s = wordStyle(st, marks, index, px);
      const text = s.upper ? word.toUpperCase() : word;
      ctx.font = s.font;
      const w = ctx.measureText(text).width;
      const space = ctx.measureText(' ').width;
      const next = line.words.length ? line.width + space + w : w;
      if (line.words.length && next > maxWidth) {
        lines.push(line);
        line = { words: [], width: 0, size: 0, y: 0 };
      }
      const x = line.words.length ? line.width + space : 0;
      line.words.push({ text, index: index++, x, width: w, font: s.font, size: s.size, color: s.color });
      line.width = x + w;
      line.size = Math.max(line.size, s.size);
    }
    if (!line.size) line.size = px;
    lines.push(line);
  }
  let cursor = 0;
  for (const l of lines) {
    l.y = cursor + l.size * 0.85;
    cursor += l.size * st.lineHeight;
  }
  return { lines, width: Math.max(0, ...lines.map((l) => l.width)), height: cursor };
}

/** How far into its in-animation (0..1) and out-animation (1..0) a text clip is. */
function phases(c: TextClip, t: number): { pin: number; pout: number } {
  const s = Math.max(0.01, c.animSeconds);
  return { pin: c.animIn === 'none' ? 1 : clamp((t - c.start) / s), pout: c.animOut === 'none' ? 1 : clamp((clipEnd(c) - t) / s) };
}

/** Where a layer is on the canvas (pixels): its centre, size (with its scale) and rotation. */
export interface LayerBox {
  id: string;
  type: 'media' | 'text' | 'shape' | 'motion';
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** The visible layers' boxes at time t, bottom layer first (for selecting and moving them on the preview). */
export function layerBoxes(ctx: CanvasRenderingContext2D, p: Project, t: number, W: number, H: number): LayerBox[] {
  const out: LayerBox[] = [];
  for (const c of visibleAt(p, t)) {
    const m = motionAt(c, t, H);
    let w: number;
    let h: number;
    if (c.type === 'media') {
      const a = p.assets.find((x) => x.id === c.assetId);
      const b = croppedBox(c, a?.width || W, a?.height || H, W, H);
      w = b.vw;
      h = b.vh;
      if (b.ox || b.oy) {
        // The part that is left, where it is drawn (its offset turns and scales with the layer).
        const r = (m.rotation * Math.PI) / 180;
        const x = b.ox * m.scaleX;
        const y = b.oy * m.scaleY;
        out.push({ id: c.id, type: c.type, cx: m.x * W + x * Math.cos(r) - y * Math.sin(r), cy: m.y * H + x * Math.sin(r) + y * Math.cos(r), w: w * Math.abs(m.scaleX), h: h * Math.abs(m.scaleY), rotation: m.rotation });
        continue;
      }
    } else if (c.type === 'shape') {
      w = c.style.width * W;
      h = c.style.height * H;
    } else if (c.type === 'motion') {
      ({ w, h } = motionBox(c, W, H));
    } else {
      const st = c.style;
      const px = (st.sizePct / 100) * H;
      ctx.save();
      ctx.font = `${FONT_WEIGHT[st.weight]} ${px}px "${st.font}", "Segoe UI", sans-serif`;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${(st.letterSpacing * px) / 100}px`;
      const raw = c.counter ? counterText(c.counter, c.duration, c.duration) : c.text;
      const laid = layout(ctx, raw, st, c.marks, px, st.maxWidth * W);
      ctx.restore();
      w = Math.max(px, laid.width) + px * 0.4;
      h = laid.height + px * 0.3;
    }
    out.push({ id: c.id, type: c.type, cx: m.x * W, cy: m.y * H, w: w * Math.abs(m.scaleX), h: h * Math.abs(m.scaleY), rotation: m.rotation });
  }
  return out;
}

export function drawText(ctx: CanvasRenderingContext2D, c: TextClip, t: number, W: number, H: number): void {
  const st = c.style;
  const px = (st.sizePct / 100) * H;
  const raw = c.counter ? counterText(c.counter, t - c.start, c.duration) : c.text;
  const text = st.uppercase ? raw.toUpperCase() : raw;
  const m: MotionState = motionAt(c, t, H);
  ctx.save();
  ctx.font = `${FONT_WEIGHT[st.weight]} ${px}px "${st.font}", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'alphabetic';
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${(st.letterSpacing * px) / 100}px`;
  const baseFont = ctx.font;
  const laid = layout(ctx, raw, st, c.marks, px, st.maxWidth * W);
  ctx.font = baseFont;
  const lines = laid.lines;
  const blockH = laid.height;
  const blockW = Math.max(1, laid.width);
  const { pin, pout } = phases(c, t);

  // Whole-block animation (position, scale, opacity, blur).
  let alpha = m.opacity;
  let scale = 1;
  let dy = 0;
  let dx = 0;
  let turn = 0;
  let blur = m.blur;
  let wipe = 1;
  const e = easeOut(pin);
  switch (c.animIn) {
    case 'zoom':
      scale *= 1 + (1 - e) * 1.4;
      blur += (1 - e) * px * 0.25;
      alpha *= e;
      break;
    case 'wipe':
      wipe = Math.min(wipe, EASES['in-out'](pin));
      break;
    case 'fade':
      alpha *= e;
      break;
    case 'pop':
      scale *= pin < 1 ? 0.6 + 0.4 * backOut(pin) : 1;
      alpha *= clamp(pin * 3);
      break;
    case 'slide-up':
      dy += (1 - e) * 0.05 * H;
      alpha *= e;
      break;
    // In from a side: from the right moving left, from the left moving right, from above.
    case 'slide-left':
      dx += (1 - e) * 0.35 * W;
      alpha *= clamp(pin * 2.5);
      break;
    case 'slide-right':
      dx -= (1 - e) * 0.35 * W;
      alpha *= clamp(pin * 2.5);
      break;
    case 'slide-down':
      dy -= (1 - e) * 0.08 * H;
      alpha *= e;
      break;
    case 'spin':
      turn += (1 - e) * -180;
      scale *= 0.3 + 0.7 * e;
      alpha *= clamp(pin * 2);
      break;
    case 'bounce':
      scale *= pin < 1 ? EASES.bounce(pin) : 1;
      alpha *= clamp(pin * 4);
      break;
    case 'blur-in':
      blur += (1 - e) * px * 0.35;
      alpha *= e;
      scale *= 1 + (1 - e) * 0.05;
      break;
    default:
      break;
  }
  const o = easeOut(pout);
  switch (c.animOut) {
    case 'zoom':
      scale *= 1 + (1 - o) * 0.6;
      alpha *= o;
      break;
    case 'wipe':
      wipe = Math.min(wipe, EASES['in-out'](pout));
      break;
    case 'fade':
      alpha *= o;
      break;
    case 'pop':
      scale *= 0.85 + 0.15 * o;
      alpha *= o;
      break;
    case 'slide-down':
      dy += (1 - o) * 0.05 * H;
      alpha *= o;
      break;
    // Out to a side.
    case 'slide-left':
      dx -= (1 - o) * 0.35 * W;
      alpha *= clamp(pout * 2.5);
      break;
    case 'slide-right':
      dx += (1 - o) * 0.35 * W;
      alpha *= clamp(pout * 2.5);
      break;
    case 'slide-up':
      dy -= (1 - o) * 0.08 * H;
      alpha *= o;
      break;
    case 'blur-out':
      blur += (1 - o) * px * 0.35;
      alpha *= o;
      break;
    default:
      break;
  }
  if (alpha <= 0.001) {
    ctx.restore();
    return;
  }

  ctx.translate(m.x * W + dx, m.y * H + dy);
  if (m.rotation || turn) ctx.rotate(((m.rotation + turn) * Math.PI) / 180);
  ctx.scale(scale * m.scaleX, scale * m.scaleY);
  if (wipe < 1) {
    // Revealed from the left (in) or hidden to the right (out) through a moving edge.
    ctx.beginPath();
    ctx.rect(-blockW / 2 - px, -blockH / 2 - px, (blockW + px * 2) * wipe, blockH + px * 2);
    ctx.clip();
  }

  // How much of the text shows (typewriter), and each word's own reveal (words / timed captions).
  const totalChars = text.replace(/\s+/g, '').length;
  const shownChars = c.animIn === 'typewriter' ? Math.floor(pin * totalChars + 1e-6) : Infinity;
  const wordCount = lines.reduce((n, l) => n + l.words.length, 0);
  // Caption word times are seconds from the clip's start.
  const rt = t - c.start;
  const wordReveal = (wi: number): number => {
    if (c.animIn !== 'words' && !WORD_MOVES.has(c.animIn)) return 1;
    const timed = c.words?.[wi];
    if (timed) return clamp((rt - timed.start) / 0.22);
    const stagger = Math.min(0.2, (Math.max(0.2, c.animSeconds) * 1.6) / Math.max(1, wordCount));
    return clamp((t - c.start - wi * stagger) / 0.25);
  };
  const spoken = (wi: number) => {
    const w = c.words?.[wi];
    return !!w && rt >= w.start && rt < w.end;
  };

  const top = -blockH / 2;
  const basePx = px;
  const fillFor = (lineWidth: number): string | CanvasGradient => {
    if (!st.color2) return st.color;
    const left = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 - lineWidth : -lineWidth / 2;
    const g = ctx.createLinearGradient(left, 0, left + lineWidth, 0);
    g.addColorStop(0, st.color);
    g.addColorStop(1, st.color2);
    return g;
  };

  const perLetter = c.animIn === 'letters' || c.animIn === 'drop' || c.animIn === 'wave';
  const letterCount = Math.max(1, text.replace(/\s+/g, '').length);
  const letterSeconds = Math.max(0.12, c.animSeconds);
  const letterStagger = Math.min(0.07, (Math.max(0.2, c.animSeconds) * 1.5) / letterCount);
  // Glitch: while coming in, words jump sideways and split into red and cyan copies.
  const glitch = c.animIn === 'glitch' && pin < 1 ? 1 - pin : 0;
  /** Draws a piece of text with the style's glow, shadow and outline. */
  const paint = (str: string, x: number, y: number, color: string | CanvasGradient, a: number, b: number, seed: number, font?: string, size?: number) => {
    // A word of rich text: its own font, and glow, shadow and outline in proportion to its size.
    const px = size ?? basePx;
    ctx.save();
    if (font) ctx.font = font;
    ctx.globalAlpha = clamp(a);
    if (b > 0.3) ctx.filter = `blur(${b.toFixed(1)}px)`;
    let gx = 0;
    if (glitch > 0) {
      const jitter = Math.sin(rt * 47 + seed * 13.7);
      gx = jitter > 0.3 ? jitter * px * 0.18 * glitch : 0;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(a * 0.8);
      ctx.fillStyle = '#FF2A55';
      ctx.fillText(str, x + gx + px * 0.06 * glitch, y);
      ctx.fillStyle = '#2AE5FF';
      ctx.fillText(str, x + gx - px * 0.06 * glitch, y);
      ctx.restore();
    }
    if (st.glow > 0) {
      ctx.shadowColor = st.glowColor;
      ctx.shadowBlur = (st.glow * px) / 30;
      ctx.fillStyle = color;
      ctx.fillText(str, x + gx, y);
      ctx.fillText(str, x + gx, y);
    }
    if (st.shadow > 0) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = (st.shadow * px) / 40;
      ctx.shadowOffsetY = (st.shadow * px) / 160;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    if (st.outline > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = (st.outline * px) / 30;
      ctx.strokeStyle = st.outlineColor;
      ctx.strokeText(str, x + gx, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x + gx, y);
    ctx.restore();
  };
  if (st.curve) {
    // Along an arc: the text as one line, each letter placed and turned on the circle.
    const full = lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    const total = Math.max(1, ctx.measureText(full).width);
    const arc = (Math.abs(st.curve) / 100) * Math.PI;
    const R = total / arc;
    const up = st.curve > 0 ? 1 : -1;
    // The arc's own height, so the curved text stays centred where the straight text was.
    const lift = (R * (1 - Math.cos(arc / 2))) / 2;
    let along = -total / 2;
    const fill = fillFor(total);
    let letters = 0;
    [...full].forEach((ch, i) => {
      const w = ctx.measureText(ch).width;
      const theta = (along + w / 2) / R;
      along += w;
      // Typewriter: only the letters typed so far.
      if (!ch.trim() || letters++ >= shownChars) return;
      ctx.save();
      ctx.translate(R * Math.sin(theta), up * (R * (1 - Math.cos(theta)) - lift));
      ctx.rotate(up * theta);
      paint(ch, -w / 2, px * 0.35, fill, alpha, blur, i);
      ctx.restore();
    });
    ctx.restore();
    return;
  }
  let chars = 0;
  lines.forEach((line) => {
    const y = top + line.y;
    const x0 = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 - line.width : -line.width / 2;
    if (st.box && line.words.length) {
      const pad = px * 0.22;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = st.boxColor;
      ctx.beginPath();
      ctx.roundRect(x0 - pad, y - line.size * 0.85 - pad * 0.6, line.width + pad * 2, line.size * st.lineHeight + pad * 0.6, px * 0.18);
      ctx.fill();
      ctx.restore();
    }
    const fill = fillFor(line.width);
    for (const w of line.words) {
      let word = w.text;
      if (shownChars !== Infinity) {
        const left = shownChars - chars;
        if (left <= 0) break;
        if (left < word.length) word = word.slice(0, left);
      }
      const firstLetter = chars;
      chars += w.text.length;
      const r = wordReveal(w.index);
      if (r <= 0) continue;
      const color = c.highlight && spoken(w.index) ? c.highlight : w.color;
      const x = x0 + w.x;
      if (!perLetter) {
        // Word by word from a side (or popping): each word travels the last stretch on its own.
        const k = 1 - easeOut(r);
        if (WORD_MOVES.has(c.animIn) && k > 0) {
          const wx = c.animIn === 'words-left' ? -k * px * 2.2 : c.animIn === 'words-right' ? k * px * 2.2 : 0;
          const wy = c.animIn === 'words-up' ? k * px * 1.2 : 0;
          const ws = c.animIn === 'words-pop' ? (r < 1 ? 0.4 + 0.6 * EASES.back(r) : 1) : 1;
          ctx.save();
          const cx = x + w.width / 2;
          ctx.translate(cx + wx, y + wy);
          ctx.scale(ws, ws);
          paint(word, -w.width / 2, 0, color ?? fill, alpha * clamp(r * 2), blur, w.index, w.font, w.size);
          ctx.restore();
          continue;
        }
        paint(word, x, y, color ?? fill, alpha * easeOut(r), blur + (1 - easeOut(r)) * px * 0.3, w.index, w.font, w.size);
        continue;
      }
      ctx.font = w.font;
      // Letter by letter: each letter has its own moment, a little after the one before.
      for (let i = 0; i < word.length; i++) {
        const ch = word[i]!;
        const gi = firstLetter + i;
        const lp = clamp((rt - gi * letterStagger) / letterSeconds);
        if (lp <= 0 && c.animIn !== 'wave') continue;
        const lx = x + ctx.measureText(word.slice(0, i)).width;
        let la = alpha;
        let lb = blur;
        let ly: number;
        if (c.animIn === 'letters') {
          la *= easeOut(lp);
          lb += (1 - easeOut(lp)) * px * 0.4;
          ly = (1 - easeOut(lp)) * px * 0.35;
        } else if (c.animIn === 'drop') {
          la *= clamp(lp * 4);
          ly = -(1 - EASES.bounce(lp)) * px * 1.6;
        } else {
          // wave: letters rise in with a little overshoot, then keep a gentle wave going.
          la *= clamp(lp * 3);
          ly = -(1 - EASES.back(lp)) * px * 0.7 + Math.sin(rt * 4 - gi * 0.55) * px * 0.045;
        }
        if (la <= 0.001) continue;
        paint(ch, lx, y + ly, color ?? fill, la, lb, w.index, w.font, w.size);
      }
    }
  });
  ctx.restore();
}
