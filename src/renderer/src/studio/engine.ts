import { clipEnd, type Asset, type MediaClip, type Project, type TextClip } from '@shared/studio';

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
  return Math.max(0, Math.min(asset.duration, c.in + (t - c.start) * c.speed));
}

/** The fade (0..1) of a clip with fade-in/out seconds at timeline time t. */
export function fadeAt(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, t: number): number {
  let a = 1;
  if (c.fadeIn > 0) a = Math.min(a, clamp((t - c.start) / c.fadeIn));
  if (c.fadeOut > 0) a = Math.min(a, clamp((clipEnd(c) - t) / c.fadeOut));
  return a;
}

/** The visible clips at time t, bottom layer first. */
export function visibleAt(p: Project, t: number): Array<MediaClip | TextClip> {
  const out: Array<MediaClip | TextClip> = [];
  for (const tr of p.tracks) {
    if (tr.hidden || tr.kind === 'audio') continue;
    for (const c of tr.clips) if (c.type !== 'audio' && t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) out.push(c);
  }
  return out;
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
  for (const c of visibleAt(p, t)) {
    if (c.type === 'media') {
      const a = p.assets.find((x) => x.id === c.assetId);
      if (!a) continue;
      const src = sources.frame(c, a, sourceTime(c, a, t));
      if (src) drawMedia(ctx, c, src, fadeAt(c, t), W, H);
    } else drawText(ctx, c, t, W, H);
  }
  ctx.restore();
}

function drawMedia(ctx: CanvasRenderingContext2D, c: MediaClip, src: Drawable, fade: number, W: number, H: number): void {
  const { w, h } = sizeOf(src);
  const k = c.fit === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  const tr = c.transform;
  const dw = w * k * tr.scale;
  const dh = h * k * tr.scale;
  ctx.save();
  ctx.globalAlpha = clamp(tr.opacity * fade);
  ctx.translate(tr.x * W, tr.y * H);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

interface Word {
  text: string;
  /** Index among the clip's spoken words (for timed captions). */
  index: number;
  x: number;
  width: number;
}
interface Line {
  words: Word[];
  width: number;
}

const FONT_WEIGHT = { normal: 400, bold: 700, black: 900 } as const;

function layout(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): Line[] {
  const space = ctx.measureText(' ').width;
  const lines: Line[] = [];
  let index = 0;
  for (const para of text.split(/\r?\n/)) {
    let line: Line = { words: [], width: 0 };
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      const w = ctx.measureText(raw).width;
      const next = line.words.length ? line.width + space + w : w;
      if (line.words.length && next > maxWidth) {
        lines.push(line);
        line = { words: [], width: 0 };
      }
      const x = line.words.length ? line.width + space : 0;
      line.words.push({ text: raw, index: index++, x, width: w });
      line.width = x + w;
    }
    lines.push(line);
  }
  return lines;
}

/** How far into its in-animation (0..1) and out-animation (1..0) a text clip is. */
function phases(c: TextClip, t: number): { pin: number; pout: number } {
  const s = Math.max(0.01, c.animSeconds);
  return { pin: c.animIn === 'none' ? 1 : clamp((t - c.start) / s), pout: c.animOut === 'none' ? 1 : clamp((clipEnd(c) - t) / s) };
}

export function drawText(ctx: CanvasRenderingContext2D, c: TextClip, t: number, W: number, H: number): void {
  const st = c.style;
  const px = (st.sizePct / 100) * H;
  const text = st.uppercase ? c.text.toUpperCase() : c.text;
  ctx.save();
  ctx.font = `${FONT_WEIGHT[st.weight]} ${px}px "${st.font}", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'alphabetic';
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${(st.letterSpacing * px) / 100}px`;
  const lines = layout(ctx, text, st.maxWidth * W);
  const lineH = px * st.lineHeight;
  const blockH = lineH * lines.length;
  const blockW = Math.max(1, ...lines.map((l) => l.width));
  const { pin, pout } = phases(c, t);

  // Whole-block animation (position, scale, opacity, blur).
  let alpha = c.transform.opacity;
  let scale = c.transform.scale;
  let dy = 0;
  let blur = 0;
  const e = easeOut(pin);
  switch (c.animIn) {
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

  ctx.translate(c.transform.x * W, c.transform.y * H + dy);
  if (c.transform.rotation) ctx.rotate((c.transform.rotation * Math.PI) / 180);
  ctx.scale(scale, scale);

  // How much of the text shows (typewriter), and each word's own reveal (words / timed captions).
  const totalChars = text.replace(/\s+/g, '').length;
  const shownChars = c.animIn === 'typewriter' ? Math.floor(pin * totalChars + 1e-6) : Infinity;
  const wordCount = lines.reduce((n, l) => n + l.words.length, 0);
  const wordReveal = (wi: number): number => {
    if (c.animIn !== 'words') return 1;
    const timed = c.words?.[wi];
    if (timed) return clamp((t - timed.start) / 0.22);
    const stagger = Math.min(0.2, (Math.max(0.2, c.animSeconds) * 1.6) / Math.max(1, wordCount));
    return clamp((t - c.start - wi * stagger) / 0.25);
  };
  const spoken = (wi: number) => {
    const w = c.words?.[wi];
    return !!w && t >= w.start && t < w.end;
  };

  const top = -blockH / 2 + px * 0.85;
  const fillFor = (lineWidth: number): string | CanvasGradient => {
    if (!st.color2) return st.color;
    const left = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 - lineWidth : -lineWidth / 2;
    const g = ctx.createLinearGradient(left, 0, left + lineWidth, 0);
    g.addColorStop(0, st.color);
    g.addColorStop(1, st.color2);
    return g;
  };

  let chars = 0;
  lines.forEach((line, li) => {
    const y = top + li * lineH;
    const x0 = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 - line.width : -line.width / 2;
    if (st.box && line.words.length) {
      const pad = px * 0.22;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = st.boxColor;
      ctx.beginPath();
      ctx.roundRect(x0 - pad, y - px * 0.85 - pad * 0.6, line.width + pad * 2, lineH + pad * 0.6, px * 0.18);
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
      chars += w.text.length;
      const r = wordReveal(w.index);
      if (r <= 0) continue;
      const wa = alpha * easeOut(r);
      const wb = blur + (1 - easeOut(r)) * px * 0.3;
      const x = x0 + w.x;
      ctx.save();
      ctx.globalAlpha = clamp(wa);
      if (wb > 0.3) ctx.filter = `blur(${wb.toFixed(1)}px)`;
      const color = c.highlight && spoken(w.index) ? c.highlight : null;
      if (st.glow > 0) {
        ctx.shadowColor = st.glowColor;
        ctx.shadowBlur = (st.glow * px) / 30;
        ctx.fillStyle = color ?? fill;
        ctx.fillText(word, x, y);
        ctx.fillText(word, x, y);
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
        ctx.strokeText(word, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = color ?? fill;
      ctx.fillText(word, x, y);
      ctx.restore();
    }
  });
  ctx.restore();
}
