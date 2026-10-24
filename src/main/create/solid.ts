import type { ModelSpec, SolidNode } from './specs';

/**
 * A small solid modeller for 3D printing: primitives centred on the origin (cube, sphere,
 * cylinder, cone), move / turn / scale, and union / difference / intersection with BSP trees
 * (the classic constructive-solid-geometry method). Units are millimetres. The result is written as
 * binary STL. All loops are iterative, so large models cannot overflow the stack, and building yields
 * to the event loop between operations so Keo's window stays responsive.
 */

export type V = [number, number, number];
const EPS = 1e-5;

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

class Plane {
  constructor(
    public n: V,
    public w: number,
  ) {}
  flipped() {
    return new Plane([-this.n[0], -this.n[1], -this.n[2]], -this.w);
  }
  /** Newell's method: a stable plane for any convex polygon. */
  static of(vs: V[]): Plane | null {
    const n: V = [0, 0, 0];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(...n);
    if (len < 1e-12) return null;
    const u: V = [n[0] / len, n[1] / len, n[2] / len];
    return new Plane(u, dot(u, vs[0]!));
  }
}

export class Polygon {
  constructor(
    public vs: V[],
    public plane: Plane,
  ) {}
  flipped() {
    return new Polygon([...this.vs].reverse(), this.plane.flipped());
  }
  static of(vs: V[]): Polygon | null {
    const clean = vs.filter((v, i) => {
      const prev = vs[(i + vs.length - 1) % vs.length]!;
      return Math.abs(v[0] - prev[0]) > EPS || Math.abs(v[1] - prev[1]) > EPS || Math.abs(v[2] - prev[2]) > EPS;
    });
    if (clean.length < 3) return null;
    const plane = Plane.of(clean);
    return plane ? new Polygon(clean, plane) : null;
  }
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function split(plane: Plane, p: Polygon, coFront: Polygon[], coBack: Polygon[], front: Polygon[], back: Polygon[]) {
  // First pass without allocating: most polygons lie wholly on one side.
  let kind = 0;
  const [nx, ny, nz] = plane.n;
  for (const v of p.vs) {
    const t = nx * v[0] + ny * v[1] + nz * v[2] - plane.w;
    kind |= t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
  }
  if (kind === COPLANAR) (dot(plane.n, p.plane.n) > 0 ? coFront : coBack).push(p);
  else if (kind === FRONT) front.push(p);
  else if (kind === BACK) back.push(p);
  else {
    const types = p.vs.map((v) => {
      const t = dot(plane.n, v) - plane.w;
      return t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    });
    const f: V[] = [];
    const b: V[] = [];
    for (let i = 0; i < p.vs.length; i++) {
      const j = (i + 1) % p.vs.length;
      const ti = types[i]!;
      const tj = types[j]!;
      const vi = p.vs[i]!;
      const vj = p.vs[j]!;
      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(vi);
      if ((ti | tj) === SPANNING) {
        const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
        const v = lerp(vi, vj, t);
        f.push(v);
        b.push(v);
      }
    }
    if (f.length >= 3) front.push(new Polygon(f, p.plane));
    if (b.length >= 3) back.push(new Polygon(b, p.plane));
  }
}

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];
  /** On the root: the tree describes the outside of its solid (after invert()). */
  inverted = false;

  /** A convex solid's tree is a chain (every face has all the others behind it), built without any splitting. */
  static of(ps: Polygon[], convex = false): Node {
    const root = new Node();
    if (!convex) {
      root.build(ps);
      return root;
    }
    let n = root;
    ps.forEach((p, i) => {
      n.plane = p.plane;
      n.polygons = [p];
      if (i < ps.length - 1) n = n.back = new Node();
    });
    return root;
  }

  private nodes(): Node[] {
    const out: Node[] = [];
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }

  invert() {
    this.inverted = !this.inverted;
    for (const n of this.nodes()) {
      n.polygons = n.polygons.map((p) => p.flipped());
      n.plane = n.plane?.flipped() ?? null;
      [n.front, n.back] = [n.back, n.front];
    }
  }

  /** The parts of these polygons outside this tree's solid. */
  clipPolygons(ps: Polygon[]): Polygon[] {
    const out: Polygon[] = [];
    const stack: Array<[Node, Polygon[]]> = [[this, ps]];
    while (stack.length) {
      const [n, list] = stack.pop()!;
      if (!n.plane) {
        out.push(...list);
        continue;
      }
      const front: Polygon[] = [];
      const back: Polygon[] = [];
      for (const p of list) split(n.plane, p, front, back, front, back);
      if (front.length) {
        if (n.front) stack.push([n.front, front]);
        else out.push(...front);
      }
      if (back.length && n.back) stack.push([n.back, back]);
    }
    return out;
  }

  /**
   * Removes the parts of this tree's polygons inside other's solid. box = other's bounds: a polygon
   * outside it is wholly outside other's solid — kept as it is, or dropped when other is inverted.
   */
  clipTo(other: Node, box: Box) {
    for (const n of this.nodes()) {
      const near: Polygon[] = [];
      const far: Polygon[] = [];
      for (const p of n.polygons) (overlaps(polyBox(p), box) ? near : far).push(p);
      const kept = other.inverted ? [] : far;
      n.polygons = near.length ? [...kept, ...other.clipPolygons(near)] : kept;
    }
  }

  all(): Polygon[] {
    return this.nodes().flatMap((n) => n.polygons);
  }

  build(ps: Polygon[]) {
    const stack: Array<[Node, Polygon[]]> = [[this, ps]];
    while (stack.length) {
      const [n, list] = stack.pop()!;
      if (!list.length) continue;
      if (!n.plane) n.plane = list[0]!.plane;
      const front: Polygon[] = [];
      const back: Polygon[] = [];
      for (const p of list) split(n.plane, p, n.polygons, n.polygons, front, back);
      if (front.length) stack.push([(n.front ??= new Node()), front]);
      if (back.length) stack.push([(n.back ??= new Node()), back]);
    }
  }
}

export interface Box {
  min: V;
  max: V;
}

export function bounds(ps: Polygon[]): Box {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (const p of ps)
    for (const v of p.vs)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, v[k]!);
        max[k] = Math.max(max[k]!, v[k]!);
      }
  return { min, max };
}

function polyBox(p: Polygon): Box {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (const v of p.vs)
    for (let k = 0; k < 3; k++) {
      if (v[k]! < min[k]!) min[k] = v[k]!;
      if (v[k]! > max[k]!) max[k] = v[k]!;
    }
  return { min, max };
}

const overlaps = (x: Box, y: Box) => [0, 1, 2].every((k) => x.max[k]! >= y.min[k]! - EPS && y.max[k]! >= x.min[k]! - EPS);

/** Polygons of a closed surface; convex when it is one primitive (or an intersection of them), which makes its tree cheap. */
export interface Solid {
  ps: Polygon[];
  convex: boolean;
}

// As in csg.js, but the last step (building B's polygons into A's tree only to list them all again) is a
// plain concatenation: the same surfaces, without splitting them further.

export function union(a: Solid, b: Solid): Solid {
  if (!a.ps.length) return b;
  if (!b.ps.length) return a;
  const ba = bounds(a.ps);
  const bb = bounds(b.ps);
  if (!overlaps(ba, bb)) return { ps: [...a.ps, ...b.ps], convex: false };
  const A = Node.of(a.ps, a.convex);
  const B = Node.of(b.ps, b.convex);
  A.clipTo(B, bb);
  B.clipTo(A, ba);
  B.invert();
  B.clipTo(A, ba);
  B.invert();
  return { ps: [...A.all(), ...B.all()], convex: false };
}

export function difference(a: Solid, b: Solid): Solid {
  if (!a.ps.length || !b.ps.length) return a;
  const ba = bounds(a.ps);
  const bb = bounds(b.ps);
  if (!overlaps(ba, bb)) return a;
  const A = Node.of(a.ps, a.convex);
  const B = Node.of(b.ps, b.convex);
  A.invert();
  A.clipTo(B, bb);
  B.clipTo(A, ba);
  B.invert();
  B.clipTo(A, ba);
  B.invert();
  return { ps: [...A.all(), ...B.all()].map((p) => p.flipped()), convex: false };
}

export function intersection(a: Solid, b: Solid): Solid {
  const none = { ps: [], convex: true };
  if (!a.ps.length || !b.ps.length) return none;
  const ba = bounds(a.ps);
  const bb = bounds(b.ps);
  if (!overlaps(ba, bb)) return none;
  const A = Node.of(a.ps, a.convex);
  const B = Node.of(b.ps, b.convex);
  A.invert();
  B.clipTo(A, ba);
  B.invert();
  A.clipTo(B, bb);
  B.clipTo(A, ba);
  return { ps: [...A.all(), ...B.all()].map((p) => p.flipped()), convex: a.convex && b.convex };
}

// ---------- primitives (centred on the origin) ----------

const poly = (vs: V[]) => Polygon.of(vs);
const keep = (ps: Array<Polygon | null>) => ps.filter((p): p is Polygon => !!p);

export function cube(size: V): Polygon[] {
  const h = size.map((s) => s / 2) as V;
  const at = (i: number): V => [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]];
  return keep(
    [
      [0, 4, 6, 2],
      [1, 3, 7, 5],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 2, 3, 1],
      [4, 5, 7, 6],
    ].map((f) => poly(f.map(at))),
  );
}

/** Along Z from −height/2 to +height/2; radiusTop 0 makes a cone. */
export function cylinder(radius: number, height: number, radiusTop: number, n: number): Polygon[] {
  const z0 = -height / 2;
  const z1 = height / 2;
  const ring = (r: number, z: number) => Array.from({ length: n }, (_, i): V => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI), z]);
  const bottom = ring(radius, z0);
  const top = ring(radiusTop, z1);
  const out: Array<Polygon | null> = [];
  if (radius > EPS) out.push(poly([...bottom].reverse()));
  if (radiusTop > EPS) out.push(poly(top));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push(poly([bottom[i]!, bottom[j]!, top[j]!, top[i]!]));
  }
  return keep(out);
}

export function sphere(radius: number, n: number): Polygon[] {
  const stacks = Math.max(3, Math.round(n / 2));
  const at = (i: number, j: number): V => {
    const t = (i / n) * 2 * Math.PI;
    const f = (j / stacks) * Math.PI;
    return [radius * Math.cos(t) * Math.sin(f), radius * Math.sin(t) * Math.sin(f), radius * Math.cos(f)];
  };
  const out: Array<Polygon | null> = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < stacks; j++) out.push(poly([at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)]));
  return keep(out);
}

// ---------- transforms ----------

function map(ps: Polygon[], f: (v: V) => V): Polygon[] {
  return keep(ps.map((p) => poly(p.vs.map(f))));
}

function rotate(v: V, deg: V): V {
  let [x, y, z] = v;
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180) as V;
  if (ax) [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  if (ay) [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  if (az) [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  return [x, y, z];
}

function transform(ps: Polygon[], n: SolidNode): Polygon[] {
  let out = ps;
  if (n.scale !== undefined) {
    const s: V = typeof n.scale === 'number' ? [n.scale, n.scale, n.scale] : n.scale;
    out = map(out, (v) => [v[0] * s[0], v[1] * s[1], v[2] * s[2]]);
  }
  if (n.rotate && n.rotate.some((d) => d)) out = map(out, (v) => rotate(v, n.rotate!));
  if (n.translate && n.translate.some((d) => d)) {
    const t = n.translate;
    out = map(out, (v) => [v[0] + t[0], v[1] + t[1], v[2] + t[2]]);
  }
  return out;
}

export const LIMITS = { nodes: 200, depth: 12, polygons: 400_000 };

/** Counts shapes and nesting before building, so an oversized model is refused quickly. */
export function measure(n: SolidNode, depth = 1): { nodes: number; depth: number } {
  if (!('op' in n)) return { nodes: 1, depth };
  let nodes = 1;
  let deepest = depth;
  for (const c of n.children) {
    const m = measure(c, depth + 1);
    nodes += m.nodes;
    deepest = Math.max(deepest, m.depth);
  }
  return { nodes, depth: deepest };
}

const breathe = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => setImmediate(resolve)).then(() => signal?.throwIfAborted());

export async function evaluate(n: SolidNode, signal?: AbortSignal): Promise<Solid> {
  await breathe(signal);
  let solid: Solid;
  if ('op' in n) {
    const kids: Solid[] = [];
    for (const c of n.children) kids.push(await evaluate(c, signal));
    const op = n.op === 'union' ? union : n.op === 'difference' ? difference : intersection;
    solid = n.op === 'union' ? { ps: [], convex: true } : kids.shift()!;
    for (const k of kids) {
      solid = op(solid, k);
      await breathe(signal);
    }
  } else {
    const seg = 'segments' in n && n.segments ? n.segments : 48;
    let ps: Polygon[];
    if (n.shape === 'cube') ps = cube(typeof n.size === 'number' ? [n.size, n.size, n.size] : n.size);
    else if (n.shape === 'sphere') ps = sphere(n.radius, seg);
    else if (n.shape === 'cone') ps = cylinder(n.radius, n.height, 0, seg);
    else ps = cylinder(n.radius, n.height, n.radiusTop ?? n.radius, seg);
    solid = { ps, convex: true };
  }
  if (solid.ps.length > LIMITS.polygons) throw new Error('The model is too detailed (too many faces). Use fewer parts or lower segments.');
  // Moving, turning and scaling keep a convex part convex.
  return { ps: transform(solid.ps, n), convex: solid.convex };
}

export interface Mesh {
  triangles: Array<[V, V, V]>;
  size: V;
  min: V;
  max: V;
  volume: number;
}

export async function buildModel(spec: ModelSpec, signal?: AbortSignal): Promise<Mesh> {
  let ps = (await evaluate(spec.model, signal)).ps;
  if (!ps.length) throw new Error('The model is empty (for example, a difference removed everything or an intersection had no overlap).');
  if (spec.placeOnBed) {
    const b = bounds(ps);
    const c: V = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
    ps = map(ps, (v) => [v[0] - c[0], v[1] - c[1], v[2] - c[2]]);
  }
  const triangles: Array<[V, V, V]> = [];
  for (const p of ps) for (let i = 1; i + 1 < p.vs.length; i++) triangles.push([p.vs[0]!, p.vs[i]!, p.vs[i + 1]!]);
  const b = bounds(ps);
  const volume = triangles.reduce((s, [a, b2, c]) => s + dot(a, cross(b2, c)) / 6, 0);
  return { triangles, min: b.min, max: b.max, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], volume };
}

/** Binary STL: 80-byte header, triangle count, then normal + 3 corners per triangle (float32, mm). */
export function toStl(mesh: Mesh, name: string): Buffer {
  const buf = Buffer.alloc(84 + mesh.triangles.length * 50);
  buf.write(`Keo STL: ${name}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(mesh.triangles.length, 80);
  let o = 84;
  for (const [a, b, c] of mesh.triangles) {
    const n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(...n) || 1;
    for (const v of [[n[0] / len, n[1] / len, n[2] / len], a, b, c])
      for (const x of v) {
        buf.writeFloatLE(x, o);
        o += 4;
      }
    o += 2;
  }
  return buf;
}
