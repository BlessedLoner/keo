// Real-looking surfaces for Keo's scenes, drawn once on canvases: brick, wood, concrete, roof
// tiles, stone, grass… No image files, nothing downloaded. Each is near-white so the object's own
// colour tints it, and doubles as a bump map so light catches the joints and the grain.
import * as THREE from 'three';

export const MATERIALS = ['painted', 'plastic', 'metal', 'chrome', 'glass', 'concrete', 'brick', 'wood', 'stone', 'tile', 'roof', 'grass', 'water', 'rubber', 'fabric', 'asphalt', 'light'];

const cache = new Map();

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function canvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function speckle(x, size, r, count, lo, hi, dot = 2) {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(lo + r() * (hi - lo));
    x.fillStyle = `rgba(${v},${v},${v},${0.06 + r() * 0.1})`;
    x.fillRect(r() * size, r() * size, dot * (0.5 + r() * 1.5), dot * (0.5 + r() * 1.5));
  }
}

const DRAW = {
  concrete(x, s, r) {
    x.fillStyle = '#d9d9d6';
    x.fillRect(0, 0, s, s);
    speckle(x, s, r, 14000, 90, 255, 2);
    // Formwork lines and a few hairline cracks.
    x.strokeStyle = 'rgba(70,70,70,0.18)';
    x.lineWidth = 2;
    for (const p of [0, s / 2]) {
      x.beginPath();
      x.moveTo(0, p);
      x.lineTo(s, p);
      x.stroke();
    }
    for (let i = 0; i < 5; i++) {
      x.strokeStyle = 'rgba(60,60,60,0.12)';
      x.lineWidth = 1;
      x.beginPath();
      let px = r() * s;
      let py = r() * s;
      x.moveTo(px, py);
      for (let k = 0; k < 6; k++) x.lineTo((px += (r() - 0.5) * 60), (py += r() * 40));
      x.stroke();
    }
  },
  brick(x, s, r) {
    x.fillStyle = '#8f8a84'; // mortar
    x.fillRect(0, 0, s, s);
    const rows = 8;
    const h = s / rows;
    const w = s / 4;
    for (let row = 0; row < rows; row++)
      for (let col = -1; col < 5; col++) {
        const v = 205 + Math.floor(r() * 50);
        x.fillStyle = `rgb(${v},${v - 6},${v - 10})`;
        x.fillRect(col * w + (row % 2 ? w / 2 : 0) + 3, row * h + 3, w - 6, h - 6);
      }
    speckle(x, s, r, 6000, 60, 230, 2);
  },
  wood(x, s, r) {
    x.fillStyle = '#e3d6c4';
    x.fillRect(0, 0, s, s);
    // Planks with grain running along them.
    const planks = 4;
    for (let p = 0; p < planks; p++) {
      const y0 = (p * s) / planks;
      const v = 215 + Math.floor(r() * 35);
      x.fillStyle = `rgb(${v},${v - 8},${v - 20})`;
      x.fillRect(0, y0, s, s / planks - 2);
      for (let i = 0; i < 26; i++) {
        x.strokeStyle = `rgba(90,60,30,${0.06 + r() * 0.12})`;
        x.lineWidth = 0.6 + r() * 1.4;
        x.beginPath();
        const y = y0 + r() * (s / planks);
        x.moveTo(0, y);
        x.bezierCurveTo(s * 0.3, y + (r() - 0.5) * 10, s * 0.7, y + (r() - 0.5) * 10, s, y + (r() - 0.5) * 6);
        x.stroke();
      }
    }
  },
  stone(x, s, r) {
    x.fillStyle = '#7d7b78';
    x.fillRect(0, 0, s, s);
    let y = 0;
    while (y < s) {
      const h = 50 + r() * 50;
      let px = -r() * 60;
      while (px < s) {
        const w = 70 + r() * 90;
        const v = 190 + Math.floor(r() * 60);
        x.fillStyle = `rgb(${v},${v},${v - 6})`;
        x.beginPath();
        x.roundRect(px + 3, y + 3, w - 6, h - 6, 8);
        x.fill();
        px += w;
      }
      y += h;
    }
    speckle(x, s, r, 9000, 70, 240, 2);
  },
  tile(x, s, r) {
    x.fillStyle = '#b9b9b6';
    x.fillRect(0, 0, s, s);
    const n = 4;
    const w = s / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const v = 232 + Math.floor(r() * 20);
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(i * w + 2, j * w + 2, w - 4, w - 4);
      }
  },
  roof(x, s, r) {
    x.fillStyle = '#6e6a66';
    x.fillRect(0, 0, s, s);
    const rows = 8;
    const h = s / rows;
    const w = s / 6;
    for (let row = 0; row < rows; row++)
      for (let col = -1; col < 7; col++) {
        const v = 195 + Math.floor(r() * 55);
        const g = x.createLinearGradient(0, row * h, 0, row * h + h);
        g.addColorStop(0, `rgb(${v},${v},${v})`);
        g.addColorStop(1, `rgb(${v - 70},${v - 70},${v - 70})`);
        x.fillStyle = g;
        x.beginPath();
        x.roundRect(col * w + (row % 2 ? w / 2 : 0) + 1, row * h, w - 2, h + 4, [0, 0, 10, 10]);
        x.fill();
      }
  },
  grass(x, s, r) {
    x.fillStyle = '#c9d6c0';
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < 26000; i++) {
      const v = 150 + Math.floor(r() * 105);
      x.strokeStyle = `rgba(${v - 30},${v},${v - 40},0.35)`;
      x.lineWidth = 1;
      const px = r() * s;
      const py = r() * s;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + (r() - 0.5) * 5, py - 3 - r() * 6);
      x.stroke();
    }
  },
  asphalt(x, s, r) {
    x.fillStyle = '#9a9a9a';
    x.fillRect(0, 0, s, s);
    speckle(x, s, r, 30000, 30, 255, 2);
  },
  fabric(x, s) {
    x.fillStyle = '#e6e6e6';
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i += 4) {
      x.fillStyle = 'rgba(0,0,0,0.07)';
      x.fillRect(i, 0, 2, s);
      x.fillRect(0, i, s, 2);
    }
  },
  painted(x, s, r) {
    x.fillStyle = '#f4f4f4';
    x.fillRect(0, 0, s, s);
    speckle(x, s, r, 4000, 200, 255, 3);
  },
};

function texture(name) {
  if (cache.has(name)) return cache.get(name);
  const [c, x] = canvas(512);
  DRAW[name](x, 512, rng(name.length * 7919 + name.charCodeAt(0)));
  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(c);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 8;
  const t = { map, bump };
  cache.set(name, t);
  return t;
}

/** How big one tile of each surface is in the scene (metres), so bricks are brick-sized on any wall. */
export const TILE_METRES = { concrete: 3, brick: 1.1, wood: 1.6, stone: 1.8, tile: 1.2, roof: 1.6, grass: 3, asphalt: 3, fabric: 0.5, painted: 3 };

/**
 * The material for a surface. name: one of MATERIALS; color tints it.
 * Returns { mat, tile } — tile is the size of one texture tile in metres (0 = no texture).
 */
export function makeMaterial(name = 'painted', color = '#8aa0b8', opacity = 1, glow = false) {
  const base = { color, transparent: true, opacity };
  let mat;
  let tile = 0;
  const textured = (n, o) => {
    const t = texture(n);
    tile = TILE_METRES[n];
    return new THREE.MeshStandardMaterial({ ...base, map: t.map, bumpMap: t.bump, ...o });
  };
  switch (name) {
    case 'metal':
      mat = new THREE.MeshStandardMaterial({ ...base, roughness: 0.32, metalness: 0.9, envMapIntensity: 5 });
      break;
    case 'chrome':
      mat = new THREE.MeshStandardMaterial({ ...base, roughness: 0.06, metalness: 1, envMapIntensity: 6 });
      break;
    case 'glass':
      // Window glass: mostly see-through, with the sky caught on its surface.
      mat = new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: Math.min(opacity, 1) * 0.32, roughness: 0.02, metalness: 0.1, envMapIntensity: 6, reflectivity: 1, clearcoat: 1, clearcoatRoughness: 0, side: THREE.DoubleSide, depthWrite: false });
      break;
    case 'water':
      mat = new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: Math.min(opacity, 1) * 0.72, roughness: 0.04, metalness: 0.15, envMapIntensity: 5, reflectivity: 1, clearcoat: 1, clearcoatRoughness: 0.02 });
      break;
    case 'plastic':
      mat = new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 });
      break;
    case 'rubber':
      mat = new THREE.MeshStandardMaterial({ ...base, roughness: 0.95, metalness: 0 });
      break;
    case 'light':
      mat = new THREE.MeshStandardMaterial({ ...base, emissive: new THREE.Color(color), emissiveIntensity: 2.2, roughness: 0.4 });
      break;
    case 'concrete':
      mat = textured('concrete', { roughness: 0.92, metalness: 0, bumpScale: 0.6 });
      break;
    case 'brick':
      mat = textured('brick', { roughness: 0.9, metalness: 0, bumpScale: 2.2 });
      break;
    case 'wood':
      mat = textured('wood', { roughness: 0.62, metalness: 0, bumpScale: 0.7 });
      break;
    case 'stone':
      mat = textured('stone', { roughness: 0.88, metalness: 0, bumpScale: 2 });
      break;
    case 'tile':
      mat = textured('tile', { roughness: 0.25, metalness: 0, bumpScale: 0.8 });
      break;
    case 'roof':
      mat = textured('roof', { roughness: 0.8, metalness: 0, bumpScale: 2.4 });
      break;
    case 'grass':
      mat = textured('grass', { roughness: 1, metalness: 0, bumpScale: 0.6 });
      break;
    case 'asphalt':
      mat = textured('asphalt', { roughness: 0.95, metalness: 0, bumpScale: 0.5 });
      break;
    case 'fabric':
      mat = textured('fabric', { roughness: 0.98, metalness: 0, bumpScale: 0.4 });
      break;
    default:
      mat = textured('painted', { roughness: 0.55, metalness: 0.02, bumpScale: 0.08 });
  }
  if (glow && name !== 'light') {
    mat.emissive = new THREE.Color(color);
    mat.emissiveIntensity = 1.6;
  }
  mat.userData.kind = name;
  mat.userData.baseEmissive = mat.emissiveIntensity ?? 0;
  mat.userData.glows = glow || name === 'light';
  return { mat, tile };
}

/**
 * Texture coordinates from where each point really is (metres), not from the shape's own layout:
 * bricks stay brick-sized on a long wall and a short one alike. Picks the flattest side per face.
 */
export function worldUV(geo, tile) {
  if (!tile) return geo;
  // Keeps the shape's own shading (round things stay smooth); only the texture layout changes.
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    // One choice for the whole triangle, from its average normal, so a face never tears.
    const nx = Math.abs(nor.getX(i) + nor.getX(i + 1) + nor.getX(i + 2));
    const ny = Math.abs(nor.getY(i) + nor.getY(i + 1) + nor.getY(i + 2));
    const nz = Math.abs(nor.getZ(i) + nor.getZ(i + 1) + nor.getZ(i + 2));
    for (let k = i; k < i + 3 && k < pos.count; k++) {
      const x = pos.getX(k);
      const y = pos.getY(k);
      const z = pos.getZ(k);
      if (ny >= nx && ny >= nz) {
        uv[k * 2] = x / tile;
        uv[k * 2 + 1] = z / tile;
      } else if (nx >= nz) {
        uv[k * 2] = z / tile;
        uv[k * 2 + 1] = y / tile;
      } else {
        uv[k * 2] = x / tile;
        uv[k * 2 + 1] = y / tile;
      }
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
