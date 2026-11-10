// A real city from OpenStreetMap data (made by Keo's build__city): roads, buildings, lights, parks,
// physics colliders and a road network for traffic and police.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACADES, facadeTextures, glowTexture, groundTexture, rng, roadTexture, sidewalkTexture } from './textures.js';

const ROAD_Y = { motorway: 0.07, trunk: 0.066, primary: 0.062, secondary: 0.058, tertiary: 0.054, residential: 0.05, service: 0.046 };
const TILE_W = 12;
const TILE_H = 26.4;

/** The road network: junctions and the road pieces between them. Traffic, police and races use it. */
export class RoadGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }
  key(x, z) {
    return `${Math.round(x * 2)},${Math.round(z * 2)}`;
  }
  node(x, z) {
    const k = this.key(x, z);
    let n = this.nodes.get(k);
    if (!n) {
      n = { id: k, x, z, edges: [] };
      this.nodes.set(k, n);
    }
    return n;
  }
  add(a, b, road) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) return;
    const e = { a, b, len, road, id: this.edges.length };
    this.edges.push(e);
    a.edges.push(e);
    if (!road.oneway) b.edges.push(e);
  }
  /** The junction closest to a point. */
  nearest(x, z) {
    let best = null;
    let d = Infinity;
    for (const n of this.nodes.values()) {
      const dd = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (dd < d && n.edges.length) {
        d = dd;
        best = n;
      }
    }
    return best;
  }
  other(e, n) {
    return e.a === n ? e.b : e.a;
  }
  /** Shortest way between two junctions (A*), as a list of junctions; null when there is none. */
  path(from, to, maxNodes = 4000) {
    if (!from || !to) return null;
    const open = new Map([[from.id, { n: from, g: 0, f: 0, prev: null }]]);
    const done = new Map();
    let steps = 0;
    while (open.size && steps++ < maxNodes) {
      let cur = null;
      for (const o of open.values()) if (!cur || o.f < cur.f) cur = o;
      open.delete(cur.n.id);
      done.set(cur.n.id, cur);
      if (cur.n === to) {
        const out = [];
        for (let c = cur; c; c = c.prev) out.unshift(c.n);
        return out;
      }
      for (const e of cur.n.edges) {
        const m = this.other(e, cur.n);
        if (done.has(m.id)) continue;
        const g = cur.g + e.len * (e.road.kind === 'service' ? 1.6 : 1);
        const o = open.get(m.id);
        if (!o || g < o.g) open.set(m.id, { n: m, g, f: g + Math.hypot(to.x - m.x, to.z - m.z), prev: cur });
      }
    }
    return null;
  }
}

/** A road as a flat ribbon: miter joints, u across the road, v along it in tiles. */
function ribbon(pts, width, y, tile = TILE_W) {
  const n = pts.length;
  if (n < 2) return null;
  const pos = [];
  const uv = [];
  const idx = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // Miter: keep the road its full width round bends, but not absurdly at hairpins.
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const ax = p[0] - prev[0];
      const az = p[1] - prev[1];
      const al = Math.hypot(ax, az) || 1;
      const cos = (ax / al) * dx + (az / al) * dz;
      scale = Math.min(2.2, 1 / Math.max(0.45, Math.sqrt((1 + cos) / 2)));
    }
    const nx = -dz * (width / 2) * scale;
    const nz = dx * (width / 2) * scale;
    if (i > 0) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    pos.push(p[0] + nx, y, p[1] + nz, p[0] - nx, y, p[1] - nz);
    uv.push(0, dist / tile, 1, dist / tile);
    if (i < n - 1) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Facade UVs: one texture tile per 12 m of wall and per 8 floors. */
const wallUV = {
  generateTopUV(geometry, v, a, b, c) {
    return [a, b, c].map((i) => new THREE.Vector2(v[i * 3] / 20, v[i * 3 + 1] / 20));
  },
  generateSideWallUV(geometry, v, a, b, c, d) {
    const ax = v[a * 3];
    const ay = v[a * 3 + 1];
    const bx = v[b * 3];
    const by = v[b * 3 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    // The wall's position along the footprint keeps neighbouring walls' windows from lining up oddly.
    const u0 = (Math.abs(ax) + Math.abs(ay)) / TILE_W;
    const u1 = u0 + len / TILE_W;
    const z = (i) => v[i * 3 + 2] / TILE_H;
    return [new THREE.Vector2(u0, z(a)), new THREE.Vector2(u1, z(b)), new THREE.Vector2(u1, z(c)), new THREE.Vector2(u0, z(d))];
  },
};

function polygonCentroid(pts) {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    z += p[1];
  }
  return [x / pts.length, z / pts.length];
}

/**
 * Builds the city into the scene (and the physics world when given).
 * opts: { physics: { world, RAPIER }, lampSpacing: 34, trees: true }
 * Returns { graph, bounds, spawn, group, roadAt(x,z), update(time) }.
 */
export function buildCity(world, city, opts = {}) {
  const { scene } = world;
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);
  const graph = new RoadGraph();
  const radius = city.radius ?? 800;
  const rand = rng(Math.round((city.center?.lat ?? 1) * 1000));
  const shadows = world.quality !== 'low';

  // Ground.
  const groundTex = groundTexture('ground');
  groundTex.repeat.set(radius / 6, radius / 6);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(radius * 3, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, color: '#8a8780' }));
  ground.receiveShadow = shadows;
  group.add(ground);

  // Sidewalks under every road, then the roads (by lane layout, merged for speed).
  const walks = [];
  const roadsByLook = new Map();
  for (const r of city.roads) {
    const y = ROAD_Y[r.kind] ?? 0.05;
    const walk = r.kind === 'motorway' || r.kind === 'service' ? 0 : 3.2;
    if (walk) {
      const g = ribbon(r.pts, r.width + walk * 2, y - 0.03, 4);
      if (g) walks.push(g);
    }
    const g = ribbon(r.pts, r.width, y);
    if (!g) continue;
    const look = `${r.kind === 'service' ? 1 : Math.min(6, r.lanes)}:${r.oneway || r.kind === 'service'}`;
    if (!roadsByLook.has(look)) roadsByLook.set(look, []);
    roadsByLook.get(look).push(g);
    for (let i = 0; i < r.pts.length - 1; i++) graph.add(graph.node(r.pts[i][0], r.pts[i][1]), graph.node(r.pts[i + 1][0], r.pts[i + 1][1]), r);
  }
  const roadMats = [];
  for (const [look, list] of roadsByLook) {
    const [lanes, oneway] = look.split(':');
    const m = new THREE.MeshStandardMaterial({ map: roadTexture(Number(lanes), oneway === 'true'), roughness: 0.82, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    roadMats.push(m);
    const mesh = new THREE.Mesh(mergeGeometries(list), m);
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }
  if (walks.length) {
    const sw = sidewalkTexture();
    const mesh = new THREE.Mesh(mergeGeometries(walks), new THREE.MeshStandardMaterial({ map: sw, roughness: 0.9, color: '#b8b4aa', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }

  // Parks and water.
  const flat = (rings, y) =>
    rings
      .filter((r) => r.length >= 3)
      .map((r) => new THREE.ShapeGeometry(new THREE.Shape(r.map((p) => new THREE.Vector2(p[0], -p[1])))).rotateX(-Math.PI / 2).translate(0, y, 0));
  const parkGeos = flat(city.parks ?? [], 0.02);
  if (parkGeos.length) {
    const t = groundTexture('grass');
    t.repeat.set(0.15, 0.15);
    const park = new THREE.Mesh(mergeGeometries(parkGeos), new THREE.MeshStandardMaterial({ map: t, roughness: 1, color: '#9fb08f' }));
    park.receiveShadow = shadows;
    group.add(park);
  }
  const waterGeos = flat(city.water ?? [], 0.03);
  if (waterGeos.length) group.add(new THREE.Mesh(mergeGeometries(waterGeos), new THREE.MeshStandardMaterial({ color: '#0d1f2a', roughness: 0.08, metalness: 0.2 })));

  // Buildings: extruded footprints with facades (lit windows at night), merged by facade style.
  const byStyle = new Map();
  const roofs = [];
  const beacons = [];
  for (const b of city.buildings) {
    if (b.pts.length < 3) continue;
    const shape = new THREE.Shape(b.pts.map((p) => new THREE.Vector2(p[0], -p[1])));
    let g;
    try {
      g = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false, UVGenerator: wallUV });
    } catch {
      continue;
    }
    g.rotateX(-Math.PI / 2);
    const tall = b.h > 45;
    const style = tall ? (rand() < 0.6 ? (rand() < 0.5 ? 'glass' : 'darkglass') : 'bands') : b.kind === 'house' ? 'concrete' : FACADES[Math.floor(rand() * FACADES.length)];
    // Walls only (group 1); the roof (group 0) goes to the roof mesh.
    const walls = g.toNonIndexed();
    const roofG = walls.clone();
    const keep = (geo, which) => {
      const groups = geo.groups;
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      const P = [];
      const U = [];
      for (const gr of groups) {
        if (gr.materialIndex !== which) continue;
        for (let i = gr.start; i < gr.start + gr.count; i++) {
          P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          U.push(uv.getX(i), uv.getY(i));
        }
      }
      const o = new THREE.BufferGeometry();
      o.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      o.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      o.computeVertexNormals();
      return o;
    };
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push(keep(walls, 1));
    roofs.push(keep(roofG, 0));
    if (b.h > 80) {
      const [cx, cz] = polygonCentroid(b.pts);
      beacons.push([cx, b.h + 1.5, cz]);
    }
    if (opts.physics) {
      // A convex footprint is one solid; an L- or U-shaped one is split into triangles, so its walls
      // never reach across the street in its bend.
      const { world: pw, RAPIER } = opts.physics;
      const top = Math.min(b.h, 40);
      const prism = (pts) => {
        const verts = [];
        for (const p of pts) verts.push(p[0], 0, p[1], p[0], top, p[1]);
        const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(verts));
        if (desc) pw.createCollider(desc.setFriction(0.3).setRestitution(0.05));
      };
      if (isConvex(b.pts)) prism(b.pts);
      else
        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(
          b.pts.map((p) => new THREE.Vector2(p[0], p[1])),
          [],
        ))
          prism([b.pts[i], b.pts[j], b.pts[k]]);
    }
  }
  const facadeMats = [];
  let seed = 1;
  for (const [style, list] of byStyle) {
    const { map, emissive } = facadeTextures(style, seed++);
    const glass = style === 'glass' || style === 'darkglass';
    const m = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: '#ffffff', emissiveIntensity: 1, roughness: glass ? 0.18 : 0.85, metalness: glass ? 0.65 : 0.05, envMapIntensity: glass ? 1.4 : 0.6 });
    facadeMats.push(m);
    const mesh = new THREE.Mesh(mergeGeometries(list), m);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }
  if (roofs.length) {
    const mesh = new THREE.Mesh(mergeGeometries(roofs), new THREE.MeshStandardMaterial({ color: '#3b3d40', roughness: 0.9 }));
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }
  // Red aviation lights on the skyscrapers.
  if (beacons.length) {
    const g = new THREE.SphereGeometry(0.9, 8, 6);
    const m = new THREE.MeshBasicMaterial({ color: '#ff2a1a' });
    const inst = new THREE.InstancedMesh(g, m, beacons.length);
    beacons.forEach((b, i) => inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(b[0], b[1], b[2])));
    group.add(inst);
  }

  // Street lights along the bigger roads (both sides), with warm pools of light on the road.
  const lamps = [];
  const spacing = opts.lampSpacing ?? 34;
  for (const r of city.roads) {
    if (!['trunk', 'primary', 'secondary', 'tertiary'].includes(r.kind)) continue;
    let carry = rand() * spacing;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, az] = r.pts[i];
      const [bx, bz] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (let s = carry; s < len; s += spacing) {
        const side = lamps.length % 2 ? 1 : -1;
        const off = r.width / 2 + 1.2;
        lamps.push({ x: ax + dx * s - dz * off * side, z: az + dz * s + dx * off * side, toward: [dz * side, -dx * side] });
      }
      carry = (carry - len) % spacing;
      if (carry < 0) carry += spacing;
    }
  }
  const lampsMax = Math.min(lamps.length, 2500);
  const poleG = new THREE.CylinderGeometry(0.09, 0.14, 8, 6).translate(0, 4, 0);
  const armG = new THREE.BoxGeometry(0.12, 0.12, 2.2).translate(0, 8, 1.0);
  const headG = new THREE.BoxGeometry(0.5, 0.18, 0.9).translate(0, 7.9, 2.0);
  const poleMat = new THREE.MeshStandardMaterial({ color: '#2b2d30', roughness: 0.6, metalness: 0.7 });
  const headMat = new THREE.MeshStandardMaterial({ color: '#222', emissive: '#ffcf8a', emissiveIntensity: 6 });
  const pole = new THREE.InstancedMesh(mergeGeometries([poleG, armG]), poleMat, lampsMax);
  const head = new THREE.InstancedMesh(headG, headMat, lampsMax);
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTexture('255,190,120'), transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending, fog: true }), lampsMax);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < lampsMax; i++) {
    const l = lamps[i];
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(l.toward[0], l.toward[1]));
    mtx.compose(new THREE.Vector3(l.x, 0, l.z), q, new THREE.Vector3(1, 1, 1));
    pole.setMatrixAt(i, mtx);
    head.setMatrixAt(i, mtx);
    pool.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x + l.toward[0] * 2.4, 0.09, l.z + l.toward[1] * 2.4));
  }
  pole.castShadow = shadows;
  group.add(pole, head, pool);

  // Trees in the parks.
  if (opts.trees !== false && city.parks?.length) {
    const spots = [];
    for (const ring of city.parks) {
      const xs = ring.map((p) => p[0]);
      const zs = ring.map((p) => p[1]);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      const area = (x1 - x0) * (z1 - z0);
      for (let k = 0; k < Math.min(60, area / 90); k++) {
        const x = x0 + rand() * (x1 - x0);
        const z = z0 + rand() * (z1 - z0);
        if (inside(ring, x, z)) spots.push([x, z, 0.8 + rand() * 0.7]);
      }
    }
    if (spots.length) {
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 3, 6).translate(0, 1.5, 0), new THREE.MeshStandardMaterial({ color: '#3a2a1e', roughness: 1 }), spots.length);
      const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1).translate(0, 4.6, 0), new THREE.MeshStandardMaterial({ color: '#2d4a26', roughness: 1, flatShading: true }), spots.length);
      spots.forEach(([x, z, s], i) => {
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6), new THREE.Vector3(s, s, s));
        trunk.setMatrixAt(i, m);
        crown.setMatrixAt(i, m);
      });
      trunk.castShadow = crown.castShadow = shadows;
      group.add(trunk, crown);
    }
  }

  // Physics: the ground, and walls at the edge of the map so cars stay in the city.
  if (opts.physics) {
    const { world: pw, RAPIER } = opts.physics;
    pw.createCollider(RAPIER.ColliderDesc.cuboid(radius * 3, 0.5, radius * 3).setTranslation(0, -0.5, 0).setFriction(1.0));
    const edge = radius * 1.08;
    for (let a = 0; a < 48; a++) {
      const ang = (a / 48) * Math.PI * 2;
      const seg = ((Math.PI * 2 * edge) / 48) * 0.55;
      pw.createCollider(RAPIER.ColliderDesc.cuboid(seg, 6, 1).setTranslation(Math.cos(ang) * edge, 5, Math.sin(ang) * edge).setRotation(quatY(-ang + Math.PI / 2)));
    }
  }

  // Night: windows and lamps glow; day: they are off.
  world.onTime?.((t) => {
    for (const m of facadeMats) m.emissiveIntensity = t.windows;
    headMat.emissiveIntensity = t.lamps ? 6 : 0.2;
    pool.visible = !!t.lamps;
    for (const m of roadMats) m.roughness = t.name === 'night' ? 0.42 : t.name === 'dusk' ? 0.6 : 0.82;
  });

  return {
    group,
    graph,
    bounds: radius,
    spawn: city.spawn ?? { x: 0, z: 0, heading: 0 },
    attribution: city.attribution ?? '© OpenStreetMap contributors',
    /** The nearest point on a road (for respawning a car that left the road). */
    roadAt(x, z) {
      let best = null;
      let d = Infinity;
      for (const e of graph.edges) {
        const t = Math.max(0, Math.min(1, ((x - e.a.x) * (e.b.x - e.a.x) + (z - e.a.z) * (e.b.z - e.a.z)) / (e.len * e.len)));
        const px = e.a.x + (e.b.x - e.a.x) * t;
        const pz = e.a.z + (e.b.z - e.a.z) * t;
        const dd = (px - x) ** 2 + (pz - z) ** 2;
        if (dd < d) {
          d = dd;
          best = { x: px, z: pz, heading: Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z), edge: e };
        }
      }
      return best;
    },
  };
}

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const [cx, cz] = pts[(i + 2) % pts.length];
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function quatY(a) {
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
}

function inside(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
