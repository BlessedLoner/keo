import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetCapabilities, type AssetToolDeps } from '../src/main/capabilities/assets';
import { chooseGroups } from '../src/main/agent/toolGroups';
import type { AssetRequest } from '../src/main/studio/aiVideo';
import type { AnyCapability, CapabilityContext } from '../src/main/capabilities/types';

let root: string;
let made: AssetRequest[];
let fetched: string[];
let caps: Record<string, AnyCapability>;
let via: 'keo' | 'own' | null;
let blocked: string | null;
const ctx = (conversationId: string | null = 'c1') => ({ signal: new AbortController().signal, idempotencyKey: 'k', correlationId: 'x', conversationId, sourceMessageId: null, taskId: null, settings: {} }) as unknown as CapabilityContext;
const run = (name: string, input: unknown, c = ctx()) => caps[name]!.execute(caps[name]!.input.parse(input) as never, c) as Promise<Record<string, unknown>>;

/** A tiny real PNG (the bytes do not matter to the tools, only that they are a picture). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 7)]);

const openverse = {
  results: [
    { id: 'abc-123', title: 'Fresh bread', url: 'https://live.staticflickr.com/1/bread.jpg', thumbnail: 'https://api.openverse.org/v1/images/abc-123/thumb/', creator: 'Ada Baker', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', foreign_landing_url: 'https://www.flickr.com/photos/ada/1', width: 4000, height: 3000 },
    { id: 'bad', title: 'Not https', url: 'http://example.test/x.jpg' },
    { id: 'zero-9', title: '', url: 'https://upload.wikimedia.org/a.png', license: 'cc0', creator: '' },
  ],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-assets-'));
  made = [];
  fetched = [];
  via = 'keo';
  blocked = null;
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(path.join(buildDir, 'assets', 'photos'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'assets', 'photos', 'cake.jpg'), PNG);
  const deps: AssetToolDeps = {
    fetch: async (url) => {
      fetched.push(url);
      if (url.startsWith('https://api.openverse.org/')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => openverse, arrayBuffer: async () => new ArrayBuffer(0) };
      if (url.includes('wikimedia')) return { ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(10) };
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg; charset=binary' }, json: async () => ({}), arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) };
    },
    make: async (r) => {
      made.push(r);
      const ext = r.kind === 'vector' ? 'svg' : r.kind === 'illustration' ? 'webp' : 'png';
      const f = path.join(root, `made-${made.length}.${ext}`);
      fs.writeFileSync(f, ext === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : PNG);
      return { file: f, cached: false };
    },
    via: () => via,
    blocked: () => blocked,
    assetsDir: () => path.join(root, 'Pictures', 'Keo', 'Assets'),
    builds: {
      forConversation: (c) => (c === 'c1' ? { id: 'bd_abc123', title: 'Bakery' } : null),
      manifest: (id) => {
        if (id !== 'bd_abc123') throw new Error('no such build');
        return { id, title: 'Bakery' };
      },
      dir: () => buildDir,
      writeBinary: (_id, rel, bytes) => {
        const f = path.join(buildDir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, bytes);
        return f;
      },
    },
    studio: {
      importFile: async () => ({ assetId: 'as_new123' }),
      assetFile: (projectId, assetId) => (projectId === 'pr_abcd1' && assetId === 'as_pic123' ? path.join(buildDir, 'assets', 'photos', 'cake.jpg') : null),
    },
  };
  caps = Object.fromEntries(assetCapabilities(deps).map((c) => [c.id, c]));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('real photos (Openverse)', () => {
  it('finds photos anyone may use in a business, with their credit line; only https pictures', async () => {
    const r = (await run('assets.find_photos', { query: 'fresh bread on a table', orientation: 'wide', count: 5 })) as { photos: Array<{ id: string; license: string; credit: string }> };
    const q = new URL(fetched[0]!).searchParams;
    expect(q.get('license_type')).toBe('commercial');
    expect(q.get('mature')).toBe('false');
    expect(q.get('format')).toBe('json');
    expect(q.get('aspect_ratio')).toBe('wide');
    expect(r.photos.map((p) => p.id)).toEqual(['ph_abc123', 'ph_zero9']);
    expect(r.photos[0]).toMatchObject({ license: 'CC BY 4.0', credit: '“Fresh bread” by Ada Baker, CC BY 4.0 (https://www.flickr.com/photos/ada/1)' });
    expect(r.photos[1]!.license).toBe('CC0 (public domain)');
  });

  it('saves a found photo into the build with its credit in CREDITS.md (once); never an arbitrary link', async () => {
    await run('assets.find_photos', { query: 'bread' });
    const saved = await run('assets.save_photo', { photoId: 'ph_abc123', name: 'Hero Bread' });
    expect(saved.buildPath).toBe('assets/photos/hero-bread.jpg');
    expect(fs.existsSync(String(saved.file))).toBe(true);
    await run('assets.save_photo', { photoId: 'ph_abc123', name: 'Hero Bread' });
    const credits = fs.readFileSync(path.join(root, 'build', 'CREDITS.md'), 'utf8');
    expect(credits.match(/Ada Baker/g)).toHaveLength(1);
    expect(credits).toContain('https://creativecommons.org/licenses/by/4.0/');
    await expect(run('assets.save_photo', { photoId: 'ph_notfound1' })).rejects.toThrow(/search with assets__find_photos first/);
    // A link that does not give a picture is refused.
    await expect(run('assets.save_photo', { photoId: 'ph_zero9' })).rejects.toThrow(/JPEG, PNG or WebP/);
  });

  it('without a build, a photo goes to Pictures\\Keo\\Assets (never replacing a file), or into a Studio project', async () => {
    await run('assets.find_photos', { query: 'bread' });
    const a = await run('assets.save_photo', { photoId: 'ph_abc123', name: 'bread' }, ctx(null));
    const b = await run('assets.save_photo', { photoId: 'ph_abc123', name: 'bread' }, ctx(null));
    expect(path.basename(String(a.file))).toBe('bread.jpg');
    expect(path.basename(String(b.file))).toBe('bread-2.jpg');
    const s = await run('assets.save_photo', { photoId: 'ph_abc123', projectId: 'pr_abcd1' }, ctx(null));
    expect(s.projectAsset).toBe('as_new123');
  });
});

describe('making assets (fal.ai, paid with Studio credits)', () => {
  it('says the price before, in credits through Keo or dollars with the user’s own key', () => {
    const preview = (input: unknown) => caps['assets.make']!.preview!(caps['assets.make']!.input.parse(input) as never, ctx() as never);
    const v = preview({ kind: 'vector', prompt: 'a rocket icon' });
    expect(v.summary).toContain('vector art (SVG)');
    expect(v.consequences.join(' ')).toMatch(/18 credits|Studio credits/);
    via = 'own';
    expect(preview({ kind: 'lettering', prompt: '"SALE"', quality: 'best' }).consequences.join(' ')).toMatch(/\$0\.09.*fal\.ai account/);
    expect(caps['assets.make']!.approval).toBe('always');
  });

  it('a vector icon set in the brand colours lands in the build as SVG, with the path to use', async () => {
    const r = await run('assets.make', { kind: 'vector', prompt: 'a croissant icon', style: 'vector_illustration/line_art', colors: ['#C2410C', '#1C1917'], name: 'croissant' });
    expect(made[0]).toMatchObject({ kind: 'vector', prompt: 'a croissant icon', style: 'vector_illustration/line_art', size: 'square_hd', colors: [{ r: 194, g: 65, b: 12 }, { r: 28, g: 25, b: 23 }] });
    expect(r.buildPath).toBe('assets/vectors/croissant.svg');
    expect(r.costUsd).toBe(0.09);
  });

  it('a cut-out of a build’s own picture; never a file outside the build', async () => {
    const r = await run('assets.make', { kind: 'cutout', buildFile: 'assets/photos/cake.jpg', keep: 'the cake' });
    expect(made[0]!.image!.type).toBe('image/jpeg');
    expect(made[0]!.keep).toBe('the cake');
    expect(r.buildPath).toMatch(/^assets\/cutouts\/.+\.png$/);
    await expect(run('assets.make', { kind: 'cutout', buildFile: '../../secret.jpg' })).rejects.toThrow(/file of the build/);
    // A Studio picture by its asset id.
    await run('assets.make', { kind: 'cutout', projectId: 'pr_abcd1', assetId: 'as_pic123' }, ctx(null));
    expect(made).toHaveLength(2);
  });

  it('lettering and elements: wide or tall shapes, quality; nothing is made when it is not set up', async () => {
    await run('assets.make', { kind: 'element', prompt: 'a gold star sticker', shape: 'tall', quality: 'draft' });
    expect(made[0]).toMatchObject({ kind: 'element', aspect: '9:16', quality: 'draft' });
    blocked = 'Sign in to your Keo account.';
    await expect(run('assets.make', { kind: 'lettering', prompt: '"OPEN"' })).rejects.toThrow(/Sign in/);
    expect(made).toHaveLength(1);
    await expect(run('assets.make', { kind: 'illustration', prompt: '' })).rejects.toThrow();
  });
});

describe('the creative toolkit comes with building and Studio', () => {
  const groups = (text: string) => chooseGroups({ texts: [text], pictures: false, documents: false, pencil: false, recent: [] });
  it('is there for a website, a game and a video edit, and for asset words; not for an email', () => {
    expect(groups('build me a website for my bakery').has('assets')).toBe(true);
    expect(groups('edit this video into a tiktok with captions').has('assets')).toBe(true);
    expect(groups('make me some vector icons').has('assets')).toBe(true);
    expect(groups('email Tunde the report').has('assets')).toBe(false);
  });
});
