// The renderer, lighting, sky and post-processing: what makes it look like a real game.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { cityLightsEnvironment } from './textures.js';

export const TIMES = {
  night: { sky: ['#02040a', '#0b1426', '#2a2236'], fog: '#0b1020', fogDensity: 0.0038, hemi: ['#6f82b8', '#1c1620', 0.55], sun: ['#9fb4ff', 0.45], elevation: 25, bloom: [0.62, 0.45, 0.78], exposure: 1.1, windows: 0.85, lamps: true },
  dusk: { sky: ['#1b2440', '#7a4a6a', '#f2a65a'], fog: '#6d5566', fogDensity: 0.0026, hemi: ['#ffd6b0', '#2a2030', 0.8], sun: ['#ffb070', 1.8], elevation: 6, bloom: [0.5, 0.45, 0.8], exposure: 1.0, windows: 0.55, lamps: true },
  day: { sky: null, fog: '#b9c8d8', fogDensity: 0.0016, hemi: ['#dfeaff', '#4a4038', 1.0], sun: ['#fff4e0', 3.0], elevation: 48, bloom: [0.25, 0.4, 0.9], exposure: 0.9, windows: 0.0, lamps: false },
};

function gradientSky(colors) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.55, colors[1]);
  g.addColorStop(1, colors[2]);
  x.fillStyle = g;
  x.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

function stars() {
  const n = 2500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * 0.45 + 0.08;
    const r = 1800;
    pos[i * 3] = Math.cos(u) * Math.cos(v) * r;
    pos[i * 3 + 1] = Math.sin(v) * r;
    pos[i * 3 + 2] = Math.sin(u) * Math.cos(v) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: '#dfe8ff', size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
  p.name = 'stars';
  return p;
}

/**
 * Creates the 3D world: renderer (filmic tone mapping, soft shadows), a camera, the sky and its
 * reflections, sun or moon light that follows the player, fog, and bloom + anti-aliasing.
 * quality: 'high' | 'medium' | 'low' (low: no shadows or bloom, for weak laptops and phones).
 */
export function createWorld(canvas, opts = {}) {
  const quality = opts.quality ?? (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 1.75 : 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 2600);
  const hemi = new THREE.HemisphereLight();
  scene.add(hemi);
  const sun = new THREE.DirectionalLight();
  sun.castShadow = quality !== 'low';
  sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
  const S = 70;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 600 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // A soft light that travels with the player's car, as games do: the car always reads at night.
  const carLight = new THREE.PointLight('#c9d6ff', 22, 16, 1.6);
  scene.add(carLight);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const starField = stars();
  let current = null;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.6);
  if (quality !== 'low') composer.addPass(bloom);
  composer.addPass(new OutputPass());
  if (quality === 'high') composer.addPass(new SMAAPass());

  /** Changes the time of day: 'night', 'dusk' or 'day'. */
  function setTime(name) {
    const t = TIMES[name] ?? TIMES.night;
    current = { name, ...t };
    renderer.toneMappingExposure = t.exposure;
    hemi.color.set(t.hemi[0]);
    hemi.groundColor.set(t.hemi[1]);
    hemi.intensity = t.hemi[2];
    sun.color.set(t.sun[0]);
    sun.intensity = t.sun[1];
    scene.fog = new THREE.FogExp2(t.fog, t.fogDensity);
    scene.remove(sky, starField);
    const el = (t.elevation * Math.PI) / 180;
    const az = 0.8;
    sun.userData.dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    let envScene;
    if (t.sky) {
      const bg = gradientSky(t.sky);
      scene.background = bg;
      envScene = new THREE.Scene();
      // Reflections show a city at night (lit windows, street lights), not an empty sky.
      envScene.background = cityLightsEnvironment(t.sky);
      if (name === 'night') scene.add(starField);
    } else {
      const u = sky.material.uniforms;
      u.turbidity.value = 6;
      u.rayleigh.value = 1.6;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.85;
      u.sunPosition.value.copy(sun.userData.dir).multiplyScalar(1000);
      scene.background = null;
      scene.add(sky);
      envScene = new THREE.Scene();
      const s2 = new Sky();
      s2.scale.setScalar(1000);
      Object.assign(s2.material.uniforms.sunPosition.value, u.sunPosition.value);
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2.material.uniforms[k].value = u[k].value;
      envScene.add(s2);
    }
    const env = pmrem.fromScene(envScene, 0.02).texture;
    scene.environment = env;
    scene.environmentIntensity = name === 'night' ? 1.0 : name === 'dusk' ? 1.0 : 1.0;
    carLight.intensity = name === 'day' ? 0 : name === 'dusk' ? 12 : 22;
    bloom.strength = t.bloom[0];
    bloom.radius = t.bloom[1];
    bloom.threshold = t.bloom[2];
    for (const fn of listeners) fn(current);
  }
  const listeners = [];

  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();
  setTime(opts.time ?? 'night');

  return {
    renderer,
    scene,
    camera,
    composer,
    sun,
    quality,
    get time() {
      return current;
    },
    setTime,
    /** Called when the time of day changes (the city dims or lights its windows). */
    onTime(fn) {
      listeners.push(fn);
      if (current) fn(current);
    },
    /** Keeps the sun's shadows around the player. */
    follow(pos) {
      sun.position.copy(pos).addScaledVector(sun.userData.dir, 180);
      sun.target.position.copy(pos);
      carLight.position.set(pos.x, pos.y + 4.5, pos.z);
      starField.position.set(pos.x, 0, pos.z);
    },
    resize,
    render() {
      composer.render();
    },
  };
}
