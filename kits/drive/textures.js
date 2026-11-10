// Procedural textures, drawn once on canvases: no image files needed and nothing downloaded.
import * as THREE from 'three';

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

/** A small seeded random, so the same city always looks the same. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function tex(c, repeat = true, color = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function noise(ctx, w, h, base, spread, count, size, rand) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = Math.floor(spread * (rand() - 0.5));
    ctx.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},${0.05 + rand() * 0.08})`;
    ctx.fillRect(rand() * w, rand() * h, size * (0.5 + rand()), size * (0.5 + rand()));
  }
}

/**
 * Asphalt with the road's markings. u runs across the road (0 = left edge), v along it (one tile = 12 m).
 * Two-way roads get a double yellow centre line, lanes are split with dashed white lines, edges are solid.
 */
export function roadTexture(lanes, oneway) {
  const key = `road:${lanes}:${oneway}`;
  if (cache.has(key)) return cache.get(key);
  const W = 512;
  const H = 512;
  const [c, x] = canvas(W, H);
  const r = rng(lanes * 31 + (oneway ? 7 : 3));
  noise(x, W, H, '#2a2b2e', 70, 9000, 3, r);
  // Tyre wear in each lane.
  for (let l = 0; l < lanes; l++) {
    const cx = ((l + 0.5) / lanes) * W;
    const g = x.createLinearGradient(cx - W / lanes / 2, 0, cx + W / lanes / 2, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3, 'rgba(10,10,12,0.25)');
    g.addColorStop(0.7, 'rgba(10,10,12,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(cx - W / lanes / 2, 0, W / lanes, H);
  }
  const line = (u, color, dash, width = 6) => {
    x.fillStyle = color;
    if (!dash) x.fillRect(u - width / 2, 0, width, H);
    else for (let y = 0; y < H; y += H / 2) x.fillRect(u - width / 2, y + 20, width, H / 4);
  };
  line(10, '#d9d9d2', false);
  line(W - 10, '#d9d9d2', false);
  for (let l = 1; l < lanes; l++) {
    const u = (l / lanes) * W;
    const centre = !oneway && l === lanes / 2;
    if (centre) {
      line(u - 6, '#d8b23a', false, 5);
      line(u + 6, '#d8b23a', false, 5);
    } else line(u, '#cfcfc8', true, 5);
  }
  const t = tex(c);
  cache.set(key, t);
  return t;
}

/** Concrete sidewalk with slab joints (tile = 4 m). */
export function sidewalkTexture() {
  if (cache.has('sidewalk')) return cache.get('sidewalk');
  const [c, x] = canvas(256, 256);
  noise(x, 256, 256, '#77756f', 60, 3000, 3, rng(9));
  x.strokeStyle = 'rgba(30,30,30,0.45)';
  x.lineWidth = 3;
  for (let i = 0; i <= 256; i += 128) {
    x.beginPath();
    x.moveTo(i, 0);
    x.lineTo(i, 256);
    x.moveTo(0, i);
    x.lineTo(256, i);
    x.stroke();
  }
  const t = tex(c);
  cache.set('sidewalk', t);
  return t;
}

export function groundTexture(kind = 'ground') {
  if (cache.has(kind)) return cache.get(kind);
  const [c, x] = canvas(256, 256);
  if (kind === 'grass') noise(x, 256, 256, '#24361f', 90, 6000, 2, rng(4));
  else noise(x, 256, 256, '#3a3936', 50, 5000, 3, rng(5));
  const t = tex(c);
  cache.set(kind, t);
  return t;
}

/**
 * Building facades: a colour map and a glow map with lit windows. One tile = 12 m wide × 26.4 m
 * (8 floors of 3.3 m). Styles: glass tower, office bands, brick, concrete, stone.
 */
export const FACADES = ['glass', 'bands', 'brick', 'concrete', 'stone', 'darkglass'];

export function facadeTextures(style, seed = 1) {
  const key = `facade:${style}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const W = 256;
  const H = 512;
  const [c, x] = canvas(W, H);
  const [e, ex] = canvas(W, H);
  const r = rng(seed * 97 + style.length * 13);
  const wall = { glass: '#4b5a68', bands: '#8c8f93', brick: '#6b3a2c', concrete: '#9a968d', stone: '#a69a84', darkglass: '#1d2733' }[style] ?? '#888';
  noise(x, W, H, wall, 40, 2500, 3, r);
  // A faint glow over the whole wall (the city's light bouncing around), so buildings read at night.
  ex.fillStyle = style === 'brick' ? '#1a0f0b' : style === 'darkglass' ? '#06090d' : '#14161a';
  ex.fillRect(0, 0, W, H);
  const cols = style === 'glass' || style === 'darkglass' ? 6 : style === 'bands' ? 1 : 4;
  const floors = 8;
  const fh = H / floors;
  const cw = W / cols;
  for (let f = 0; f < floors; f++) {
    if (style === 'bands') {
      // Long ribbon windows between concrete bands.
      x.fillStyle = '#20262e';
      x.fillRect(4, f * fh + fh * 0.32, W - 8, fh * 0.5);
      for (let s = 0; s < 8; s++) {
        if (r() < 0.45) {
          ex.fillStyle = r() < 0.7 ? `rgba(255,${200 + r() * 40},${140 + r() * 60},${0.55 + r() * 0.4})` : `rgba(180,210,255,${0.5 + r() * 0.4})`;
          ex.fillRect(4 + (s * (W - 8)) / 8, f * fh + fh * 0.34, (W - 8) / 8 - 2, fh * 0.46);
        }
      }
      continue;
    }
    for (let k = 0; k < cols; k++) {
      const glassy = style === 'glass' || style === 'darkglass';
      const pad = glassy ? 2 : cw * 0.2;
      const wx = k * cw + pad;
      const wy = f * fh + (glassy ? 2 : fh * 0.22);
      const ww = cw - pad * 2;
      const wh = glassy ? fh - 4 : fh * 0.55;
      x.fillStyle = glassy ? (style === 'glass' ? '#33475a' : '#121a24') : '#1d2229';
      x.fillRect(wx, wy, ww, wh);
      // A little sky reflected in the glass.
      const g = x.createLinearGradient(wx, wy, wx + ww, wy + wh);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(wx, wy, ww, wh);
      // Window frame.
      x.strokeStyle = 'rgba(0,0,0,0.55)';
      x.lineWidth = 2;
      x.strokeRect(wx, wy, ww, wh);
      if (!glassy) {
        x.fillStyle = 'rgba(0,0,0,0.5)';
        x.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      }
      if (r() < (glassy ? 0.22 : 0.28)) {
        // A lit room: mostly warm, brighter near the ceiling light, sometimes half-closed blinds.
        const warm = r() < 0.85;
        const a = 0.35 + r() * 0.5;
        const col = warm ? `255,${170 + r() * 50},${90 + r() * 60}` : `${150 + r() * 40},${180 + r() * 30},230`;
        const lg = ex.createLinearGradient(0, wy, 0, wy + wh);
        lg.addColorStop(0, `rgba(${col},${a})`);
        lg.addColorStop(1, `rgba(${col},${a * 0.45})`);
        ex.fillStyle = lg;
        ex.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
        if (r() < 0.35) {
          ex.fillStyle = 'rgba(0,0,0,0.7)';
          ex.fillRect(wx + 1, wy + 1, ww - 2, (wh - 2) * (0.3 + r() * 0.4));
        }
      }
    }
    if (style === 'brick' || style === 'stone') {
      x.fillStyle = 'rgba(0,0,0,0.18)';
      x.fillRect(0, f * fh + fh - 3, W, 3);
    }
  }
  const out = { map: tex(c), emissive: tex(e) };
  cache.set(key, out);
  return out;
}

/** A soft round glow (street-light pools on the road, headlight beams, lens flares). */
export function glowTexture(color = '255,200,140') {
  const key = `glow:${color}`;
  if (cache.has(key)) return cache.get(key);
  const [c, x] = canvas(128, 128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, `rgba(${color},0.9)`);
  g.addColorStop(0.35, `rgba(${color},0.35)`);
  g.addColorStop(1, `rgba(${color},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = tex(c, false);
  cache.set(key, t);
  return t;
}

/** Car body details: a carbon-like dark texture for grilles, diffusers and splitters. */
export function carbonTexture() {
  if (cache.has('carbon')) return cache.get('carbon');
  const [c, x] = canvas(64, 64);
  x.fillStyle = '#111214';
  x.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 64; i += 8)
    for (let j = 0; j < 64; j += 8) {
      x.fillStyle = (i + j) % 16 ? '#1b1c1f' : '#0c0d0e';
      x.fillRect(i, j, 8, 8);
    }
  const t = tex(c);
  cache.set('carbon', t);
  return t;
}

/**
 * A night city seen from street level, as a 360° reflection map: dark sky, a horizon of lit
 * windows, street lights and signs. Glossy paint, glass towers and wet roads reflect it.
 */
export function cityLightsEnvironment(sky = ['#02040a', '#0b1426', '#2a2236'], seed = 3) {
  const W = 1024;
  const H = 512;
  const [c, x] = canvas(W, H);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, sky[0]);
  g.addColorStop(0.45, sky[1]);
  g.addColorStop(0.5, sky[2]);
  g.addColorStop(0.52, '#07080b');
  g.addColorStop(1, '#030304');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  const r = rng(seed);
  // Buildings: dark blocks rising above the horizon, full of lit windows.
  for (let i = 0; i < 70; i++) {
    const bw = 12 + r() * 40;
    const bh = 20 + r() * 150;
    const bx = r() * W;
    const by = H * 0.5 - bh;
    x.fillStyle = '#05070b';
    x.fillRect(bx, by, bw, bh);
    for (let wy = by + 3; wy < H * 0.5 - 2; wy += 5)
      for (let wx = bx + 2; wx < bx + bw - 2; wx += 4)
        if (r() < 0.35) {
          x.fillStyle = r() < 0.75 ? `rgba(255,${200 + r() * 40},${130 + r() * 60},0.95)` : 'rgba(170,205,255,0.9)';
          x.fillRect(wx, wy, 2, 2.5);
        }
  }
  // Street lights and signs: bright blurred spots along the horizon.
  for (let i = 0; i < 90; i++) {
    const px = r() * W;
    const py = H * 0.5 - r() * 40;
    const rad = 3 + r() * 9;
    const col = r() < 0.6 ? '255,190,120' : r() < 0.5 ? '120,180,255' : '255,80,120';
    const gr = x.createRadialGradient(px, py, 0, px, py, rad);
    gr.addColorStop(0, `rgba(${col},1)`);
    gr.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = gr;
    x.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  // A soft glow on the street below (it lights the cars' lower sides in reflections).
  const gl = x.createLinearGradient(0, H * 0.5, 0, H * 0.62);
  gl.addColorStop(0, 'rgba(255,170,100,0.35)');
  gl.addColorStop(1, 'rgba(255,170,100,0)');
  x.fillStyle = gl;
  x.fillRect(0, H * 0.5, W, H * 0.12);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
