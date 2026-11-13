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
  if (fx.dream) {
    // Dreamy: a soft, light copy over the picture, a little pink.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha *= Math.min(1, fx.dream * 0.6);
    ctx.filter = `blur(${Math.round(H * 0.012 * (0.5 + fx.dream))}px) brightness(1.1) saturate(0.8) sepia(0.15) hue-rotate(-12deg)`;
    draw(ctx);
    ctx.restore();
  }
  if (fx.filmBurn) {
    // Film burn: a warm flare from one edge that swells and fades, never the same twice.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const pulse = Math.max(0, Math.sin(t * 1.7) * 0.6 + Math.sin(t * 4.3 + 1) * 0.4);
    ctx.globalAlpha *= Math.min(1, fx.filmBurn * pulse);
    const left = Math.sin(t * 0.37) > 0;
    const px = left ? x : x + w;
    const py = y + h * (0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.9)));
    const r = Math.max(w, h) * (0.45 + 0.2 * pulse);
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.25, 'rgba(255,140,40,0.9)');
    g.addColorStop(0.6, 'rgba(200,30,10,0.45)');
    g.addColorStop(1, 'rgba(120,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  // A repeatable "random" number for a slot (the same on every export of the same frame).
  const rnd = (n: number) => {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  if (fx.glitch) {
    // Glitch: in short bursts, a few horizontal slices jump sideways with a colour fringe.
    const tick = Math.floor(t * 12);
    const on = rnd(tick) < 0.35 + fx.glitch * 0.35;
    if (on) {
      const slices = 3 + Math.floor(rnd(tick + 1) * 5);
      for (let i = 0; i < slices; i++) {
        const sy = y + rnd(tick * 7 + i) * h;
        const sh = h * (0.02 + rnd(tick * 13 + i) * 0.08);
        const dx = (rnd(tick * 17 + i) - 0.5) * w * 0.12 * fx.glitch;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, sy, w, sh);
        ctx.clip();
        ctx.translate(dx, 0);
        draw(ctx);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha *= 0.5;
        ctx.fillStyle = i % 2 ? '#ff2a6d' : '#05d9e8';
        ctx.fillRect(x - dx, sy, w, sh);
        ctx.restore();
      }
    }
  }
  if (fx.crt) {
    // Old TV: scanlines, a flicker and darker curved corners.
    ctx.save();
    ctx.globalAlpha *= fx.crt * (0.3 + 0.05 * Math.sin(t * 60));
    ctx.fillStyle = '#000';
    const step = Math.max(2, Math.round(H / 270));
    for (let yy = y; yy < y + h; yy += step * 2) ctx.fillRect(x, yy, w, step);
    ctx.restore();
    ctx.save();
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(x + w / 2, y + h / 2, r * 0.55, x + w / 2, y + h / 2, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(0.75 * fx.crt).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha *= 0.35 * fx.crt;
    ctx.fillStyle = '#3cff9e';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  if (fx.bokeh) {
    // Bokeh: soft circles of warm and cool light drifting slowly upward.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const n = 14;
    for (let i = 0; i < n; i++) {
      const px = x + rnd(i) * w + Math.sin(t * 0.4 + i) * w * 0.03;
      const py = y + ((rnd(i + 50) * h - t * h * 0.03 * (0.5 + rnd(i + 9))) % h + h) % h;
      const rr = Math.max(w, h) * (0.03 + rnd(i + 20) * 0.06);
      const c = i % 3 === 0 ? '255,214,140' : i % 3 === 1 ? '255,140,200' : '150,200,255';
      const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
      g.addColorStop(0, `rgba(${c},${(0.55 * fx.bokeh).toFixed(3)})`);
      g.addColorStop(0.7, `rgba(${c},${(0.25 * fx.bokeh).toFixed(3)})`);
      g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if (fx.sparkle) {
    // Sparkles: four-pointed stars that twinkle in and out.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 22; i++) {
      const life = (t * (0.6 + rnd(i + 3)) + rnd(i)) % 1;
      const a = Math.sin(Math.PI * life) * fx.sparkle;
      if (a < 0.05) continue;
      const px = x + rnd(i * 3 + Math.floor(t * (0.6 + rnd(i + 3)) + rnd(i))) * w;
      const py = y + rnd(i * 5 + 1 + Math.floor(t * (0.6 + rnd(i + 3)) + rnd(i))) * h;
      const s = H * (0.008 + rnd(i + 40) * 0.014) * (0.6 + a);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#fffbe8';
      ctx.beginPath();
      ctx.moveTo(px, py - s * 2);
      ctx.quadraticCurveTo(px, py, px + s * 2, py);
      ctx.quadraticCurveTo(px, py, px, py + s * 2);
      ctx.quadraticCurveTo(px, py, px - s * 2, py);
      ctx.quadraticCurveTo(px, py, px, py - s * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if (fx.prism) {
    // Prism: a rainbow streak of light sliding across, with a soft flare.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const p = (t * 0.25) % 1.4 - 0.2;
    const cx = x + w * p;
    const g = ctx.createLinearGradient(cx - w * 0.25, y, cx + w * 0.25, y + h);
    g.addColorStop(0, 'rgba(255,0,80,0)');
    g.addColorStop(0.35, `rgba(255,80,60,${(0.35 * fx.prism).toFixed(3)})`);
    g.addColorStop(0.5, `rgba(255,240,120,${(0.45 * fx.prism).toFixed(3)})`);
    g.addColorStop(0.65, `rgba(60,200,255,${(0.35 * fx.prism).toFixed(3)})`);
    g.addColorStop(1, 'rgba(160,60,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  if (fx.strobe) {
    // Strobe: short white flashes on a fast rhythm.
    const f = (t * 8) % 1;
    if (f < 0.18) {
      ctx.save();
      ctx.globalAlpha *= fx.strobe * (1 - f / 0.18) * 0.85;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }
  if (fx.letterbox) {
    // Cinema bars: the picture as a wide film frame.
    ctx.save();
    ctx.fillStyle = '#000';
    const target = w / 2.39;
    const bar = Math.max(0, ((h - Math.min(h, target)) / 2) * Math.min(1, fx.letterbox) + (fx.letterbox > 0 && h <= target ? h * 0.06 * fx.letterbox : 0));
    ctx.fillRect(x, y, w, bar);
    ctx.fillRect(x, y + h - bar, w, bar);
    ctx.restore();
  }
  void src;
}
