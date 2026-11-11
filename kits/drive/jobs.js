// Passenger and delivery jobs: people wait at the kerb around the city; stop next to one to pick
// them up, then drive them to where they want to go before the clock runs out. Fares grow with
// the distance by road; a smooth, fast ride earns a tip.
import * as THREE from 'three';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const SKIN = ['#f1c9a5', '#d9a377', '#b97a4f', '#8a5a3c', '#5e3b28'];
const CLOTHES = ['#1f2937', '#7c2d12', '#0f3d5c', '#365314', '#581c87', '#b91c1c', '#e5e7eb', '#ca8a04'];

/** A simple standing person (about 1.75 m). arm: the raised arm, to wave with. */
export function createPerson(opts = {}) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: opts.skin ?? pick(SKIN), roughness: 0.8 });
  const top = new THREE.MeshStandardMaterial({ color: opts.top ?? pick(CLOTHES), roughness: 0.9 });
  const legs = new THREE.MeshStandardMaterial({ color: opts.legs ?? pick(['#111827', '#1e3a5f', '#3f3f46', '#44403c']), roughness: 0.9 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  for (const s of [-1, 1]) add(new THREE.CapsuleGeometry(0.085, 0.68, 4, 8), legs, s * 0.1, 0.43, 0);
  add(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), top, 0, 1.13, 0).scale.set(1, 1, 0.7);
  add(new THREE.SphereGeometry(0.115, 14, 12), skin, 0, 1.62, 0);
  add(new THREE.SphereGeometry(0.122, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: pick(['#111111', '#3b2412', '#6b4a1e', '#9a9a9a']), roughness: 1 }), 0, 1.635, -0.01);
  add(new THREE.CapsuleGeometry(0.06, 0.5, 4, 8), top, -0.27, 1.1, 0);
  // The other arm hangs from the shoulder, so it can be raised to wave.
  const arm = new THREE.Group();
  arm.position.set(0.27, 1.38, 0);
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.5, 4, 8), top);
  upper.position.y = -0.28;
  upper.castShadow = true;
  arm.add(upper);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), skin);
  hand.position.y = -0.6;
  arm.add(hand);
  g.add(arm);
  return { group: g, arm };
}

function ring(color, radius) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const flat = new THREE.Mesh(new THREE.RingGeometry(radius - 0.35, radius, 48), mat);
  flat.rotation.x = -Math.PI / 2;
  flat.position.y = 0.06;
  // A tall soft beam, so the spot is easy to find from far away.
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 60, 20, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
  beam.position.y = 30;
  g.add(flat, beam);
  return g;
}

export class Jobs {
  /**
   * opts: { offers: 4 (people waiting at once), baseFare: 350, perKm: 1500, tip: 0.35 (share of the
   * fare for a fast ride), minTrip: 500, maxTrip: 2200 (metres), names: [...], label: 'Passenger',
   * person(): a THREE.Group of your own (e.g. a loaded .glb) instead of the built-in figure }.
   */
  constructor(ctx, city, opts = {}) {
    this.ctx = ctx;
    this.city = city;
    this.o = { offers: 4, baseFare: 350, perKm: 1500, tip: 0.35, minTrip: 500, maxTrip: 2200, label: 'Passenger', ...opts };
    this.offers = [];
    this.active = null;
    this.events = [];
    this.enabled = false;
    this.done = 0;
    this.nodes = [...city.graph.nodes.values()].filter((n) => n.edges.length);
  }

  /** Turns jobs on or off. Off: everyone waiting leaves and a ride in progress is cancelled. */
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.clear();
  }

  clear() {
    for (const f of this.offers) this.ctx.scene.remove(f.group);
    this.offers = [];
    if (this.active) this.ctx.scene.remove(this.active.marker);
    this.active = null;
  }

  /** A spot at the kerb beside a road, between min and max metres from a point. */
  kerb(near, min, max) {
    for (let t = 0; t < 40; t++) {
      const n = pick(this.nodes);
      const d = Math.hypot(n.x - near.x, n.z - near.z);
      if (d < min || d > max) continue;
      const e = pick(n.edges);
      const k = 0.25 + Math.random() * 0.5;
      const x = e.a.x + (e.b.x - e.a.x) * k;
      const z = e.a.z + (e.b.z - e.a.z) * k;
      const heading = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
      const half = (e.road?.width ?? (e.road?.lanes ?? 2) * 3.4) / 2;
      const side = Math.random() < 0.5 ? 1 : -1;
      // Right of the road direction is (cos h, -sin h). The person stands on the kerb; the car
      // stops in the lane beside them (x, z).
      const off = (m) => ({ x: x + Math.cos(heading) * side * m, z: z - Math.sin(heading) * side * m });
      const stop = off(half * 0.45);
      const kerb = off(half + 1.3);
      return { x: stop.x, z: stop.z, kerbX: kerb.x, kerbZ: kerb.z, roadX: x, roadZ: z, heading, node: n };
    }
    return null;
  }

  spawnOffer(near) {
    const at = this.kerb(near, 90, 520);
    if (!at) return;
    const p = this.o.person ? { group: this.o.person(), arm: null } : createPerson();
    const g = new THREE.Group();
    g.add(p.group, ring('#3ddc84', 4.5));
    g.position.set(at.x, 0, at.z);
    // On the kerb, facing the road.
    p.group.position.set(at.kerbX - at.x, 0, at.kerbZ - at.z);
    p.group.rotation.y = Math.atan2(at.roadX - at.kerbX, at.roadZ - at.kerbZ);
    this.ctx.scene.add(g);
    this.offers.push({ ...at, group: g, person: p, wait: 0, name: pick(this.o.names ?? ['Maya', 'Andre', 'Sofia', 'Jamal', 'Elena', 'Marcus', 'Priya', 'Diego', 'Hana', 'Tyler', 'Zoe', 'Omar']) });
  }

  /** Where the passenger wants to go: far enough away by road, with a fare for the distance. */
  plan(from) {
    for (let t = 0; t < 14; t++) {
      const to = this.kerb(from, this.o.minTrip * 0.7, this.o.maxTrip);
      if (!to) continue;
      const route = this.city.graph.path(this.city.graph.nearest(from.roadX, from.roadZ), to.node);
      if (!route || route.length < 2) continue;
      let metres = 0;
      for (let i = 1; i < route.length; i++) metres += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
      if (metres < this.o.minTrip) continue;
      return { to, metres, fare: Math.round((this.o.baseFare + (metres / 1000) * this.o.perKm) / 10) * 10, seconds: Math.round(25 + metres / 11) };
    }
    return null;
  }

  update(dt, player, time) {
    if (!this.enabled) return;
    const p = player.body.translation();
    const slow = Math.abs(player.speed) < 3.5;
    if (!this.active) {
      while (this.offers.length < this.o.offers) {
        const before = this.offers.length;
        this.spawnOffer(p);
        if (this.offers.length === before) break;
      }
      for (const f of this.offers) {
        f.wait += dt;
        const d = Math.hypot(f.x - p.x, f.z - p.z);
        // They wave when the car is close.
        if (f.person.arm) f.person.arm.rotation.z = d < 60 ? 2.5 + Math.sin(time * 9) * 0.35 : 0;
        if (d < 6 && slow) return this.pickUp(f, player);
        // Someone left far behind gives up; another person appears nearer.
        if (d > 700 || f.wait > 150) {
          this.ctx.scene.remove(f.group);
          this.offers.splice(this.offers.indexOf(f), 1);
          break;
        }
      }
      return;
    }
    const a = this.active;
    a.left -= dt;
    a.marker.rotation.y += dt * 0.8;
    const d = Math.hypot(a.to.x - p.x, a.to.z - p.z);
    if (d < 7 && slow) return this.dropOff();
    if (a.left <= -20) {
      // Far too late: the passenger gets out and pays nothing.
      this.ctx.scene.remove(a.marker);
      this.active = null;
      this.events.push({ type: 'job_failed', name: a.name });
    }
  }

  pickUp(f, player) {
    const trip = this.plan(f);
    this.ctx.scene.remove(f.group);
    this.offers.splice(this.offers.indexOf(f), 1);
    if (!trip) return;
    const marker = ring('#ffd23d', 5.5);
    marker.position.set(trip.to.x, 0, trip.to.z);
    this.ctx.scene.add(marker);
    this.active = { name: f.name, to: trip.to, fare: trip.fare, metres: trip.metres, left: trip.seconds, seconds: trip.seconds, marker, health: player.health };
    // The others wait while this ride is on.
    for (const o of this.offers) o.group.visible = false;
    this.events.push({ type: 'pickup', name: f.name, fare: trip.fare, metres: trip.metres, seconds: trip.seconds, to: { x: trip.to.x, z: trip.to.z } });
  }

  dropOff() {
    const a = this.active;
    this.ctx.scene.remove(a.marker);
    this.active = null;
    this.done++;
    const late = a.left < 0;
    const tip = late ? 0 : Math.round((a.fare * this.o.tip * Math.min(1, a.left / (a.seconds * 0.4))) / 10) * 10;
    const pay = late ? Math.round(a.fare * 0.5) : a.fare;
    for (const o of this.offers) o.group.visible = true;
    this.events.push({ type: 'dropoff', name: a.name, fare: pay, tip, late, metres: a.metres, total: pay + tip });
  }

  /** Dots for the minimap: people waiting (green), or where the passenger is going (yellow). */
  marks() {
    if (!this.enabled) return [];
    if (this.active) return [{ x: this.active.to.x, z: this.active.to.z, color: '#ffd23d', r: 9 }];
    return this.offers.map((f) => ({ x: f.x, z: f.z, color: '#3ddc84', r: 6 }));
  }

  /** The ride in progress as text for the HUD, or null. */
  status() {
    const a = this.active;
    if (!a) return null;
    const s = Math.max(0, Math.ceil(a.left));
    return { name: a.name, fare: a.fare, seconds: s, late: a.left < 0, text: `${a.name} · $${a.fare.toLocaleString('en-US')} · ${a.left < 0 ? 'late!' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}` };
  }
}
