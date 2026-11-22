import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  it('three.js r187 comes with its core module and the WebGPU entry points', { timeout: 180_000 }, () => {
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
    const files = fs.readdirSync(dir).filter((f) => /\.(woff2|ttf)$/.test(f));
    // The packaged fonts: only their Latin files (Keo's own extra fonts are Latin-only already).
    expect(files.filter((f) => /-(cyrillic|greek|vietnamese)/.test(f))).toEqual([]);
    expect(files.length).toBe(new Set(used).size);
    const kb = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1024;
    // About 40 families; a page downloads only the ones it uses.
    expect(kb).toBeLessThan(6000);
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

describe('a builder that finishes the job', () => {
  const ctx = { signal: new AbortController().signal } as never;
  // A stand-in for Keo's sandboxed preview: each check reports what the test sets.
  const setup = () => {
    const p = make();
    const m = p.create({ title: 'Racer', kind: 'game' });
    let report = { errors: [] as string[], missing: [] as string[], steps: [] as string[] };
    const host = { open: async () => undefined, check: async () => ({ page: 'index.html', title: 'Racer', errors: report.errors, warnings: [], missing: report.missing, text: 'Play', steps: report.steps, screenshot: null }) };
    const caps = buildCapabilities({ projects: p, host } as never);
    const get = (id: string) => caps.find((c) => c.id === id)!;
    const call = async (id: string, input: object) => (await get(id).execute(get(id).input.parse({ build: m.id, ...input }) as never, ctx)) as Record<string, unknown>;
    return { p, m, call, set: (r: Partial<typeof report>) => void (report = { ...report, ...r }) };
  };

  it('remembers each check; a game only counts as good once it was played', async () => {
    const { p, m, call, set } = setup();
    p.write(m.id, [{ path: 'index.html', content: '<h1>v1</h1>' }]);
    expect(p.checkState(m.id)).toMatchObject({ last: null, changedSinceCheck: true });
    await call('build.check', {});
    // Loaded fine, but nothing was played: checked, not yet good.
    expect(p.checkState(m.id)).toMatchObject({ last: { ok: true }, good: null, changedSinceCheck: false, changedSinceGood: true });
    set({ steps: ['click "Play": clicked', 'keys KeyW 3s: held'] });
    await call('build.check', { actions: [{ do: 'click', text: 'Play' }] });
    expect(p.checkState(m.id)).toMatchObject({ last: { ok: true }, changedSinceGood: false });
    expect(p.checkState(m.id).good).not.toBeNull();
    p.write(m.id, [{ path: 'index.html', content: '<h1>v2</h1>' }]);
    expect(p.checkState(m.id)).toMatchObject({ changedSinceCheck: true, changedSinceGood: true });
  });

  it('when fixes make it worse, it goes back to the last version that passed — even for changes made seconds later', async () => {
    const { p, m, call, set } = setup();
    p.write(m.id, [{ path: 'index.html', content: 'good' }]);
    set({ steps: ['click "Play": clicked'] });
    await call('build.check', { actions: [{ do: 'click', text: 'Play' }] });
    // Two quick "fixes" that break it (well within the 2 minutes that normally make one version).
    p.write(m.id, [{ path: 'index.html', content: 'broken 1' }]);
    p.write(m.id, [{ path: 'index.html', content: 'broken 2' }, { path: 'js/extra.js', content: 'x' }]);
    set({ errors: ['TypeError: car is undefined'] });
    const bad = await call('build.check', {});
    expect(bad.ok).toBe(false);
    expect(String(bad.next)).toMatch(/toLastGood: true/);
    expect(p.checkState(m.id).last?.problems).toEqual(['TypeError: car is undefined']);
    const back = await call('build.undo', { toLastGood: true });
    expect(back.removed).toEqual(['js/extra.js']);
    expect(fs.readFileSync(path.join(p.dir(m.id), 'index.html'), 'utf8')).toBe('good');
    expect(p.checkState(m.id).changedSinceGood).toBe(false);
    await expect(call('build.undo', { toLastGood: true })).rejects.toThrow(/Nothing changed since the last good check/);
  });

  it('"continue editing" starts from where the work stands: last check, open problems, recent changes', async () => {
    const { p, m, call, set } = setup();
    p.write(m.id, [{ path: 'index.html', content: 'v1' }]);
    expect(String((await call('build.read', {})).next)).toMatch(/not been checked yet/);
    set({ errors: ['ReferenceError: score is not defined'], missing: ['img/car.png'] });
    await call('build.check', {});
    const r = await call('build.read', {});
    expect(r.state).toMatchObject({ lastCheck: { passed: false, problems: ['ReferenceError: score is not defined', 'missing img/car.png'] }, lastGood: null, changedSinceCheck: false });
    expect((r.state as { recentChanges: unknown[] }).recentChanges).toHaveLength(1);
    expect(String(r.next)).toMatch(/fix those first/);
  });

  it('a reply that would end on an unproven build is sent back to check and fix it', async () => {
    const { buildFinishNote } = await import('../src/main/agent/agentService');
    const note = buildFinishNote([{ id: 'bd_1', open: 'its last check found problems', problems: ['TypeError: car is undefined'] }]);
    expect(note).toMatch(/not typed by the user/);
    expect(note).toMatch(/build__check it now/);
    expect(note).toMatch(/TypeError: car is undefined/);
    expect(note).toMatch(/toLastGood: true/);
  });
});

describe('links in builds', () => {
  it('a build’s pages may link to each other only inside the build windows, never in Keo’s own', async () => {
    vi.doMock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) } }));
    const { isBuildPageNavigation } = await import('../src/main/build/host');
    const preview = { name: 'preview' };
    const check = { name: 'check' };
    const keoWindow = { name: 'keo' };
    const parts = (p: string) => (p === 'persist:keo-build' ? preview : check) as never;
    expect(isBuildPageNavigation(preview as never, 'keobuild://bd_51d1052102/menu.html', parts)).toBe(true);
    expect(isBuildPageNavigation(check as never, 'keobuild://bd_51d1052102/order.html', parts)).toBe(true);
    expect(isBuildPageNavigation(keoWindow as never, 'keobuild://bd_51d1052102/menu.html', parts)).toBe(false);
    expect(isBuildPageNavigation(preview as never, 'https://example.com/', parts)).toBe(false);
    vi.doUnmock('electron');
  });

  it('a check that clicks a link says where it goes, so a link that opens nothing is caught', async () => {
    const { actionScript, OPENS } = await import('../src/main/build/checkActions');
    const link = (href: string, words: string) => ({
      innerText: words, href, target: '', disabled: false, tagName: 'A',
      hasAttribute: () => false, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 50, height: 20 }),
      scrollIntoView: () => undefined, dispatchEvent: () => true, click: () => undefined,
      closest(this: unknown) { return this; },
    });
    const links = [link('keobuild://bd_1a2b3c/menu.html', 'Our menu'), link('keobuild://bd_1a2b3c/#hours', 'Hours')];
    const doc = { querySelectorAll: () => links, querySelector: () => null, elementFromPoint: () => null, body: {} };
    const run = (text: string) => new Function('document', 'location', 'window', 'PointerEvent', 'MouseEvent', `return ${actionScript({ do: 'click', text } as never).script}`)(doc, { href: 'keobuild://bd_1a2b3c/' }, {}, undefined, class { constructor(public t: string) {} });
    expect(run('Our menu')).toBe(`clicked our menu ${OPENS}keobuild://bd_1a2b3c/menu.html]`);
    // A jump within the same page is not a page that must open.
    expect(run('Hours')).toBe('clicked hours');
  });
});

describe('creative direction in the builder', () => {
  it('picks art directions that suit the brief, and never the ones recent builds used', async () => {
    const { pickDirections, ART_DIRECTIONS } = await import('../src/main/build/directions');
    expect(pickDirections('a website for a streetwear brand drop', 'website')[0]!.id).toBe('neo-brutalist');
    expect(pickDirections('an AI app for meditation', 'app')[0]!.id).toBe('liquid-aurora');
    const two = pickDirections('a bakery website', 'website', ['organic-soft', 'collage-maximal']);
    expect(two.map((d) => d.id)).not.toContain('organic-soft');
    expect(new Set(two.map((d) => d.id)).size).toBe(3);
    // Every direction names fonts Keo really ships to builds.
    const { BUILD_FONTS, EXTRA_FONTS } = await import('../src/main/build/libraries');
    const families = [...BUILD_FONTS, ...EXTRA_FONTS].map((f) => f.family);
    for (const d of ART_DIRECTIONS) for (const name of d.type.match(/"([^"]+)"/g) ?? []) expect(families, `${d.id}: ${name}`).toContain(name.replace(/"/g, ''));
  });

  it('a new build gets a direction, the effects kit and 40 fonts; the next build looks different', async () => {
    const p = make();
    const looks: string[] = [];
    const caps = buildCapabilities({ projects: p, host: null, look: async (_png: Buffer, _b: string, _s: AbortSignal, mode?: string) => (looks.push(mode ?? ''), 'ok') } as never);
    const start = caps.find((c) => c.id === 'build.start')!;
    const ctx = (id: string) => ({ signal: new AbortController().signal, conversationId: id }) as never;
    const a = (await start.execute(start.input.parse({ title: 'Sunrise Bakery', kind: 'website', brief: 'A bakery website with a menu and orders' }) as never, ctx('c1'))) as { id: string; artDirection: string; otherDirections: string[] };
    expect(a.artDirection).toMatch(/^Art direction: /);
    expect(a.otherDirections).toHaveLength(2);
    const lib = path.join(p.dir(a.id), 'lib');
    expect(fs.readFileSync(path.join(lib, 'fx', 'fx.js'), 'utf8')).toContain('window.fx =');
    const css = fs.readFileSync(path.join(lib, 'fonts', 'fonts.css'), 'utf8');
    for (const fam of ['Unbounded', 'Instrument Serif', 'Big Shoulders Display', 'Inter']) expect(css).toContain(`font-family: '${fam}'`);
    expect(fs.existsSync(path.join(lib, 'fonts', 'unbounded-latin-wght-normal.woff2'))).toBe(true);
    const b = (await start.execute(start.input.parse({ title: 'Crumbs', kind: 'website', brief: 'Another bakery website' }) as never, ctx('c2'))) as { id: string };
    expect(p.manifest(b.id).direction).not.toBe(p.manifest(a.id).direction);
    // The user's own look: no direction forced on it.
    const c = (await start.execute(start.input.parse({ title: 'Mine', kind: 'website', brief: 'x', direction: 'none' }) as never, ctx('c3'))) as { id: string; artDirection?: string };
    expect(c.artDirection).toBeUndefined();
    // Changing the look later.
    const upd = caps.find((x) => x.id === 'build.update')!;
    const u = (await upd.execute(upd.input.parse({ build: a.id, direction: 'cinematic-dark' }) as never, ctx('c1'))) as { artDirection: string };
    expect(u.artDirection).toMatch(/Cinematic Dark/);
    await expect(upd.execute(upd.input.parse({ build: a.id, direction: 'made-up' }) as never, ctx('c1'))).rejects.toThrow(/no art direction/);
  });

  it('font files say their weight and style', async () => {
    const { fontFace } = await import('../src/main/build/libraries');
    expect(fontFace('syne-latin-wght-normal.woff2')).toEqual({ weight: '100 900', style: 'normal' });
    expect(fontFace('InstrumentSerif-Italic.ttf')).toEqual({ weight: '400', style: 'italic' });
    expect(fontFace('Poppins-ExtraBold.ttf')).toEqual({ weight: '800', style: 'normal' });
    expect(fontFace('space-mono-latin-700-italic.woff2')).toEqual({ weight: '700', style: 'italic' });
  });
});

describe('the art director’s critique', () => {
  it('waits for entrance animations, and is limited to two per build so polishing never eats a request', async () => {
    const p = make();
    const m = p.create({ title: 'Studio', kind: 'website', direction: 'kinetic-swiss' });
    const modes: string[] = [];
    const settles: boolean[] = [];
    const host = { open: async () => undefined, check: async (_id: string, _p?: string, o?: { settle?: boolean }) => (settles.push(!!o?.settle), { page: 'index.html', title: 'S', errors: [], warnings: [], missing: [], text: '', steps: [], screenshot: Buffer.from('png') }) };
    const caps = buildCapabilities({ projects: p, host, look: async (_png: Buffer, brief: string, _s: AbortSignal, mode?: string) => (modes.push(`${mode}:${/Kinetic Swiss/.test(brief)}`), 'notes') } as never);
    const check = caps.find((c) => c.id === 'build.check')!;
    const ctx = { signal: new AbortController().signal } as never;
    const run = async () => (await check.execute(check.input.parse({ build: m.id, critique: true }) as never, ctx)) as { next: string };
    await run();
    await run();
    const third = await run();
    expect(modes).toEqual(['critique:true', 'critique:true', 'check:true']);
    expect(settles).toEqual([true, true, false]);
    expect(third.next).toMatch(/reviewed this build twice/);
  });
});
