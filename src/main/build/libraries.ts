import fs from 'node:fs';
import path from 'node:path';

/**
 * The libraries Keo's builder ships with (open source, installed with Keo, never downloaded while
 * building). A project lists the ones it uses; Keo copies just those into its lib/ folder, so the
 * site or game works offline, in Keo's preview and on any web host.
 */
export interface BuildLibrary {
  label: string;
  /** How a page uses it (told to the model). */
  usage: string;
  /** node_modules paths → paths inside the project's lib/ folder (folders are copied whole). */
  files: Array<[from: string, to: string]>;
  /** An import map entry the pages need (module libraries), added by Keo when missing. */
  importMap?: Record<string, string>;
}

const THREE_ADDONS = ['controls', 'loaders', 'postprocessing', 'shaders', 'environments', 'geometries', 'math', 'utils', 'objects', 'lines', 'curves', 'effects', 'animation', 'misc', 'modifiers', 'helpers', 'lights', 'textures', 'interactive', 'exporters', 'csm', 'physics'];
const THREE_LIBS = ['fflate.module.js', 'tween.module.js', 'lil-gui.module.min.js', 'stats.module.js', 'meshopt_decoder.module.js', 'motion-controllers.module.js'];

export const BUILD_LIBRARIES = {
  three: {
    label: 'three.js (3D: scenes, lights, models, materials, post-processing)',
    usage: 'ES modules: <script type="module"> import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; (also GLTFLoader, EffectComposer, UnrealBloomPass, RoomEnvironment, Sky, Water, Reflector…). Keo adds the import map.',
    files: [
      ['three/build/three.module.min.js', 'three/three.module.min.js'],
      ...THREE_ADDONS.map((d): [string, string] => [`three/examples/jsm/${d}`, `three/addons/${d}`]),
      ...THREE_LIBS.map((f): [string, string] => [`three/examples/jsm/libs/${f}`, `three/addons/libs/${f}`]),
    ],
    importMap: { three: '/lib/three/three.module.min.js', 'three/addons/': '/lib/three/addons/' },
  },
  gsap: {
    label: 'GSAP (motion: timelines, scroll-driven animation, text and SVG motion, drag)',
    usage: '<script src="/lib/gsap/gsap.min.js"></script> then plugins as needed: <script src="/lib/gsap/ScrollTrigger.min.js"></script> (also ScrollToPlugin, Flip, Draggable, MotionPathPlugin, TextPlugin, Observer, CustomEase, EasePack); call gsap.registerPlugin(ScrollTrigger, …).',
    files: ['gsap', 'ScrollTrigger', 'ScrollToPlugin', 'Flip', 'Draggable', 'MotionPathPlugin', 'TextPlugin', 'Observer', 'CustomEase', 'EasePack'].map((n): [string, string] => [`gsap/dist/${n}.min.js`, `gsap/${n}.min.js`]),
  },
  phaser: {
    label: 'Phaser 3 (2D games: scenes, sprites, tweens, particles, arcade and Matter physics, cameras, input, sound)',
    usage: '<script src="/lib/phaser/phaser.min.js"></script> then new Phaser.Game({ type: Phaser.AUTO, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, physics: { default: "arcade" }, scene: [...] }). Make textures in code (this.make.graphics … generateTexture) or use SVG/PNG files of the project.',
    files: [['phaser/dist/phaser.min.js', 'phaser/phaser.min.js']],
  },
  rapier: {
    label: 'Rapier (real 3D physics: rigid bodies, colliders, joints, character controller; pairs with three.js)',
    usage: 'ES module: import RAPIER from "@dimforge/rapier3d-compat"; await RAPIER.init(); const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); … world.step() each frame. Keo adds the import map.',
    files: [['@dimforge/rapier3d-compat/rapier.es.js', 'rapier/rapier.es.js']],
    importMap: { '@dimforge/rapier3d-compat': '/lib/rapier/rapier.es.js' },
  },
} satisfies Record<string, BuildLibrary>;
export type BuildLibraryId = keyof typeof BUILD_LIBRARIES;
export const BUILD_LIBRARY_IDS = Object.keys(BUILD_LIBRARIES) as BuildLibraryId[];

/** Copies a library's files into a project's lib/ folder (once; again when Keo's copy is newer). */
export function copyLibrary(id: BuildLibraryId, modules: string, projectDir: string): void {
  for (const [from, to] of BUILD_LIBRARIES[id].files) {
    const src = path.join(modules, from);
    const dst = path.join(projectDir, 'lib', to);
    if (!fs.existsSync(src)) throw new Error(`Keo's copy of ${BUILD_LIBRARIES[id].label.split(' (')[0]} is missing (${from}). Reinstall Keo.`);
    copyTree(src, dst);
  }
}

function copyTree(src: string, dst: string): void {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
    return;
  }
  // Source maps and TypeScript types are not needed in a site.
  if (/\.(map|d\.ts)$/.test(src)) return;
  try {
    if (fs.statSync(dst).mtimeMs >= st.mtimeMs && fs.statSync(dst).size === st.size) return;
  } catch {
    /* not copied yet */
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * A page with the import map its module libraries need (three.js, Rapier), when it has none: put
 * right after <head>, before any module script.
 */
export function withImportMap(html: string, libraries: BuildLibraryId[]): string {
  const map: Record<string, string> = {};
  for (const id of libraries) Object.assign(map, (BUILD_LIBRARIES[id] as BuildLibrary).importMap ?? {});
  if (!Object.keys(map).length || /<script[^>]*type\s*=\s*["']?importmap/i.test(html)) return html;
  const tag = `<script type="importmap">${JSON.stringify({ imports: map })}</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${tag}`);
  return `${tag}\n${html}`;
}
