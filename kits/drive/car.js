// Car models: a detailed procedural car (styles: super, sports, muscle, suv, police), or a 3D model
// file (.glb, e.g. one Keo made with build__model) with the kit's wheels and lights.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { carbonTexture } from './textures.js';

/** Paint finishes for the garage's "sprays". */
export function paintMaterial(color = '#b0121b', finish = 'gloss') {
  const base = { color, envMapIntensity: 1.3 };
  if (finish === 'matte') return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.1, roughness: 0.62, clearcoat: 0.1, clearcoatRoughness: 0.6 });
  if (finish === 'metallic') return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.85, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  if (finish === 'pearl') return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.5, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.9, iridescenceIOR: 1.6, sheen: 0.4, sheenColor: '#ffffff' });
  if (finish === 'chrome') return new THREE.MeshPhysicalMaterial({ ...base, metalness: 1, roughness: 0.06, clearcoat: 1 });
  return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0.45, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
}

/** Proportions per style: length, width, sill, beltline, roof, cabin start/end, hood drop, wheel radius. */
const STYLES = {
  super: { L: 4.55, W: 2.0, sill: 0.28, belt: 0.82, roof: 1.12, cab: [-0.55, 0.95], nose: 0.5, tail: 0.86, r: 0.36, wing: true, wb: 1.38 },
  sports: { L: 4.45, W: 1.9, sill: 0.3, belt: 0.92, roof: 1.3, cab: [-0.85, 0.75], nose: 0.6, tail: 0.92, r: 0.35, wing: false, wb: 1.36 },
  muscle: { L: 4.75, W: 1.95, sill: 0.33, belt: 1.0, roof: 1.36, cab: [-1.0, 0.45], nose: 0.82, tail: 0.98, r: 0.37, wing: true, wb: 1.45 },
  suv: { L: 4.8, W: 2.0, sill: 0.48, belt: 1.18, roof: 1.78, cab: [-1.85, 1.0], nose: 1.02, tail: 1.12, r: 0.42, wing: false, wb: 1.5 },
  police: { L: 4.95, W: 1.92, sill: 0.34, belt: 0.98, roof: 1.48, cab: [-1.35, 0.85], nose: 0.78, tail: 0.98, r: 0.36, wing: false, wb: 1.48 },
};

function extrudeProfile(points, width, bevel) {
  const s = new THREE.Shape();
  points.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 4, curveSegments: 10 });
  // Profile in (z, y) → car space: x across, y up, z forward.
  g.rotateY(-Math.PI / 2);
  g.translate((width - bevel * 2) / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

function wheel(r, width, rimMat, tireMat) {
  const w = new THREE.Group();
  const tireProfile = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    tireProfile.push(new THREE.Vector2(r * 0.72 + Math.sin(a) * r * 0.28, -width / 2 + (1 - Math.cos(a)) * (width / 2)));
  }
  const tire = new THREE.Mesh(new THREE.LatheGeometry(tireProfile, 28).rotateZ(Math.PI / 2), tireMat);
  tire.castShadow = true;
  w.add(tire);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.7, width * 0.82, 24).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#111', metalness: 0.4, roughness: 0.5 }));
  w.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, width * 0.95, 12).rotateZ(Math.PI / 2), rimMat);
  w.add(hub);
  for (let k = 0; k < 5; k++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width * 0.2, r * 0.58, r * 0.13), rimMat);
    spoke.position.y = r * 0.33;
    const holder = new THREE.Group();
    holder.add(spoke);
    holder.rotation.x = (k / 5) * Math.PI * 2;
    holder.position.x = width * 0.36;
    w.add(holder);
  }
  const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.69, r * 0.035, 6, 32).rotateY(Math.PI / 2).translate(width * 0.41, 0, 0), rimMat);
  w.add(lip);
  return w;
}

/**
 * A procedural car. opts: { style, color, finish, rimColor, police }.
 * Returns { group, wheels[4] (FL, FR, RL, RR), size, setBraking(on), update(time) }.
 */
export function createCarModel(opts = {}) {
  const st = STYLES[opts.style ?? 'sports'] ?? STYLES.sports;
  const police = opts.police || opts.style === 'police';
  const { L, W, sill, belt, roof, r } = st;
  const half = L / 2;
  const wb = st.wb;
  const group = new THREE.Group();
  const paint = paintMaterial(police ? '#f4f4f2' : (opts.color ?? '#a3101b'), opts.finish ?? 'gloss');
  const dark = new THREE.MeshStandardMaterial({ color: '#0d0e10', roughness: 0.55, metalness: 0.2 });
  const carbon = new THREE.MeshStandardMaterial({ map: carbonTexture(), roughness: 0.35, metalness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#0a0e14', metalness: 0.1, roughness: 0.05, transmission: 0, opacity: 0.92, transparent: true, clearcoat: 1, envMapIntensity: 2 });
  const chrome = new THREE.MeshStandardMaterial({ color: opts.rimColor ?? '#c9ccd1', metalness: 1, roughness: 0.18 });
  const tireMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92 });

  // Body side profile. The rounded edges (BV) grow the outline outwards, so the profile is drawn BV
  // inside the car's real outline: the arches then clear the wheels and lights sit on the skin.
  const BV = 0.12;
  const F = half - BV;
  const R = -half + BV;
  const bottom = sill + BV;
  const arch = r + 0.07 + BV;
  const quad = (out, [ax, ay], [cx, cy], [bx, by], n = 8) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push([(1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx, (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by]);
    }
  };
  const prof = [[R + 0.12, bottom]];
  // Wheel arches round the wheel centres, from the sill up and over.
  const a0 = Math.asin(Math.max(-0.95, Math.min(0.95, (bottom - r) / arch)));
  for (const zc of [-wb, wb])
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI - a0 - (i / 12) * (Math.PI - 2 * a0);
      prof.push([zc + Math.cos(a) * arch, r + Math.sin(a) * arch]);
    }
  prof.push([F - 0.14, bottom]);
  prof.push([F, bottom + 0.14]);
  prof.push([F, st.nose - BV - 0.08]);
  // Hood: a soft curve from the nose up to the base of the windscreen.
  quad(prof, [F - 0.06, st.nose - BV], [st.cab[1] + 0.9, belt - BV + 0.08], [st.cab[1] + 0.3, belt - BV]);
  prof.push([st.cab[0] - 0.1, belt - BV + 0.03]);
  // Rear deck curving down to the tail.
  quad(prof, [st.cab[0] - 0.4, belt - BV + 0.02], [R + 0.25, belt - BV + 0.03], [R + 0.06, st.tail - BV]);
  prof.push([R, st.tail - BV - 0.12]);
  prof.push([R, bottom + 0.14]);
  const body = new THREE.Mesh(extrudeProfile(prof, W, BV), paint);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Cabin: tinted glass greenhouse, a little narrower, with a painted roof panel.
  const cw = W * 0.82;
  const [c0, c1] = st.cab;
  const cabin = new THREE.Mesh(
    extrudeProfile(
      (() => {
        // Raked windscreen and a curved roof and rear window.
        const pts = [
          [c0 - 0.2, belt - 0.12],
          [c1 + 0.38, belt - 0.12],
        ];
        quad(pts, [c1 + 0.38, belt - 0.12], [c1 + 0.05, roof - 0.12], [c1 - 0.25, roof - 0.08], 6);
        quad(pts, [c1 - 0.25, roof - 0.08], [(c0 + c1) / 2, roof - 0.02], [c0 + 0.3, roof - 0.1], 6);
        quad(pts, [c0 + 0.3, roof - 0.1], [c0 - 0.05, roof - 0.18], [c0 - 0.2, belt - 0.12], 6);
        pts.pop();
        return pts;
      })(),
      cw,
      0.08,
    ),
    glass,
  );
  cabin.castShadow = true;
  group.add(cabin);
  // Painted roof skin over the middle of the glass canopy (glass stays at the windscreen and rear).
  const roofPts = [];
  quad(roofPts, [c1 - 0.32, roof - 0.07], [(c0 + c1) / 2, roof - 0.01], [c0 + 0.38, roof - 0.09], 10);
  const roofProf = [...roofPts.map(([z, y]) => [z, y + 0.07]), ...roofPts.reverse().map(([z, y]) => [z, y + 0.1])];
  const roofPanel = new THREE.Mesh(extrudeProfile(roofProf, cw * 0.96, 0.02), paint);
  group.add(roofPanel);

  // Lights.
  const headMat = new THREE.MeshStandardMaterial({ color: '#dfe8f2', emissive: '#e6f0ff', emissiveIntensity: 4, roughness: 0.1 });
  const tailMat = new THREE.MeshStandardMaterial({ color: '#3a0306', emissive: '#ff1428', emissiveIntensity: 1.6, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.06), headMat);
    h.position.set(s * (W / 2 - 0.34), st.nose - 0.06, half + BV - 0.05);
    h.rotation.y = s * -0.25;
    group.add(h);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.14), paint);
    mirror.position.set(s * (cw / 2 + 0.12), belt + 0.12, c1 - 0.1);
    group.add(mirror);
  }
  // Tail lights: two wide units and a thin light bar between them, and a third brake light.
  for (const s of [-1, 1]) {
    const unit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.06), tailMat);
    unit.position.set(s * (W / 2 - 0.38), st.tail - 0.06, -half - BV + 0.02);
    group.add(unit);
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(W - 1.3, 0.035, 0.05), tailMat);
  strip.position.set(0, st.tail - 0.04, -half - BV + 0.02);
  group.add(strip);
  const third = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.04), tailMat);
  third.position.set(0, roof - 0.02, st.cab[0] + 0.32);
  group.add(third);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.02), new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.5 }));
  plate.position.set(0, sill + 0.2, -half - BV + 0.01);
  group.add(plate);

  // Splitter, diffuser, exhausts, spoiler.
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(W - 0.2, 0.04, 0.3), carbon);
  splitter.position.set(0, sill - 0.1, half + 0.02);
  group.add(splitter);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 0.14, 0.25), carbon);
  diffuser.position.set(0, sill - 0.04, -half - BV + 0.1);
  group.add(diffuser);
  for (const s of [-1, 1]) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12).rotateX(Math.PI / 2), chrome);
    ex.position.set(s * 0.42, sill + 0.0, -half - BV - 0.02);
    group.add(ex);
  }
  if (st.wing && !police) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(W - 0.15, 0.04, 0.32), carbon);
    wing.position.set(0, st.tail + 0.26, -half + 0.28);
    group.add(wing);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.24, 0.12), carbon);
      post.position.set(s * 0.55, st.tail + 0.13, -half + 0.3);
      group.add(post);
    }
  }
  // Grille.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, 0.14, 0.04), dark);
  grille.position.set(0, sill + 0.12, half + BV - 0.03);
  group.add(grille);

  // Police: black doors and hood, light bar.
  let bar = null;
  if (police) {
    paint.color.set('#f4f4f2');
    const black = paintMaterial('#0b0b0c', 'gloss');
    const door = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, belt - sill - 0.12, 1.9), black);
    door.position.set(0, (belt + sill) / 2 + 0.02, -0.15);
    group.add(door);
    const red = new THREE.MeshStandardMaterial({ color: '#300', emissive: '#ff1010', emissiveIntensity: 0 });
    const blue = new THREE.MeshStandardMaterial({ color: '#003', emissive: '#1a3cff', emissiveIntensity: 0 });
    bar = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.28), dark);
    const lr = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.24), red);
    lr.position.x = -0.3;
    const lb = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.24), blue);
    lb.position.x = 0.3;
    lr.position.y = lb.position.y = 0.08;
    bar.add(base, lr, lb);
    bar.position.set(0, roof + 0.06, (c0 + c1) / 2);
    bar.userData = { red, blue };
    group.add(bar);
  }

  // Wheels: FL, FR, RL, RR (positions used by the physics too).
  const wheels = [];
  for (const [z, s] of [
    [wb, -1],
    [wb, 1],
    [-wb, -1],
    [-wb, 1],
  ]) {
    const w = wheel(r, 0.26, chrome, tireMat);
    if (s > 0) w.rotation.y = Math.PI;
    const holder = new THREE.Group();
    holder.position.set(s * (W / 2 - 0.16), r, z);
    holder.add(w);
    holder.userData.spin = w;
    holder.userData.side = s;
    group.add(holder);
    wheels.push(holder);
  }

  return {
    group,
    wheels,
    paint,
    size: { length: L, width: W, height: roof, wheelRadius: r, wheelBase: wb, track: W / 2 - 0.16 },
    setBraking(on) {
      tailMat.emissiveIntensity = on ? 5 : 1.6;
    },
    setHeadlights(on) {
      headMat.emissiveIntensity = on ? 4 : 0.3;
    },
    setPaint(color, finish) {
      const m = paintMaterial(color, finish);
      for (const o of [body, roofPanel]) o.material = m;
      group.traverse((o) => {
        if (o.isMesh && o.material === paint) o.material = m;
      });
    },
    update(time, sirenOn = true) {
      if (!bar) return;
      const phase = Math.floor(time * 8) % 4;
      bar.userData.red.emissiveIntensity = sirenOn && phase < 2 ? 9 : 0;
      bar.userData.blue.emissiveIntensity = sirenOn && phase >= 2 ? 9 : 0;
    },
  };
}

const loader = new GLTFLoader();

/**
 * A car from a 3D model file (.glb), scaled to a real car's length and set on the ground, facing
 * forward (+z). The kit's own wheels go on unless the model has its own (opts.ownWheels).
 * opts: { length (m, default 4.6), turn (radians, if the model faces another way), style, wheelRadius }
 */
export async function loadCarModel(url, opts = {}) {
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  model.rotation.y = opts.turn ?? 0;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // The longer side of the model is its length.
  if (size.x > size.z && opts.turn === undefined) {
    model.rotation.y = Math.PI / 2;
    model.updateMatrixWorld(true);
    box.setFromObject(model);
    box.getSize(size);
  }
  const scale = (opts.length ?? 4.6) / Math.max(size.z, 0.01);
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) o.material.envMapIntensity = 1.3;
    }
  });
  const base = createCarModel({ style: opts.style ?? 'sports' });
  const group = new THREE.Group();
  group.add(model);
  const sized = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  const r = opts.wheelRadius ?? Math.max(0.3, Math.min(0.45, sized.y * 0.27));
  const wb = sized.z * 0.31;
  const track = sized.x / 2 - 0.18;
  const wheels = [];
  for (const [z, s] of [
    [wb, -1],
    [wb, 1],
    [-wb, -1],
    [-wb, 1],
  ]) {
    const holder = new THREE.Group();
    holder.position.set(s * track, r, z);
    if (!opts.ownWheels) {
      const w = base.wheels[0].userData.spin.clone();
      if (s > 0) w.rotation.y = Math.PI;
      holder.add(w);
      holder.userData.spin = w;
    }
    holder.userData.side = s;
    group.add(holder);
    wheels.push(holder);
  }
  return {
    group,
    wheels,
    size: { length: sized.z, width: sized.x, height: sized.y, wheelRadius: r, wheelBase: wb, track },
    setBraking() {},
    setHeadlights() {},
    setPaint() {},
    update() {},
  };
}
