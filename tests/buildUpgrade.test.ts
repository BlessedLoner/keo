import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_FONTS, BUILD_LIBRARIES, withImportMap } from '../src/main/build/libraries';
import { BuildProjects } from '../src/main/build/projects';
import { buildCapabilities } from '../src/main/capabilities/build';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined };
const modules = path.join(__dirname, '..', 'node_modules');
const make = () => {
  const root = tempDir('keo-builds-');
  return new BuildProjects({ root: () => root, modules: () => modules, log });
};

describe('builder libraries, fonts and icons', () => {
  it('three.js r187 comes with its core module and the WebGPU entry points', () => {
    const p = make();
    const m = p.create({ title: 'Space', kind: 'game', libraries: ['three', 'rapier'] });
    const lib = path.join(p.dir(m.id), 'lib');
    for (const f of ['three/three.module.min.js', 'three/three.core.js', 'three/three.webgpu.js', 'three/three.tsl.js', 'rapier/rapier.es.js']) expect(fs.existsSync(path.join(lib, f)), f).toBe(true);
    // The entry imports its core from the file next to it.
    expect(fs.readFileSync(path.join(lib, 'three/three.module.min.js'), 'utf8')).toContain("from './three.core.js'");
    const html = withImportMap('<html><head></head></html>', ['three']);
    expect(html).toContain('"three/webgpu":"/lib/three/three.webgpu.js"');
    expect(html).toContain('"three/tsl":"/lib/three/three.tsl.js"');
  });

  it('GSAP comes with the plugins that are free now (SplitText, ScrollSmoother, DrawSVG, MorphSVG…)', () => {
    const p = make();
    const m = p.create({ title: 'Motion', kind: 'website', libraries: ['gsap'] });
    for (const n of ['SplitText', 'ScrollSmoother', 'DrawSVGPlugin', 'MorphSVGPlugin', 'ScrambleTextPlugin', 'InertiaPlugin']) {
      expect(fs.existsSync(path.join(p.dir(m.id), 'lib', 'gsap', `${n}.min.js`)), n).toBe(true);
    }
  });

  it('fonts: one fonts.css with every family, only the small Latin files, and their licences', () => {
    const p = make();
    const m = p.create({ title: 'Café', kind: 'website', libraries: ['fonts', 'icons'] });
    const dir = path.join(p.dir(m.id), 'lib', 'fonts');
    const css = fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8');
    for (const f of BUILD_FONTS) expect(css, f.family).toContain(`font-family: '${f.family}'`);
    // Every file the css points to is there; nothing else (no Cyrillic, Greek, Vietnamese…).
    const used = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((x) => x[1]!);
    for (const u of used) expect(fs.existsSync(path.join(dir, u)), u).toBe(true);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.woff2'));
    expect(files.every((f) => /-latin(-ext)?-/.test(f))).toBe(true);
    expect(files.length).toBe(new Set(used).size);
    const kb = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1024;
    expect(kb).toBeLessThan(3000);
    expect(fs.readFileSync(path.join(dir, 'LICENSES.txt'), 'utf8')).toContain('SIL Open Font License');
    // Icons: one sprite with Lucide's symbols.
    const sprite = fs.readFileSync(path.join(p.dir(m.id), 'lib', 'icons', 'sprite.svg'), 'utf8');
    for (const name of ['shopping-cart', 'heart', 'menu', 'map-pin', 'gamepad-2']) expect(sprite, name).toContain(`id="${name}"`);
  });

  it('the model is told about every library, and may use them all at once', () => {
    const caps = buildCapabilities({ projects: make() } as never);
    const start = caps.find((c) => c.id === 'build.start')!;
    expect(start.description).toContain('fonts');
    expect(start.description).toContain('SplitText');
    expect(start.input.safeParse({ title: 'x', kind: 'website', brief: '', libraries: Object.keys(BUILD_LIBRARIES) }).success).toBe(true);
  });
});

describe('build history', () => {
  it('keeps each version and goes back to it; new files are removed again', () => {
    const p = make();
    const m = p.create({ title: 'Shop', kind: 'website' });
    p.write(m.id, [{ path: 'index.html', content: '<h1>One</h1>' }]);
    const v1 = p.versions(m.id)[0]!;
    expect(v1.files).toEqual(['index.html']);

    // Later (a new request): a change to the page and a new file.
    const later = p.versions(m.id);
    expect(later).toHaveLength(1);
    p.write(m.id, [{ path: 'index.html', content: '<h1>Two</h1>' }, { path: 'css/site.css', content: 'body{}' }]);
    // Close together: still the same version.
    expect(p.versions(m.id)).toHaveLength(1);

    const r = p.goBack(m.id, v1.version);
    expect(r.removed).toEqual(['css/site.css', 'index.html']);
    expect(fs.existsSync(path.join(p.dir(m.id), 'index.html'))).toBe(false);
    expect(p.versions(m.id)).toEqual([]);
    expect(() => p.goBack(m.id)).toThrow(/no such version/);
    // History is not one of the build's own files, and Keo's own folder cannot be written.
    expect(p.files(m.id).map((f) => f.path)).toEqual(['keo-build.json']);
    expect(() => p.write(m.id, [{ path: '.keo-history/index.json', content: '[]' }])).toThrow();
  });

  it('changes far apart are separate versions: undo goes back one at a time', async () => {
    const { recordBefore, versions, goBack } = await import('../src/main/build/history');
    const dir = tempDir('keo-hist-');
    const put = (t: string) => fs.writeFileSync(path.join(dir, 'index.html'), t);
    put('v0');
    recordBefore(dir, ['index.html'], new Date('2026-11-10T10:00:00Z'));
    put('v1');
    recordBefore(dir, ['index.html'], new Date('2026-11-10T10:30:00Z'));
    put('v2');
    recordBefore(dir, ['index.html', 'about.html'], new Date('2026-11-10T10:30:30Z'));
    put('v3');
    fs.writeFileSync(path.join(dir, 'about.html'), 'about');
    expect(versions(dir).map((v) => v.changes)).toEqual([2, 1]);
    // Undo the latest version: both of its changes, back to v1; the new page goes.
    const r = goBack(dir);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(dir, 'about.html'))).toBe(false);
    expect(r.restored).toEqual(['index.html']);
    goBack(dir);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('v0');
  });
});
