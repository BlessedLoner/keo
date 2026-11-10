// Visual effects: skid marks, sparks, nitro flames and rain.
import * as THREE from 'three';
import { glowTexture } from './textures.js';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    // Skid marks: a ring buffer of dark quads on the road.
    this.maxSkid = 1200;
    this.skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#050505', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }), this.maxSkid);
    this.skids.count = 0;
    this.skidI = 0;
    this.skids.frustumCulled = false;
    scene.add(this.skids);
    // Sparks.
    this.sparks = [];
    const n = 300;
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(n * 3);
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkPts = new THREE.Points(this.sparkGeo, new THREE.PointsMaterial({ color: '#ffc06a', map: glowTexture('255,200,120'), size: 0.11, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.sparkPts.frustumCulled = false;
    scene.add(this.sparkPts);
    // Nitro flame sprites (two exhausts).
    const flameMat = new THREE.SpriteMaterial({ map: glowTexture('120,170,255'), color: '#7fb2ff', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.flames = [new THREE.Sprite(flameMat), new THREE.Sprite(flameMat.clone())];
    for (const f of this.flames) {
      f.scale.set(0.9, 0.9, 1);
      f.visible = false;
      scene.add(f);
    }
    this.rain = null;
  }

  /** Skid marks under the rear wheels while sliding. */
  skid(vehicle) {
    if (vehicle.slip < 0.28 || Math.abs(vehicle.speed) < 6) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.heading);
    for (const i of [2, 3]) {
      const w = vehicle.model.wheels[i];
      const p = w.getWorldPosition(new THREE.Vector3());
      m.compose(new THREE.Vector3(p.x, 0.1, p.z), q, new THREE.Vector3(1, 1, 1));
      this.skids.setMatrixAt(this.skidI, m);
      this.skidI = (this.skidI + 1) % this.maxSkid;
      this.skids.count = Math.min(this.maxSkid, this.skids.count + 1);
    }
    this.skids.instanceMatrix.needsUpdate = true;
  }

  spark(at, count = 24) {
    for (let i = 0; i < count; i++) this.sparks.push({ p: at.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 9, Math.random() * 6, (Math.random() - 0.5) * 9), life: 0.5 + Math.random() * 0.4 });
    if (this.sparks.length > 300) this.sparks.splice(0, this.sparks.length - 300);
  }

  nitro(vehicle, on) {
    const back = vehicle.model.size.length / 2 + 0.25;
    this.flames.forEach((f, i) => {
      f.visible = on;
      if (!on) return;
      const local = new THREE.Vector3(i ? 0.32 : -0.32, 0.38, -back);
      f.position.copy(vehicle.model.group.localToWorld(local));
      const s = 0.7 + Math.random() * 0.6;
      f.scale.set(s, s, 1);
    });
  }

  /** Rain on/off (wet roads come from the world's time-of-day roughness). */
  setRain(on, camera) {
    if (on && !this.rain) {
      const n = 6000;
      const pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const x = (Math.random() - 0.5) * 120;
        const y = Math.random() * 40;
        const z = (Math.random() - 0.5) * 120;
        pos.set([x, y, z, x, y - 0.7, z], i * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#9fb4d0', transparent: true, opacity: 0.35 }));
      this.rain.frustumCulled = false;
      this.rain.userData.camera = camera;
      this.scene.add(this.rain);
    } else if (!on && this.rain) {
      this.scene.remove(this.rain);
      this.rain = null;
    }
  }

  update(dt) {
    let k = 0;
    for (const s of this.sparks) {
      s.life -= dt;
      s.v.y -= 18 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.life > 0 && k < 300) this.sparkPos.set([s.p.x, Math.max(0.05, s.p.y), s.p.z], k++ * 3);
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
    this.sparkGeo.setDrawRange(0, k);
    this.sparkGeo.attributes.position.needsUpdate = true;
    if (this.rain) {
      const cam = this.rain.userData.camera;
      this.rain.position.set(cam.position.x, cam.position.y - 15 - ((performance.now() / 25) % 20), cam.position.z);
    }
  }
}
