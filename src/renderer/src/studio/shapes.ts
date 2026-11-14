import type { ShapeClip } from '@shared/studio';
import type { MotionState } from '@shared/studioMotion';
import { clipReveal, placeLayer } from './motion';

/**
 * Elements: rectangles, circles, rings, lines, arrows, stars and triangles — filled or outlined,
 * with gradients, glow and shadow, and outlines that can draw themselves on. Also the device
 * frames (phone, browser, card) videos and pictures can be shown in.
 */

/** The shape's outline as a path centred at 0,0, and roughly how long it is (for drawing on). */
function shapePath(ctx: CanvasRenderingContext2D, kind: ShapeClip['shape'], w: number, h: number, radius: number): number {
  ctx.beginPath();
  switch (kind) {
    case 'rect': {
      const r = Math.min(w, h) * radius;
      ctx.roundRect(-w / 2, -h / 2, w, h, r);
      return 2 * (w + h);
    }
    case 'circle':
    case 'ring':
      // From the top, clockwise (so an outline draws on from 12 o'clock).
      ctx.ellipse(0, 0, w / 2, h / 2, -Math.PI / 2, 0, Math.PI * 2);
      return Math.PI * (w + h) * 0.5;
    case 'line':
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      return w;
    case 'arrow': {
      const head = Math.min(h, w * 0.4);
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.moveTo(w / 2 - head, -head / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w / 2 - head, head / 2);
      return w + head * 1.5;
    }
    case 'star': {
      let len = 0;
      let px = 0;
      let py = 0;
      for (let i = 0; i <= 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.42 : 1;
        const x = Math.cos(a) * (w / 2) * r;
        const y = Math.sin(a) * (h / 2) * r;
        if (i === 0) ctx.moveTo(x, y);
        else {
          ctx.lineTo(x, y);
          len += Math.hypot(x - px, y - py);
        }
        px = x;
        py = y;
      }
      ctx.closePath();
      return len;
    }
    case 'triangle':
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      return w + 2 * Math.hypot(w / 2, h);
    // Hand-drawn: a loop and a bit, a little uneven, as a pen goes round something.
    case 'scribble':
      return polyline(ctx, 90, (t) => {
        const a = -Math.PI * 0.62 + t * Math.PI * 2.25;
        const grow = 1 + t * 0.07;
        return [Math.cos(a) * (w / 2) * grow * (1 + 0.035 * Math.sin(a * 3)), Math.sin(a) * (h / 2) * grow * (1 + 0.05 * Math.cos(a * 2)) - t * h * 0.04];
      });
    case 'underline':
      // A quick stroke, then a shorter one back under it.
      return (
        polyline(ctx, 30, (t) => [-w / 2 + t * w, -h * 0.18 + Math.sin(t * Math.PI) * -h * 0.12 + t * h * 0.1]) +
        polyline(ctx, 20, (t) => [w * 0.42 - t * w * 0.75, h * 0.2 + Math.sin(t * Math.PI) * h * 0.08])
      );
    case 'curved-arrow': {
      // A curve up and over, then its head along the curve's last direction.
      const q = (t: number): [number, number] => {
        const x0 = -w / 2, y0 = h * 0.4, cx = -w * 0.1, cy = -h * 0.75, x1 = w / 2, y1 = -h * 0.15;
        return [(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1];
      };
      let len = polyline(ctx, 40, q);
      const [ex, ey] = q(1);
      const [px, py] = q(0.94);
      const ang = Math.atan2(ey - py, ex - px);
      const head = Math.min(w, h) * 0.32;
      for (const side of [-1, 1]) {
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang + side * 0.5) * head, ey - Math.sin(ang + side * 0.5) * head);
        len += head;
      }
      return len;
    }
    case 'marker':
      // A highlighter swipe: one wide stroke (its thickness is the height), drawn left to right.
      ctx.moveTo(-w / 2 + h / 2, h * 0.04);
      ctx.lineTo(w / 2 - h / 2, -h * 0.04);
      return w - h;
    case 'check':
      ctx.moveTo(-w / 2, h * 0.02);
      ctx.lineTo(-w * 0.12, h / 2);
      ctx.lineTo(w / 2, -h / 2);
      return Math.hypot(w * 0.38, h * 0.48) + Math.hypot(w * 0.62, h);
    case 'cross':
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.moveTo(w / 2, -h / 2);
      ctx.lineTo(-w / 2, h / 2);
      return 2 * Math.hypot(w, h);
    case 'zigzag': {
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const x = -w / 2 + (i * w) / n;
        const y = i % 2 ? h / 2 : -h / 2;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      return n * Math.hypot(w / n, h);
    }
    case 'sparkle':
      // Four points pinched in between (a twinkle).
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 2;
        const b = a + Math.PI / 4;
        const [x, y] = [Math.cos(a) * (w / 2), Math.sin(a) * (h / 2)];
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        ctx.quadraticCurveTo(Math.cos(b) * w * 0.08, Math.sin(b) * h * 0.08, Math.cos(a + Math.PI / 2) * (w / 2), Math.sin(a + Math.PI / 2) * (h / 2));
      }
      ctx.closePath();
      return Math.PI * (w + h) * 0.5;
    case 'burst': {
      // A comic "POW" star: 14 uneven spikes.
      const n = 14;
      for (let i = 0; i <= n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const r = i % 2 ? 0.62 + 0.06 * Math.sin(i * 1.7) : 1 - 0.08 * Math.cos(i * 2.3);
        const [x, y] = [Math.cos(a) * (w / 2) * r, Math.sin(a) * (h / 2) * r];
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      return Math.PI * (w + h) * 0.6;
    }
    case 'bubble': {
      // A rounded speech bubble with its tail at the bottom left.
      const bh = h * 0.8;
      const r = Math.min(w, bh) * 0.3;
      const top = -h / 2;
      const bottom = top + bh;
      ctx.moveTo(-w / 2 + r, top);
      ctx.lineTo(w / 2 - r, top);
      ctx.arcTo(w / 2, top, w / 2, top + r, r);
      ctx.lineTo(w / 2, bottom - r);
      ctx.arcTo(w / 2, bottom, w / 2 - r, bottom, r);
      ctx.lineTo(-w * 0.12, bottom);
      ctx.lineTo(-w * 0.32, h / 2);
      ctx.lineTo(-w * 0.28, bottom);
      ctx.lineTo(-w / 2 + r, bottom);
      ctx.arcTo(-w / 2, bottom, -w / 2, bottom - r, r);
      ctx.lineTo(-w / 2, top + r);
      ctx.arcTo(-w / 2, top, -w / 2 + r, top, r);
      ctx.closePath();
      return 2 * (w + bh);
    }
    case 'heart':
      ctx.moveTo(0, h / 2);
      ctx.bezierCurveTo(-w * 0.62, h * 0.05, -w * 0.5, -h * 0.55, 0, -h * 0.2);
      ctx.bezierCurveTo(w * 0.5, -h * 0.55, w * 0.62, h * 0.05, 0, h / 2);
      ctx.closePath();
      return Math.PI * (w + h) * 0.55;
    case 'badge': {
      // A seal with a scalloped edge.
      const n = 18;
      for (let i = 0; i <= n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const r = i % 2 ? 0.9 : 1;
        const [x, y] = [Math.cos(a) * (w / 2) * r, Math.sin(a) * (h / 2) * r];
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      return Math.PI * (w + h) * 0.5;
    }
  }
}

/** A stroke through n + 1 points of f(0..1), as its own piece of the path; returns its length. */
function polyline(ctx: CanvasRenderingContext2D, n: number, f: (t: number) => [number, number]): number {
  let len = 0;
  let [px, py] = f(0);
  ctx.moveTo(px, py);
  for (let i = 1; i <= n; i++) {
    const [x, y] = f(i / n);
    ctx.lineTo(x, y);
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

/** Graphics drawn as a line (a pen stroke), not filled. */
const OUTLINE = new Set<ShapeClip['shape']>(['ring', 'line', 'arrow', 'scribble', 'underline', 'curved-arrow', 'marker', 'check', 'cross', 'zigzag']);

function fillFor(ctx: CanvasRenderingContext2D, color: string, color2: string | null, angle: number, w: number, h: number): string | CanvasGradient {
  if (!color2) return color;
  const a = (angle * Math.PI) / 180;
  const dx = (Math.cos(a) * w) / 2;
  const dy = (Math.sin(a) * h) / 2;
  const g = ctx.createLinearGradient(-dx, -dy, dx, dy);
  g.addColorStop(0, color);
  g.addColorStop(1, color2);
  return g;
}

export function drawShape(ctx: CanvasRenderingContext2D, c: ShapeClip, m: MotionState, W: number, H: number): void {
  const st = c.style;
  const w = st.width * W;
  const h = st.height * H;
  ctx.save();
  ctx.globalAlpha = m.opacity;
  placeLayer(ctx, m, W, H);
  clipReveal(ctx, m, w + H * 0.2, h + H * 0.2);
  if (m.blur > 0.3) ctx.filter = `blur(${m.blur.toFixed(1)}px)`;
  // A marker swipe is one stroke as thick as the shape is tall, a little see-through like a highlighter.
  const lineW = c.shape === 'marker' ? h : (st.strokeWidth / 1000) * H;
  const outlineOnly = OUTLINE.has(c.shape);
  if (c.shape === 'marker') ctx.globalAlpha = m.opacity * 0.6;
  const stroke = st.stroke ?? (outlineOnly ? (st.fill ?? '#FFFFFF') : null);
  const len = shapePath(ctx, c.shape, w, h, st.radius);
  const paint = () => {
    if (!outlineOnly && st.fill) {
      ctx.fillStyle = fillFor(ctx, st.fill, st.fill2, st.angle, w, h);
      ctx.fill();
    }
    if (stroke && lineW > 0) {
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = outlineOnly && st.fill2 ? fillFor(ctx, stroke, st.fill2, st.angle, w, h) : stroke;
      if (m.draw < 1) ctx.setLineDash([len * m.draw, len + 1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  };
  if (st.shadow > 0) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = (st.shadow / 40) * H * 0.05;
    ctx.shadowOffsetY = (st.shadow / 160) * H * 0.05;
    paint();
    ctx.restore();
  }
  if (st.glow > 0) {
    ctx.save();
    ctx.shadowColor = st.glowColor;
    ctx.shadowBlur = (st.glow / 30) * H * 0.03;
    paint();
    paint();
    ctx.restore();
  }
  paint();
  if (m.flash > 0) {
    ctx.globalAlpha = m.flash * m.opacity;
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A device around a screen of sw×sh (centred at 0,0): drawn behind the screen; returns the
 * screen's corner radius (the media is clipped to it).
 */
export function drawDevice(ctx: CanvasRenderingContext2D, frame: 'phone' | 'browser' | 'card', sw: number, sh: number, H: number): number {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = H * 0.05;
  ctx.shadowOffsetY = H * 0.02;
  if (frame === 'phone') {
    const bezel = sw * 0.045;
    const r = sw * 0.16;
    ctx.beginPath();
    ctx.roundRect(-sw / 2 - bezel, -sh / 2 - bezel, sw + bezel * 2, sh + bezel * 2, r + bezel);
    ctx.fillStyle = '#0B0B0F';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1, sw * 0.008);
    ctx.strokeStyle = '#3A3A44';
    ctx.stroke();
    ctx.restore();
    return r;
  }
  if (frame === 'browser') {
    const bar = sw * 0.07;
    const r = sw * 0.025;
    ctx.beginPath();
    ctx.roundRect(-sw / 2, -sh / 2 - bar, sw, sh + bar, r);
    ctx.fillStyle = '#1C1C22';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // Three window dots and an address pill.
    const cy = -sh / 2 - bar / 2;
    ['#FF5F57', '#FEBC2E', '#28C840'].forEach((col, i) => {
      ctx.beginPath();
      ctx.arc(-sw / 2 + bar * (0.6 + i * 0.55), cy, bar * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    });
    ctx.beginPath();
    ctx.roundRect(-sw * 0.25, cy - bar * 0.25, sw * 0.5, bar * 0.5, bar * 0.25);
    ctx.fillStyle = '#2C2C34';
    ctx.fill();
    ctx.restore();
    return 0;
  }
  // card: a white border and a deep soft shadow.
  const border = Math.min(sw, sh) * 0.03;
  const r = Math.min(sw, sh) * 0.06;
  ctx.beginPath();
  ctx.roundRect(-sw / 2 - border, -sh / 2 - border, sw + border * 2, sh + border * 2, r + border);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();
  return r;
}

/** Adds a little notch (a phone's camera island) over the top of the screen. */
export function drawNotch(ctx: CanvasRenderingContext2D, sw: number, sh: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-sw * 0.16, -sh / 2 + sw * 0.035, sw * 0.32, sw * 0.085, sw * 0.045);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();
}
