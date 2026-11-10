// Chase camera and player controls (keyboard, gamepad, touch).
import * as THREE from 'three';

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.shakeT = 0;
    this.view = 0; // 0 = chase, 1 = far chase, 2 = bumper
    this.first = true;
  }
  shake(amount = 0.5) {
    this.shakeT = Math.max(this.shakeT, amount);
  }
  cycle() {
    this.view = (this.view + 1) % 3;
  }
  update(dt, vehicle) {
    const t = vehicle.body.translation();
    const h = vehicle.heading;
    const sp = Math.abs(vehicle.speed);
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const car = new THREE.Vector3(t.x, t.y, t.z);
    let want;
    let look;
    if (this.view === 2) {
      want = car.clone().addScaledVector(fwd, 0.6).add(new THREE.Vector3(0, 1.05, 0));
      look = car.clone().addScaledVector(fwd, 20).add(new THREE.Vector3(0, 0.9, 0));
    } else {
      const back = (this.view === 1 ? 9.5 : 6.4) + sp * 0.035;
      want = car.clone().addScaledVector(fwd, -back).add(new THREE.Vector3(0, this.view === 1 ? 3.4 : 2.25, 0));
      look = car.clone().addScaledVector(fwd, 4 + sp * 0.08).add(new THREE.Vector3(0, 1.0, 0));
    }
    if (this.first) {
      this.pos.copy(want);
      this.look.copy(look);
      this.first = false;
    }
    const k = this.view === 2 ? 1 : 1 - Math.exp(-dt * 6.5);
    this.pos.lerp(want, k);
    this.look.lerp(look, 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.pos);
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt * 1.8);
      const s = this.shakeT * 0.35;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.camera.lookAt(this.look);
    // Speed widens the view; nitro more.
    const fov = 60 + Math.min(18, sp * 0.22) + (vehicle.boosting ? 8 : 0);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }
}

/**
 * Keyboard (WASD / arrows, Space handbrake, Shift nitro), gamepad (triggers, stick, A/B) and
 * touch buttons (made on touch screens). read() gives { throttle, brake, steer, handbrake, nitro }.
 * Keys for game actions (camera C, pause P/Esc, horn H, gadgets 1–4…) arrive through onKey.
 */
export class Controls {
  constructor(root = document.body) {
    this.keys = new Set();
    this.touch = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
    this.listeners = [];
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      for (const fn of this.listeners) fn(e.code, e);
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    if (matchMedia('(pointer: coarse)').matches) this.makeTouch(root);
  }
  onKey(fn) {
    this.listeners.push(fn);
  }
  makeTouch(root) {
    const pad = document.createElement('div');
    pad.className = 'kd-touch';
    const btn = (label, cls, on, off) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = `kd-tbtn ${cls}`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        on();
      });
      const end = () => off();
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      pad.appendChild(b);
      return b;
    };
    btn('◀', 'left', () => (this.touch.steer = -1), () => (this.touch.steer = 0));
    btn('▶', 'right', () => (this.touch.steer = 1), () => (this.touch.steer = 0));
    btn('GAS', 'gas', () => (this.touch.throttle = 1), () => (this.touch.throttle = 0));
    btn('BRAKE', 'brake', () => (this.touch.brake = 1), () => (this.touch.brake = 0));
    btn('DRIFT', 'drift', () => (this.touch.handbrake = true), () => (this.touch.handbrake = false));
    btn('NOS', 'nos', () => (this.touch.nitro = true), () => (this.touch.nitro = false));
    root.appendChild(pad);
  }
  read() {
    const k = this.keys;
    const kb = {
      throttle: k.has('KeyW') || k.has('ArrowUp') ? 1 : 0,
      brake: k.has('KeyS') || k.has('ArrowDown') ? 1 : 0,
      steer: (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      handbrake: k.has('Space'),
      nitro: k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyN'),
    };
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (gp) {
      const ax = Math.abs(gp.axes[0]) > 0.12 ? gp.axes[0] : 0;
      kb.steer = kb.steer || ax;
      kb.throttle = Math.max(kb.throttle, gp.buttons[7]?.value ?? 0);
      kb.brake = Math.max(kb.brake, gp.buttons[6]?.value ?? 0);
      kb.handbrake ||= !!gp.buttons[0]?.pressed;
      kb.nitro ||= !!gp.buttons[1]?.pressed;
    }
    const t = this.touch;
    // Steering left/right flips: the car's right is +steer in screen terms.
    return {
      throttle: Math.max(kb.throttle, t.throttle),
      brake: Math.max(kb.brake, t.brake),
      steer: -(kb.steer || t.steer),
      handbrake: kb.handbrake || t.handbrake,
      nitro: kb.nitro || t.nitro,
    };
  }
}
