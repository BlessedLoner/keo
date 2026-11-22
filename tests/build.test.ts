import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_LIBRARIES, withImportMap } from '../src/main/build/libraries';
import { BuildProjects, onlineGuide } from '../src/main/build/projects';
import { buildCapabilities } from '../src/main/capabilities/build';
import { groupOf } from '../src/main/agent/toolGroups';
import type { ChatResult } from '../src/main/providers/types';
import { tempDir } from './helpers';

const log = { info: () => undefined };
const make = (changed?: (id: string) => void) => {
  const root = tempDir('keo-builds-');
  return { root, p: new BuildProjects({ root: () => root, modules: () => path.join(__dirname, '..', 'node_modules'), log, ...(changed ? { changed } : {}) }) };
};

describe('Keo’s builder: projects', () => {
  it('every library file Keo copies is installed', () => {
    for (const [id, lib] of Object.entries(BUILD_LIBRARIES)) for (const [from] of lib.files) expect(fs.existsSync(path.join(__dirname, '..', 'node_modules', from)), `${id}: ${from}`).toBe(true);
  });

  it('makes a project folder with its settings, and copies the libraries it uses', () => {
    const { root, p } = make();
    const m = p.create({ title: 'Kira’s Café', kind: 'website', brief: 'A café site', libraries: ['gsap', 'three'] });
    expect(m.id).toMatch(/^bd_[a-z0-9]+$/);
    const dir = p.dir(m.id);
    expect(path.dirname(dir)).toBe(root);
    expect(fs.existsSync(path.join(dir, 'lib', 'gsap', 'ScrollTrigger.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'lib', 'three', 'three.module.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'lib', 'three', 'addons', 'controls', 'OrbitControls.js'))).toBe(true);
    // A second project with the same title gets its own folder.
    expect(p.dir(p.create({ title: 'Kira’s Café', kind: 'website' }).id)).not.toBe(dir);
    expect(p.list()).toHaveLength(2);
  });

  it('writes and edits files safely; pages get the import map; Keo’s own files and paths outside are refused', () => {
    const changed: string[] = [];
    const { p } = make((id) => changed.push(id));
    const m = p.create({ title: 'Space', kind: 'game', libraries: ['three'] });
    p.write(m.id, [
      { path: 'index.html', content: '<!doctype html><html><head><title>Space</title></head><body><script type="module" src="/js/game.js"></script></body></html>' },
      { path: 'js/game.js', content: 'import * as THREE from "three";\nconst speed = 1;\n' },
    ]);
    expect(p.read(m.id, 'index.html')).toContain('<script type="importmap">{"imports":{"three":"/lib/three/three.module.min.js"');
    expect(changed.length).toBeGreaterThan(0);
    p.edit(m.id, 'js/game.js', [{ find: 'const speed = 1;', replace: 'const speed = 2;' }]);
    expect(p.read(m.id, 'js/game.js')).toContain('speed = 2');
    expect(() => p.edit(m.id, 'js/game.js', [{ find: 'nothing like this', replace: 'x' }])).toThrow(/appears 0 times/);
    expect(() => p.write(m.id, [{ path: '../evil.js', content: 'x' }])).toThrow(/not a file name/);
    expect(() => p.write(m.id, [{ path: 'C:/Windows/evil.js', content: 'x' }])).toThrow(/not a file name/);
    expect(() => p.write(m.id, [{ path: 'lib/three/three.module.min.js', content: 'x' }])).toThrow(/managed by Keo/);
    expect(() => p.write(m.id, [{ path: 'run.exe', content: 'x' }])).toThrow(/not a file name/);
    expect(p.files(m.id).map((f) => f.path)).toEqual(['index.html', 'js/game.js', 'keo-build.json']);
  });

  it('a backend makes the going-online files: Cloudflare settings, what not to upload, and the guide with the user’s to-do list', () => {
    const { p } = make();
    const m = p.create({ title: 'Shop', kind: 'website' });
    p.write(m.id, [
      { path: 'api/index.js', content: 'export default { async fetch() { return Response.json({ ok: true }); } };' },
      { path: 'api/schema.sql', content: 'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, total REAL);' },
    ]);
    const after = p.update(m.id, { vars: { SHOP_NAME: 'Kira’s Shop' }, todo: [{ what: 'Create a Paystack account', how: 'paystack.com → Sign up, then add the secret key with wrangler secret put PAYSTACK_SECRET', who: 'you', done: false }] });
    expect(after.backend).toBe(true);
    const dir = p.dir(m.id);
    const toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('main = "api/index.js"');
    expect(toml).toContain('binding = "DB"');
    expect(toml).toContain('SHOP_NAME = "Kira’s Shop"');
    expect(fs.readFileSync(path.join(dir, '.assetsignore'), 'utf8')).toContain('api');
    const guide = fs.readFileSync(path.join(dir, 'PUT-IT-ONLINE.md'), 'utf8');
    expect(guide).toContain('npx wrangler deploy');
    expect(guide).toContain('Create a Paystack account');
    expect(onlineGuide(after, 'shop')).toContain('Secrets (payment keys');
  });

  it('adds the import map only once and only for module libraries', () => {
    expect(withImportMap('<html><head></head></html>', ['gsap'])).toBe('<html><head></head></html>');
    const once = withImportMap('<html><head></head></html>', ['three', 'rapier']);
    expect(once).toContain('"@dimforge/rapier3d-compat":"/lib/rapier/rapier.es.js"');
    expect(withImportMap(once, ['three'])).toBe(once);
  });
});

describe('Keo’s builder: tools', () => {
  it('are in the create group, and the start tool teaches how to build', () => {
    const { p } = make();
    const caps = buildCapabilities({ projects: p, host: null });
    expect(caps.map((c) => c.id)).toEqual(['build.start', 'build.write', 'build.append', 'build.edit', 'build.read', 'build.update', 'build.picture', 'build.check', 'build.open', 'build.list', 'build.history', 'build.undo', 'build.city', 'build.model']);
    expect(groupOf('build__start')).toBe('create');
    const start = caps[0]!;
    expect(start.description).toContain('Cloudflare Worker');
    expect(start.description).toContain('build__check');
    expect(start.description).toContain('three.js');
  });
});

describe('Keo’s builder: the Builds page', () => {
  it('lists the pages (home first) and takes a build off the list', () => {
    const { p } = make();
    const m = p.create({ title: 'Site', kind: 'website' });
    p.write(m.id, [
      { path: 'shop.html', content: '<html><body>Shop</body></html>' },
      { path: 'index.html', content: '<html><body>Home</body></html>' },
      { path: 'blog/index.html', content: '<html><body>Blog</body></html>' },
    ]);
    expect(p.pages(m.id)).toEqual(['index.html', 'blog/index.html', 'shop.html']);
    const dir = p.forget(m.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect(p.list()).toEqual([]);
    expect(() => p.dir(m.id)).toThrow(/no such build/);
  });
});

describe('Keo builds a site in one turn, in small steps', () => {
  it('runs past the usual 8 steps once building, writes a long file in parts, and is told plainly when a call was cut off', async () => {
    const { makeHarness } = await import('./helpers');
    const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, model: 'keo-test-1', native: undefined, ...extra });
    let n = 0;
    const call = (name: string, input: unknown) => reply('', { toolCalls: [{ id: `c${++n}`, name, input }], stopReason: 'tool_use' });
    let id = '';
    const seen: string[] = [];
    const h = makeHarness({
      script: (req) => {
        const last = req.messages[req.messages.length - 1];
        const result = last?.content.find((b) => b.type === 'tool_result') as { content: string } | undefined;
        if (result) seen.push(result.content);
        const m = /"id":"(bd_[a-z0-9]+)"/.exec(result?.content ?? '');
        if (m) id = m[1]!;
        const step = seen.length;
        if (step === 0) return call('build__start', { title: 'Haven Homes', kind: 'website', brief: 'Real estate', libraries: ['gsap'] });
        // A call that was cut off at the reply limit (the provider reports it).
        if (step === 1) return reply('', { toolCalls: [{ id: `c${++n}`, name: 'build__write', input: null, parseError: 'This tool call was cut off: it was longer than one reply can be. Send much less per call.' }], stopReason: 'tool_use' });
        if (step === 2) return call('build__write', { build: id, files: [{ path: 'index.html', content: '<!doctype html><html><head><title>Haven</title></head><body><main>' }] });
        // Ten more parts: past the usual 8 rounds.
        if (step < 13) return call('build__append', { build: id, path: 'index.html', content: `<section id="s${step}">Section ${step}</section>` });
        if (step === 13) return call('build__append', { build: id, path: 'index.html', content: '</main></body></html>' });
        return reply('Built Haven Homes.');
      },
    });
    try {
      h.services.settings.update({ agent: { maxToolIterations: 8 } });
      const c = h.services.conversations.create();
      const msg = await h.services.agent.send(c.id, 'Build a real estate website').done;
      expect(msg.content).toContain('Built Haven Homes.');
      expect(seen[1]).toContain('cut off');
      const html = h.services.builds.read(id, 'index.html');
      expect(html).toContain('<section id="s12">');
      expect(html.trim().endsWith('</html>')).toBe(true);
    } finally {
      await h.close();
    }
  }, 60_000);
});

describe('Keo’s builder: robust building', () => {
  it('serves the usual npm paths of the libraries from Keo’s copies', async () => {
    const { libraryAlias } = await import('../src/main/build/libraries');
    expect(libraryAlias('lib/three/build/three.module.js')).toBe('lib/three/three.module.min.js');
    expect(libraryAlias('lib/three/examples/jsm/controls/OrbitControls.js')).toBe('lib/three/addons/controls/OrbitControls.js');
    expect(libraryAlias('lib/gsap/dist/ScrollTrigger.min.js')).toBe('lib/gsap/ScrollTrigger.min.js');
    expect(libraryAlias('lib/phaser/dist/phaser.js')).toBe('lib/phaser/phaser.min.js');
    expect(libraryAlias('css/site.css')).toBeNull();
    expect(withImportMap('<html><head></head></html>', ['three'])).toContain('"/lib/three/build/three.module.js":"/lib/three/three.module.min.js"');
  });

  it('starting again in the same chat (Retry, continue) carries on with the same build', async () => {
    const { p } = make();
    const caps = buildCapabilities({ projects: p, host: null });
    const start = caps.find((c) => c.id === 'build.start')!;
    const ctx = { conversationId: 'conv1', signal: new AbortController().signal } as never;
    const first = (await start.execute({ title: 'Driftline', kind: 'game', brief: '3D racer', libraries: ['three'] } as never, ctx)) as { id: string; continued: boolean };
    p.write(first.id, [{ path: 'js/game.js', content: 'const x = 1;' }]);
    const again = (await start.execute({ title: 'Neon Drift', kind: 'game', brief: '3D racer', libraries: ['three', 'rapier'] } as never, ctx)) as { id: string; continued: boolean; files: Array<{ path: string }>; libraries: string[] };
    expect(again.id).toBe(first.id);
    expect(again.continued).toBe(true);
    expect(again.files.map((f) => f.path)).toContain('js/game.js');
    expect(again.libraries).toEqual(expect.arrayContaining(['three', 'rapier']));
    // Another chat starts its own.
    const other = (await start.execute({ title: 'Other', kind: 'game', brief: 'x', libraries: [] } as never, { conversationId: 'conv2', signal: new AbortController().signal } as never)) as { id: string };
    expect(other.id).not.toBe(first.id);
  });

  it('a model call that drops mid-turn is made again; the turn keeps its work', async () => {
    const { makeHarness } = await import('./helpers');
    const { ProviderError } = await import('../src/main/providers/types');
    const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, model: 'keo-test-1', native: undefined, ...extra });
    let calls = 0;
    let dropped = false;
    const h = makeHarness({
      script: (req) => {
        calls++;
        const done = req.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
        if (!done) return reply('', { toolCalls: [{ id: 'c1', name: 'build__list', input: {} }], stopReason: 'tool_use' });
        if (!dropped) {
          dropped = true;
          throw new ProviderError('network', 'The connection to Keo dropped in the middle of a reply (TypeError: terminated).', { retryable: true });
        }
        return reply('All good.');
      },
    });
    try {
      const c = h.services.conversations.create();
      const msg = await h.services.agent.send(c.id, 'list my builds').done;
      expect(msg.status).toBe('complete');
      expect(msg.content).toContain('All good.');
      expect(calls).toBe(3);
    } finally {
      await h.close();
    }
  }, 60_000);
});
