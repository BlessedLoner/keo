import type { Effects } from '@shared/studio';

/**
 * Effects laid over a video or picture: film grain, VHS, glow, RGB split and a light leak. Drawn
 * by the picture engine right after the picture (so the preview and the export look the same);
 * they move with time t so grain flickers and leaks drift.
 */

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Drawable = CanvasImageSource;

let noiseTiles: Array<HTMLCanvasElement | OffscreenCanvas> | null = null;

/** A few tiles of grey noise (made once), cycled for moving grain. */
function noise(): Array<HTMLCanvasElement | OffscreenCanvas> {
  if (noiseTiles) return noiseTiles;
  const make = () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(192, 192) : Object.assign(document.createElement('canvas'), { width: 192, height: 192 }));
  noiseTiles = Array.from({ length: 4 }, (_, k) => {
    const c = make();
    const ctx = c.getContext('2d') as Canvas2D;
    const img = ctx.createImageData(192, 192);
    let s = 1234567 + k * 9973;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = (s >> 16) & 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
  return noiseTiles;
}

/**
 * Draws the effects over the picture just drawn at (x, y, w, h) (layer coordinates), from src
 * drawn the same way. H: the frame's height in pixels.
 */
export function drawEffects(ctx: CanvasRenderingContext2D, fx: Effects, src: Drawable, draw: (ctx: CanvasRenderingContext2D) => void, x: number, y: number, w: number, h: number, t: number, H: number): void {
  if (fx.glow) {
    // Glow: a blurred, brighter copy added on top (bright parts bloom).
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha *= Math.min(1, fx.glow * 0.75);
    ctx.filter = `blur(${Math.round(H * 0.02 * (0.5 + fx.glow))}px) brightness(1.25)`;
    draw(ctx);
    ctx.restore();
  }
  if (fx.rgbSplit) {
    // RGB split: a red copy pushed one way and a blue one the other.
    const d = Math.max(1, H * 0.008 * fx.rgbSplit * (1 + 0.4 * Math.sin(t * 9)));
    for (const [dx, hue] of [
      [-d, 'sepia(1) saturate(8) hue-rotate(-40deg)'],
      [d, 'sepia(1) saturate(8) hue-rotate(170deg)'],
    ] as const) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha *= 0.45 * Math.min(1, fx.rgbSplit + 0.3);
      ctx.filter = hue;
      ctx.translate(dx, 0);
      draw(ctx);
      ctx.restore();
    }
  }
  if (fx.lightLeak) {
    // Light leak: warm light drifting across one side.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha *= Math.min(1, fx.lightLeak * 0.85);
    const px = x + w * (0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.35)));
    const py = y + h * (0.2 + 0.25 * Math.sin(t * 0.23 + 1));
    const r = Math.max(w, h) * 0.6;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,170,90,0.95)');
    g.addColorStop(0.35, 'rgba(255,80,120,0.55)');
    g.addColorStop(1, 'rgba(255,80,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  if (fx.vhs) {
    ctx.save();
    // A cold-warm tint, scanlines, and a soft bright band rolling down.
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha *= fx.vhs * 0.5;
    const tint = ctx.createLinearGradient(x, y, x + w, y + h);
    tint.addColorStop(0, '#ff3df0');
    tint.addColorStop(1, '#2ae5ff');
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha *= fx.vhs * 0.22;
    ctx.fillStyle = '#000';
    const step = Math.max(2, Math.round(H / 360) * 2);
    for (let yy = y; yy < y + h; yy += step) ctx.fillRect(x, yy, w, step / 2);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha *= fx.vhs * 0.18;
    const band = y + ((t * 0.12) % 1) * h;
    const bg = ctx.createLinearGradient(0, band - h * 0.06, 0, band + h * 0.06);
    bg.addColorStop(0, 'rgba(255,255,255,0)');
    bg.addColorStop(0.5, 'rgba(255,255,255,1)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(x, band - h * 0.06, w, h * 0.12);
    ctx.restore();
  }
  if (fx.grain) {
    // Film grain: moving noise blended into the picture.
    const tiles = noise();
    const tile = tiles[Math.floor(t * 24) % tiles.length]!;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha *= Math.min(1, fx.grain * 0.45);
    const pat = ctx.createPattern(tile as CanvasImageSource, 'repeat');
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }
  void src;
}
