import fs from 'node:fs';
import path from 'node:path';
import { FX_JS, FX_USAGE } from './fxKit';

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
  /** Files Keo makes for the library instead of copying them as they are (fonts.css). */
  make?: (modules: string, libDir: string) => void;
  /** Other libraries it needs (added with it). */
  needs?: string[];
}

/** A library list with what each one needs (the drive kit brings three.js, Rapier and the fonts). */
export function withNeeds(ids: BuildLibraryId[]): BuildLibraryId[] {
  const out: BuildLibraryId[] = [];
  const add = (id: BuildLibraryId) => {
    if (out.includes(id)) return;
    for (const n of (BUILD_LIBRARIES[id] as BuildLibrary).needs ?? []) add(n as BuildLibraryId);
    out.push(id);
  };
  ids.forEach(add);
  return out;
}

/**
 * Fonts that come with Keo (open source, SIL Open Font License): each as a variable font where
 * there is one, Latin and Latin Extended only (small files), with one fonts.css for all of them.
 */
export const BUILD_FONTS: Array<{ family: string; pkg: string; css: string[]; role: string }> = [
  { family: 'Inter', pkg: '@fontsource-variable/inter', css: ['wght.css'], role: 'clean sans (apps, dashboards, UI)' },
  { family: 'Manrope', pkg: '@fontsource-variable/manrope', css: ['wght.css'], role: 'modern sans (startups, SaaS)' },
  { family: 'DM Sans', pkg: '@fontsource-variable/dm-sans', css: ['wght.css', 'wght-italic.css'], role: 'friendly sans' },
  { family: 'Plus Jakarta Sans', pkg: '@fontsource-variable/plus-jakarta-sans', css: ['wght.css', 'wght-italic.css'], role: 'premium sans (agencies, real estate)' },
  { family: 'Outfit', pkg: '@fontsource-variable/outfit', css: ['wght.css'], role: 'geometric sans (bold headings)' },
  { family: 'Sora', pkg: '@fontsource-variable/sora', css: ['wght.css'], role: 'techy sans (crypto, tech)' },
  { family: 'Space Grotesk', pkg: '@fontsource-variable/space-grotesk', css: ['wght.css'], role: 'quirky grotesk (creative, portfolios)' },
  { family: 'Playfair Display', pkg: '@fontsource-variable/playfair-display', css: ['wght.css', 'wght-italic.css'], role: 'elegant serif headings (fashion, restaurants)' },
  { family: 'Fraunces', pkg: '@fontsource-variable/fraunces', css: ['wght.css', 'wght-italic.css'], role: 'soft characterful serif (cafés, editorial)' },
  { family: 'Lora', pkg: '@fontsource-variable/lora', css: ['wght.css', 'wght-italic.css'], role: 'readable serif body text (blogs)' },
  { family: 'Cormorant Garamond', pkg: '@fontsource-variable/cormorant-garamond', css: ['wght.css', 'wght-italic.css'], role: 'luxury serif (weddings, hotels, beauty)' },
  { family: 'Bebas Neue', pkg: '@fontsource/bebas-neue', css: ['index.css'], role: 'tall all-caps display (sports, events, posters)' },
  { family: 'Orbitron', pkg: '@fontsource-variable/orbitron', css: ['wght.css'], role: 'sci-fi display (games, tech)' },
  { family: 'Press Start 2P', pkg: '@fontsource/press-start-2p', css: ['index.css'], role: 'pixel font (retro games)' },
  { family: 'JetBrains Mono', pkg: '@fontsource-variable/jetbrains-mono', css: ['wght.css', 'wght-italic.css'], role: 'monospace (code, numbers, terminals)' },
];

/**
 * More display and character fonts, from the font files Keo ships for Studio (SIL Open Font License,
 * each folder has its OFL.txt): the range an art director needs, not only safe sans and serifs.
 */
export const EXTRA_FONTS: Array<{ family: string; dir: string; role: string }> = [
  { family: 'Unbounded', dir: 'unbounded', role: 'wide geometric display (bold modern headlines)' },
  { family: 'Bricolage Grotesque', dir: 'bricolagegrotesque', role: 'characterful grotesk (studios, friendly brands)' },
  { family: 'Syne', dir: 'syne', role: 'art-gallery display (creative, avant-garde)' },
  { family: 'Instrument Serif', dir: 'instrumentserif', role: 'editorial serif with italic (magazines, luxury)' },
  { family: 'DM Serif Display', dir: 'dmserifdisplay', role: 'high-contrast serif display' },
  { family: 'Big Shoulders Display', dir: 'bigshouldersdisplay', role: 'tall condensed display (cinematic, industrial)' },
  { family: 'Archivo Black', dir: 'archivoblack', role: 'heavy grotesk (brutalist, posters)' },
  { family: 'Anton', dir: 'anton', role: 'condensed impact headlines' },
  { family: 'Rubik Mono One', dir: 'rubikmonoone', role: 'chunky mono caps (brutalist, playful)' },
  { family: 'Space Mono', dir: 'spacemono', role: 'retro monospace (tech, zines)' },
  { family: 'Teko', dir: 'teko', role: 'sporty condensed (sport, fitness)' },
  { family: 'Oswald', dir: 'oswald', role: 'condensed sans (sport, news)' },
  { family: 'Monoton', dir: 'monoton', role: 'neon retro lines (80s, music)' },
  { family: 'Righteous', dir: 'righteous', role: 'retro rounded display' },
  { family: 'Bungee', dir: 'bungee', role: 'urban signage display' },
  { family: 'Shrikhand', dir: 'shrikhand', role: 'fat retro italic (food, fun)' },
  { family: 'Abril Fatface', dir: 'abrilfatface', role: 'fat didone headlines (posters, editorial)' },
  { family: 'Permanent Marker', dir: 'permanentmarker', role: 'marker handwriting (notes, collage)' },
  { family: 'Caveat', dir: 'caveat', role: 'casual handwriting' },
  { family: 'Montserrat', dir: 'montserrat', role: 'classic geometric sans' },
  { family: 'Raleway', dir: 'raleway', role: 'elegant thin-to-bold sans' },
  { family: 'Bangers', dir: 'bangers', role: 'comic book display' },
  { family: 'Black Ops One', dir: 'blackopsone', role: 'stencil military display (games)' },
  { family: 'Great Vibes', dir: 'greatvibes', role: 'formal script (weddings)' },
  { family: 'Pacifico', dir: 'pacifico', role: 'surf script (casual brands)' },
];

/** Where Keo's own font files are: the source folder when developing, the built app's folder when installed. */
function extraFontDir(modules: string): string | null {
  const root = path.dirname(modules);
  for (const d of [path.join(root, 'src', 'renderer', 'public', 'fonts'), path.join(root, 'out', 'renderer', 'fonts')]) if (fs.existsSync(d)) return d;
  return null;
}

/** A font file's weight and style from its name ("…-wght-italic.woff2", "Poppins-Bold.ttf", "…-400-normal.woff2"). */
export function fontFace(file: string): { weight: string; style: 'normal' | 'italic' } {
  const n = file.toLowerCase();
  const style = /italic/.test(n) ? 'italic' : 'normal';
  if (/wght|variable/.test(n)) return { weight: '100 900', style };
  const num = /-(\d{3})-/.exec(n)?.[1];
  if (num) return { weight: num, style };
  const named: Array<[RegExp, string]> = [[/extrabold/, '800'], [/semibold/, '600'], [/black/, '900'], [/bold/, '700'], [/light/, '300'], [/medium/, '500']];
  return { weight: named.find(([r]) => r.test(n))?.[1] ?? '400', style };
}

/** fonts.css plus just the font files it uses (Latin and Latin Extended), into lib/fonts. */
function makeFonts(modules: string, libDir: string): void {
  const out: string[] = ['/* Fonts that come with Keo — SIL Open Font License 1.1 (see LICENSES.txt). */'];
  const licenses: string[] = [];
  for (const f of BUILD_FONTS) {
    const dir = path.join(modules, f.pkg);
    for (const name of f.css) {
      const css = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
        const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
        // Latin and Latin Extended only: the other scripts would add many files nobody uses here.
        if (!file || !/-latin(-ext)?-/.test(file)) continue;
        copyTree(path.join(dir, 'files', file), path.join(libDir, file));
        out.push(
          block
            .replace(/font-family:\s*'[^']+'/, `font-family: '${f.family}'`)
            // Every browser that runs these pages reads woff2: the older .woff fallback is left out.
            .replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '')
            .replace(/url\(\.\/files\//g, 'url(./'),
        );
      }
    }
    try {
      licenses.push(`${f.family}\n${fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')}`);
    } catch {
      /* the license text is in the package; the notice in fonts.css still applies */
    }
  }
  const extra = extraFontDir(modules);
  if (extra) {
    for (const f of EXTRA_FONTS) {
      const dir = path.join(extra, f.dir);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((x) => /\.(woff2|ttf)$/i.test(x))) {
        copyTree(path.join(dir, file), path.join(libDir, file));
        const { weight, style } = fontFace(file);
        const format = file.toLowerCase().endsWith('.ttf') ? 'truetype' : 'woff2';
        out.push(`@font-face {\n  font-family: '${f.family}';\n  font-style: ${style};\n  font-display: swap;\n  font-weight: ${weight};\n  src: url(./${file}) format('${format}');\n}`);
      }
      try {
        licenses.push(`${f.family}\n${fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8')}`);
      } catch {
        /* the notice in fonts.css still applies */
      }
    }
  }
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'fonts.css'), `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(libDir, 'LICENSES.txt'), licenses.join('\n\n----\n\n'));
}

const THREE_ADDONS = ['controls', 'loaders', 'postprocessing', 'shaders', 'environments', 'geometries', 'math', 'utils', 'objects', 'lines', 'curves', 'effects', 'animation', 'misc', 'modifiers', 'helpers', 'lights', 'textures', 'interactive', 'exporters', 'csm', 'physics', 'webxr', 'tsl', 'materials', 'lighting', 'generators', 'gpgpu', 'renderers', 'interaction'];
const THREE_LIBS = ['fflate.module.js', 'tween.module.js', 'lil-gui.module.min.js', 'stats.module.js', 'meshopt_decoder.module.js', 'motion-controllers.module.js'];

export const BUILD_LIBRARIES = {
  three: {
    label: 'three.js r187 (3D: scenes, lights, models, materials, post-processing; WebGPU optional)',
    usage: 'ES modules: <script type="module"> import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; (also GLTFLoader, EffectComposer, UnrealBloomPass, OutputPass, RoomEnvironment, Sky, Water, Reflector…). Use the WebGLRenderer (works everywhere); "three/webgpu" and "three/tsl" are there for WebGPU work. Keo adds the import map.',
    // r187 ships its build as a few modules that import each other (three.core.js); the entry keeps
    // the file name older builds and import maps use.
    files: [
      ['three/build/three.module.js', 'three/three.module.min.js'],
      ['three/build/three.core.js', 'three/three.core.js'],
      ['three/build/three.webgpu.js', 'three/three.webgpu.js'],
      ['three/build/three.tsl.js', 'three/three.tsl.js'],
      ...THREE_ADDONS.map((d): [string, string] => [`three/examples/jsm/${d}`, `three/addons/${d}`]),
      ...THREE_LIBS.map((f): [string, string] => [`three/examples/jsm/libs/${f}`, `three/addons/libs/${f}`]),
    ],
    // Also the paths people know from npm and three.js examples, so either way of writing it works.
    importMap: {
      three: '/lib/three/three.module.min.js',
      'three/webgpu': '/lib/three/three.webgpu.js',
      'three/tsl': '/lib/three/three.tsl.js',
      'three/addons/': '/lib/three/addons/',
      'three/examples/jsm/': '/lib/three/addons/',
      '/lib/three/build/three.module.js': '/lib/three/three.module.min.js',
      '/lib/three/build/three.module.min.js': '/lib/three/three.module.min.js',
      '/lib/three/examples/jsm/': '/lib/three/addons/',
    },
  },
  gsap: {
    label: 'GSAP 3.15 with every plugin (motion: timelines, scroll-driven animation, split-text reveals, smooth scrolling, SVG drawing and morphing, drag with inertia)',
    usage: '<script src="/lib/gsap/gsap.min.js"></script> then plugins as needed: <script src="/lib/gsap/ScrollTrigger.min.js"></script> — also SplitText (split headings into lines/words/chars and animate them in), ScrollSmoother (smooth scrolling; needs #smooth-wrapper > #smooth-content around the page), DrawSVGPlugin (draw SVG strokes), MorphSVGPlugin, ScrambleTextPlugin, InertiaPlugin (with Draggable), Flip, Draggable, MotionPathPlugin, TextPlugin, Observer, ScrollToPlugin, CustomEase, CustomBounce, CustomWiggle, Physics2DPlugin, EasePack; call gsap.registerPlugin(ScrollTrigger, SplitText, …).',
    files: [
      'gsap', 'ScrollTrigger', 'ScrollToPlugin', 'Flip', 'Draggable', 'MotionPathPlugin', 'TextPlugin', 'Observer', 'CustomEase', 'EasePack',
      'SplitText', 'ScrollSmoother', 'DrawSVGPlugin', 'MorphSVGPlugin', 'ScrambleTextPlugin', 'InertiaPlugin', 'CustomBounce', 'CustomWiggle', 'Physics2DPlugin',
    ].map((n): [string, string] => [`gsap/dist/${n}.min.js`, `gsap/${n}.min.js`]),
  },
  phaser: {
    label: 'Phaser 3.90 (2D games: scenes, sprites, tweens, particles, arcade and Matter physics, cameras, input, sound)',
    usage: '<script src="/lib/phaser/phaser.min.js"></script> then new Phaser.Game({ type: Phaser.AUTO, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, physics: { default: "arcade" }, scene: [...] }). Make textures in code (this.make.graphics … generateTexture) or use SVG/PNG files of the project.',
    files: [['phaser/dist/phaser.min.js', 'phaser/phaser.min.js']],
  },
  rapier: {
    label: 'Rapier 0.21 (real 3D physics: rigid bodies, colliders, joints, character controller, vehicle controller; pairs with three.js)',
    usage: 'ES module: import RAPIER from "@dimforge/rapier3d-compat"; await RAPIER.init(); const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); … world.step() each frame. Keo adds the import map.',
    files: [['@dimforge/rapier3d-compat/dist/rapier.mjs', 'rapier/rapier.es.js']],
    importMap: { '@dimforge/rapier3d-compat': '/lib/rapier/rapier.es.js' },
  },
  fonts: {
    label: `Fonts (${BUILD_FONTS.length + EXTRA_FONTS.length} real web fonts, offline: sans, serif, display, condensed, retro, handwriting, pixel and mono)`,
    usage: `<link rel="stylesheet" href="/lib/fonts/fonts.css"> then font-family by name, with a fallback: ${[...BUILD_FONTS, ...EXTRA_FONTS].map((f) => `"${f.family}" (${f.role})`).join(', ')}. Variable weights 100–900 where the font has them. Pick what the art direction says (a display font with character and a body font) — not the same safe pair every time.`,
    files: [],
    make: makeFonts,
  },
  drive: {
    label: "Keo's driving game kit (real cities from build__city and travel between them, passengers to pick up and drive, realistic night/dusk/day lighting, raycast car physics with drift and nitro, chase camera, traffic, police pursuits with heat levels, street races with rivals, garage with cars, upgrades, paint and gadgets, HUD with minimap, engine sound, saving)",
    usage:
      'For any car or driving game. Brings three.js, Rapier and the fonts with it. FIRST read lib/drive/README.md with build__read: it is the whole API on one page (options, car spec units, a world of several cities with travel, passenger jobs, events, the game object). Do not read the kit\'s other files while building (that only wastes the user\'s allowance) — but when the user reports a problem that is not in your own files (the car, physics, police, HUD misbehave), DO read the kit file involved (lib/drive/vehicle.js for the car and its physics, game.js for the loop and crashes, ai.js for police and traffic) and measure it while playing (build__check) until you find the cause. The game is one call: <script type="module"> import { createDriveGame } from "/lib/drive/index.js"; const game = await createDriveGame({ city: "/assets/city.json", title: "…", cars: [{ id, name, style, price, color, spec: { power: 12000 (newtons), topSpeed: 80 (m/s), grip: 3.4, mass: 1400 (kg) }, model: "/assets/cars/x.glb" }], races: […], jobs: {…}, cities: […], onEvent(e, game) { … } }); </script>. The kit draws the menus, HUD, garage, controls and credit itself: do not rebuild them. Missions and story go in your own js files using the game object.',
    files: [['keo-drive-kit', 'drive']],
    needs: ['three', 'rapier', 'fonts'],
  },
  fx: {
    label: "Keo's effects kit (film grain, WebGL shader backgrounds, kinetic split-text reveals, custom cursor, magnetic buttons, marquees, 3D tilt, parallax, counters, reading bar, page wipes)",
    usage: FX_USAGE,
    files: [],
    make: (_modules: string, libDir: string) => {
      fs.mkdirSync(libDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, 'fx.js'), FX_JS);
    },
  },
  icons: {
    label: 'Icons (Lucide: 2,300+ clean line icons, offline)',
    usage:
      'One sprite file: <svg class="icon" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="/lib/icons/sprite.svg#NAME"/></svg> — the colour follows CSS color. Lucide names, e.g. menu, x, search, shopping-cart, shopping-bag, heart, star, user, users, phone, mail, map-pin, calendar, clock, check, check-circle, arrow-right, arrow-left, chevron-down, chevron-right, plus, minus, trash-2, pencil, settings, home, house, bed, bath, car, truck, credit-card, wallet, lock, eye, play, pause, volume-2, camera, image, instagram, facebook, twitter, linkedin, youtube, github, sun, moon, sparkles, zap, rocket, shield-check, gift, coffee, utensils, music, globe, wifi, trophy, gamepad-2, swords, crown, coins, timer, flag. Keo tells you if a name does not exist.',
    files: [
      ['lucide-static/sprite.svg', 'icons/sprite.svg'],
      ['lucide-static/LICENSE', 'icons/LICENSE.txt'],
    ],
  },
} satisfies Record<string, BuildLibrary>;
export type BuildLibraryId = keyof typeof BUILD_LIBRARIES;
export const BUILD_LIBRARY_IDS = Object.keys(BUILD_LIBRARIES) as BuildLibraryId[];

/**
 * A library file asked for by its usual npm path (lib/three/build/three.module.js,
 * lib/gsap/dist/gsap.min.js, lib/phaser/dist/phaser.min.js…): the path of Keo's copy, or null.
 */
export function libraryAlias(rel: string): string | null {
  const r = rel.replace(/\\/g, '/');
  const rules: Array<[RegExp, string]> = [
    [/^lib\/three\/build\/three\.module(\.min)?\.js$/, 'lib/three/three.module.min.js'],
    [/^lib\/three\/examples\/jsm\/(.+)$/, 'lib/three/addons/$1'],
    [/^lib\/gsap\/dist\/([A-Za-z]+)(\.min)?\.js$/, 'lib/gsap/$1.min.js'],
    [/^lib\/gsap\/([A-Za-z]+)\.js$/, 'lib/gsap/$1.min.js'],
    [/^lib\/phaser\/dist\/phaser(\.min)?\.js$/, 'lib/phaser/phaser.min.js'],
    [/^lib\/phaser\/phaser\.js$/, 'lib/phaser/phaser.min.js'],
    [/^lib\/rapier\/rapier(\.es)?\.js$/, 'lib/rapier/rapier.es.js'],
  ];
  for (const [re, to] of rules) if (re.test(r)) return r.replace(re, to);
  return null;
}

/** Copies a library's files into a project's lib/ folder (once; again when Keo's copy is newer). */
export function copyLibrary(id: BuildLibraryId, modules: string, projectDir: string): void {
  const lib = BUILD_LIBRARIES[id] as BuildLibrary;
  lib.make?.(modules, path.join(projectDir, 'lib', id));
  for (const [from, to] of lib.files) {
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
