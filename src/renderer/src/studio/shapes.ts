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
  }
}

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
  const lineW = (st.strokeWidth / 1000) * H;
  const outlineOnly = c.shape === 'ring' || c.shape === 'line' || c.shape === 'arrow';
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
