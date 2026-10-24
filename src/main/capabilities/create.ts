import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildDocx, type LoadedImage } from '../create/docx';
import { pageProblems, withPolicy } from '../create/html';
import { imageInfo } from '../create/images';
import { safeFileName, uniquePath, writeAtomic, type CreatedFiles, type CreatedKind } from '../create/output';
import { buildPptx } from '../create/pptx';
import { buildModel, LIMITS, measure, toStl } from '../create/solid';
import { DeckSpec, DocSpec, ModelSpec, PageSpec, WorkbookSpec } from '../create/specs';
import { buildXlsx, unsafeFormula } from '../create/xlsx';
import { mentions } from './video';
import { CapabilityError, defineCapability, type AnyCapability, type CapabilityContext } from './types';

/**
 * Making real files on request: Word documents, PowerPoint decks, Excel workbooks, single-file web
 * games/apps and 3D-printable STL models. The model sends a plain spec; Keo builds the file itself,
 * saves it in Documents\Keo (or a folder the user named inside their allowed folders), never over an
 * existing file unless the user approves replacing one Keo made, and can then open it.
 */
export interface CreateDeps {
  /** Documents\Keo. */
  outputRoot(): string;
  /** Inside the folders the user allowed in Settings → Files. */
  allowed(p: string): boolean;
  /** The user's own recent messages in a conversation (to check a folder they named). */
  userTexts(conversationId: string): string[];
  openPath(p: string): Promise<boolean>;
  created: CreatedFiles;
  /** Where the old version goes when the user approves replacing a file. */
  backupRoot(): string;
}

const fail = (code: string, message: string) => new CapabilityError(code, message, { dispatched: 'no' });

const Place = {
  fileName: z.string().trim().min(1).max(120).optional().describe('File name without folder; default from the title.'),
  folder: z.string().trim().min(3).max(500).optional().describe('Full path of a folder the user named (inside their allowed folders). Omit for Documents\\Keo.'),
  replace: z.string().trim().min(4).max(500).optional().describe('Full path of a file Keo made earlier (from create__recent) to replace with this new version; the user approves, and the old one is backed up.'),
};

const Made = z.object({ path: z.string(), fileName: z.string(), folder: z.string(), bytes: z.number(), replaced: z.boolean(), details: z.record(z.string(), z.unknown()), next: z.string() });
type Made = z.infer<typeof Made>;

const isInside = (p: string, dir: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const EXT: Record<CreatedKind, string> = { document: '.docx', presentation: '.pptx', spreadsheet: '.xlsx', web_app: '.html', model_3d: '.stl' };
const NOUN: Record<CreatedKind, string> = { document: 'Word document', presentation: 'PowerPoint deck', spreadsheet: 'Excel workbook', web_app: 'web page', model_3d: '3D model (STL)' };
const IMAGE_EXT = /\.(png|jpe?g|gif)$/i;
/** Specs larger than this are not kept for later edits (the file itself is still made). */
const MAX_KEPT_SPEC = 2_000_000;

interface Placed {
  fileName?: string;
  folder?: string;
  replace?: string;
}

export function createCapabilities(d: CreateDeps): AnyCapability[] {
  /** Checks that need no conversation: the folder is allowed, the file to replace is one Keo made. */
  function placeProblem(i: Placed, kind: CreatedKind): string | null {
    if (i.replace) {
      if (!path.isAbsolute(i.replace)) return 'replace needs the full path of the file, as create__recent lists it.';
      const rec = d.created.get(i.replace);
      if (!rec) return 'Keo replaces only files it made itself (see create__recent). Make a new file instead.';
      if (rec.kind !== kind) return `That file is a ${NOUN[rec.kind]}, not a ${NOUN[kind]}.`;
      if (!fs.existsSync(i.replace)) return 'That file no longer exists. Make a new one instead (omit replace).';
      return null;
    }
    if (i.folder) {
      if (!path.isAbsolute(i.folder)) return 'Give the full path of the folder (like C:\\Users\\you\\Desktop), or omit it for Documents\\Keo.';
      if (!isInside(i.folder, d.outputRoot()) && !d.allowed(i.folder)) return 'That folder is outside the folders Keo may use (Settings → Files). Omit folder to save in Documents\\Keo.';
    }
    return null;
  }

  /** Where the file will go (a free name: never over an existing file unless replacing one Keo made). */
  function plannedPath(i: Placed, kind: CreatedKind, title: string): string {
    if (i.replace) return path.resolve(i.replace);
    const dir = i.folder ? path.resolve(i.folder) : d.outputRoot();
    return uniquePath(dir, safeFileName(i.fileName ?? title, EXT[kind]));
  }

  function checkFolderNamed(i: Placed, ctx: CapabilityContext) {
    if (!i.folder || i.replace || isInside(i.folder, d.outputRoot())) return;
    const texts = ctx.conversationId ? d.userTexts(ctx.conversationId) : [];
    const full = path.resolve(i.folder);
    if (!mentions(texts, full) && !mentions(texts, i.folder.replace(/[\\/]+$/, '')) && !mentions(texts, path.basename(full))) {
      throw fail('folder_not_named', 'Keo saves outside Documents\\Keo only in a folder the user named. Omit folder, or ask the user where to save it. Nothing was saved.');
    }
  }

  async function loadImages(paths: string[]): Promise<Map<string, LoadedImage>> {
    const out = new Map<string, LoadedImage>();
    for (const p of new Set(paths)) {
      const problem = imageProblem(p);
      if (problem) throw fail('bad_image', problem);
      let data: Buffer;
      try {
        const st = fs.statSync(p);
        if (st.size > 15 * 1024 * 1024) throw fail('bad_image', `${path.basename(p)} is larger than 15 MB.`);
        data = fs.readFileSync(p);
      } catch (e) {
        if (e instanceof CapabilityError) throw e;
        throw fail('bad_image', `The picture ${path.basename(p)} was not found. Search for it again with files__search.`);
      }
      const info = imageInfo(data);
      if (!info || !info.width || !info.height) throw fail('bad_image', `${path.basename(p)} is not a PNG, JPEG or GIF picture Keo can read.`);
      out.set(p, { data, info });
    }
    return out;
  }

  function imageProblem(p: string): string | null {
    if (!path.isAbsolute(p)) return `Give the full path of the picture (${p.slice(0, 80)}), e.g. as files__search returned it.`;
    if (!IMAGE_EXT.test(p)) return `${path.basename(p)}: only PNG, JPEG and GIF pictures can be placed.`;
    if (!d.allowed(p) && !isInside(p, d.outputRoot())) return `${path.basename(p)} is outside the folders Keo may use (Settings → Files).`;
    return null;
  }

  type Built = { data: Buffer | string; details: Record<string, unknown> };

  interface MakerConfig<S> {
    id: string;
    kind: CreatedKind;
    title: string;
    description: string;
    spec: z.ZodObject<z.ZodRawShape>;
    titleOf(s: S): string;
    images?(s: S): string[];
    problem?(s: S): string | null;
    consequences(s: S): string[];
    timeoutMs?: number;
    build(s: S, images: Map<string, LoadedImage>, ctx: CapabilityContext): Built | Promise<Built>;
    /** The spec kept for later edits. */
    keep?(s: S): unknown;
  }

  function maker<S extends object>(c: MakerConfig<S>) {
    type I = S & Placed;
    return defineCapability<I, Made>({
      id: c.id,
      version: '1.0.0',
      title: c.title,
      description: `${c.description} Saved in Documents\\Keo unless the user named another folder; an existing file is never overwritten (a free name like “Name (2)” is used). To change a file Keo made, call create__get_spec, edit the spec and call this again with replace. Afterwards tell the user where it is and offer to open it (create__open).`,
      input: c.spec.extend(Place).strict() as unknown as z.ZodType<I>,
      output: Made,
      risk: 'low',
      approval: 'always',
      permissions: [],
      consequential: true,
      idempotent: false,
      timeoutMs: c.timeoutMs ?? 60_000,
      maxAttempts: 1,
      modelVisible: true,
      verificationPolicy: 'The saved file is read back and its size checked.',
      // A new file is routine; replacing one always asks (the old version is backed up).
      autonomy: (i) => (i.replace ? { tier: 'always_ask', reason: 'Replaces a file Keo made earlier (the old version is backed up).' } : { tier: 'routine' }),
      precheck: (i) => placeProblem(i, c.kind) ?? (c.images?.(i) ?? []).map(imageProblem).find(Boolean) ?? c.problem?.(i) ?? null,
      preview: (i) => {
        let target: string | null = null;
        try {
          target = plannedPath(i, c.kind, c.titleOf(i));
        } catch {
          /* reported by precheck / execute */
        }
        return {
          summary: `${i.replace ? 'Replace' : 'Create'} ${NOUN[c.kind]} “${target ? path.basename(target) : c.titleOf(i)}”`,
          target,
          consequences: [...c.consequences(i), i.replace ? 'Replaces the file Keo made earlier; the old version is kept in Keo’s backups.' : 'A new file; nothing existing is changed.'],
          dataExport: null,
        };
      },
      auditView: (i) => ({ kind: c.kind, replace: !!i.replace, inFolder: !!i.folder }),
      async execute(i, ctx) {
        checkFolderNamed(i, ctx);
        const images = await loadImages(c.images?.(i) ?? []);
        ctx.signal.throwIfAborted();
        let built: Built;
        try {
          built = await c.build(i, images, ctx);
        } catch (e) {
          if (e instanceof CapabilityError || ctx.signal.aborted) throw e;
          throw fail('build_failed', (e as Error).message);
        }
        const target = plannedPath(i, c.kind, c.titleOf(i));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (i.replace) {
          const dir = d.backupRoot();
          fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(target, path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')} ${path.basename(target)}`));
        }
        writeAtomic(target, built.data);
        const { fileName: _f, folder: _d, replace: _r, ...spec } = i;
        const kept = c.keep ? c.keep(i) : spec;
        d.created.add({ path: target, kind: c.kind, title: c.titleOf(i), createdAt: new Date().toISOString(), spec: JSON.stringify(kept).length <= MAX_KEPT_SPEC ? kept : null });
        const bytes = typeof built.data === 'string' ? Buffer.byteLength(built.data) : built.data.length;
        return { path: target, fileName: path.basename(target), folder: path.dirname(target), bytes, replaced: !!i.replace, details: built.details, next: 'Tell the user where it is and offer to open it with create__open.' };
      },
      async verify(_i, o) {
        try {
          const size = fs.statSync(o.path).size;
          return size === o.bytes ? { verified: true, detail: `${o.fileName} saved in ${o.folder}.` } : { verified: false, detail: 'The saved file has a different size than what was written.' };
        } catch {
          return { verified: false, detail: 'The file is not there after saving.' };
        }
      },
    });
  }

  const document = maker<DocSpec>({
    id: 'create.document',
    kind: 'document',
    title: 'Make a Word document',
    description:
      'Make a real Word document (.docx): a report, letter, contract template, CV, plan, notes… The title goes at the top; blocks are headings (level 1–3), paragraphs (**bold**, *italic* inside text), bullet or numbered lists, tables (header row + rows), page breaks and pictures from full paths. Write the complete content yourself; for templates use clear placeholders like [Client name].',
    spec: DocSpec,
    titleOf: (s) => s.title,
    images: (s) => s.blocks.flatMap((b) => (b.type === 'image' ? [b.path] : [])),
    consequences: (s) => [`${s.blocks.length} blocks${s.blocks.some((b) => b.type === 'table') ? ', with tables' : ''}${s.blocks.some((b) => b.type === 'image') ? ', with pictures' : ''}.`],
    build: (s, images) => ({
      data: buildDocx(s, images),
      details: { blocks: s.blocks.length, headings: s.blocks.filter((b) => b.type === 'heading').length, tables: s.blocks.filter((b) => b.type === 'table').length, pictures: images.size },
    }),
  });

  const presentation = maker<DeckSpec>({
    id: 'create.presentation',
    kind: 'presentation',
    title: 'Make a PowerPoint presentation',
    description:
      'Make a real PowerPoint deck (.pptx), designed by Keo: a colour theme (or your own accent/background colour), sized text, accent shapes and slide numbers. Layouts: title (first slide), section, bullets (3–6 short bullets), two_column (leftHeading/bullets + rightHeading/right), image (a picture from a full path, with optional bullets), chart (simple column or bar chart of up to 3 series, drawn with shapes), quote, closing. Keep bullets short (under ~12 words); 6–12 slides suit most talks. Write the real content, not placeholders.',
    spec: DeckSpec,
    titleOf: (s) => s.title,
    images: (s) => s.slides.flatMap((sl) => (sl.image ? [sl.image] : [])),
    problem: (s) => s.slides.map((sl, n) => (sl.layout === 'chart' && !sl.chart ? `Slide ${n + 1} is a chart slide without chart data.` : sl.layout === 'image' && !sl.image ? `Slide ${n + 1} is an image slide without an image path.` : null)).find(Boolean) ?? null,
    consequences: (s) => [`${s.slides.length} slides, ${s.theme} theme${s.accent ? ` with accent #${s.accent}` : ''}.`],
    build: (s, images) => ({ data: buildPptx(s, images), details: { slides: s.slides.length, theme: s.theme, charts: s.slides.filter((x) => x.chart).length, pictures: images.size } }),
  });

  const spreadsheet = maker<WorkbookSpec>({
    id: 'create.spreadsheet',
    kind: 'spreadsheet',
    title: 'Make an Excel workbook',
    description:
      'Make a real Excel workbook (.xlsx): budgets, trackers, invoices, schedules, tables of data. Each sheet has columns (header, optional width, format: general, text, integer, number, currency, percent (0.25 = 25%), date ("YYYY-MM-DD")) and rows of values; text starting with "=" is a formula that Excel calculates when the file opens (with columns, data starts on row 2, e.g. "=SUM(C2:C13)"). The header row is styled and frozen; totalsRow makes the last row bold. Formulas that reach outside the workbook (WEBSERVICE, HYPERLINK, DDE…) are refused.',
    spec: WorkbookSpec,
    titleOf: (s) => s.title,
    problem: (s) => {
      if (new Set(s.sheets.map((x) => x.name.toLowerCase())).size !== s.sheets.length) return 'Each sheet needs a different name.';
      const bad = unsafeFormula(s);
      return bad ? `Formulas that reach outside the workbook are not allowed (${bad}).` : null;
    },
    consequences: (s) => [`${s.sheets.length} sheet${s.sheets.length === 1 ? '' : 's'}: ${s.sheets.map((x) => `${x.name} (${x.rows.length} rows)`).join(', ').slice(0, 300)}.`],
    build: (s) => ({
      data: buildXlsx(s),
      details: { sheets: s.sheets.map((x) => x.name), rows: s.sheets.reduce((n, x) => n + x.rows.length, 0), formulas: s.sheets.reduce((n, x) => n + x.rows.flat().filter((v) => typeof v === 'string' && v.startsWith('=')).length, 0) },
    }),
  });

  const webApp = maker<PageSpec>({
    id: 'create.web_app',
    kind: 'web_app',
    title: 'Make a web game or app',
    description:
      'Make a small game or app as ONE self-contained HTML file that opens in the user’s browser: write complete, working code (canvas + JavaScript, inline <style> and <script>), with controls explained on screen (e.g. arrow keys to move, space to boost), a score, game over and restart. For 3D, write a small renderer on <canvas> yourself (perspective projection) — no libraries. No external scripts, styles, fonts, images or network requests of any kind; pictures and sounds must be drawn in code, generated with Web Audio, or data: URLs. Keo refuses pages that load anything remote, and adds a policy that blocks the network.',
    spec: PageSpec,
    titleOf: (s) => s.title,
    problem: (s) => {
      const p = pageProblems(s.html);
      return p.length ? `The page is not self-contained: it has ${p.join('; ')}. Rewrite it with everything inline and no network use.` : null;
    },
    consequences: (s) => [`${Math.round(s.html.length / 1000)} kB of HTML, self-contained; the network is blocked inside the page.`],
    build: (s) => ({ data: withPolicy(s.html, s.title), details: { chars: s.html.length, networkBlocked: true } }),
    keep: (s) => ({ title: s.title }),
  });

  const model3d = maker<ModelSpec>({
    id: 'create.model',
    kind: 'model_3d',
    title: 'Make a 3D-printable model',
    description:
      'Make a 3D-printable STL file (millimetres) from a solid you describe with shapes. Shapes are centred on the origin: cube (size: edge or [x, y, z]), sphere (radius), cylinder (radius, height along Z, optional radiusTop), cone (radius, height along Z, tip at +Z). Any node can have scale, rotate ([x, y, z] degrees, applied in that order) and translate ([x, y, z] mm), applied in that order. Combine with { op: "union" | "difference" | "intersection", children: [...] } (difference = first child minus the others). A node turns about its own centre before it moves; to place parts around the model’s axis (fins, spokes), wrap the moved part in a union with rotate. Example rocket: union of a cylinder body, a cone nose translated up, and three fins, each { op: "union", rotate: [0, 0, 0 | 120 | 240], children: [a thin cube translated out from the axis] }. Keep walls at least 1.2 mm thick and parts overlapping so they fuse. Up to 200 shapes.',
    spec: ModelSpec,
    titleOf: (s) => s.name,
    problem: (s) => {
      const m = measure(s.model);
      if (m.nodes > LIMITS.nodes) return `The model has ${m.nodes} parts; the limit is ${LIMITS.nodes}.`;
      if (m.depth > LIMITS.depth) return `The model is nested ${m.depth} levels deep; the limit is ${LIMITS.depth}.`;
      return null;
    },
    consequences: (s) => [`${measure(s.model).nodes} shapes, built into one solid and saved as binary STL (mm).`],
    timeoutMs: 120_000,
    build: async (s, _images, ctx) => {
      const mesh = await buildModel(s, ctx.signal);
      const mm = (n: number) => Math.round(n * 10) / 10;
      return {
        data: toStl(mesh, s.name),
        details: {
          sizeMm: { x: mm(mesh.size[0]), y: mm(mesh.size[1]), z: mm(mesh.size[2]) },
          triangles: mesh.triangles.length,
          volumeCm3: Math.round(Math.abs(mesh.volume) / 10) / 100,
          note: 'Units are millimetres; most slicers (Cura, PrusaSlicer, Bambu Studio) open STL directly.',
        },
      };
    },
  });

  const OPENABLE = /\.(docx|pptx|xlsx|html|stl)$/i;
  const open = defineCapability({
    id: 'create.open',
    version: '1.0.0',
    title: 'Open a file Keo made',
    description: 'Open a file Keo made (create__…) in its usual app: Word, PowerPoint, Excel, the default browser for a web game/app, or the 3D viewer/slicer for an STL.',
    input: z.object({ path: z.string().trim().min(4).max(500) }).strict(),
    output: z.object({ opened: z.boolean(), path: z.string() }),
    risk: 'low',
    approval: 'always',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 20_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Windows reports whether it opened the file with its default app.',
    // A web page runs its script in the browser (network blocked): a little more than opening a document.
    autonomy: (i) => (/\.html$/i.test(i.path) ? { tier: 'important' } : { tier: 'routine' }),
    precheck: (i) => (!OPENABLE.test(i.path) ? 'Only documents, decks, workbooks, web pages and STL models Keo made can be opened this way.' : !d.created.get(i.path) ? 'Keo opens only files it made here (see create__recent). Use files__open for other files.' : null),
    preview: (i) => ({ summary: `Open ${path.basename(i.path)}`, target: i.path, consequences: [/\.html$/i.test(i.path) ? 'Opens it in your default browser; the page cannot use the network.' : 'Opens it with its usual app. Nothing is changed.'], dataExport: null }),
    auditView: (i) => ({ ext: path.extname(i.path).toLowerCase() }),
    async execute(i) {
      if (!fs.existsSync(i.path)) throw fail('not_found', 'That file no longer exists.');
      const opened = await d.openPath(path.resolve(i.path));
      if (!opened) throw new CapabilityError('open_failed', 'Windows could not open it (there may be no app for this kind of file).', { dispatched: 'unknown' });
      return { opened, path: i.path };
    },
  });

  const recent = defineCapability({
    id: 'create.recent',
    version: '1.0.0',
    title: 'Files Keo made',
    description: 'List the documents, decks, workbooks, web pages and 3D models Keo made recently (newest first), with their paths — to open, change or regenerate one (“the presentation you made yesterday”).',
    input: z.object({ kind: z.enum(['document', 'presentation', 'spreadsheet', 'web_app', 'model_3d']).optional(), limit: z.number().int().min(1).max(50).default(15) }).strict(),
    output: z.object({ files: z.array(z.object({ path: z.string(), kind: z.string(), title: z.string(), createdAt: z.string(), exists: z.boolean() })) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 10_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    preview: () => ({ summary: 'List files Keo made', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ kind: i.kind ?? null }),
    async execute(i) {
      const files = d.created
        .list()
        .filter((f) => !i.kind || f.kind === i.kind)
        .slice(0, i.limit)
        .map((f) => ({ path: f.path, kind: f.kind, title: f.title, createdAt: f.createdAt, exists: fs.existsSync(f.path) }));
      return { files };
    },
  });

  const getSpec = defineCapability({
    id: 'create.get_spec',
    version: '1.0.0',
    title: 'Get the spec of a file Keo made',
    description: 'Get the spec a file Keo made was built from (for a web page, its HTML), so you can change it and call the same create__ tool with replace set to the path — the user approves replacing it, and the old version is backed up.',
    input: z.object({ path: z.string().trim().min(4).max(500) }).strict(),
    output: z.object({ kind: z.string(), title: z.string(), spec: z.unknown(), html: z.string().nullable() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 10_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    precheck: (i) => (d.created.get(i.path) ? null : 'Keo has no spec for that file (it keeps them only for files it made; see create__recent).'),
    preview: (i) => ({ summary: `Read how ${path.basename(i.path)} was made`, target: i.path, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i) {
      const rec = d.created.get(i.path)!;
      let html: string | null = null;
      if (rec.kind === 'web_app') {
        try {
          // Without Keo's own policy line, which is added again on save.
          html = fs.readFileSync(rec.path, 'utf8').replace(/\n?<meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*">/, '');
        } catch {
          throw fail('not_found', 'That page no longer exists.');
        }
      } else if (rec.spec === null) throw fail('no_spec', 'That file was too large for Keo to keep its spec; make a new one instead.');
      return { kind: rec.kind, title: rec.title, spec: rec.spec, html };
    },
  });

  return [document, presentation, spreadsheet, webApp, model3d, open, recent, getSpec];
}
