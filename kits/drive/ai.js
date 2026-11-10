// Computer drivers: traffic, police pursuits and street-race rivals, all on the real road network.
import * as THREE from 'three';
import { createCarModel } from './car.js';
import { driveToward, Vehicle } from './vehicle.js';

const TRAFFIC_COLORS = ['#1c1d20', '#e9e9e6', '#8c9196', '#2b3d5c', '#6b0f14', '#c9c3b3', '#1f3b2c', '#3d3f45', '#b7b9bc', '#0f2238'];
const TRAFFIC_STYLES = ['sports', 'suv', 'police', 'muscle', 'suv', 'sports'];

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

/** A point on an edge: t (0..1) from `from`, in the right-hand lane. */
function lanePoint(e, from, t, laneShift) {
  const to = e.a === from ? e.b : e.a;
  const x = from.x + (to.x - from.x) * t;
  const z = from.z + (to.z - from.z) * t;
  const dx = (to.x - from.x) / e.len;
  const dz = (to.z - from.z) / e.len;
  // Right-hand traffic: the right of travel direction (dx, dz) is (-dz, dx) in this map (x east, z south).
  return { x: x - dz * laneShift, z: z + dx * laneShift, heading: Math.atan2(dx, dz) };
}

/** Traffic: everyday cars driving the streets in their lane, slowing for whatever is ahead. */
export class Traffic {
  constructor(ctx, city, opts = {}) {
    this.ctx = ctx;
    this.city = city;
    this.count = opts.count ?? 26;
    this.cars = [];
    this.radius = opts.radius ?? 320;
    this.edges = city.graph.edges.filter((e) => e.road.kind !== 'service' && e.len > 8);
  }
  spawn(near) {
    const { RAPIER, world } = this.ctx.physics;
    const options = this.edges.filter((e) => {
      const d = Math.hypot(e.a.x - near.x, e.a.z - near.z);
      return d > 40 && d < this.radius;
    });
    const e = pick(options.length ? options : this.edges);
    const from = Math.random() < 0.5 || e.road.oneway ? e.a : e.b;
    const style = pick(TRAFFIC_STYLES);
    const model = createCarModel({ style: style === 'police' ? 'sports' : style, color: pick(TRAFFIC_COLORS), finish: Math.random() < 0.5 ? 'metallic' : 'gloss' });
    model.setHeadlights(true);
    const lane = Math.min(e.road.width / 4, 2.6);
    const p = lanePoint(e, from, Math.random(), lane);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0, p.z));
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(model.size.width / 2 - 0.05, 0.6, model.size.length / 2 - 0.05).setTranslation(0, 0.75, 0).setDensity(160).setFriction(0.4).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
      body,
    );
    collider.setContactForceEventThreshold(8000);
    this.ctx.scene.add(model.group);
    const car = { model, body, collider, edge: e, from, t: 0, speed: 9 + Math.random() * 6, lane, wrecked: 0, kind: 'traffic' };
    car.t = Math.random();
    this.cars.push(car);
    return car;
  }
  /** A hard hit knocks a traffic car loose (it becomes a real physics object until it is recycled). */
  knock(car) {
    if (car.wrecked) return;
    car.wrecked = 0.01;
    car.body.setBodyType(this.ctx.physics.RAPIER.RigidBodyType.Dynamic, true);
  }
  carOf(handle) {
    return this.cars.find((c) => c.collider.handle === handle);
  }
  update(dt, player, others = []) {
    const pp = player.body.translation();
    while (this.cars.length < this.count) this.spawn(pp);
    for (const c of this.cars) {
      const b = c.body.translation();
      const far = Math.hypot(b.x - pp.x, b.z - pp.z);
      if (far > this.radius + 60 || (c.wrecked && (c.wrecked += dt) > 12 && far > 60)) {
        this.recycle(c, pp);
        continue;
      }
      if (c.wrecked) {
        const q = c.body.rotation();
        c.model.group.position.set(b.x, b.y, b.z);
        c.model.group.quaternion.set(q.x, q.y, q.z, q.w);
        continue;
      }
      // Slow down for anything just ahead in the lane (the player, police, other cars).
      const h = c.heading ?? 0;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      let gap = Infinity;
      for (const o of [pp, ...others.map((v) => v.body.translation()), ...this.cars.filter((x) => x !== c).map((x) => x.body.translation())]) {
        const dx = o.x - b.x;
        const dz = o.z - b.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < gap && side < 2.4) gap = ahead;
      }
      const want = gap < 9 ? 0 : gap < 22 ? c.speed * ((gap - 9) / 13) : c.speed;
      c.v = (c.v ?? c.speed) + (want - (c.v ?? c.speed)) * Math.min(1, dt * 2.5);
      c.t += (c.v * dt) / c.edge.len;
      while (c.t >= 1) {
        const at = c.edge.a === c.from ? c.edge.b : c.edge.a;
        const next = at.edges.filter((e) => e !== c.edge && e.road.kind !== 'service');
        const e = next.length ? pick(next) : at.edges.includes(c.edge) ? c.edge : pick(at.edges);
        c.t = (c.t - 1) * (c.edge.len / Math.max(1, e.len));
        c.edge = e;
        c.from = at;
        c.lane = Math.min(e.road.width / 4, 2.6);
        if (!e) break;
      }
      const p = lanePoint(c.edge, c.from, Math.min(1, c.t), c.lane);
      // Turn smoothly into the new direction.
      let dh = p.heading - (c.heading ?? p.heading);
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      c.heading = (c.heading ?? p.heading) + dh * Math.min(1, dt * 6);
      c.body.setNextKinematicTranslation({ x: p.x, y: 0, z: p.z });
      c.body.setNextKinematicRotation({ x: 0, y: Math.sin(c.heading / 2), z: 0, w: Math.cos(c.heading / 2) });
      c.model.group.position.set(p.x, 0, p.z);
      c.model.group.rotation.set(0, c.heading, 0);
      c.spin = (c.spin ?? 0) + (c.v * dt) / c.model.size.wheelRadius;
      for (const w of c.model.wheels) if (w.userData.spin) w.userData.spin.rotation.x = c.spin * (w.userData.side > 0 ? -1 : 1);
    }
  }
  recycle(c, near) {
    const { world } = this.ctx.physics;
    world.removeRigidBody(c.body);
    this.ctx.scene.remove(c.model.group);
    this.cars.splice(this.cars.indexOf(c), 1);
    this.spawn(near);
  }
}

/**
 * Police: notice speeding and crashes, then chase with more cars as the heat rises (1–5). Cops
 * follow the roads to the player and ram; standing still next to them for a few seconds is a bust,
 * staying out of sight long enough is an escape. Events: 'heat', 'busted', 'escaped'.
 */
export class Police {
  constructor(ctx, city, opts = {}) {
    this.ctx = ctx;
    this.city = city;
    this.cops = [];
    this.heat = 0;
    this.bust = 0;
    this.lostFor = 0;
    this.cooldown = 0;
    this.patrols = opts.patrols ?? 3;
    this.maxCops = opts.maxCops ?? 6;
    this.events = [];
    this.wanted = 0;
  }
  get pursuit() {
    return this.heat > 0;
  }
  /** Adds heat (crashing into a cop, a mission's crime, …). */
  addHeat(n = 1, why = '') {
    const before = Math.floor(this.heat);
    this.heat = Math.min(5, Math.max(this.heat, 1) + n * 0.5);
    this.lostFor = 0;
    if (Math.floor(this.heat) !== before) this.events.push({ type: 'heat', heat: Math.floor(this.heat), why });
  }
  spawnCop(near, behind = true, player = null) {
    const g = this.city.graph;
    const h = player?.heading ?? 0;
    const opts = [...g.nodes.values()].filter((n) => {
      const d = Math.hypot(n.x - near.x, n.z - near.z);
      if (d < 110 || d > 260 || !n.edges.length) return false;
      if (!behind) return true;
      return (n.x - near.x) * Math.sin(h) + (n.z - near.z) * Math.cos(h) < 0;
    });
    const n = pick(opts.length ? opts : [...g.nodes.values()].filter((x) => x.edges.length));
    const e = n.edges[0];
    const to = g.other(e, n);
    const model = createCarModel({ style: 'police', police: true });
    const v = new Vehicle(this.ctx, model, { power: 10500, topSpeed: 70 + this.heat * 3, grip: 3.4, mass: 1550 }, { x: n.x, z: n.z, heading: Math.atan2(to.x - n.x, to.z - n.z) });
    v.kind = 'police';
    v.patrol = !this.pursuit;
    this.cops.push(v);
    return v;
  }
  isCop(handle) {
    return this.cops.find((c) => c.collider.handle === handle);
  }
  update(dt, player, time) {
    const pp = player.body.translation();
    const g = this.city.graph;
    // Patrols when calm, a growing pursuit when wanted.
    const want = this.pursuit ? Math.min(this.maxCops, 1 + Math.floor(this.heat)) : this.patrols;
    while (this.cops.length < want) this.spawnCop(pp, this.pursuit, player);
    let nearest = Infinity;
    for (const c of [...this.cops]) {
      const p = c.body.translation();
      const d = Math.hypot(p.x - pp.x, p.z - pp.z);
      nearest = Math.min(nearest, d);
      if (d > 420 || (this.cops.length > want && d > 200)) {
        c.remove();
        this.cops.splice(this.cops.indexOf(c), 1);
        continue;
      }
      if (this.pursuit) {
        if (d < 75) {
          const pv = player.body.linvel();
          driveToward(c, pp.x + pv.x * 0.5, pp.z + pv.z * 0.5, { maxSpeed: 80, nitro: true });
        } else {
          c.repath = (c.repath ?? 0) - dt;
          if (c.repath <= 0 || !c.route?.length) {
            c.repath = 1.5;
            c.route = g.path(g.nearest(p.x, p.z), g.nearest(pp.x, pp.z)) ?? [];
          }
          while (c.route.length && Math.hypot(c.route[0].x - p.x, c.route[0].z - p.z) < 10) c.route.shift();
          const t = c.route[0] ?? { x: pp.x, z: pp.z };
          driveToward(c, t.x, t.z, { maxSpeed: 60, nitro: d > 150 });
        }
      } else {
        // Patrol: cruise along the roads.
        if (!c.route?.length) {
          const n = g.nearest(p.x, p.z);
          const e = pick(n.edges);
          c.route = [g.other(e, n)];
        }
        if (Math.hypot(c.route[0].x - p.x, c.route[0].z - p.z) < 8) {
          const at = c.route.shift();
          const e = pick(at.edges);
          c.route.push(g.other(e, at));
        }
        driveToward(c, c.route[0].x, c.route[0].z, { maxSpeed: 14 });
        // Noticing: fast driving near a patrol car starts a pursuit.
        if (d < 70 && Math.abs(player.speed) > 33) this.addHeat(1, 'speeding');
      }
      c.update(dt, time);
      c.model.update(time, this.pursuit);
    }
    if (this.pursuit) {
      // Busted: stopped with a cop right there. Escaped: out of sight long enough.
      if (Math.abs(player.speed) < 3 && nearest < 10) this.bust += dt;
      else this.bust = Math.max(0, this.bust - dt * 0.6);
      if (this.bust > 3) {
        this.events.push({ type: 'busted', heat: Math.floor(this.heat) });
        this.reset();
      }
      if (nearest > 150) this.lostFor += dt;
      else this.lostFor = 0;
      this.cooldown = 8 + this.heat * 2.5;
      if (this.lostFor > this.cooldown) {
        this.events.push({ type: 'escaped', heat: Math.floor(this.heat), bounty: Math.round(this.heat * 1500 + this.wanted) });
        this.reset();
      }
      this.wanted += dt * 25 * this.heat;
      // A long pursuit gets hotter.
      if (this.heat < 5) {
        const before = Math.floor(this.heat);
        this.heat = Math.min(5, this.heat + dt * 0.012);
        if (Math.floor(this.heat) !== before) this.events.push({ type: 'heat', heat: Math.floor(this.heat), why: 'pursuit' });
      }
    }
  }
  reset() {
    this.heat = 0;
    this.bust = 0;
    this.lostFor = 0;
    this.wanted = 0;
    for (const c of this.cops) c.patrol = true;
  }
}

/**
 * A street race through the real city: a route of checkpoints (glowing gates) along the roads from
 * the start to a finish about `length` metres away, against rivals. Events: 'checkpoint', 'finish'.
 */
export class Race {
  constructor(ctx, city, opts = {}) {
    this.ctx = ctx;
    this.city = city;
    this.events = [];
    this.rivals = [];
    this.gates = [];
    this.done = false;
    const g = city.graph;
    const start = opts.start ?? city.spawn;
    const a = g.nearest(start.x, start.z);
    const length = opts.length ?? 1600;
    // A finish far enough away by road.
    const cands = [...g.nodes.values()].filter((n) => n.edges.length && Math.hypot(n.x - a.x, n.z - a.z) > length * 0.45 && Math.hypot(n.x - a.x, n.z - a.z) < length * 0.8);
    let route = null;
    for (let tries = 0; tries < 12 && !route; tries++) route = g.path(a, pick(cands.length ? cands : [...g.nodes.values()]));
    this.route = route ?? [a];
    // Checkpoints about every 140 m along the route.
    let acc = 0;
    for (let i = 1; i < this.route.length; i++) {
      acc += Math.hypot(this.route[i].x - this.route[i - 1].x, this.route[i].z - this.route[i - 1].z);
      if (acc > 140 || i === this.route.length - 1) {
        acc = 0;
        const n = this.route[i];
        const prev = this.route[i - 1];
        this.gates.push({ x: n.x, z: n.z, heading: Math.atan2(n.x - prev.x, n.z - prev.z), mesh: this.gateMesh(n, prev, i === this.route.length - 1) });
      }
    }
    this.next = 0;
    this.reward = opts.reward ?? 5000;
    const count = opts.rivals ?? 3;
    const first = this.route[0];
    const second = this.route[1] ?? first;
    const heading = Math.atan2(second.x - first.x, second.z - first.z);
    for (let i = 0; i < count; i++) {
      const side = (i % 2 ? 1 : -1) * 2.6;
      const back = 7 * (Math.floor(i / 2) + 1);
      const model = createCarModel({ style: pick(['super', 'sports', 'muscle']), color: pick(['#f2c200', '#0a6cff', '#16a34a', '#f97316', '#e5e7eb', '#7c3aed']), finish: 'metallic' });
      const v = new Vehicle(ctx, model, { power: 9000 + (opts.difficulty ?? 1) * 1200, topSpeed: 70 + (opts.difficulty ?? 1) * 5 }, { x: first.x - Math.sin(heading) * back + Math.cos(heading) * side, z: first.z - Math.cos(heading) * back - Math.sin(heading) * side, heading });
      v.kind = 'rival';
      v.gate = 0;
      v.name = opts.names?.[i] ?? ['Vega', 'Kato', 'Reyes', 'Mira', 'Duke'][i % 5];
      this.rivals.push(v);
    }
    this.startHeading = heading;
    this.startAt = { x: first.x, z: first.z, heading };
  }
  gateMesh(n, prev, finish) {
    const grp = new THREE.Group();
    const color = finish ? '#ffffff' : '#ffb000';
    const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3, transparent: true, opacity: 0.85 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 0.4), m);
      post.position.set(s * 7, 3, 0);
      grp.add(post);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.4, 0.4), m);
    top.position.y = 6;
    grp.add(top);
    grp.position.set(n.x, 0, n.z);
    grp.rotation.y = Math.atan2(n.x - prev.x, n.z - prev.z);
    grp.visible = false;
    this.ctx.scene.add(grp);
    return grp;
  }
  /** Who is where: [{ name, gate, dist, player }] sorted by race position. */
  standings(player) {
    const rows = [{ name: 'You', gate: this.next, v: player, player: true }, ...this.rivals.map((v) => ({ name: v.name, gate: v.gate, v }))];
    for (const r of rows) {
      const g = this.gates[Math.min(r.gate, this.gates.length - 1)];
      const p = r.v.body.translation();
      r.dist = g ? Math.hypot(g.x - p.x, g.z - p.z) : 0;
    }
    return rows.sort((a, b) => b.gate - a.gate || a.dist - b.dist);
  }
  update(dt, player, time) {
    this.gates.forEach((g, i) => (g.mesh.visible = i >= this.next && i < this.next + 2));
    if (this.done) return;
    const pp = player.body.translation();
    const gate = this.gates[this.next];
    if (gate && Math.hypot(gate.x - pp.x, gate.z - pp.z) < 12) {
      this.next++;
      if (this.next >= this.gates.length) {
        this.done = true;
        const place = this.standings(player).findIndex((r) => r.player) + 1;
        this.events.push({ type: 'finish', place, reward: Math.round(this.reward / place) });
      } else this.events.push({ type: 'checkpoint', index: this.next, of: this.gates.length });
    }
    for (const v of this.rivals) {
      const g = this.gates[v.gate];
      if (!g) {
        v.input.throttle = 0;
        v.input.brake = 1;
        v.update(dt, time);
        continue;
      }
      const p = v.body.translation();
      if (Math.hypot(g.x - p.x, g.z - p.z) < 13) v.gate++;
      // Rubber band: rivals far behind get a little help, those far ahead ease off.
      const lead = v.gate - this.next;
      driveToward(v, g.x, g.z, { maxSpeed: 62 + (lead < 0 ? 10 : lead > 1 ? -8 : 0), nitro: lead < 0 });
      v.update(dt, time);
    }
  }
  end() {
    for (const g of this.gates) this.ctx.scene.remove(g.mesh);
    for (const v of this.rivals) v.remove();
    this.rivals = [];
  }
}
