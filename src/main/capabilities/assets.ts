import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assetCost, studioPrice } from '../../shared/aiPrices';
import type { AssetKind, AssetRequest } from '../studio/aiVideo';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

/**
 * Keo's creative toolkit, for websites, apps, games and Studio videos alike:
 *  - real photographs anyone may use (Openverse: openly licensed pictures, with their credit line);
 *  - cut-outs, illustrations, vector art (SVG), styled lettering and transparent elements, made by
 *    fal.ai's models (Studio credits through Keo Cloud, or the user's own fal.ai key).
 * Each result is saved in the build's own folder, added to the Studio project, or kept in
 * Pictures\Keo\Assets.
 */

export interface Photo {
  id: string;
  title: string;
  /** The full picture. */
  url: string;
  thumbnail: string;
  width: number | null;
  height: number | null;
  creator: string | null;
  license: string;
  licenseUrl: string | null;
  /** Where the picture comes from (its page). */
  source: string;
  /** The credit line to show with it (the licence asks for it). */
  credit: string;
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface AssetToolDeps {
  fetch: Fetch;
  /** Makes an asset with fal.ai (Keo Cloud's Studio credits, or the user's own key). */
  make: (r: AssetRequest, signal: AbortSignal) => Promise<{ file: string; cached: boolean }>;
  /** 'keo' (Studio credits), 'own' (the user's fal.ai key), or null (not set up). */
  via: () => 'keo' | 'own' | null;
  /** Why making assets is not possible now (null when it is). */
  blocked: () => string | null;
  /** Where assets go when there is no build or project: Pictures\Keo\Assets. */
  assetsDir: () => string;
  builds: {
    forConversation(conversationId: string): { id: string; title: string } | null;
    manifest(id: string): { id: string; title: string };
    dir(id: string): string;
    writeBinary(id: string, rel: string, bytes: Buffer): string;
  };
  studio?: {
    importFile(projectId: string, file: string): Promise<{ assetId: string } | null>;
    /** The file of one of the project's pictures (cut-outs of it). */
    assetFile(projectId: string, assetId: string): string | null;
  };
}

const OPENVERSE = 'https://api.openverse.org/v1/images/';
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

const fail = (code: string, message: string) => new CapabilityError(code, message);
const safeName = (s: string, fallback: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50) || fallback;

/** Openverse's licence code in words (CC BY 4.0, CC0…). */
function licenceName(code: string, version: string | null): string {
  const c = code.toLowerCase();
  if (c === 'cc0') return 'CC0 (public domain)';
  if (c === 'pdm') return 'Public Domain Mark';
  return `CC ${c.toUpperCase()}${version ? ` ${version}` : ''}`;
}

const Where = z
  .object({
    buildId: z.string().regex(/^bd_[a-f0-9]{6,20}$/).optional().describe('Save into this build (default: the build of this conversation, if any)'),
    projectId: z.string().regex(/^pr_[A-Za-z0-9]{4,24}$/).optional().describe('Or: add to this Studio project'),
    name: z.string().trim().min(1).max(60).optional().describe('A short file name (e.g. "hero-baker")'),
  })
  .strict();

export function assetCapabilities(d: AssetToolDeps): AnyCapability[] {
  /** Photos found in this session: only these can be saved (never an arbitrary link). */
  const found = new Map<string, Photo>();

  /** Saves bytes where they belong; returns where they went. */
  async function place(bytes: Buffer, ext: string, o: z.infer<typeof Where>, fallback: string, conversationId: string | null | undefined, folder: string): Promise<{ file: string; buildPath: string | null; buildId: string | null; projectAsset: string | null }> {
    const name = `${safeName(o.name ?? fallback, 'asset')}.${ext}`;
    const build = o.buildId ? d.builds.manifest(o.buildId) : !o.projectId && conversationId ? d.builds.forConversation(conversationId) : null;
    if (build) {
      const rel = `assets/${folder}/${name}`;
      const file = d.builds.writeBinary(build.id, rel, bytes);
      return { file, buildPath: rel, buildId: build.id, projectAsset: null };
    }
    const dir = path.join(d.assetsDir(), folder);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name);
    // Never replaces a file: a new name instead.
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, name.replace(/(\.\w+)$/, `-${n}$1`));
    fs.writeFileSync(file, bytes);
    let projectAsset: string | null = null;
    if (o.projectId && d.studio) projectAsset = (await d.studio.importFile(o.projectId, file))?.assetId ?? null;
    return { file, buildPath: null, buildId: null, projectAsset };
  }

  const findPhotos = defineCapability({
    id: 'assets.find_photos',
    version: '1.0.0',
    title: 'Find real photos',
    description:
      'Search real photographs that anyone may use, including in a business (Openverse: openly licensed pictures from Flickr, Wikimedia and others; CC0, CC BY and CC BY-SA). Use them to make websites, apps and videos look real instead of only gradients and shapes: a bakery’s bread, a city skyline, people working. Describe the picture in plain words (subject, mood, setting). Then save the ones that fit with assets__save_photo (it keeps the credit line the licence asks for). Free: costs nothing.',
    input: z
      .object({
        query: z.string().trim().min(2).max(200),
        orientation: z.enum(['wide', 'tall', 'square', 'any']).default('any'),
        count: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    output: z.object({ photos: z.array(z.object({ id: z.string(), title: z.string(), thumbnail: z.string(), width: z.number().nullable(), height: z.number().nullable(), license: z.string(), credit: z.string() })), note: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 30_000,
    maxAttempts: 2,
    modelVisible: true,
    verificationPolicy: 'A search: nothing is changed.',
    preview: (i) => ({ summary: `Find photos of “${i.query}”`, target: null, consequences: ['Searches Openverse; nothing is saved.'], dataExport: 'The search words are sent to Openverse.' }),
    auditView: (i) => ({ query: i.query }),
    async execute(i, ctx) {
      // format=json: without it Openverse may answer with its web page instead of data.
      const q = new URLSearchParams({ q: i.query, page_size: String(Math.min(20, i.count * 2)), license_type: 'commercial', mature: 'false', format: 'json' });
      if (i.orientation !== 'any') q.set('aspect_ratio', i.orientation);
      const r = await d.fetch(`${OPENVERSE}?${q}`, { headers: { accept: 'application/json', 'user-agent': 'Keo (desktop assistant)' }, signal: ctx.signal }).catch(() => null);
      if (!r || !r.ok) throw fail('photos_unavailable', `The photo search did not answer${r ? ` (${r.status})` : ''}. Try again in a moment.`);
      const data = (await r.json().catch(() => ({}))) as { results?: Array<Record<string, unknown>> };
      const photos: Photo[] = [];
      for (const x of data.results ?? []) {
        const url = typeof x.url === 'string' ? x.url : '';
        if (!/^https:\/\//.test(url) || typeof x.id !== 'string') continue;
        const license = licenceName(String(x.license ?? ''), typeof x.license_version === 'string' ? x.license_version : null);
        const creator = typeof x.creator === 'string' && x.creator.trim() ? x.creator.trim().slice(0, 120) : null;
        const title = (typeof x.title === 'string' && x.title.trim() ? x.title.trim() : 'Untitled').slice(0, 160);
        const source = typeof x.foreign_landing_url === 'string' && /^https?:\/\//.test(x.foreign_landing_url) ? x.foreign_landing_url : url;
        const photo: Photo = {
          id: `ph_${x.id.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`,
          title,
          url,
          thumbnail: typeof x.thumbnail === 'string' ? x.thumbnail : url,
          width: Number(x.width) || null,
          height: Number(x.height) || null,
          creator,
          license,
          licenseUrl: typeof x.license_url === 'string' ? x.license_url : null,
          source,
          credit: `“${title}”${creator ? ` by ${creator}` : ''}, ${license}${source ? ` (${source})` : ''}`,
        };
        found.set(photo.id, photo);
        photos.push(photo);
        if (photos.length >= i.count) break;
      }
      return {
        photos: photos.map((p) => ({ id: p.id, title: p.title, thumbnail: p.thumbnail, width: p.width, height: p.height, license: p.license, credit: p.credit })),
        note: photos.length ? 'Save the ones that fit with assets__save_photo (by id). Show the credit line with CC BY and CC BY-SA photos (assets__save_photo adds it to the build’s CREDITS.md).' : 'Nothing found: try other words (simpler, in English).',
      };
    },
  });

  const savePhoto = defineCapability({
    id: 'assets.save_photo',
    version: '1.0.0',
    title: 'Save a photo',
    description:
      'Save a photo found with assets__find_photos (by its id) into the build (assets/photos/, with its credit line added to the build’s CREDITS.md), into a Studio project, or into Pictures\\Keo\\Assets. Returns the path to use in the code (e.g. "assets/photos/fresh-bread.jpg"). Free.',
    input: Where.extend({ photoId: z.string().regex(/^ph_[A-Za-z0-9]{1,24}$/) }).strict(),
    output: z.object({ file: z.string(), buildPath: z.string().nullable(), projectAsset: z.string().nullable(), credit: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    // A new file (never replacing one), free: like the builder's own file writes.
    consequential: false,
    idempotent: false,
    timeoutMs: 60_000,
    maxAttempts: 2,
    modelVisible: true,
    verificationPolicy: 'A new picture file in the build, the Studio project or Pictures\\Keo\\Assets.',
    preview: (i) => ({ summary: `Save photo ${i.photoId}`, target: null, consequences: ['Downloads the photo and saves it as a new file.'], dataExport: 'Nothing is sent: the photo is downloaded from where Openverse found it.' }),
    auditView: (i) => ({ photo: i.photoId, buildId: i.buildId ?? null, projectId: i.projectId ?? null }),
    async execute(i, ctx) {
      const photo = found.get(i.photoId);
      if (!photo) throw fail('unknown_photo', 'That photo was not found in a search here: search with assets__find_photos first and use one of its ids.');
      // Wikimedia and others ask downloaders to say who they are.
      const r = await d.fetch(photo.url, { headers: { 'user-agent': 'Keo (desktop assistant)' }, signal: ctx.signal }).catch(() => null);
      if (!r || !r.ok) throw fail('download_failed', `The photo could not be downloaded${r ? ` (${r.status})` : ''}: try another one.`);
      const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!PICTURE_TYPES.has(type)) throw fail('not_a_picture', 'That link did not give a JPEG, PNG or WebP picture: try another one.');
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length < 1000 || bytes.length > MAX_PHOTO_BYTES) throw fail('bad_size', 'That photo is empty or over 15 MB: try another one.');
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const where = await place(bytes, ext, i, photo.title, ctx.conversationId, 'photos');
      // The licence asks for credit: kept next to the build's files (and shown on the site if the user wants).
      if (where.buildId) {
        const credits = path.join(d.builds.dir(where.buildId), 'CREDITS.md');
        const line = `- ${where.buildPath}: ${photo.credit}${photo.licenseUrl ? ` — licence: ${photo.licenseUrl}` : ''}\n`;
        const before = fs.existsSync(credits) ? fs.readFileSync(credits, 'utf8') : '# Photo credits\n\n';
        if (!before.includes(line)) fs.writeFileSync(credits, before + line);
      }
      return { file: where.file, buildPath: where.buildPath, projectAsset: where.projectAsset, credit: photo.credit };
    },
  });

  const make = defineCapability({
    id: 'assets.make',
    version: '1.0.0',
    title: 'Make a creative asset',
    description: [
      'Make a picture element for a website, app, game or Studio video with fal.ai’s design models (Studio credits through the Keo account, or the user’s own fal.ai key). Kinds:',
      '- cutout: the background of a picture removed (a PNG with transparency): a product, a person, a logo. Give `image` (a file of the build: buildFile, or a Studio picture: assetId) and, when it is not obvious, `keep` (“the cup”). About $0.02.',
      '- illustration: an illustration in a chosen style (Recraft V3; `style` like "digital_illustration/hand_drawn", "digital_illustration/2d_art_poster", "realistic_image/studio_portrait"). About $0.04.',
      '- vector: icons, logos, badges and flat art as a real SVG that scales to any size (Recraft in a vector style like "vector_illustration/line_art", "vector_illustration/roundish_flat", "vector_illustration/bold_stroke", then made into SVG). About $0.09.',
      '- lettering: words drawn as designed lettering (posters, hero titles, thumbnails, stylised words in a video) with exact spelling (Ideogram V3). Put the exact words in quotes in the prompt. About $0.06.',
      '- element: a sticker, shape, badge, frame or object on a transparent background, to lay over a page or a video (Ideogram V3 Transparent). About $0.06.',
      'Use them to make designs that do not look like every other site: real art direction, custom icons in one style, cut-out products, hero lettering. Pass the brand colours (colors) for illustrations and vectors. Quality draft costs half, best costs 1.5×. Making the same thing again is free; again: true makes a fresh take (paid). Say the price before (the approval shows it too). The result is saved in the build (assets/<kind>/…, the path to use in the code is returned), added to the Studio project, or kept in Pictures\\Keo\\Assets.',
    ].join('\n'),
    input: Where.extend({
      kind: z.enum(['cutout', 'illustration', 'vector', 'lettering', 'element']),
      prompt: z.string().trim().max(1500).default('').describe('What to make; for lettering the exact words in quotes and the look'),
      buildFile: z.string().trim().max(300).optional().describe('cutout: a picture file of the build (e.g. "assets/photos/cake.jpg")'),
      assetId: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/).optional().describe('cutout: a picture of the Studio project'),
      keep: z.string().trim().max(200).optional().describe('cutout: what to keep, when it is not obvious'),
      style: z.string().regex(/^(realistic_image|digital_illustration|vector_illustration)(\/[a-z0-9_]{2,40})?$/).optional(),
      shape: z.enum(['square', 'wide', 'tall']).default('square'),
      colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(5).optional().describe('Brand colours as #RRGGBB'),
      quality: z.enum(['draft', 'standard', 'best']).default('standard'),
      transparent: z.boolean().default(false).describe('lettering on a transparent background'),
      again: z.boolean().default(false),
    }).strict(),
    output: z.object({ file: z.string(), buildPath: z.string().nullable(), projectAsset: z.string().nullable(), cached: z.boolean(), costUsd: z.number() }),
    risk: 'medium',
    // It spends the user's money (and a cut-out sends their picture to the AI service): they approve each one.
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 8 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'A new picture or SVG file in the build, the Studio project or Pictures\\Keo\\Assets.',
    unavailableReason: () => d.blocked(),
    autonomy: () => ({ tier: 'important', reason: 'it costs money and uses the AI picture service' }),
    preview: (i) => {
      const via = d.via() ?? 'own';
      const usd = assetCost(i.kind, { keep: !!i.keep, quality: i.quality });
      const cost = studioPrice(usd, via);
      const what = { cutout: 'a cut-out (background removed)', illustration: 'an illustration', vector: 'vector art (SVG)', lettering: 'designed lettering', element: 'an element on a transparent background' }[i.kind];
      return {
        summary: `Make ${what}${i.prompt ? `: “${i.prompt.slice(0, 80)}”` : ''}, about ${cost}`,
        target: null,
        consequences: [`Costs about ${cost}${via === 'keo' ? ' (Studio credits)' : ' from your fal.ai account'} (nothing if the same was made before).`, 'Saves a new file; nothing existing is changed.'],
        dataExport: i.kind === 'cutout' ? `The picture is sent to the AI service (fal.ai${via === 'keo' ? ', through Keo Cloud' : ''}).` : `The description is sent to the AI service (fal.ai${via === 'keo' ? ', through Keo Cloud' : ''}).`,
      };
    },
    auditView: (i) => ({ kind: i.kind, quality: i.quality, again: i.again, buildId: i.buildId ?? null, projectId: i.projectId ?? null }),
    async execute(i, ctx) {
      const blocked = d.blocked();
      if (blocked) throw fail('assets_unavailable', blocked);
      if (i.kind !== 'cutout' && !i.prompt) throw fail('no_prompt', 'Say what to make.');
      const req: AssetRequest = { kind: i.kind as AssetKind, prompt: i.prompt, quality: i.quality, transparent: i.transparent, ...(i.again ? { take: Date.now() % 100000 } : {}) };
      if (i.kind === 'cutout') {
        let file: string | null = null;
        if (i.buildFile) {
          const build = i.buildId ? d.builds.manifest(i.buildId) : ctx.conversationId ? d.builds.forConversation(ctx.conversationId) : null;
          if (!build) throw fail('no_build', 'Which build is the picture in? Give buildId.');
          const root = path.resolve(d.builds.dir(build.id));
          const f = path.resolve(root, i.buildFile);
          if (!f.startsWith(root + path.sep)) throw fail('outside_build', 'The picture must be a file of the build.');
          file = f;
        } else if (i.assetId && i.projectId && d.studio) file = d.studio.assetFile(i.projectId, i.assetId);
        if (!file || !fs.existsSync(file)) throw fail('no_picture', 'Give the picture to cut out: buildFile (a file of the build) or assetId with projectId (a Studio picture).');
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null;
        if (!type) throw fail('not_a_picture', 'A cut-out needs a JPEG, PNG or WebP picture.');
        const bytes = fs.readFileSync(file);
        if (bytes.length > MAX_PHOTO_BYTES) throw fail('too_big', 'That picture is over 15 MB: use a smaller one.');
        req.image = { bytes, type };
        if (i.keep) req.keep = i.keep;
      }
      if (i.style) req.style = i.style;
      if (i.colors?.length) req.colors = i.colors.map((c) => ({ r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16) }));
      req.size = i.shape === 'wide' ? 'landscape_16_9' : i.shape === 'tall' ? 'portrait_16_9' : 'square_hd';
      req.aspect = i.shape === 'wide' ? '16:9' : i.shape === 'tall' ? '9:16' : '1:1';
      const made = await d.make(req, ctx.signal).catch((e: unknown) => {
        throw fail('asset_failed', `${(e as Error)?.message ?? 'The AI service could not make it.'} Nothing was charged for a request that failed.`);
      });
      const ext = path.extname(made.file).slice(1) || 'png';
      const where = await place(fs.readFileSync(made.file), ext, i, i.name ?? (i.prompt || 'cutout').slice(0, 40), ctx.conversationId, `${i.kind}s`);
      return { file: where.file, buildPath: where.buildPath, projectAsset: where.projectAsset, cached: made.cached, costUsd: made.cached ? 0 : assetCost(i.kind, { keep: !!i.keep, quality: i.quality }) };
    },
  });

  return [findPhotos, savePhoto, make] as AnyCapability[];
}
