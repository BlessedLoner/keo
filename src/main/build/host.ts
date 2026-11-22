import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session, type Session } from 'electron';
import { BuildError, type BuildProjects } from './projects';
import { libraryAlias } from './libraries';
import { RUNNER_HTML } from './runner';
import { OPENS, actionLabel, actionScript, type CheckAction } from './checkActions';

/**
 * Where Keo's builds run: the preview window and the backend sandbox.
 *
 * - A build's pages are served at keobuild://<build id>/… in their own browser session: no Node.js,
 *   no Keo pages or data, no network (only the build's own files), no permissions except fullscreen
 *   and pointer lock for games.
 * - Its API (api/index.js) runs in a second, hidden sandboxed page (keoapi://<build id>/), reached
 *   only through requests to /api/… of the preview; its database is a file in the build's data/.
 */
export const BUILD_SCHEMES = [
  { scheme: 'keobuild', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'keoapi', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
] as const;

/** The sessions build pages run in (the preview the user sees, and Keo's checks). */
export const BUILD_PARTITIONS = ['persist:keo-build', 'keo-build-check'] as const;

/**
 * Keo blocks every window from leaving Keo's own pages; a build's pages linking to each other is the
 * one exception, and only in the build sessions (never Keo's own windows).
 */
export function isBuildPageNavigation(ses: Session, url: string, partitionSession: (p: string) => Session = (p) => session.fromPartition(p)): boolean {
  if (!/^keobuild:\/\/bd_[a-z0-9]{6,24}\//i.test(url)) return false;
  return BUILD_PARTITIONS.some((p) => partitionSession(p) === ses);
}

const PAGE_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.glsl': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
};

export interface BuildCheck {
  page: string;
  title: string;
  /** Errors in the page or its API (what Keo must fix). */
  errors: string[];
  warnings: string[];
  /** Files the page asked for that are not in the project. */
  missing: string[];
  /** What the page shows, as text (start of it). */
  text: string;
  /** A picture of the page after it ran for a moment (and after the actions, when there were any). */
  screenshot: Buffer | null;
  /** What each action did, in order ("click “Play”: clicked play"). */
  steps: string[];
}

interface Runner {
  win: BrowserWindow;
  stamp: number;
  ready: Promise<void>;
  queue: Promise<unknown>;
}

export class BuildHost {
  private previewSession: Session | null = null;
  private checkSession: Session | null = null;
  private apiSession: Session | null = null;
  private readonly previews = new Map<string, BrowserWindow>();
  private readonly runners = new Map<string, Runner>();
  /** What each build's pages and API said lately (errors and warnings), and files they missed. */
  private readonly logs = new Map<string, { errors: string[]; warnings: string[]; missing: Set<string> }>();
  private reloadTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly d: {
      projects: () => BuildProjects;
      /** node_modules of Keo's install (sql.js for the backend). */
      modules: () => string;
      log: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
      icon?: string;
    },
  ) {}

  private logOf(id: string) {
    let l = this.logs.get(id);
    if (!l) this.logs.set(id, (l = { errors: [], warnings: [], missing: new Set() }));
    return l;
  }
  private note(id: string, kind: 'errors' | 'warnings', text: string): void {
    // The browser's words for a blocked internet request, said plainly (once per address).
    const blocked = /(?:Connecting to|load|Refused to load the \w+) '?(https?:\/\/[^'"\s]+)/i.exec(text);
    if (blocked && /Content Security Policy/i.test(text)) {
      const url = blocked[1]!.slice(0, 120);
      text = `Blocked: the page tried to reach ${url}. Built pages never use the internet: put the file in the project (or make it with build__picture / SVG / code), use a library from Keo, or call the build’s own /api/.`;
      if (this.logOf(id)[kind].includes(text)) return;
    }
    const l = this.logOf(id)[kind];
    l.push(text.slice(0, 600));
    if (l.length > 40) l.splice(0, l.length - 40);
  }

  // ---------------------------------------------------------------- sessions

  private preview(): Session {
    if (this.previewSession) return this.previewSession;
    const ses = session.fromPartition('persist:keo-build');
    ses.protocol.handle('keobuild', (req) => this.servePage(req));
    this.lockDown(ses, 'keobuild:', ['fullscreen', 'pointerLock']);
    this.previewSession = ses;
    return ses;
  }

  /**
   * Keo's checks get their own session, wiped before each check: every check is a new visitor (an
   * empty cart, no saved login), and what Keo clicks while checking never shows up in the user's preview.
   */
  private checker(): Session {
    if (this.checkSession) return this.checkSession;
    const ses = session.fromPartition('keo-build-check');
    ses.protocol.handle('keobuild', (req) => this.servePage(req));
    this.lockDown(ses, 'keobuild:', ['fullscreen', 'pointerLock']);
    this.checkSession = ses;
    return ses;
  }

  private api(): Session {
    if (this.apiSession) return this.apiSession;
    const ses = session.fromPartition('keo-build-api');
    ses.protocol.handle('keoapi', (req) => this.serveRunner(req));
    this.lockDown(ses, 'keoapi:', []);
    this.apiSession = ses;
    return ses;
  }

  /** Only the build's own scheme (and data:/blob:) loads; no permissions but the ones named. */
  private lockDown(ses: Session, scheme: string, allowed: string[]): void {
    ses.webRequest.onBeforeRequest((details, cb) => {
      const u = details.url;
      const ok = u.startsWith(scheme) || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('devtools:');
      cb({ cancel: !ok });
    });
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.includes(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------- serving

  private async servePage(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.host;
    let dir: string;
    try {
      dir = this.d.projects().dir(id);
    } catch {
      return new Response('No such build', { status: 404 });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return this.apiRequest(id, req);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    // A library asked for by its usual npm path is served from Keo's copy.
    if (!fs.existsSync(path.resolve(dir, rel))) rel = libraryAlias(rel) ?? rel;
    let file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return new Response('Forbidden', { status: 403 });
    // Pretty addresses: /about → about.html or about/index.html.
    if (!fs.existsSync(file) && !path.extname(file)) file = fs.existsSync(`${file}.html`) ? `${file}.html` : path.join(file, 'index.html');
    // Keo's own files are not served.
    const relClean = path.relative(dir, file).replace(/\\/g, '/');
    if (/^(data\/|api\/|keo-build\.json$|wrangler\.toml$|\.assetsignore$)/.test(relClean)) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: {
          'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': PAGE_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'cross-origin-opener-policy': 'same-origin',
        },
      });
    } catch {
      if (!/favicon\.ico$/.test(relClean)) this.logOf(id).missing.add(relClean);
      return new Response(`Not found: ${relClean}`, { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  }

  private async serveRunner(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.host;
    const headers = { 'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:", 'cache-control': 'no-store' };
    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(RUNNER_HTML, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
    const kit = /^\/_keo\/(sql-wasm\.js|sql-wasm\.wasm)$/.exec(url.pathname);
    if (kit) {
      const file = path.join(this.d.modules(), 'sql.js', 'dist', kit[1]!);
      return new Response(await fs.promises.readFile(file), { headers: { ...headers, 'content-type': kit[1]!.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
    }
    // Only the build's api/ files.
    const m = /^\/api\/([A-Za-z0-9_./-]{1,200}\.m?js)$/.exec(url.pathname);
    if (!m || m[1]!.includes('..')) return new Response('Not found', { status: 404 });
    try {
      const file = path.resolve(this.d.projects().dir(id), 'api', m[1]!);
      return new Response(await fs.promises.readFile(file), { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  // ---------------------------------------------------------------- the backend

  private apiStamp(id: string): number {
    const dir = path.join(this.d.projects().dir(id), 'api');
    let max = 0;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else max = Math.max(max, fs.statSync(full).mtimeMs);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return max;
  }

  private dbFile(id: string): string {
    return path.join(this.d.projects().dir(id), 'data', 'preview.sqlite');
  }

  /** The build's API page, started (again when its files changed), with its database loaded. */
  private runner(id: string): Runner {
    const stamp = this.apiStamp(id);
    const have = this.runners.get(id);
    if (have && have.stamp === stamp && !have.win.isDestroyed()) return have;
    if (have && !have.win.isDestroyed()) have.win.destroy();
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'keo-build-api', devTools: false, backgroundThrottling: false },
    });
    this.api();
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') this.note(id, 'errors', `API: ${e.message}`);
      else if (e.level === 'warning') this.note(id, 'warnings', `API: ${e.message}`);
    });
    const ready = (async () => {
      await win.loadURL(`keoapi://${id}/`);
      for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.__keoReady')); i++) await new Promise((r) => setTimeout(r, 50));
      const m = this.d.projects().manifest(id);
      let dbB64: string | null;
      try {
        dbB64 = fs.readFileSync(this.dbFile(id)).toString('base64');
      } catch {
        dbB64 = null;
      }
      let schema: string;
      try {
        schema = this.d.projects().read(id, 'api/schema.sql');
      } catch {
        schema = '';
      }
      const r = (await win.webContents.executeJavaScript(`window.__keo.start(${JSON.stringify(dbB64)}, ${JSON.stringify(schema)}, ${JSON.stringify(m.vars)})`)) as { fresh: boolean; db: string | null };
      if (r.db) this.saveDb(id, r.db);
    })();
    const runner: Runner = { win, stamp, ready, queue: Promise.resolve() };
    ready.catch((e: unknown) => this.note(id, 'errors', `API did not start: ${e instanceof Error ? e.message : String(e)}`));
    this.runners.set(id, runner);
    return runner;
  }

  private saveDb(id: string, b64: string): void {
    const file = this.dbFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, Buffer.from(b64, 'base64'));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** A request to the build's /api/…, answered by its API in the sandbox (one at a time). */
  private async apiRequest(id: string, req: Request): Promise<Response> {
    let m;
    try {
      m = this.d.projects().manifest(id);
    } catch {
      return new Response('No such build', { status: 404 });
    }
    if (!m.backend || !fs.existsSync(path.join(this.d.projects().dir(id), 'api', 'index.js'))) return new Response(JSON.stringify({ error: 'This build has no API yet (api/index.js).' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : Buffer.from(await req.arrayBuffer());
    if (body && body.length > 10 * 1024 * 1024) return new Response('Too large', { status: 413 });
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const r = this.runner(id);
    const run = r.queue.then(async () => {
      await r.ready;
      const out = (await Promise.race([
        r.win.webContents.executeJavaScript(`window.__keo.handle(${JSON.stringify({ method: req.method, url: `http://localhost${url.pathname}${url.search}`, headers, body: body ? body.toString('base64') : null })})`),
        new Promise((_, no) => setTimeout(() => no(new Error('The API took longer than 20 seconds.')), 20_000)),
      ])) as { status: number; headers: Record<string, string>; body: string; db: string | null; error?: string };
      if (out.db) this.saveDb(id, out.db);
      if (out.error) this.note(id, 'errors', out.error);
      return new Response(out.status === 204 || out.status === 304 ? null : Buffer.from(out.body, 'base64'), { status: out.status, headers: out.headers });
    });
    r.queue = run.catch(() => undefined);
    try {
      return await run;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      this.note(id, 'errors', `API: ${text}`);
      return new Response(`The API failed: ${text}`, { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  }

  // ---------------------------------------------------------------- preview and checks

  private page(id: string, page = ''): string {
    const p = page.replace(/\\/g, '/').replace(/^\/+/, '');
    if (p.includes('..')) throw new BuildError('That page is outside the build.');
    return `keobuild://${id}/${p}`;
  }

  private watch(id: string, win: BrowserWindow): void {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') this.note(id, 'errors', `${e.message}${e.lineNumber ? ` (${String(e.sourceId).replace(`keobuild://${id}/`, '')}:${e.lineNumber})` : ''}`);
      else if (e.level === 'warning') this.note(id, 'warnings', e.message);
    });
    win.webContents.on('render-process-gone', (_e, details) => this.note(id, 'errors', `The page crashed (${details.reason}).`));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(`keobuild://${id}/`)) e.preventDefault();
    });
  }

  /** Opens (or brings back) the build in Keo's preview window; it reloads as Keo changes files. */
  async open(id: string, page = ''): Promise<void> {
    this.d.projects().manifest(id);
    // Fixes in Keo's own libraries (the driving kit, the scene kit) reach games made before them.
    this.d.projects().refreshLibraries(id);
    this.preview();
    let win = this.previews.get(id);
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 1280,
        height: 820,
        title: `${this.d.projects().manifest(id).title} — Keo preview`,
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        ...(this.d.icon ? { icon: this.d.icon } : {}),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:keo-build', backgroundThrottling: false },
      });
      this.watch(id, win);
      win.on('closed', () => this.previews.delete(id));
      this.previews.set(id, win);
    }
    await win.loadURL(this.page(id, page));
    win.show();
    win.focus();
  }

  /** Keo changed files: an open preview reloads (once, a moment after the last change). */
  changed(id: string): void {
    const win = this.previews.get(id);
    if (!win || win.isDestroyed()) return;
    clearTimeout(this.reloadTimers.get(id));
    this.reloadTimers.set(
      id,
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 400),
    );
  }

  /**
   * Loads a page in a hidden window like a visitor would, lets it run a few seconds, and reports
   * its errors, missing files, text and a screenshot: how Keo checks its own work.
   */
  async check(id: string, page = '', o: { waitMs?: number; width?: number; height?: number; shotWidth?: number; actions?: CheckAction[] } = {}): Promise<BuildCheck> {
    this.d.projects().manifest(id);
    this.d.projects().refreshLibraries(id);
    this.preview();
    await this.checker()
      .clearStorageData()
      .catch(() => undefined);
    this.logs.set(id, { errors: [], warnings: [], missing: new Set() });
    const win = new BrowserWindow({
      show: false,
      width: o.width ?? 1280,
      height: o.height ?? 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'keo-build-check', offscreen: false, backgroundThrottling: false },
    });
    this.watch(id, win);
    try {
      await win.loadURL(this.page(id, page)).catch((e: unknown) => this.note(id, 'errors', `The page did not load: ${e instanceof Error ? e.message : String(e)}`));
      await new Promise((r) => setTimeout(r, o.waitMs ?? 2500));
      // Using the page like a visitor: each action runs in the page, then it gets a moment to react.
      const steps: string[] = [];
      for (const a of o.actions ?? []) {
        if (win.isDestroyed()) break;
        const { script, settleMs } = actionScript(a);
        let did = 'done';
        if (script) {
          did = await Promise.race([
            win.webContents.executeJavaScript(script, true).then((v: unknown) => String(v ?? 'done')),
            // A long key hold takes as long as it is held.
            new Promise<string>((r) => setTimeout(() => r('no answer from the page (it may be frozen)'), 12_000 + (a.do === 'keys' ? a.holdSeconds * 1000 : 0))),
          ]).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
        // A link was clicked: the page it points to must really open (a link that goes nowhere is a bug).
        const opens = did.indexOf(OPENS);
        if (opens >= 0) {
          const want = did.slice(opens + OPENS.length, did.lastIndexOf(']')).split('#')[0]!;
          did = did.slice(0, opens).trimEnd();
          const at = () => (win.isDestroyed() ? want : win.webContents.getURL().split('#')[0]!);
          for (let t = 0; t < 10 && at() !== want; t++) await new Promise((r) => setTimeout(r, 250));
          const short = (u: string) => u.replace(`keobuild://${id}/`, '/');
          did += at() === want ? ` → opened ${short(want)}` : ` → the link did not open ${short(want)} (still on ${short(at())})`;
        }
        steps.push(`${actionLabel(a)}${a.do === 'measure' ? ' → ' : ': '}${did}`.slice(0, 700));
      }
      const title = win.isDestroyed() ? '' : win.webContents.getTitle();
      const text = win.isDestroyed() ? '' : String(await win.webContents.executeJavaScript('(document.body && document.body.innerText || "").slice(0, 1500)').catch(() => ''));
      const shot = win.isDestroyed() ? null : await win.webContents.capturePage().then((img) => img.resize({ width: o.shotWidth ?? 960 }).toPNG()).catch(() => null);
      const l = this.logOf(id);
      return { page: page || 'index.html', title, errors: [...l.errors], warnings: [...l.warnings].slice(-12), missing: [...l.missing], text, screenshot: shot, steps };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  /** Closes everything (Keo is quitting). */
  close(): void {
    for (const w of [...this.previews.values(), ...[...this.runners.values()].map((r) => r.win)]) if (!w.isDestroyed()) w.destroy();
  }
}
