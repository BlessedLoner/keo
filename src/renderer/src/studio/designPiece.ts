import { designTime, DESIGN_EASES, keyValue, pieceProgress, revealRanks, type Design, type DesignGradientLayer, type DesignLayer, type DesignParticlesLayer, type DesignShapeLayer, type DesignTextLayer } from '@shared/studioDesign';

/**
 * Draws a motion graphic Keo designed (the "design" piece): its layers, bottom first, each at its
 * keyframed place and look at time t. The canvas origin is the clip's centre (the clip's own
 * transform is already applied); layer positions are fractions of the frame, sizes in U.
 */
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function rng(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483647 || 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const BLEND: Record<DesignLayer['blend'], GlobalCompositeOperation> = {
  normal: 'source-over',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  lighten: 'lighten',
  difference: 'difference',
  add: 'lighter',
};

interface Frame {
  ctx: CanvasRenderingContext2D;
  t: number;
  d: number;
  W: number;
  H: number;
  U: number;
}

/** The loop's extra motion at time t. */
function loopOf(l: DesignLayer, t: number, U: number): { dx: number; dy: number; s: number; r: number; a: number } {
  const o = { dx: 0, dy: 0, s: 1, r: 0, a: 1 };
  const lp = l.loop;
  if (!lp || lp.kind === 'none') return o;
  const w = t * lp.speed;
  switch (lp.kind) {
    case 'float':
      o.dy = Math.sin(w * 2.1) * lp.amount * U;
      o.dx = Math.sin(w * 1.3 + 1) * lp.amount * 0.5 * U;
      break;
    case 'pulse':
      o.s = 1 + Math.sin(w * Math.PI * 2) * lp.amount * 0.05;
      break;
    case 'spin':
      o.r = w * 360 * Math.max(0.05, lp.amount * 0.1);
      break;
    case 'wiggle':
      o.dx = (Math.sin(w * 13.1) * 0.6 + Math.sin(w * 7.7) * 0.4) * lp.amount * U * 0.4;
      o.dy = (Math.sin(w * 11.3 + 2) * 0.6 + Math.sin(w * 5.9) * 0.4) * lp.amount * U * 0.4;
      break;
    case 'flicker':
      o.a = 0.75 + 0.25 * Math.sin(w * 31) * Math.sin(w * 17.3);
      break;
    case 'sway':
      o.r = Math.sin(w * 1.7) * lp.amount;
      break;
  }
  return o;
}

/** Clips the layer to its wipe (0 hidden … 1 whole), in layer space around a box of w×h. */
function applyWipe(ctx: CanvasRenderingContext2D, from: DesignLayer['wipeFrom'], p: number, w: number, h: number): void {
  if (p >= 1) return;
  const x0 = -w / 2;
  const y0 = -h / 2;
  ctx.beginPath();
  switch (from) {
    case 'left':
      ctx.rect(x0, y0, w * p, h);
      break;
    case 'right':
      ctx.rect(x0 + w * (1 - p), y0, w * p, h);
      break;
    case 'top':
      ctx.rect(x0, y0, w, h * p);
      break;
    case 'bottom':
      ctx.rect(x0, y0 + h * (1 - p), w, h * p);
      break;
    case 'center':
      ctx.rect(-w * p / 2, y0, w * p, h);
      break;
  }
  ctx.clip();
}

function gradientFill(ctx: CanvasRenderingContext2D, a: string, b: string | undefined, angle: number, radial: boolean, w: number, h: number): string | CanvasGradient {
  if (!b) return a;
  if (radial) {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
  }
  const rad = ((angle - 90) * Math.PI) / 180;
  const dx = (Math.cos(rad) * w) / 2;
  const dy = (Math.sin(rad) * h) / 2;
  const g = ctx.createLinearGradient(-dx, -dy, dx, dy);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

// ------------------------------------------------------------------ text

interface Piece {
  text: string;
  x: number;
  y: number;
  w: number;
}

/** Lays the text out in lines (wrapped to maxWidth), then in the pieces it builds by. */
function layoutText(ctx: CanvasRenderingContext2D, l: DesignTextLayer, px: number, W: number): { pieces: Piece[]; width: number; height: number } {
  const text = l.uppercase ? l.text.toUpperCase() : l.text;
  const spacing = l.tracking * px;
  const measure = (s: string) => ctx.measureText(s).width + Math.max(0, s.length - 1) * spacing;
  const maxW = l.maxWidth * W;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxW) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const lh = px * l.lineHeight;
  const height = lines.length * lh;
  const width = Math.max(1, ...lines.map(measure));
  const pieces: Piece[] = [];
  const space = measure(' ') + spacing;
  lines.forEach((line, li) => {
    const lw = measure(line);
    const left = l.align === 'left' ? -width / 2 : l.align === 'right' ? width / 2 - lw : -lw / 2;
    const y = -height / 2 + lh * (li + 0.5);
    if (l.split === 'none' || l.split === 'lines') {
      pieces.push({ text: line, x: left + lw / 2, y, w: lw });
      return;
    }
    let x = left;
    line.split(' ').forEach((word, wi) => {
      if (wi > 0) x += space;
      if (l.split === 'words') {
        const ww = measure(word);
        pieces.push({ text: word, x: x + ww / 2, y, w: ww });
        x += ww;
      } else {
        for (const ch of word) {
          const cw = ctx.measureText(ch).width;
          pieces.push({ text: ch, x: x + cw / 2, y, w: cw });
          x += cw + spacing;
        }
      }
    });
  });
  return { pieces, width, height };
}

function drawText(f: Frame, l: DesignTextLayer, seed: number): { w: number; h: number } {
  const { ctx, t, d, W, U } = f;
  const px = l.size * U;
  ctx.font = `${l.italic ? 'italic ' : ''}${l.weight} ${px}px "${l.font}", "Inter", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${l.tracking * px}px`;
  } catch {
    /* older engines: no spacing */
  }
  const { pieces, width, height } = layoutText(ctx, l, px, W);
  const fill = gradientFill(ctx, l.color, l.color2, 90, false, width, height);
  const ranks = revealRanks(pieces.length, l.order, seed);
  if (l.glow > 0) {
    ctx.shadowColor = l.glowColor ?? l.color;
    ctx.shadowBlur = l.glow * U * 0.3;
  } else if (l.shadow > 0) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = l.shadow * U * 0.2;
    ctx.shadowOffsetY = l.shadow * U * 0.06;
  }
  pieces.forEach((pc, i) => {
    const p = l.split === 'none' ? 1 : pieceProgress(l, ranks[i]!, pieces.length, t, d);
    if (p <= 0.001) return;
    const e = l.enter;
    const away = 1 - p;
    ctx.save();
    ctx.globalAlpha *= e.opacity + (1 - e.opacity) * p;
    ctx.translate(pc.x + e.x * U * away, pc.y + e.y * U * away);
    if (e.rotation) ctx.rotate((e.rotation * away * Math.PI) / 180);
    const s = e.scale + (1 - e.scale) * p;
    if (s !== 1) ctx.scale(s, s);
    if (e.blur > 0 && away > 0.01) ctx.filter = `blur(${(e.blur * away * U * 0.1).toFixed(2)}px)`;
    if (l.split === 'lines' || l.split === 'none' || l.split === 'words') {
      // Lines and words rise out of a mask (the classic kinetic reveal) when they come from below.
      if (l.split !== 'none' && e.y > 0 && e.opacity >= 0.99) {
        ctx.beginPath();
        ctx.rect(-pc.w / 2 - px, -px * 0.62 - e.y * U * away, pc.w + px * 2, px * 1.3);
        ctx.clip();
      }
    }
    if (l.hollow || l.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, (l.strokeWidth || 1.2) * U * 0.1);
      ctx.strokeStyle = l.stroke ?? l.color;
      ctx.strokeText(pc.text, 0, 0);
    }
    if (!l.hollow) {
      // One gradient across the whole text, whichever piece is drawn (pieces sit at their own origin).
      if (l.color2) {
        const g = ctx.createLinearGradient(-width / 2 - pc.x, 0, width / 2 - pc.x, 0);
        g.addColorStop(0, l.color);
        g.addColorStop(1, l.color2);
        ctx.fillStyle = g;
      } else ctx.fillStyle = fill;
      ctx.fillText(pc.text, 0, 0);
    }
    ctx.restore();
  });
  return { w: width, h: height };
}

// ------------------------------------------------------------------ shapes

function shapePath(l: DesignShapeLayer, w: number, h: number, U: number): Path2D {
  const p = new Path2D();
  switch (l.shape) {
    case 'rect': {
      const r = Math.min(l.radius * U, w / 2, h / 2);
      p.roundRect(-w / 2, -h / 2, w, h, r);
      break;
    }
    case 'circle':
    case 'ring':
      p.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'line':
      p.moveTo(-w / 2, 0);
      p.lineTo(w / 2, 0);
      break;
    case 'polygon':
    case 'star': {
      const n = l.shape === 'star' ? l.sides * 2 : l.sides;
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const rr = l.shape === 'star' && i % 2 ? 0.45 : 1;
        const x = (Math.cos(a) * w * rr) / 2;
        const y = (Math.sin(a) * h * rr) / 2;
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      break;
    }
    case 'path': {
      const m = new DOMMatrix().translate(-w / 2, -h / 2).scale(w / 100, h / 100);
      p.addPath(new Path2D(l.path || 'M0 50 L100 50'), m);
      break;
    }
  }
  return p;
}

/** Roughly how long an outline is (for drawing it on): perimeter of the box, or the path's sampled length. */
function outlineLength(l: DesignShapeLayer, w: number, h: number): number {
  if (l.shape === 'line') return w;
  if (l.shape === 'circle' || l.shape === 'ring') return Math.PI * (w + h) / 2;
  if (l.shape === 'path') return (w + h) * 3;
  return 2 * (w + h) * (l.shape === 'star' ? 1.6 : 1);
}

function drawShape(f: Frame, l: DesignShapeLayer, draw: number): { w: number; h: number } {
  const { ctx, U } = f;
  const w = l.w * U;
  const h = (l.shape === 'line' ? Math.max(l.h, 0.01) : l.h) * U;
  const path = shapePath(l, w, h, U);
  if (l.glow > 0) {
    ctx.shadowColor = l.glowColor ?? l.stroke ?? l.fill ?? '#FFFFFF';
    ctx.shadowBlur = l.glow * U * 0.3;
  }
  const outlined = l.shape === 'line' || l.shape === 'ring' || (l.stroke && l.strokeWidth > 0);
  const filled = l.fill && l.shape !== 'line' && l.shape !== 'ring';
  if (filled && draw >= 0.999) {
    ctx.fillStyle = gradientFill(ctx, l.fill!, l.fill2, l.angle, l.radial, w, h);
    ctx.fill(path);
  } else if (filled && draw > 0) {
    // A fill that is "drawing on" fades in after its outline.
    ctx.save();
    ctx.globalAlpha *= clamp((draw - 0.6) / 0.4);
    ctx.fillStyle = gradientFill(ctx, l.fill!, l.fill2, l.angle, l.radial, w, h);
    ctx.fill(path);
    ctx.restore();
  }
  if (outlined && draw > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.5, (l.strokeWidth || 1) * U);
    ctx.strokeStyle = l.stroke ?? l.fill ?? '#FFFFFF';
    const len = outlineLength(l, w, h);
    if (l.dash) ctx.setLineDash(l.dash.map((v) => v * U));
    else if (draw < 0.999) {
      ctx.setLineDash([len, len]);
      ctx.lineDashOffset = len * (1 - draw);
    }
    ctx.stroke(path);
    ctx.setLineDash([]);
  }
  return { w, h };
}

// ------------------------------------------------------------------ particles and gradients

function drawParticles(f: Frame, l: DesignParticlesLayer, layerSeed: number): void {
  const { ctx, t, U } = f;
  const r = rng(l.seed * 7919 + layerSeed);
  const sx = l.spreadX * U;
  const sy = l.spreadY * U;
  for (let i = 0; i < l.count; i++) {
    const bx = (r() - 0.5) * sx;
    const by = (r() - 0.5) * sy;
    const size = l.size * U * (0.4 + 0.6 * r());
    const phase = r() * Math.PI * 2;
    const sp = (0.5 + r()) * l.speed;
    const color = l.colors[Math.floor(r() * l.colors.length)]!;
    let x = bx;
    let y = by;
    let a = 1;
    switch (l.motion) {
      case 'float':
        x += Math.sin(t * sp + phase) * U * 2;
        y += Math.cos(t * sp * 0.8 + phase) * U * 2;
        break;
      case 'rise':
      case 'fall': {
        const dir = l.motion === 'rise' ? -1 : 1;
        const travel = ((t * sp * U * 8 + (by + sy / 2)) % sy + sy) % sy;
        y = -sy / 2 + (dir < 0 ? sy - travel : travel);
        x += Math.sin(t * sp + phase) * U * 1.5;
        a = Math.sin((travel / sy) * Math.PI);
        break;
      }
      case 'burst': {
        const k = DESIGN_EASES.expo(clamp(t * sp * 0.8));
        const ang = phase;
        const dist = (0.3 + r() * 0.7) * Math.max(sx, sy) * 0.5;
        x = Math.cos(ang) * dist * k;
        y = Math.sin(ang) * dist * k + t * t * U * 2;
        a = 1 - clamp(t * sp * 0.5 - 0.3);
        break;
      }
      case 'orbit': {
        const rad = Math.hypot(bx, by);
        const ang = Math.atan2(by, bx) + t * sp * 0.6;
        x = Math.cos(ang) * rad;
        y = Math.sin(ang) * rad * 0.45;
        a = 0.55 + 0.45 * Math.sin(ang);
        break;
      }
      case 'twinkle':
        a = 0.5 + 0.5 * Math.sin(t * sp * 4 + phase);
        break;
      case 'drift':
        x = ((bx + t * sp * U * 6 + sx / 2) % sx + sx) % sx - sx / 2;
        a = Math.sin(((x + sx / 2) / sx) * Math.PI);
        break;
    }
    if (a <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha *= clamp(a);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.translate(x, y);
    switch (l.particle) {
      case 'dot':
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'square':
        ctx.rotate(phase + t * sp);
        ctx.fillRect(-size / 2, -size / 2, size, size);
        break;
      case 'ring':
        ctx.lineWidth = Math.max(1, size * 0.15);
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'line':
        ctx.rotate(phase);
        ctx.lineWidth = Math.max(1, size * 0.18);
        ctx.beginPath();
        ctx.moveTo(-size, 0);
        ctx.lineTo(size, 0);
        ctx.stroke();
        break;
      case 'star':
      case 'spark': {
        ctx.rotate(phase + (l.particle === 'spark' ? t * sp * 2 : 0));
        ctx.beginPath();
        for (let k = 0; k <= 8; k++) {
          const ang = (k / 8) * Math.PI * 2;
          const rr = k % 2 ? size * 0.18 : size * 0.6;
          ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }
}

function drawGradient(f: Frame, l: DesignGradientLayer, cx: number, cy: number): void {
  const { ctx, t, W, H } = f;
  const shift = l.drift ? Math.sin(t * 0.3 * l.drift) * 0.15 : 0;
  let g: CanvasGradient;
  if (l.radial) {
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * (0.6 + shift));
  } else {
    const rad = (((l.angle + shift * 60) - 90) * Math.PI) / 180;
    const dx = (Math.cos(rad) * W) / 2;
    const dy = (Math.sin(rad) * H) / 2;
    g = ctx.createLinearGradient(-dx, -dy, dx, dy);
  }
  const n = l.colors.length;
  l.colors.forEach((c, i) => g.addColorStop(n === 1 ? 0 : i / (n - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(-W, -H, W * 2, H * 2);
}

// ------------------------------------------------------------------ the design

/** Draws a whole design at t seconds into a clip of duration d (origin at the clip's centre). */
export function drawDesign(ctx: CanvasRenderingContext2D, design: Design, t: number, d: number, W: number, H: number, clipId: string): void {
  const U = Math.min(W, H) / 100;
  const f: Frame = { ctx, t, d, W, H, U };
  if (design.background) {
    ctx.fillStyle = design.background;
    ctx.fillRect(-W, -H, W * 2, H * 2);
  }
  const base = hashOf(clipId);
  design.layers.forEach((l, i) => {
    if (l.from !== undefined && t < designTime(l.from, d)) return;
    if (l.until !== undefined && t > designTime(l.until, d)) return;
    const k = (prop: Parameters<typeof keyValue>[1], v: number) => keyValue(l.keys, prop, t, d, v);
    const loop = loopOf(l, t, U);
    const opacity = k('opacity', l.opacity) * loop.a;
    if (opacity <= 0.002) return;
    const x = (k('x', l.x) - 0.5) * W + loop.dx;
    const y = (k('y', l.y) - 0.5) * H + loop.dy;
    const s = k('scale', l.scale) * loop.s;
    const sx = k('scaleX', 1) * s;
    const sy = k('scaleY', 1) * s;
    const rot = k('rotation', l.rotation) + loop.r;
    const blur = k('blur', 0);
    const wipe = k('wipe', 1);
    const skew = k('skewX', 0);
    if (wipe <= 0.001 || Math.abs(sx) < 0.0005 || Math.abs(sy) < 0.0005) return;
    ctx.save();
    ctx.globalAlpha *= opacity;
    ctx.globalCompositeOperation = BLEND[l.blend];
    if (blur > 0.2) ctx.filter = `blur(${(blur * U * 0.1).toFixed(2)}px)`;
    if (l.kind === 'gradient') {
      drawGradient(f, l, x, y);
      ctx.restore();
      return;
    }
    ctx.translate(x, y);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    if (skew) ctx.transform(1, 0, Math.tan((skew * Math.PI) / 180), 1, 0, 0);
    ctx.scale(sx, sy);
    if (wipe < 0.999) {
      // The box to wipe: big enough for the layer (texts and shapes measure themselves first).
      const box = l.kind === 'shape' ? { w: l.w * U + 4 * U, h: l.h * U + 4 * U } : l.kind === 'text' ? { w: l.maxWidth * W, h: l.size * U * 4 } : { w: l.spreadX * U, h: l.spreadY * U };
      applyWipe(ctx, l.wipeFrom, wipe, box.w, box.h);
    }
    if (l.kind === 'text') drawText(f, l, base + i);
    else if (l.kind === 'shape') drawShape(f, l, k('draw', l.draw));
    else drawParticles(f, l, base + i);
    ctx.restore();
  });
}
