// Keo's scene viewer: draws a visual explanation (objects, labels, steps that move things while a
// caption says what is happening). The scene is data; nothing in it is ever run as code.
// Used by Keo's chat and results panel and by Keo Studio, and usable in built sites.
//
// Made to look real: daylight with a true sky, reflections, soft shadows where things touch,
// rounded edges, and surfaces (brick, wood, glass, concrete…) at their real-world size.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeMaterial, worldUV } from './materials.js';

/** The setting: where the sun is, how strong the light is, what the ground and the air look like. */
const SETTINGS = {
  sky: { sky: true, sun: [0.5, 0.55, 0.42], sunColor: '#fff1dc', sunPower: 3.8, ambient: 0.85, env: 0.3, exposure: 0.5, fog: '#c4d8ec', ground: '#6f7f5c', label: '#ffffff', labelBg: 'rgba(14,18,28,.84)', turbidity: 2.2, rayleigh: 0.9 },
  sunset: { sky: true, sun: [0.8, 0.14, 0.3], sunColor: '#ffa860', sunPower: 3.4, ambient: 0.6, env: 0.26, exposure: 0.5, fog: '#d9a98c', ground: '#6b6552', label: '#ffffff', labelBg: 'rgba(14,18,28,.84)', turbidity: 7, rayleigh: 2.4 },
  night: { sky: false, back: '#070b14', sun: [0.3, 0.7, 0.5], sunColor: '#9db8ff', sunPower: 0.7, ambient: 0.22, env: 0.25, exposure: 0.9, fog: '#070b14', ground: '#1b212b', label: '#ffffff', labelBg: 'rgba(14,18,28,.86)' },
  dark: { sky: false, back: '#10141c', sun: [0.4, 0.75, 0.4], sunColor: '#ffffff', sunPower: 2.2, ambient: 0.4, env: 0.75, exposure: 0.85, fog: '#10141c', ground: '#1a202b', label: '#ffffff', labelBg: 'rgba(14,18,28,.86)' },
  light: { sky: false, back: '#eef1f5', sun: [0.4, 0.75, 0.4], sunColor: '#ffffff', sunPower: 2.4, ambient: 0.7, env: 1, exposure: 0.8, fog: '#eef1f5', ground: '#e3e7ec', label: '#10141c', labelBg: 'rgba(255,255,255,.94)' },
};

const GROUNDS = { grass: ['grass', '#6f9a4c'], concrete: ['concrete', '#a9aaa6'], asphalt: ['asphalt', '#4b4d51'] };

/** The colour an object has when the scene gives none. */
const DEFAULT_COLOR = '#8aa0b8';

const rad = (d) => (d * Math.PI) / 180;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function prism(points, depth) {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: Math.min(0.02, depth * 0.1), bevelSize: 0.015, bevelSegments: 2, curveSegments: 16 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** The shape of one object at its real size (metres), with texture coordinates at real-world scale. */
function geometryOf(o, tile) {
  const [w, h, d] = o.size;
  let g;
  switch (o.shape) {
    case 'sphere':
      g = new THREE.SphereGeometry(0.5, 56, 40).scale(w, h, d);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, 56).scale(w, h, d);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(0.5, 1, 56).scale(w, h, d);
      break;
    case 'torus':
      g = new THREE.TorusGeometry(0.5, 0.12, 24, 72).rotateX(Math.PI / 2).scale(w, Math.max(0.2, h) / 0.24, d);
      break;
    case 'capsule':
      g = new THREE.CapsuleGeometry(0.5, 1, 12, 32).scale(w, h / 2, d);
      break;
    case 'plane':
      g = new THREE.BoxGeometry(w, Math.min(Math.max(h, 0.02), 0.08), d);
      break;
    case 'wedge':
      g = prism([[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2]], d);
      break;
    case 'roof':
      // A pitched roof: the ridge runs along the depth.
      g = prism([[-w / 2, -h / 2], [w / 2, -h / 2], [0, h / 2]], d);
      break;
    case 'wall': {
      // A wall with real holes for its windows and doors.
      const s = new THREE.Shape();
      s.moveTo(-w / 2, -h / 2);
      s.lineTo(w / 2, -h / 2);
      s.lineTo(w / 2, h / 2);
      s.lineTo(-w / 2, h / 2);
      s.closePath();
      for (const op of o.openings ?? []) {
        const x0 = -w / 2 + Math.max(0.01, op.x);
        const y0 = -h / 2 + Math.max(0, op.y);
        const x1 = Math.min(w / 2 - 0.01, x0 + op.w);
        const y1 = Math.min(h / 2 - 0.01, y0 + op.h);
        if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
        const hole = new THREE.Path();
        hole.moveTo(x0, y0);
        hole.lineTo(x0, y1);
        hole.lineTo(x1, y1);
        hole.lineTo(x1, y0);
        hole.closePath();
        s.holes.push(hole);
      }
      g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
      g.translate(0, 0, -d / 2);
      break;
    }
    case 'extrude':
      g = prism(o.outline ?? [[0, 0], [1, 0], [0, 1]], Math.max(0.02, d));
      break;
    case 'lathe':
      g = new THREE.LatheGeometry((o.outline ?? [[0.5, 0], [0.5, 1]]).map(([r, y]) => new THREE.Vector2(Math.max(0.001, Math.abs(r)), y)), 64);
      break;
    case 'tube':
    case 'arrow': {
      const pts = (o.points ?? [[0, 0, 0], [0, 1, 0]]).map(v3);
      const curve = pts.length > 2 ? new THREE.CatmullRomCurve3(pts) : new THREE.LineCurve3(pts[0], pts[1]);
      g = new THREE.TubeGeometry(curve, Math.max(12, pts.length * 16), Math.max(0.01, w / 2), 18, false);
      break;
    }
    default: {
      // A box, with edges as round as real things have them.
      const least = Math.min(w, h, d);
      const r = Math.min(least / 2 - 0.0005, o.round !== undefined ? (o.round * least) / 2 : Math.min(0.03, least * 0.12));
      g = r > 0.002 ? new RoundedBoxGeometry(w, h, d, 4, r) : new THREE.BoxGeometry(w, h, d);
    }
  }
  return tile ? worldUV(g, tile) : g;
}

/** A tree at the size asked for: a trunk and a few lumps of leaves. */
function treeOf(o, add, clay) {
  const [w, h] = o.size;
  const trunk = clay ? clayMaterial(o.opacity) : makeMaterial('wood', '#6b4a2f', o.opacity).mat;
  add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.05, w * 0.08, h * 0.45, 14).translate(0, -h * 0.275, 0), trunk), trunk, false);
  const { mat: leaves, tile } = clay ? { mat: clayMaterial(o.opacity), tile: 1 } : makeMaterial('grass', o.color === DEFAULT_COLOR ? '#3f6b2f' : o.color, o.opacity);
  leaves.roughness = 1;
  leaves.bumpScale = 3;
  const lumps = [[0, 0.12, 0, 0.5], [0.22, 0.02, 0.1, 0.36], [-0.2, 0.05, -0.12, 0.38], [0.02, 0.3, -0.05, 0.34], [-0.05, 0.0, 0.22, 0.33], [0.12, 0.18, -0.2, 0.3], [-0.16, 0.24, 0.1, 0.28]];
  for (const [x, y, z, r] of lumps) {
    // A lumpy ball: many small bumps, shaded smoothly, read as foliage.
    const g = new THREE.SphereGeometry(w * r, 36, 26);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i);
      const py = p.getY(i);
      const pz = p.getZ(i);
      const n = 1 + 0.09 * Math.sin(px * 7.1 + py * 5.3) * Math.cos(pz * 6.7 + px * 2.1) + 0.05 * Math.sin(py * 13.7 + pz * 11.3);
      p.setXYZ(i, px * n, py * n, pz * n);
    }
    g.computeVertexNormals();
    g.translate(w * x, h * y, w * z);
    add(new THREE.Mesh(worldUV(g, tile * 0.4), leaves), leaves, true);
  }
}

/** The matte white of an architect's model. */
function clayMaterial(opacity = 1, color = '#dcd8d0') {
  return new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 0.9, metalness: 0 });
}

/** A person, for a sense of size: dressed, or (white) the plain white figure of an architect's drawing. */
function personOf(o, add, white) {
  const h = o.size[1];
  const one = white ? clayMaterial(o.opacity, '#f7f6f3') : null;
  const cloth = one ?? makeMaterial('fabric', o.color === DEFAULT_COLOR ? '#3a5f8f' : o.color, o.opacity).mat;
  const skin = one ?? makeMaterial('painted', '#c99a78', o.opacity).mat;
  const dark = one ?? makeMaterial('fabric', '#262a33', o.opacity).mat;
  const hair = one ?? makeMaterial('painted', '#2a211c', o.opacity).mat;
  // Feet at the bottom of the size, head at the top: about seven and a half heads tall.
  const y = (f) => h * (f - 0.5);
  // Torso: wide at the shoulders, narrower at the waist.
  const torso = new THREE.CylinderGeometry(h * 0.105, h * 0.085, h * 0.3, 24).scale(1, 1, 0.62).translate(0, y(0.67), 0);
  add(new THREE.Mesh(torso, cloth), cloth, true);
  add(new THREE.Mesh(new THREE.SphereGeometry(h * 0.105, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.45, 0.62).translate(0, y(0.82), 0), cloth), cloth, true);
  add(new THREE.Mesh(new THREE.CylinderGeometry(h * 0.028, h * 0.03, h * 0.04, 14).translate(0, y(0.855), 0), skin), skin, false);
  add(new THREE.Mesh(new THREE.SphereGeometry(h * 0.062, 28, 22).scale(0.9, 1.08, 0.98).translate(0, y(0.925), 0), skin), skin, false);
  add(new THREE.Mesh(new THREE.SphereGeometry(h * 0.065, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.05, 1).translate(0, y(0.932), -h * 0.004), hair), hair, false);
  for (const s of [-1, 1]) {
    // Legs, then shoes.
    add(new THREE.Mesh(new THREE.CylinderGeometry(h * 0.05, h * 0.036, h * 0.48, 16).translate(s * h * 0.048, y(0.28), 0), dark), dark, false);
    add(new THREE.Mesh(new RoundedBoxGeometry(h * 0.055, h * 0.035, h * 0.14, 3, h * 0.015).translate(s * h * 0.048, y(0.02), h * 0.025), hair), hair, false);
    // Arms hanging at the sides, then hands.
    add(new THREE.Mesh(new THREE.CylinderGeometry(h * 0.03, h * 0.024, h * 0.32, 14).translate(s * h * 0.128, y(0.66), 0), cloth), cloth, true);
    add(new THREE.Mesh(new THREE.SphereGeometry(h * 0.026, 14, 10).translate(s * h * 0.128, y(0.485), 0), skin), skin, false);
  }
}

export class SceneViewer {
  /**
   * container: an element with a size; scene: a checked VisualScene; states: stepStates(scene)
   * (the state at the start of every step, and after the last).
   * opts: { controls: true (drag to turn, wheel to zoom), labels: true, onChange(info),
   *   onStep(index, step) → may hand back a promise the step waits for (the narration),
   *   loadModel(name) → Promise<ArrayBuffer> of a .glb for objects of shape "model",
   *   quality: 'high' | 'fast' }
   */
  constructor(container, scene, states, opts = {}) {
    this.container = container;
    this.sceneData = scene;
    this.states = states;
    this.opts = { controls: true, labels: true, quality: 'high', ...opts };
    this.look = SETTINGS[scene.background] ?? SETTINGS.sky;
    this.style = scene.style ?? 'real';
    // In the build look, a part that is not there yet but will be at the end is drawn as sketch lines.
    const last = states[states.length - 1];
    this.toCome = new Set(this.style === 'reveal' ? scene.objects.filter((o) => !last[o.id].hidden && states.some((s) => s[o.id].hidden)).map((o) => o.id) : []);
    this.step = 0;
    this.t = 0; // seconds into the current step
    this.playing = false;
    this.done = false;
    this.hold = null;
    this.userMovedCamera = false;
    this.disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.look.exposure;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    container.style.position = container.style.position || 'relative';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const three = new THREE.Scene();
    this.three = three;

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 4000);
    this.camFrom = v3(scene.camera.from);
    this.camTo = v3(scene.camera.to);
    this.camera.position.copy(this.camFrom);
    this.camera.lookAt(this.camTo);

    // Objects first, so the light and the ground can be fitted to how big the scene is.
    this.parts = new Map();
    this.glowing = false;
    for (const o of scene.objects) this.parts.set(o.id, this.build(o));
    for (const p of this.parts.values()) (p.o.parent && this.parts.get(p.o.parent) ? this.parts.get(p.o.parent).pivot : three).add(p.pivot);
    const reach = this.reach();
    this.size = reach;

    this.light(reach);
    this.ground(reach);

    // Labels: plain text over the picture, next to the parts a step points at.
    this.labelLayer = document.createElement('div');
    this.labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    container.appendChild(this.labelLayer);
    this.labels = new Map();

    if (this.opts.controls) {
      const c = new OrbitControls(this.camera, renderer.domElement);
      c.target.copy(this.camTo);
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.maxPolarAngle = Math.PI / 2 - 0.015;
      c.minDistance = Math.max(0.2, reach * 0.02);
      c.maxDistance = reach * 12;
      c.addEventListener('start', () => (this.userMovedCamera = true));
      this.controls = c;
    }

    this.post();
    this.resize = () => {
      const w = Math.max(2, container.clientWidth);
      const h = Math.max(2, container.clientHeight);
      renderer.setSize(w, h, false);
      this.composer?.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(container);
    }

    this.clock = new THREE.Clock();
    this.apply();
    this.loop = () => {
      if (this.disposed) return;
      this.tick(Math.min(0.1, this.clock.getDelta()));
      this.raf = requestAnimationFrame(this.loop);
    };
    if (!opts.still) this.raf = requestAnimationFrame(this.loop);
  }

  /** One object: a pivot (where it is, how it is turned and stretched) holding what is drawn. */
  build(o) {
    const pivot = new THREE.Group();
    const part = { o, pivot, meshes: [], mats: [], tints: [], height: Math.max(0.2, o.size[1]) };
    const add = (mesh, mat, tint) => {
      mesh.castShadow = !mat.userData.glows && mat.userData.kind !== 'glass';
      mesh.receiveShadow = true;
      pivot.add(mesh);
      part.meshes.push(mesh);
      if (!part.mats.includes(mat)) part.mats.push(mat);
      if (tint && !part.tints.includes(mat)) part.tints.push(mat);
    };
    if (o.glow || o.material === 'light') this.glowing = true;
    const clay = this.style === 'clay';
    if (o.shape === 'tree') treeOf(o, add, clay);
    else if (o.shape === 'person') personOf(o, add, this.style !== 'real');
    else if (o.shape === 'model') this.model(o, part, add);
    else {
      // A white model keeps its glass and its lights; everything else is matte white.
      const keeps = o.material === 'glass' || o.material === 'water' || o.material === 'light' || o.glow;
      const clear = o.material === 'glass' || o.material === 'water';
      const { mat, tile } = clay && !keeps ? { mat: clayMaterial(o.opacity), tile: 0 } : clay && clear ? makeMaterial(o.material, '#dfe9ef', o.opacity, false) : makeMaterial(o.material, o.color, o.opacity, o.glow);
      add(new THREE.Mesh(geometryOf(o, tile), mat), mat, true);
      if (o.shape === 'arrow') {
        const pts = (o.points ?? [[0, 0, 0], [0, 1, 0]]).map(v3);
        const r = Math.max(0.01, o.size[0] / 2);
        const head = new THREE.Mesh(new THREE.ConeGeometry(r * 2.6, r * 6, 24), mat);
        head.position.copy(pts[pts.length - 1]);
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pts[pts.length - 1].clone().sub(pts[pts.length - 2]).normalize());
        add(head, mat, true);
      }
    }
    for (const m of part.mats) m.userData.opacity = m.opacity;
    if (this.toCome.has(o.id) && o.shape !== 'person' && o.shape !== 'tree' && o.shape !== 'model') this.sketch(part);
    return part;
  }

  /** The sketch of a part still to be built: its outline in thin lines over a faint white. */
  sketch(part) {
    const o = part.o;
    const dark = this.look === SETTINGS.night || this.look === SETTINGS.dark;
    const lines = new THREE.LineBasicMaterial({ color: dark ? '#b4c8ff' : '#1d2430', transparent: true, opacity: 0.9, depthWrite: false });
    const fill = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    const objs = [];
    for (const mesh of [...part.meshes]) {
      // A box's outline is its hard edges, not the rounding.
      const src = o.shape === 'box' && mesh === part.meshes[0] ? new THREE.BoxGeometry(...o.size) : mesh.geometry;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(src, 24), lines);
      const ghost = new THREE.Mesh(mesh.geometry, fill);
      for (const g of [edge, ghost]) {
        g.position.copy(mesh.position);
        g.quaternion.copy(mesh.quaternion);
        g.scale.copy(mesh.scale);
        g.renderOrder = 2;
        part.pivot.add(g);
        objs.push(g);
      }
    }
    part.sketch = { objs, lines, fill };
  }

  /** A realistic model: a soft stand-in at once, the real thing when its file has arrived. */
  model(o, part, add) {
    const stand = makeMaterial('plastic', o.color, Math.min(o.opacity, 0.35)).mat;
    const box = new THREE.Mesh(new RoundedBoxGeometry(o.size[0], o.size[1], o.size[2], 3, Math.min(...o.size) * 0.12), stand);
    add(box, stand, true);
    if (!this.opts.loadModel || !o.model) return;
    Promise.resolve(this.opts.loadModel(o.model))
      .then((bytes) => new Promise((ok, fail) => new GLTFLoader().parse(bytes, '', ok, fail)))
      .then((gltf) => {
        if (this.disposed) return;
        const root = gltf.scene;
        // Fitted inside the size asked for, standing in the middle of it.
        const b = new THREE.Box3().setFromObject(root);
        const s = b.getSize(new THREE.Vector3());
        const k = Math.min(o.size[0] / Math.max(s.x, 1e-6), o.size[1] / Math.max(s.y, 1e-6), o.size[2] / Math.max(s.z, 1e-6));
        root.scale.setScalar(k);
        const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
        root.position.sub(c);
        part.pivot.remove(box);
        part.meshes.length = 0;
        part.mats.length = 0;
        part.tints.length = 0;
        root.traverse((n) => {
          if (!n.isMesh) return;
          n.castShadow = true;
          n.receiveShadow = true;
          if (this.style === 'clay') n.material = clayMaterial(o.opacity);
          for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
            m.transparent = true;
            m.userData.opacity = m.opacity;
            m.userData.baseEmissive = m.emissiveIntensity ?? 0;
            m.userData.keepsColor = true;
            if (!part.mats.includes(m)) part.mats.push(m);
          }
          part.meshes.push(n);
        });
        part.pivot.add(root);
        this.opts.onChange?.(this.info());
      })
      .catch(() => {
        /* the stand-in stays */
      });
  }

  /** How far the scene reaches from its middle, counting where things travel to. */
  reach() {
    let r = 4;
    const seen = (p) => (r = Math.max(r, Math.hypot(p[0], p[1], p[2])));
    for (const o of this.sceneData.objects) {
      if (o.parent) continue;
      for (const s of this.states) seen(s[o.id].at.map((v, i) => Math.abs(v) + o.size[i] / 2));
    }
    seen(this.sceneData.camera.to);
    return Math.min(400, r);
  }

  light(reach) {
    const L = this.look;
    const three = this.three;
    const sunDir = v3(L.sun).normalize();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    if (L.sky) {
      const sky = new Sky();
      sky.scale.setScalar(3500);
      const u = sky.material.uniforms;
      u.turbidity.value = L.turbidity;
      u.rayleigh.value = L.rayleigh;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.8;
      u.sunPosition.value.copy(sunDir);
      three.add(sky);
      this.sky = sky;
      // What the sky reflects onto glass and metal.
      const only = new THREE.Scene();
      const copy = new Sky();
      copy.scale.setScalar(3500);
      Object.assign(copy.material.uniforms.turbidity, { value: L.turbidity });
      copy.material.uniforms.rayleigh.value = L.rayleigh;
      copy.material.uniforms.sunPosition.value.copy(sunDir);
      only.add(copy);
      three.environment = pmrem.fromScene(only, 0, 1, 5000).texture;
    } else {
      three.background = new THREE.Color(L.back);
      three.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
    three.environmentIntensity = L.env;
    pmrem.dispose();
    // Only the far distance fades into the air; nothing near is hazy.
    three.fog = new THREE.Fog(L.fog, reach * 5, reach * 42);

    // A white model needs less fill light, so its form shows in light and shade.
    three.add(new THREE.HemisphereLight('#ffffff', L.ground, this.style === 'clay' ? L.ambient * 0.5 : L.ambient));
    const sun = new THREE.DirectionalLight(L.sunColor, L.sunPower);
    sun.position.copy(sunDir.clone().multiplyScalar(reach * 3));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const span = reach * 1.6;
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: reach * 7 });
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 4;
    three.add(sun, sun.target);
    this.sun = sun;
  }

  ground(reach) {
    const kind = this.sceneData.ground;
    if (kind === 'none') return;
    // A white model stands on a plain pale base.
    const [surface, colour] = this.style === 'clay' && kind !== 'grid' ? ['painted', '#c4c0b8'] : (GROUNDS[kind] ?? ['painted', this.look.ground]);
    const { mat, tile } = makeMaterial(surface, colour, 1);
    mat.transparent = false;
    const size = Math.max(600, reach * 60);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    if (tile && mat.map) {
      mat.map = mat.map.clone();
      mat.bumpMap = mat.bumpMap.clone();
      mat.map.repeat.set(size / tile, size / tile);
      mat.bumpMap.repeat.set(size / tile, size / tile);
    }
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.three.add(floor);
    if (kind === 'grid') {
      const cells = Math.round(Math.min(200, Math.max(20, reach * 4)));
      const grid = new THREE.GridHelper(cells, cells, '#7f8aa0', '#7f8aa0');
      grid.position.y = 0.004;
      grid.material.transparent = true;
      grid.material.opacity = 0.28;
      this.three.add(grid);
    }
  }

  /** The finishing passes: soft shade where things meet, and a glow around lit parts. */
  post() {
    if (this.opts.quality === 'fast') return;
    try {
      const w = Math.max(2, this.container.clientWidth);
      const h = Math.max(2, this.container.clientHeight);
      const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.three, this.camera));
      const ao = new GTAOPass(this.three, this.camera, w, h);
      ao.updateGtaoMaterial({ radius: Math.max(0.25, this.size * 0.04), distanceExponent: 1.4, thickness: 1, scale: 1.1, samples: 8 });
      ao.blendIntensity = 0.9;
      composer.addPass(ao);
      if (this.glowing) composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.6, 0.92));
      composer.addPass(new OutputPass());
      this.composer = composer;
    } catch {
      this.composer = null;
    }
  }

  draw() {
    if (this.composer) {
      try {
        this.composer.render();
        return;
      } catch {
        this.composer = null;
      }
    }
    this.renderer.render(this.three, this.camera);
  }

  get stepCount() {
    return this.sceneData.steps.length;
  }

  /** The picture being drawn (for Studio, which copies it onto its own frame). */
  get canvas() {
    return this.renderer.domElement;
  }

  info() {
    const s = this.sceneData.steps[this.step];
    return { step: this.step, steps: this.stepCount, title: s.title, say: s.say, playing: this.playing, done: this.done, progress: Math.min(1, this.t / s.seconds) };
  }

  changed() {
    this.opts.onChange?.(this.info());
  }

  /** Starts (or carries on) the explanation. From the end, it starts again. */
  play() {
    if (this.done) this.goTo(0);
    this.playing = true;
    if (this.t === 0) this.enter();
    this.changed();
  }

  pause() {
    this.playing = false;
    this.changed();
  }

  /** Jumps to the start of a step (the scene shows what came before it). */
  goTo(i) {
    this.step = Math.max(0, Math.min(this.stepCount - 1, i));
    this.t = 0;
    this.done = false;
    this.hold = null;
    this.camStart = null;
    if (this.playing) this.enter();
    this.apply();
    this.changed();
  }

  /**
   * Shows the exact moment `seconds` into the whole explanation and draws it (nothing plays, no
   * narration): the same picture every time for the same moment, which is what a video needs.
   */
  seek(seconds, width, height) {
    let left = Math.max(0, seconds);
    let i = 0;
    while (i < this.stepCount - 1 && left >= this.sceneData.steps[i].seconds) left -= this.sceneData.steps[i++].seconds;
    this.step = i;
    this.t = Math.min(left, this.sceneData.steps[i].seconds);
    this.camStart = i > 0 ? this.endCamera(i - 1) : null;
    if (width && height && (this.renderer.domElement.width !== width || this.renderer.domElement.height !== height)) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.composer?.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.apply();
    this.draw();
    return this.renderer.domElement;
  }

  /** The view goes back to following the explanation's own camera. */
  resetView() {
    this.userMovedCamera = false;
    this.apply();
  }

  /** A step begins: whoever listens may hand back a promise (the narration); the step waits for it too. */
  enter() {
    const wait = this.opts.onStep?.(this.step, this.sceneData.steps[this.step]);
    const mine = wait && typeof wait.then === 'function' ? wait.then(() => undefined, () => undefined) : null;
    this.hold = mine;
    if (mine)
      mine.then(() => {
        if (this.hold === mine) this.hold = null;
      });
  }

  tick(dt) {
    if (this.playing && !this.done) {
      const s = this.sceneData.steps[this.step];
      this.t += dt;
      if (this.t >= s.seconds && !this.hold) {
        if (this.step + 1 < this.stepCount) {
          // The next step's camera starts from where this one ended.
          if (this.camNow) this.camStart = { from: this.camNow.from.clone(), to: this.camNow.to.clone() };
          this.step++;
          this.t = 0;
          this.enter();
        } else {
          this.t = s.seconds;
          this.playing = false;
          this.done = true;
        }
        this.changed();
      }
    }
    this.apply();
    this.controls?.update();
    this.draw();
    this.placeLabels();
    // A computer that cannot keep up gets the plain picture: smooth movement matters more than soft shade.
    if (this.composer && !this.opts.still) {
      this.slow = (this.slow ?? 0) * 0.9 + dt * 0.1;
      this.frames = (this.frames ?? 0) + 1;
      if (this.frames > 50 && this.slow > 1 / 20) {
        this.composer.dispose?.();
        this.composer = null;
        this.renderer.setPixelRatio(1);
        this.resize();
      }
    }
  }

  /** Puts everything where it belongs at this moment of this step. */
  apply() {
    const s = this.sceneData.steps[this.step];
    // The movement takes most of the step; the last part holds still so it can be looked at.
    const k = ease(Math.min(1, this.t / Math.max(0.5, s.seconds * 0.8)));
    const a = this.states[this.step];
    const b = this.states[this.step + 1];
    // A still picture for a preview shows everything; a step dims what it is not about.
    const focus = new Set(this.opts.still && !this.opts.dim ? [] : s.focus);
    for (const [id, p] of this.parts) {
      const from = a[id];
      const to = b[id];
      // Something that appears is set down into place, the way a part is lowered onto a building.
      // A part with a sketch is filled in where its lines are instead.
      const arriving = from.hidden && !to.hidden && !p.sketch ? (1 - k) * (1 - k) * Math.min(1.2, p.height * 0.5) : 0;
      p.pivot.position.set(lerp(from.at[0], to.at[0], k), lerp(from.at[1], to.at[1], k) + arriving, lerp(from.at[2], to.at[2], k));
      // A spin is worked out from the time, never added up, so any moment can be shown on its own.
      const spin = to.spin;
      p.pivot.rotation.set(rad(lerp(from.rot[0], to.rot[0], k) + spin[0] * this.t), rad(lerp(from.rot[1], to.rot[1], k) + spin[1] * this.t), rad(lerp(from.rot[2], to.rot[2], k) + spin[2] * this.t));
      p.pivot.scale.set(lerp(from.scale[0], to.scale[0], k), lerp(from.scale[1], to.scale[1], k), lerp(from.scale[2], to.scale[2], k));
      // What a step is not about stays solid and real; the labels (and a soft lift) point at what it is about.
      const dim = 1;
      const show = lerp(from.hidden ? 0 : from.opacity, to.hidden ? 0 : to.opacity, k) / Math.max(0.05, p.o.opacity);
      const visible = show * dim > 0.01;
      for (const m of p.meshes) m.visible = visible;
      if (p.sketch) {
        const left = Math.max(0, 1 - Math.min(1, show));
        for (const g of p.sketch.objs) g.visible = left > 0.01;
        p.sketch.lines.opacity = 0.9 * left;
        p.sketch.fill.opacity = 0.32 * left;
      }
      const colour = new THREE.Color(from.color).lerp(new THREE.Color(to.color), k);
      for (const m of p.mats) {
        const opacity = (m.userData.opacity ?? 1) * show * dim;
        m.opacity = opacity;
        m.depthWrite = opacity > 0.6 && m.userData.kind !== 'glass' && m.userData.kind !== 'water';
        if (m.userData.glows) continue;
        if (m.emissive) {
          if (focus.has(id) && !m.userData.keepsColor) {
            m.emissive.copy(colour);
            m.emissiveIntensity = 0.07;
          } else {
            m.emissive.set('#000000');
            m.emissiveIntensity = m.userData.baseEmissive ?? 0;
          }
        }
      }
      // The colour is touched only when a step changed it, so a tree keeps its green and a model its paint.
      if (from.color !== p.o.color || to.color !== p.o.color)
        for (const m of p.tints) {
          m.color.copy(colour);
          if (m.userData.glows) m.emissive.copy(colour);
        }
    }
    // The camera: the step's own view when it names one; otherwise it stays with what the step is about.
    const prev = this.camStart ?? this.cameraAt(this.step - 1);
    let next = s.camera ? { from: v3(s.camera.from), to: v3(s.camera.to) } : null;
    if (!next && s.focus.length) {
      const centre = this.centreOf(s.focus);
      if (centre) next = { to: centre, from: centre.clone().add(prev.from.clone().sub(prev.to)) };
    }
    next ??= prev;
    this.camNow = { from: new THREE.Vector3().lerpVectors(prev.from, next.from, k), to: new THREE.Vector3().lerpVectors(prev.to, next.to, k) };
    if (!this.userMovedCamera) {
      this.camera.position.copy(this.camNow.from);
      this.camera.lookAt(this.camNow.to);
      if (this.controls) this.controls.target.copy(this.camNow.to);
    }
    // The sun's shadow stays centred on what is being looked at.
    if (this.sun) {
      const offset = this.sun.position.clone().sub(this.sun.target.position);
      this.sun.target.position.copy(this.camNow.to).setY(0);
      this.sun.position.copy(this.sun.target.position).add(offset);
    }
    this.focus = focus;
  }

  /** Where the camera is when a step has finished (for showing any moment on its own). */
  endCamera(i) {
    const keepStep = this.step;
    const keepT = this.t;
    const keepStart = this.camStart;
    let cam = null;
    for (let n = 0; n <= i; n++) {
      this.step = n;
      this.t = this.sceneData.steps[n].seconds;
      this.camStart = cam;
      this.apply();
      cam = { from: this.camNow.from.clone(), to: this.camNow.to.clone() };
    }
    this.step = keepStep;
    this.t = keepT;
    this.camStart = keepStart;
    return cam;
  }

  /** The middle of some parts, where they are right now. */
  centreOf(ids) {
    const sum = new THREE.Vector3();
    let n = 0;
    this.three.updateMatrixWorld(true);
    for (const id of ids) {
      const p = this.parts.get(id);
      if (!p) continue;
      sum.add(new THREE.Box3().setFromObject(p.pivot).getCenter(new THREE.Vector3()));
      n++;
    }
    return n ? sum.multiplyScalar(1 / n) : null;
  }

  /** A part counts as pointed at when something it hangs from is. */
  inFocus(o, focus) {
    for (let p = o.parent, hops = 0; p && hops < 40; hops++) {
      if (focus.has(p)) return true;
      p = this.parts.get(p)?.o.parent;
    }
    return false;
  }

  /** The camera a step ends on: its own, or the last one set before it. */
  cameraAt(i) {
    for (let n = Math.min(i, this.stepCount - 1); n >= 0; n--) {
      const c = this.sceneData.steps[n].camera;
      if (c) return { from: v3(c.from), to: v3(c.to) };
    }
    return { from: this.camFrom.clone(), to: this.camTo.clone() };
  }

  placeLabels() {
    if (!this.opts.labels) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const want = new Set();
    for (const id of this.focus ?? []) {
      const p = this.parts.get(id);
      if (!p?.o.label || !p.meshes[0]?.visible) continue;
      want.add(id);
      let el = this.labels.get(id);
      if (!el) {
        el = document.createElement('div');
        el.textContent = p.o.label;
        el.style.cssText = `position:absolute;transform:translate(-50%,-140%);padding:5px 11px;border-radius:999px;font:600 13px "Plus Jakarta Sans","Inter",system-ui,sans-serif;white-space:nowrap;color:${this.look.label};background:${this.look.labelBg};border:1px solid rgba(127,160,255,.6);box-shadow:0 6px 18px rgba(0,0,0,.35);backdrop-filter:blur(6px)`;
        this.labelLayer.appendChild(el);
        this.labels.set(id, el);
      }
      const box = new THREE.Box3().setFromObject(p.pivot);
      const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(this.camera);
      const behind = top.z > 1;
      el.style.display = behind ? 'none' : 'block';
      el.style.left = `${((top.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - top.y) / 2) * h}px`;
    }
    for (const [id, el] of this.labels)
      if (!want.has(id)) {
        el.remove();
        this.labels.delete(id);
      }
  }

  /** Where the labels of the current step belong in the picture, as fractions of its width and height (for drawing them into a video). */
  labelPoints() {
    const out = [];
    this.three.updateMatrixWorld(true);
    for (const id of this.focus ?? []) {
      const p = this.parts.get(id);
      if (!p?.o.label || !p.meshes[0]?.visible) continue;
      const box = new THREE.Box3().setFromObject(p.pivot);
      const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(this.camera);
      if (top.z > 1) continue;
      out.push({ text: p.o.label, x: (top.x + 1) / 2, y: (1 - top.y) / 2 });
    }
    return out;
  }

  /** One still picture of the scene as it is now (a data URL; JPEG by default, it is a photo-like picture). */
  snapshot(type = 'image/jpeg', quality = 0.9) {
    this.apply();
    this.draw();
    return this.renderer.domElement.toDataURL(type, quality);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.controls?.dispose();
    this.three.traverse((n) => {
      if (n.isLineSegments) {
        n.geometry?.dispose();
        n.material?.dispose?.();
      }
      if (!n.isMesh) return;
      n.geometry?.dispose();
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) m?.dispose?.();
    });
    this.three.environment?.dispose?.();
    this.composer?.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }
}

/**
 * A still picture of a scene for a small preview box: everything in place as it is at the end of
 * the explanation, seen from the opening view.
 */
export function sceneThumbnail(scene, states, width = 640, height = 360, opts = {}) {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(holder);
  try {
    const v = new SceneViewer(holder, scene, states, { controls: false, labels: false, still: true, ...opts });
    // The finished thing is the best picture of it.
    v.step = v.stepCount - 1;
    v.t = scene.steps[v.stepCount - 1].seconds;
    v.camStart = { from: v.camFrom.clone(), to: v.camTo.clone() };
    v.sceneData = { ...scene, steps: scene.steps.map((s) => ({ ...s, camera: undefined, focus: [] })) };
    const url = v.snapshot();
    v.dispose();
    return url;
  } finally {
    holder.remove();
  }
}
