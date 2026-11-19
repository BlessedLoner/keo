import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BUILD_LIBRARY_IDS, copyLibrary, withImportMap, withNeeds, type BuildLibraryId } from './libraries';
import { goBack, HISTORY_DIR, recordBefore, versions, type BuildVersion } from './history';

/**
 * Keo's builder: websites (with their backend), web apps and games as real projects, each a folder
 * in Documents\Keo\Builds with its pages, scripts, styles and assets. Keo writes and changes the
 * files; the libraries a project uses are copied in from Keo's own install; the project runs in
 * Keo's sandboxed preview and can be put on any host as it is.
 */

export const BuildId = z.string().regex(/^bd_[a-z0-9]{6,24}$/);
export const BuildKind = z.enum(['website', 'app', 'game']);
export type BuildKind = z.infer<typeof BuildKind>;

/** Files Keo writes: text files with a known extension, up to 6 folders deep, never .. or a drive. */
const TEXT_EXT = 'html|css|js|mjs|json|svg|txt|md|sql|glsl|frag|vert|webmanifest|xml|toml|csv';
export const FILE_PATH = new RegExp(`^(?!.*\\.\\.)(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}/){0,6}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\\.(?:${TEXT_EXT})$`);
/** Files Keo manages itself: never written by the model. */
const RESERVED = /^(lib\/|data\/|\.keo-history\/|keo-build\.json$|PUT-IT-ONLINE\.md$|wrangler\.toml$|\.assetsignore$)/;

export const TodoItem = z
  .object({
    /** What the user does, in a few words: "Buy a domain name", "Create a Paystack account". */
    what: z.string().trim().min(3).max(160),
    /** Why, and how (where to click). */
    how: z.string().trim().max(800).default(''),
    /** Only the user can do it (accounts, payments, keys, legal), or Keo can once allowed. */
    who: z.enum(['you', 'keo']).default('you'),
    done: z.boolean().default(false),
  })
  .strict();
export type TodoItem = z.infer<typeof TodoItem>;

export const BuildManifest = z
  .object({
    id: BuildId,
    title: z.string().trim().min(1).max(120),
    kind: BuildKind,
    /** What it is for, in a sentence (Keo's memory of the brief). */
    brief: z.string().max(2000).default(''),
    libraries: z.array(z.enum(BUILD_LIBRARY_IDS as [BuildLibraryId, ...BuildLibraryId[]])).default([]),
    /** Has an API (api/index.js) and a database (api/schema.sql). */
    backend: z.boolean().default(false),
    /** Settings the backend reads (env.NAME), never secrets: those the user adds when going live. */
    vars: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/), z.string().max(400)).default({}),
    todo: z.array(TodoItem).max(40).default([]),
    /** The chat it was made in: asking again there (Retry, continue) carries on with it. */
    conversationId: z.string().max(80).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type BuildManifest = z.infer<typeof BuildManifest>;

export class BuildError extends Error {}

const MAX_FILE = 800_000;
const MAX_FILES = 300;
const MAX_PROJECT = 40 * 1024 * 1024;

export class BuildProjects {
  constructor(
    private readonly d: {
      /** Documents\Keo\Builds. */
      root: () => string;
      /** node_modules of Keo's install (where the libraries are). */
      modules: () => string;
      log: { info: (event: string, data?: Record<string, unknown>) => void };
      /** Told when a project's files change (the preview reloads). */
      changed?: (id: string) => void;
      /**
       * The signed-in account's own folder: its list of builds is kept there, so each account on
       * the PC sees only its own builds (the files stay in Documents\Keo\Builds). Without it
       * (tests), the list is kept beside the builds.
       */
      accountDir?: () => string;
      /** Whether this account may take the list from before builds were kept per account (not when signed out). */
      mayClaim?: () => boolean;
    },
  ) {}

  private indexFile(): string {
    return path.join(this.d.accountDir?.() ?? this.d.root(), 'builds.json');
  }
  private index(): Record<string, string> {
    this.claimShared();
    try {
      return JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  /**
   * One-time: the list of builds from before it was kept per account (Documents\Keo\Builds\builds.json)
   * goes to the first account (or local use) that opens its builds — never to a signed-out Keo —
   * and is then gone from the shared folder, so no other account sees those builds.
   */
  private claimShared(): void {
    if (!this.d.accountDir) return;
    const shared = path.join(this.d.root(), 'builds.json');
    if (!fs.existsSync(shared) || this.d.mayClaim?.() === false) return;
    const mine = this.indexFile();
    try {
      fs.mkdirSync(path.dirname(mine), { recursive: true });
      if (!fs.existsSync(mine)) fs.renameSync(shared, mine);
      else {
        // This account already has its own list: the shared one is added to it.
        const merged = { ...(JSON.parse(fs.readFileSync(shared, 'utf8')) as Record<string, string>), ...(JSON.parse(fs.readFileSync(mine, 'utf8')) as Record<string, string>) };
        fs.writeFileSync(mine, JSON.stringify(merged, null, 1));
        fs.rmSync(shared, { force: true });
      }
      this.d.log.info('build.list_claimed', {});
    } catch {
      /* tried again next time */
    }
  }
  private saveIndex(ix: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.indexFile()), { recursive: true });
    fs.writeFileSync(`${this.indexFile()}.tmp`, JSON.stringify(ix, null, 1));
    fs.renameSync(`${this.indexFile()}.tmp`, this.indexFile());
  }

  /** Takes a build off Keo's list (its folder is handled by the caller: the Recycle Bin). */
  forget(id: string): string {
    const dir = this.dir(id);
    const ix = this.index();
    delete ix[id];
    this.saveIndex(ix);
    this.d.log.info('build.forgotten', {});
    this.d.changed?.(id);
    return dir;
  }

  /** The pages a visitor can open (HTML files, the home page first). */
  pages(id: string): string[] {
    const html = this.files(id)
      .map((f) => f.path)
      .filter((p) => /\.html$/i.test(p) && !p.startsWith('api/'));
    return [...html.filter((p) => p === 'index.html'), ...html.filter((p) => p !== 'index.html')];
  }

  /** The project's folder. */
  dir(id: string): string {
    const folder = this.index()[id];
    if (!folder) throw new BuildError('Keo has no such build. List them with build__list.');
    return path.join(this.d.root(), folder);
  }

  manifest(id: string): BuildManifest {
    try {
      return BuildManifest.parse(JSON.parse(fs.readFileSync(path.join(this.dir(id), 'keo-build.json'), 'utf8')));
    } catch (e) {
      if (e instanceof BuildError) throw e;
      throw new BuildError('That build’s keo-build.json is damaged.');
    }
  }
  private saveManifest(m: BuildManifest): void {
    const file = path.join(this.dir(m.id), 'keo-build.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  list(): BuildManifest[] {
    return Object.keys(this.index())
      .map((id) => {
        try {
          return this.manifest(id);
        } catch {
          return null;
        }
      })
      .filter((m): m is BuildManifest => !!m)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** A new project folder (a free name from the title). */
  /** The build a chat made most recently (within maxAgeMs), to carry on with instead of starting another. */
  forConversation(conversationId: string, maxAgeMs = 24 * 3600_000): BuildManifest | null {
    return this.list().find((m) => m.conversationId === conversationId && Date.now() - Date.parse(m.updatedAt) < maxAgeMs) ?? null;
  }

  create(o: { title: string; kind: BuildKind; brief?: string; libraries?: BuildLibraryId[]; conversationId?: string }): BuildManifest {
    const id = `bd_${crypto.randomBytes(5).toString('hex')}`;
    const base = o.title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'keo-build';
    let folder = base;
    for (let n = 2; fs.existsSync(path.join(this.d.root(), folder)); n++) folder = `${base}-${n}`;
    fs.mkdirSync(path.join(this.d.root(), folder), { recursive: true });
    this.saveIndex({ ...this.index(), [id]: folder });
    const now = new Date().toISOString();
    const m = BuildManifest.parse({ id, title: o.title, kind: o.kind, brief: o.brief ?? '', libraries: [], ...(o.conversationId ? { conversationId: o.conversationId } : {}), createdAt: now, updatedAt: now });
    this.saveManifest(m);
    this.d.log.info('build.created', { kind: o.kind });
    return o.libraries?.length ? this.update(id, { libraries: o.libraries }) : m;
  }

  /** Changes the project's settings; libraries newly listed are copied in. */
  update(id: string, patch: Partial<Pick<BuildManifest, 'title' | 'brief' | 'libraries' | 'backend' | 'vars' | 'todo'>>): BuildManifest {
    const m = this.manifest(id);
    const next = BuildManifest.parse({ ...m, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() });
    // A library brings what it needs (the drive kit: three.js, Rapier, the fonts).
    next.libraries = withNeeds(next.libraries);
    // Libraries newly listed (or missing from the folder) are copied in.
    for (const lib of next.libraries) if (!m.libraries.includes(lib) || !fs.existsSync(path.join(this.dir(id), 'lib', lib))) copyLibrary(lib, this.d.modules(), this.dir(id));
    this.saveManifest(next);
    if (next.backend) this.writeDeployFiles(next);
    this.d.changed?.(id);
    return next;
  }

  /** The file's full path inside the project (refusing anything outside it or Keo's own files). */
  file(id: string, rel: string, o: { writing?: boolean } = {}): string {
    const clean = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!FILE_PATH.test(clean)) throw new BuildError(`“${rel}” is not a file name Keo can write: use folders/name.ext with ${TEXT_EXT.replace(/\|/g, ', ')}.`);
    if (o.writing && RESERVED.test(clean)) throw new BuildError(`${clean} is managed by Keo (libraries, data, settings, the going-online guide). Change the project with build__update instead.`);
    const dir = this.dir(id);
    const full = path.resolve(dir, clean);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new BuildError('That path is outside the project.');
    return full;
  }

  /** Writes (creates or replaces) files; pages get the import map their libraries need. */
  write(id: string, files: Array<{ path: string; content: string }>): { written: string[]; bytes: number } {
    const m = this.manifest(id);
    if (files.length > 40) throw new BuildError('Write up to 40 files at a time.');
    const planned = files.map((f) => {
      if (f.content.length > MAX_FILE) throw new BuildError(`${f.path} is over ${MAX_FILE / 1000} kB: split it into several files.`);
      const full = this.file(id, f.path, { writing: true });
      const content = /\.html$/i.test(full) ? withImportMap(f.content, m.libraries) : f.content;
      return { full, content, rel: path.relative(this.dir(id), full).replace(/\\/g, '/') };
    });
    const existing = this.files(id);
    const count = new Set([...existing.map((f) => f.path), ...planned.map((p) => p.rel)]).size;
    if (count > MAX_FILES) throw new BuildError(`A project can have up to ${MAX_FILES} files of its own.`);
    const size = existing.filter((f) => !planned.some((p) => p.rel === f.path)).reduce((n, f) => n + f.bytes, 0) + planned.reduce((n, p) => n + Buffer.byteLength(p.content), 0);
    if (size > MAX_PROJECT) throw new BuildError('The project would be over 40 MB of its own files.');
    // How these files were, so the change can be undone.
    try {
      recordBefore(this.dir(id), planned.map((p) => p.rel));
    } catch (e) {
      this.d.log.info('build.history_failed', { error: String(e).slice(0, 200) });
    }
    for (const p of planned) {
      fs.mkdirSync(path.dirname(p.full), { recursive: true });
      fs.writeFileSync(`${p.full}.keo-tmp`, p.content);
      fs.renameSync(`${p.full}.keo-tmp`, p.full);
    }
    const written = planned.map((p) => p.rel);
    const backend = written.some((w) => w.startsWith('api/'));
    this.update(id, backend && !m.backend ? { backend: true } : {});
    this.d.log.info('build.written', { files: written.length });
    return { written, bytes: planned.reduce((n, p) => n + Buffer.byteLength(p.content), 0) };
  }

  /**
   * Changes parts of a file: each find must appear exactly once (so the change lands where meant).
   * All or nothing.
   */
  edit(id: string, rel: string, edits: Array<{ find: string; replace: string }>): { path: string; bytes: number } {
    const full = this.file(id, rel, { writing: true });
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      throw new BuildError(`${rel} does not exist yet: write it with build__write.`);
    }
    for (const [k, e] of edits.entries()) {
      const n = e.find ? text.split(e.find).length - 1 : 0;
      if (n !== 1) throw new BuildError(`Change ${k + 1} of ${rel}: the text to find appears ${n} times (it must appear exactly once). Read the file with build__read and copy a longer, unique piece. Nothing was changed.`);
      text = text.replace(e.find, () => e.replace);
    }
    const r = this.write(id, [{ path: rel, content: text }]);
    return { path: r.written[0]!, bytes: r.bytes };
  }

  /**
   * Adds the next part of a long file (written in parts, so each part fits in one reply of the model).
   * The file must have been started with write.
   */
  append(id: string, rel: string, content: string): { path: string; bytes: number } {
    const full = this.file(id, rel, { writing: true });
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      throw new BuildError(`${rel} does not exist yet: write its first part with build__write, then add the rest with build__append.`);
    }
    const r = this.write(id, [{ path: rel, content: text + content }]);
    return { path: r.written[0]!, bytes: Buffer.byteLength(text + content) };
  }

  /** Earlier versions of the build's files, newest first. */
  versions(id: string): BuildVersion[] {
    this.manifest(id);
    return versions(this.dir(id));
  }

  /** Goes back to how the build was before a version (the latest one when none is given). */
  goBack(id: string, version?: number): { version: number; restored: string[]; removed: string[] } {
    this.manifest(id);
    let r: { version: number; restored: string[]; removed: string[] };
    try {
      r = goBack(this.dir(id), version);
    } catch (e) {
      throw new BuildError(e instanceof Error ? e.message : String(e));
    }
    this.d.log.info('build.went_back', { version: r.version, restored: r.restored.length, removed: r.removed.length });
    this.d.changed?.(id);
    return r;
  }

  /** The project's own files (not the copied libraries or the preview data). */
  files(id: string): Array<{ path: string; bytes: number }> {
    const dir = this.dir(id);
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        if (e.isDirectory()) {
          if (rel === 'lib' || rel === 'data' || rel === 'node_modules' || rel === HISTORY_DIR) continue;
          walk(full);
        } else if (!e.name.endsWith('.keo-tmp')) out.push({ path: rel, bytes: fs.statSync(full).size });
      }
    };
    walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(id: string, rel: string): string {
    const full = this.file(id, rel);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch {
      throw new BuildError(`${rel} does not exist.`);
    }
  }

  /** A picture (or other binary file) saved into the project, e.g. an AI picture for the hero. */
  writeBinary(id: string, rel: string, bytes: Buffer): string {
    const clean = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!/^(?!.*\.\.)(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\/){0,6}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\.(png|jpe?g|webp|gif|mp3|wav|ogg|glb|woff2|json)$/.test(clean) || RESERVED.test(clean)) throw new BuildError(`“${rel}” is not a picture, sound, model or font path Keo can save.`);
    const full = path.resolve(this.dir(id), clean);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    this.update(id, {});
    return clean;
  }

  /**
   * Going online: a Cloudflare Workers setup (the site's files as static assets, api/index.js as the
   * Worker, a D1 database from api/schema.sql) and a step-by-step guide with the user's to-do list.
   */
  private writeDeployFiles(m: BuildManifest): void {
    const dir = this.dir(m.id);
    const name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'keo-site';
    const vars = Object.entries(m.vars);
    fs.writeFileSync(
      path.join(dir, 'wrangler.toml'),
      [
        '# Made by Keo: puts this site online on Cloudflare (free plan is enough to start).',
        `name = "${name}"`,
        'main = "api/index.js"',
        'compatibility_date = "2026-10-01"',
        '',
        '[assets]',
        'directory = "."',
        'run_worker_first = ["/api/*"]',
        '',
        '[[d1_databases]]',
        'binding = "DB"',
        `database_name = "${name}-db"`,
        'database_id = "PASTE-THE-ID-FROM-STEP-3"',
        ...(vars.length ? ['', '[vars]', ...vars.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)] : []),
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, '.assetsignore'), ['api', 'data', HISTORY_DIR, 'wrangler.toml', 'keo-build.json', 'PUT-IT-ONLINE.md', '.assetsignore', ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'PUT-IT-ONLINE.md'), onlineGuide(m, name));
  }
}

/** The guide for putting the site online, with what only the user can do. */
export function onlineGuide(m: BuildManifest, name: string): string {
  const yours = m.todo.filter((t) => t.who === 'you' && !t.done);
  return [
    `# Put “${m.title}” online`,
    '',
    'Keo built and tested this site on your PC. Going online needs your own accounts, so these steps are yours.',
    '',
    '## 1. Install the Cloudflare tool (once)',
    '1. Make a free account at cloudflare.com.',
    '2. Open a terminal in this folder and run: `npx wrangler login` (a browser opens: click Allow).',
    '',
    '## 2. Make the database',
    `Run: \`npx wrangler d1 create ${name}-db\`, and copy the \`database_id\` it prints.`,
    '',
    '## 3. Connect it',
    'Open `wrangler.toml` in Notepad and replace `PASTE-THE-ID-FROM-STEP-3` with that id. Save.',
    '',
    '## 4. Create the tables',
    `Run: \`npx wrangler d1 execute ${name}-db --remote --file=api/schema.sql\``,
    '',
    '## 5. Put it online',
    'Run: `npx wrangler deploy`. It prints your site’s address (…workers.dev). Open it and check it works.',
    '',
    ...(yours.length ? ['## What only you can do', ...yours.map((t, i) => `${i + 1}. **${t.what}**${t.how ? ` — ${t.how}` : ''}`), ''] : []),
    'Secrets (payment keys, email passwords) never go in these files: add each with `npx wrangler secret put NAME`.',
    '',
  ].join('\n');
}
