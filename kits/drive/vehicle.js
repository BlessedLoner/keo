// Car physics: Rapier's raycast vehicle (suspension, tyre grip, steering, engine and brakes per
// wheel) with arcade help so it feels like a racing game: downforce, drift on the handbrake,
// nitro, a speed-sensitive steering, damage and auto-recovery.
import * as THREE from 'three';

/** Base specs; garage upgrades multiply these (see garage.js). */
export const DEFAULT_SPEC = {
  mass: 1350,
  /** Engine force at the wheels (N). */
  power: 9500,
  /** Top speed (m/s; 90 m/s ≈ 200 mph). */
  topSpeed: 78,
  brake: 85,
  grip: 3.2,
  steer: 0.6,
  /** Nitro: extra force and how many seconds a full tank lasts. */
  nitroForce: 7500,
  nitroSeconds: 4,
  /** 0..0.9: share of crash damage the armour takes. */
  armor: 0,
  suspension: 32,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Car specs in the units the physics needs, whatever way they were written. Ratings are accepted
 * (0–1, 0–10 or 0–100: power, topSpeed, grip, brake) and so is a top speed in km/h or mph-like
 * numbers above 130; mass may be in tonnes. Missing or broken values fall back to DEFAULT_SPEC.
 */
export function normalSpec(spec = {}) {
  const s = { ...DEFAULT_SPEC };
  for (const [k, v] of Object.entries(spec ?? {})) if (typeof v === 'number' && Number.isFinite(v)) s[k] = v;
  const rating = (v) => clamp01(v <= 1 ? v : v <= 10 ? v / 10 : v / 100);
  // Power: real values are thousands of newtons.
  if (s.power <= 100) s.power = 7000 + rating(s.power) * 9000;
  else if (s.power < 2000) s.power = 7000 + clamp01(s.power / 1000) * 9000; // horsepower-like
  // Top speed: m/s; ratings and km/h are converted.
  if (s.topSpeed <= 10) s.topSpeed = 55 + rating(s.topSpeed) * 45;
  else if (s.topSpeed > 130) s.topSpeed = s.topSpeed / 3.6;
  s.topSpeed = Math.max(30, Math.min(120, s.topSpeed));
  if (s.grip <= 1) s.grip = 2.6 + rating(s.grip) * 1.5;
  else if (s.grip > 6) s.grip = 2.6 + rating(s.grip) * 1.5;
  if (s.brake <= 10) s.brake = 60 + rating(s.brake) * 60;
  if (s.mass < 50) s.mass = s.mass < 5 ? s.mass * 1000 : 1350;
  s.mass = Math.max(600, Math.min(4000, s.mass));
  s.armor = Math.max(0, Math.min(0.9, s.armor > 1 ? s.armor / 100 : s.armor));
  if (!(s.steer > 0.2 && s.steer < 1.2)) s.steer = DEFAULT_SPEC.steer;
  if (!(s.nitroForce > 500)) s.nitroForce = DEFAULT_SPEC.nitroForce;
  if (!(s.nitroSeconds > 0.5)) s.nitroSeconds = DEFAULT_SPEC.nitroSeconds;
  if (!(s.suspension > 5 && s.suspension < 120)) s.suspension = DEFAULT_SPEC.suspension;
  return s;
}

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Vehicle {
  /**
   * ctx: { scene, physics: { world, RAPIER } }; model: from createCarModel / loadCarModel;
   * spec: DEFAULT_SPEC overrides; at: { x, z, heading }.
   */
  constructor(ctx, model, spec = {}, at = { x: 0, z: 0, heading: 0 }) {
    this.ctx = ctx;
    this.model = model;
    this.spec = normalSpec(spec);
    this.health = 1;
    this.nitro = 1;
    this.steerNow = 0;
    this.shield = 0;
    this.input = { throttle: 0, steer: 0, brake: 0, handbrake: false, nitro: false };
    this.events = [];
    const { world, RAPIER } = ctx.physics;
    this.RAPIER = RAPIER;
    const { length: L, width: W, height: H, wheelRadius: r, wheelBase: wb, track } = model.size;
    const m = this.spec.mass;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(at.x, 0.4, at.z)
      .setRotation({ x: 0, y: Math.sin(at.heading / 2), z: 0, w: Math.cos(at.heading / 2) })
      .setLinearDamping(0.06)
      .setAngularDamping(0.9)
      .setCanSleep(false)
      .setCcdEnabled(true)
      // The weight sits low (that is what keeps a real car on its wheels).
      .setAdditionalMassProperties(m, { x: 0, y: 0.32, z: 0.05 }, { x: (m / 12) * (0.9 + L * L), y: (m / 12) * (W * W + L * L), z: (m / 12) * (W * W + 0.9) }, { x: 0, y: 0, z: 0, w: 1 });
    this.body = world.createRigidBody(desc);
    const bodyH = Math.max(0.35, (H - 0.35) / 2);
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(W / 2 - 0.05, bodyH * 0.75, L / 2 - 0.05)
        .setTranslation(0, 0.35 + bodyH * 0.75, 0)
        .setDensity(0)
        .setFriction(0.35)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
      this.body,
    );
    this.collider.setContactForceEventThreshold(m * 6);
    this.vc = world.createVehicleController(this.body);
    this.vc.setIndexForwardAxis = 2;
    this.vc.indexUpAxis = 1;
    this.rest = 0.3;
    this.r = r;
    const points = [
      [-track, wb],
      [track, wb],
      [-track, -wb],
      [track, -wb],
    ];
    for (const [x, z] of points) this.vc.addWheel({ x, y: this.rest + r, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.rest, r);
    this.applySpec();
    ctx.scene.add(model.group);
    this.sync(0);
  }

  /** Re-applies the specs (after an upgrade). */
  applySpec(spec) {
    if (spec) this.spec = normalSpec({ ...this.spec, ...spec });
    const s = this.spec;
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelSuspensionStiffness(i, s.suspension);
      this.vc.setWheelSuspensionCompression(i, 3.2);
      this.vc.setWheelSuspensionRelaxation(i, 4.2);
      this.vc.setWheelMaxSuspensionTravel(i, 0.35);
      this.vc.setWheelMaxSuspensionForce(i, s.mass * 60);
      this.vc.setWheelFrictionSlip(i, s.grip * (i < 2 ? 1.0 : 1.06));
      this.vc.setWheelSideFrictionStiffness(i, 1);
    }
  }

  get position() {
    const t = this.body.translation();
    return tmpV.set(t.x, t.y, t.z).clone();
  }
  /** Direction the car faces (radians, like the city's headings). */
  get heading() {
    const q = this.body.rotation();
    tmpQ.set(q.x, q.y, q.z, q.w);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(tmpQ);
    return Math.atan2(f.x, f.z);
  }
  /** Forward speed in m/s (negative when reversing). */
  get speed() {
    return this.vc.currentVehicleSpeed();
  }
  get mph() {
    return Math.abs(this.speed) * 2.23694;
  }
  /** How much the car slides sideways (0 = rolling straight, 1 = full drift). */
  get slip() {
    const v = this.body.linvel();
    const sp = Math.hypot(v.x, v.z);
    if (sp < 3) return 0;
    const h = this.heading;
    const side = Math.abs(v.x * Math.cos(h) - v.z * Math.sin(h));
    return Math.min(1, side / sp);
  }

  update(dt, time = 0) {
    const s = this.spec;
    const inp = this.input;
    const speed = this.speed;
    const absSp = Math.abs(speed);
    // Steering: quick at low speed, calmer at high speed, eased in.
    const target = inp.steer * s.steer * (1 / (1 + absSp * 0.045));
    this.steerNow += (target - this.steerNow) * Math.min(1, dt * 9);
    this.vc.setWheelSteering(0, this.steerNow);
    this.vc.setWheelSteering(1, this.steerNow);
    // Engine: strong pull that fades near top speed; reverse after stopping when braking.
    let force = 0;
    let brake = 0;
    const ratio = absSp / s.topSpeed;
    if (inp.throttle > 0) force = inp.throttle * s.power * Math.max(0, 1 - ratio * ratio) * (speed < -1 ? 0 : 1);
    if (inp.brake > 0) {
      if (speed > 1.5) brake = inp.brake * s.brake;
      else force = -inp.brake * s.power * 0.45 * Math.max(0, 1 - absSp / 18);
    }
    if (inp.throttle > 0 && speed < -1) brake = s.brake;
    this.boosting = false;
    if (inp.nitro && this.nitro > 0 && inp.throttle > 0) {
      force += s.nitroForce;
      this.nitro = Math.max(0, this.nitro - dt / s.nitroSeconds);
      this.boosting = true;
    } else this.nitro = Math.min(1, this.nitro + dt * 0.04);
    // Rear-wheel drive with a little at the front: stable but lively.
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelEngineForce(i, (i < 2 ? 0.25 : 0.75) * force);
      this.vc.setWheelBrake(i, brake * (i < 2 ? 0.6 : 0.4));
    }
    // Handbrake: rear wheels lock and lose grip → drift.
    for (let i = 2; i < 4; i++) {
      this.vc.setWheelFrictionSlip(i, inp.handbrake ? s.grip * 0.42 : s.grip * 1.06);
      if (inp.handbrake) this.vc.setWheelBrake(i, s.brake * 0.6);
    }
    this.vc.updateVehicle(dt);
    // Downforce keeps a fast car planted. Forces added to a body stay until cleared, so last step's
    // is cleared first: without this the downforce piled up every step until, after a minute or so
    // of driving, the car was pressed into the road, stuck, and wrecked by its own "crashes".
    const down = -absSp * absSp * 0.9;
    this.body.resetForces(true);
    this.body.addForce({ x: 0, y: down, z: 0 }, true);
    // Stuck on its roof or side: put it back on the road.
    const q = this.body.rotation();
    tmpQ.set(q.x, q.y, q.z, q.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(tmpQ);
    if (up.y < 0.3 && absSp < 3) {
      this.flipTime = (this.flipTime ?? 0) + dt;
      if (this.flipTime > 1.5) this.recover();
    } else this.flipTime = 0;
    if (this.shield > 0) this.shield = Math.max(0, this.shield - dt);
    this.sync(time);
  }

  /** A crash with this force (from the physics contact events). */
  hit(force) {
    if (this.shield > 0) return 0;
    const dmg = Math.min(0.35, force / (this.spec.mass * 900)) * (1 - this.spec.armor);
    this.health = Math.max(0, this.health - dmg);
    this.events.push({ type: 'crash', force, dmg });
    return dmg;
  }

  /** Back on its wheels where it is (or at a given place on the road). */
  recover(at) {
    const p = this.body.translation();
    const x = at?.x ?? p.x;
    const z = at?.z ?? p.z;
    const h = at?.heading ?? this.heading;
    this.body.setTranslation({ x, y: 0.6, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flipTime = 0;
  }

  /** Copies the physics to the 3D model (body, wheel travel, steering and spin, brake lights). */
  sync(time) {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.model.group.position.set(t.x, t.y, t.z);
    this.model.group.quaternion.set(q.x, q.y, q.z, q.w);
    for (let i = 0; i < 4; i++) {
      const holder = this.model.wheels[i];
      if (!holder) continue;
      const len = this.vc.wheelSuspensionLength(i) ?? this.rest;
      holder.position.y = this.rest + this.r - len;
      holder.rotation.y = i < 2 ? this.steerNow : 0;
      const spin = holder.userData.spin;
      if (spin) spin.rotation.x = (this.vc.wheelRotation(i) ?? 0) * (holder.userData.side > 0 ? -1 : 1);
    }
    this.model.setBraking(this.input.brake > 0.1 || this.input.handbrake);
    this.model.update(time, true);
  }

  remove() {
    const { world } = this.ctx.physics;
    world.removeVehicleController(this.vc);
    world.removeRigidBody(this.body);
    this.ctx.scene.remove(this.model.group);
  }
}

/** Steering for computer drivers: head for a point, ease off for bends. */
export function driveToward(v, tx, tz, opts = {}) {
  const p = v.body.translation();
  const h = v.heading;
  const want = Math.atan2(tx - p.x, tz - p.z);
  let diff = want - h;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const dist = Math.hypot(tx - p.x, tz - p.z);
  const sharp = Math.abs(diff);
  const max = opts.maxSpeed ?? 40;
  const want_sp = Math.min(max, sharp > 1.2 ? 9 : sharp > 0.6 ? 18 : max);
  v.input.steer = Math.max(-1, Math.min(1, diff * 2.2));
  const sp = v.speed;
  v.input.throttle = sp < want_sp ? 1 : 0.15;
  v.input.brake = sp > want_sp + 6 ? 0.8 : 0;
  v.input.handbrake = false;
  v.input.nitro = !!opts.nitro && sharp < 0.2 && dist > 80;
  // Reverse out when stuck against a wall.
  v.stuck = Math.abs(sp) < 1 && v.input.throttle > 0.5 ? (v.stuck ?? 0) + 1 : 0;
  if (v.stuck > 90) {
    v.input.throttle = 0;
    v.input.brake = 1;
    v.input.steer = -v.input.steer;
    if (v.stuck > 160) v.stuck = 0;
  }
  return dist;
}
export { UP };
