import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { CdpError, CdpPipe } from './cdp';
import { PAGE_SCRIPT } from './pageScript';

/** One element as the last read of its page described it (used for approvals and re-checks). */
export interface WebElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type: string | null;
  id: string | null;
  href: string | null;
  submits: boolean;
  inForm: boolean;
  editable: boolean;
  secret: 'password' | 'payment' | null;
  multiline: boolean;
}

export interface WebTab {
  tab: string;
  url: string;
  title: string;
  current: boolean;
}

export interface WebSnapshot {
  tab: string;
  url: string;
  title: string;
  text: string;
  elements: number;
  focused: string | null;
  truncated: boolean;
  dialog: string | null;
}

export interface BrowserChoice {
  exe: string;
  label: string;
}

export interface KeoBrowserOptions {
  /** Keo's own profile folder for this window (never the user's normal browser profile). */
  profileDir: () => string;
  /** Chrome or Edge, whichever the user chose or is installed; null = neither. */
  pick: () => BrowserChoice | null;
  /** Tests run it without a window. */
  headless?: boolean;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** A browser-side failure, with whether anything may have happened on the page. */
export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly dispatched: 'no' | 'yes' | 'unknown' = 'no',
  ) {
    super(message);
  }
}

interface Page {
  targetId: string;
  sessionId: string | null;
  url: string;
  title: string;
  docTag: string;
  ctx: number | null;
  items: Map<string, WebElement>;
  dialog: string | null;
  opener: string | null;
}

/** The arguments Keo starts the browser with: a pipe for control, never a debugging port. */
export function launchArgs(profileDir: string, headless: boolean): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-breakpad',
    ...(headless ? ['--headless=new', '--window-size=1280,900'] : []),
    'about:blank',
  ];
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
for (let n = 1; n <= 12; n++) KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n };
const MODS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, win: 4, shift: 8 };

/** "ctrl+shift+v" → the key and its modifier bits; null when not a key Keo knows. */
export function parseCombo(combo: string): { mods: number; key: { key: string; code: string; vk: number; text?: string } } | null {
  const parts = combo.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (!parts.length) return null;
  let mods = 0;
  for (const p of parts.slice(0, -1)) {
    if (!(p in MODS)) return null;
    mods |= MODS[p]!;
  }
  const last = parts[parts.length - 1]!;
  let key = KEYS[last];
  if (!key && /^[a-z0-9]$/.test(last)) {
    const up = last.toUpperCase();
    key = { key: mods & 8 ? up : last, code: /\d/.test(last) ? `Digit${last}` : `Key${up}`, vk: up.charCodeAt(0), text: mods & 8 ? up : last };
  }
  if (!key) return null;
  return { mods, key };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keo's own browser window: Chrome or Edge with a profile folder inside Keo's data, controlled
 * through the browser's DevTools pipe. The user signs in to sites in this window themselves;
 * it never shares cookies or saved passwords with their normal browser.
 */
export class KeoBrowser {
  private proc: ChildProcess | null = null;
  private cdp: CdpPipe | null = null;
  private starting: Promise<void> | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly byTag = new Map<string, Page>();
  private current: string | null = null;
  private docs = 0;
  private label = '';
  /** Newly opened tabs, so an action can report (and move to) a tab it opened. */
  private opened: string[] = [];
  private chooser: ((backendNodeId: number) => void) | null = null;
  /** The command line used for the last launch (checked by tests: no debugging port). */
  lastArgs: string[] = [];

  constructor(private readonly o: KeoBrowserOptions) {}

  running(): boolean {
    return !!this.cdp && !this.cdp.closed;
  }

  browserLabel(): string {
    return this.label;
  }

  pid(): number | null {
    return this.proc?.pid ?? null;
  }

  private async start(): Promise<void> {
    const pick = this.o.pick();
    if (!pick) throw new WebError('no_browser', 'Neither Google Chrome nor Microsoft Edge is installed, so Keo cannot open its browser window.');
    const dir = this.o.profileDir();
    fs.mkdirSync(dir, { recursive: true });
    this.lastArgs = launchArgs(dir, !!this.o.headless);
    const proc = spawn(pick.exe, this.lastArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: false });
    // The last of the browser's own error output, for the log when it fails to start.
    let stderr = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (s: string) => (stderr = (stderr + s).slice(-1500)));
    const cdp = new CdpPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
    proc.on('exit', () => cdp.close());
    proc.on('error', () => cdp.close());
    cdp.onClose(() => {
      if (this.cdp === cdp) this.reset();
    });
    cdp.on((method, params, sessionId) => this.event(method, params, sessionId));
    this.proc = proc;
    this.cdp = cdp;
    this.label = pick.label;
    try {
      await withTimeout(cdp.send('Browser.getVersion'), 25000, 'did not answer');
    } catch {
      this.o.log?.('web.browser_start_failed', { browser: pick.label, exited: proc.exitCode, stderr: stderr.slice(-600) });
      this.reset();
      proc.kill();
      throw new WebError(
        'browser_start_failed',
        `${pick.label} did not start for Keo. If Keo's browser window is still open from before, close it and try again.`,
      );
    }
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') this.addPage(t.targetId, t.url, t.title, null);
    if (!this.pages.size) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      this.addPage(targetId, 'about:blank', '', null);
    }
    this.current = [...this.pages.keys()][0] ?? null;
    this.opened = [];
    this.o.log?.('web.browser_started', { browser: pick.label, headless: !!this.o.headless });
  }

  private reset(): void {
    this.cdp = null;
    this.proc = null;
    this.pages.clear();
    this.byTag.clear();
    this.current = null;
    this.chooser = null;
  }

  private async ensure(): Promise<CdpPipe> {
    if (this.running()) return this.cdp!;
    // A browser's very first start in a new profile sometimes does not answer: one more try.
    if (!this.starting)
      this.starting = this.start()
        .catch((e: unknown) => {
          if (e instanceof WebError && e.code === 'browser_start_failed') return this.start();
          throw e;
        })
        .finally(() => (this.starting = null));
    await this.starting;
    if (!this.cdp) throw new WebError('browser_closed', 'Keo’s browser window closed.');
    return this.cdp;
  }

  private newTag(page: Page): void {
    this.byTag.delete(page.docTag);
    page.docTag = `p${++this.docs}`;
    page.ctx = null;
    page.items.clear();
    this.byTag.set(page.docTag, page);
  }

  private addPage(targetId: string, url: string, title: string, opener: string | null): Page {
    const existing = this.pages.get(targetId);
    if (existing) return existing;
    const p: Page = { targetId, sessionId: null, url, title, docTag: '', ctx: null, items: new Map(), dialog: null, opener };
    this.newTag(p);
    this.pages.set(targetId, p);
    return p;
  }

  private event(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    const info = params.targetInfo as { targetId: string; type: string; url: string; title: string; openerId?: string } | undefined;
    if (method === 'Target.targetCreated' && info?.type === 'page') {
      this.addPage(info.targetId, info.url, info.title, info.openerId ?? null);
      this.opened.push(info.targetId);
    } else if (method === 'Target.targetInfoChanged' && info?.type === 'page') {
      const p = this.pages.get(info.targetId);
      if (p) Object.assign(p, { url: info.url, title: info.title });
    } else if (method === 'Target.targetDestroyed') {
      const p = this.pages.get(params.targetId as string);
      if (p) {
        this.byTag.delete(p.docTag);
        this.pages.delete(p.targetId);
        if (this.current === p.targetId) this.current = [...this.pages.keys()].pop() ?? null;
      }
    } else if (sessionId) {
      const p = [...this.pages.values()].find((x) => x.sessionId === sessionId);
      if (!p) return;
      if (method === 'Page.frameNavigated') {
        const frame = params.frame as { parentId?: string; url: string };
        if (!frame.parentId) {
          this.newTag(p);
          p.url = frame.url;
        }
      } else if (method === 'Page.javascriptDialogOpening') {
        p.dialog = `${String(params.type)}: ${String(params.message ?? '').slice(0, 300)}`;
      } else if (method === 'Page.javascriptDialogClosed') {
        p.dialog = null;
      } else if (method === 'Page.fileChooserOpened') {
        this.chooser?.(params.backendNodeId as number);
      }
    }
  }

  private async attach(p: Page): Promise<string> {
    const cdp = await this.ensure();
    if (p.sessionId) return p.sessionId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: p.targetId, flatten: true });
    p.sessionId = sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    return sessionId;
  }

  /** Only web.open starts the window; everything else needs it open already. */
  private need(): CdpPipe {
    if (!this.running()) throw new WebError('not_open', 'Keo’s browser window is not open. Use web__open first.');
    return this.cdp!;
  }

  private async page(tab?: string): Promise<Page> {
    if (this.starting) await this.starting;
    this.need();
    const id = tab ?? this.current;
    const p = id ? this.pages.get(id) : undefined;
    if (!p) throw new WebError('no_tab', tab ? 'That tab is closed. Call web__tabs to see the open tabs.' : 'Keo’s browser window has no open tab. Use web__open first.');
    await this.attach(p);
    return p;
  }

  /** The page an element ref belongs to (refs are tied to one document of one tab). */
  private pageForRef(ref: string): Page {
    this.need();
    const tag = /^(p\d+)e\d+$/.exec(ref)?.[1];
    const p = tag ? this.byTag.get(tag) : undefined;
    if (!p) throw new WebError('stale_ref', `${ref} is from a page that has changed or closed. Read the page again (web__read) and use the new refs.`);
    return p;
  }

  private async world(p: Page): Promise<number> {
    if (p.ctx) return p.ctx;
    const cdp = await this.ensure();
    const sid = await this.attach(p);
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sid);
    const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'keo', grantUniveralAccess: false }, sid);
    p.ctx = executionContextId;
    return executionContextId;
  }

  /** Calls the page script in Keo's isolated world of the page. */
  private async call<T>(p: Page, fn: string, args: unknown[], returnObject = false): Promise<T> {
    const cdp = await this.ensure();
    const tagNow = p.docTag;
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.world(p);
      const expression = `(globalThis.__keo || (globalThis.__keo = (${PAGE_SCRIPT})(${JSON.stringify(p.docTag)}))).${fn}(...${JSON.stringify(args)})`;
      try {
        const r = await withTimeout(
          cdp.send<{ result: { value?: unknown; objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
            'Runtime.evaluate',
            { expression, contextId, returnByValue: !returnObject, awaitPromise: true },
            p.sessionId!,
          ),
          20000,
          'page_busy',
        );
        if (r.exceptionDetails) throw new WebError('page_script_failed', `The page did not respond as expected (${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '').split('\n')[0]?.slice(0, 160)}).`);
        return (returnObject ? r.result.objectId : r.result.value) as T;
      } catch (e) {
        if (e instanceof CdpError && /context/i.test(e.message)) {
          // The document changed under us: refs from before are gone.
          if (p.docTag === tagNow) this.newTag(p);
          if (args.some((a) => typeof a === 'string' && /^p\d+e\d+$/.test(a))) throw new WebError('stale_ref', 'The page changed. Read it again (web__read) and use the new refs.');
          continue;
        }
        if (e instanceof Error && e.message === 'page_busy') throw new WebError('page_busy', p.dialog ? `The page shows a dialog (${p.dialog}). Ask the user to answer it in Keo’s browser window.` : 'The page is not responding (it may be busy or showing a dialog).', 'unknown');
        throw e;
      }
    }
    throw new WebError('page_changed', 'The page kept changing. Try again.');
  }

  /** What the last read said about an element (for approval cards); null if unknown or stale. */
  element(ref: string): WebElement | null {
    const tag = /^(p\d+)e\d+$/.exec(ref)?.[1];
    const p = tag ? this.byTag.get(tag) : undefined;
    return p?.items.get(ref) ?? null;
  }

  /** The site of the tab an element is on (or of the current tab). */
  siteOf(ref?: string): { origin: string; host: string; title: string } | null {
    const tag = ref ? /^(p\d+)e\d+$/.exec(ref)?.[1] : undefined;
    const p = tag ? this.byTag.get(tag) : this.current ? this.pages.get(this.current) : undefined;
    if (!p) return null;
    try {
      const u = new URL(p.url);
      return { origin: u.origin, host: u.host || u.protocol.replace(':', ''), title: p.title };
    } catch {
      return null;
    }
  }

  async tabs(): Promise<WebTab[]> {
    if (!this.running()) return [];
    const { targetInfos } = await this.cdp!.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>('Target.getTargets');
    for (const t of targetInfos) {
      const p = this.pages.get(t.targetId);
      if (p) Object.assign(p, { url: t.url, title: t.title });
    }
    return [...this.pages.values()].map((p) => ({ tab: p.targetId, url: p.url, title: p.title, current: p.targetId === this.current }));
  }

  async switchTab(tab: string): Promise<WebTab> {
    const p = await this.page(tab);
    this.current = p.targetId;
    await this.cdp!.send('Page.bringToFront', {}, p.sessionId!);
    return { tab: p.targetId, url: p.url, title: p.title, current: true };
  }

  private async waitReady(p: Page, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = await this.call<{ ready: string }>(p, 'page', []).catch(() => null);
      if (s?.ready === 'complete') return;
      await sleep(200);
    }
  }

  async open(url: string, newTab: boolean): Promise<{ tab: string; url: string; title: string; status: 'loaded' | 'still_loading' }> {
    const cdp = await this.ensure();
    let p: Page;
    if (newTab) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      p = this.addPage(targetId, 'about:blank', '', null);
      this.opened = this.opened.filter((t) => t !== targetId);
    } else p = await this.page();
    const sid = await this.attach(p);
    this.current = p.targetId;
    if (!this.o.headless) await cdp.send('Page.bringToFront', {}, sid).catch(() => undefined);
    const r = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sid);
    if (r.errorText) throw new WebError('navigation_failed', `The page could not be opened (${r.errorText}).`, 'yes');
    const until = Date.now() + 20000;
    let ready = '';
    while (Date.now() < until) {
      const s = await this.call<{ url: string; title: string; ready: string }>(p, 'page', []).catch(() => null);
      if (s && s.url !== 'about:blank') {
        p.url = s.url;
        p.title = s.title;
        ready = s.ready;
        if (ready === 'complete') break;
      }
      await sleep(200);
    }
    return { tab: p.targetId, url: p.url, title: p.title, status: ready === 'complete' ? 'loaded' : 'still_loading' };
  }

  async read(o: { mode: 'all' | 'interactive' | 'text'; maxChars: number; maxElements: number; within?: string }): Promise<WebSnapshot> {
    const p = o.within ? this.pageForRef(o.within) : await this.page();
    await this.attach(p);
    if (p.dialog) return { tab: p.targetId, url: p.url, title: p.title, text: '', elements: 0, focused: null, truncated: false, dialog: p.dialog };
    const s = await this.call<{ error?: string; url: string; title: string; lines: string[]; items: WebElement[]; truncated: boolean; focused: string | null }>(p, 'snapshot', [o]);
    if (s.error) throw new WebError('stale_ref', `${o.within} is no longer on the page. Read the whole page again.`);
    for (const it of s.items) p.items.set(it.ref, it);
    p.url = s.url;
    p.title = s.title;
    return { tab: p.targetId, url: s.url, title: s.title, text: s.lines.join('\n'), elements: s.items.length, focused: s.focused, truncated: s.truncated, dialog: null };
  }

  /** The element now, checked against what the last read said (same role and name). */
  private async live(ref: string): Promise<{ p: Page; el: WebElement }> {
    const p = this.pageForRef(ref);
    await this.attach(p);
    const known = p.items.get(ref);
    const now = await this.call<WebElement | null>(p, 'describe', [ref]);
    if (!now) throw new WebError('stale_ref', `${ref} is no longer on the page. Read the page again (web__read).`);
    if (known && (known.role !== now.role || known.name !== now.name)) {
      throw new WebError('element_changed', `${ref} changed since it was read (it was ${known.role} “${known.name}”, now ${now.role} “${now.name}”). Nothing was done; read the page again.`);
    }
    p.items.set(ref, now);
    return { p, el: now };
  }

  private async mouseClick(p: Page, x: number, y: number): Promise<void> {
    const cdp = this.cdp!;
    const sid = p.sessionId!;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
  }

  private async clickRef(p: Page, ref: string): Promise<'mouse' | 'element'> {
    const pt = await this.call<{ x: number; y: number; topmost: boolean } | null>(p, 'point', [ref]);
    if (!pt) throw new WebError('stale_ref', `${ref} is no longer on the page. Read the page again (web__read).`);
    if (pt.topmost) {
      await this.mouseClick(p, pt.x, pt.y);
      return 'mouse';
    }
    // Hidden behind something else (or zero-sized): activate the element itself, never what covers it.
    await this.call(p, 'clickEl', [ref]);
    return 'element';
  }

  /** After an action: where the tab is now, and a tab it opened (Keo moves to it). */
  private async after(p: Page, before: string[], waitMs: number): Promise<{ url: string; title: string; newTab: WebTab | null }> {
    await sleep(waitMs);
    const fresh = this.opened.filter((t) => !before.includes(t) && this.pages.has(t));
    let newTab: WebTab | null = null;
    if (fresh.length) {
      const np = this.pages.get(fresh[fresh.length - 1]!)!;
      this.current = np.targetId;
      await this.attach(np);
      await this.waitReady(np, 5000);
      newTab = { tab: np.targetId, url: np.url, title: np.title, current: true };
    }
    const s = await this.call<{ url: string; title: string }>(p, 'page', []).catch(() => ({ url: p.url, title: p.title }));
    return { url: s.url, title: s.title, newTab };
  }

  async click(ref: string): Promise<{ element: { role: string; name: string }; method: 'mouse' | 'element'; url: string; title: string; newTab: WebTab | null; dialog: string | null }> {
    const { p, el } = await this.live(ref);
    const before = [...this.opened];
    const urlBefore = p.url;
    const method = await this.clickRef(p, ref).catch((e: unknown) => {
      throw e instanceof WebError ? e : new WebError('click_failed', (e as Error).message, 'unknown');
    });
    const a = await this.after(p, before, 600);
    if (a.url !== urlBefore) await this.waitReady(p, 8000).catch(() => undefined);
    return { element: { role: el.role, name: el.name }, method, ...a, dialog: p.dialog };
  }

  async fill(ref: string, value: string): Promise<{ element: { role: string; name: string }; value: string; verified: boolean; method: 'typed' | 'set' }> {
    const { p, el } = await this.live(ref);
    const prep = await this.call<{ error?: string; kind?: string; focused?: boolean }>(p, 'prepFill', [ref]);
    if (prep.error === 'password' || prep.error === 'payment') throw new WebError('secret_field', `“${el.name}” is a ${prep.error} field. Keo never types passwords, codes or card details: the user types them in Keo’s browser window.`);
    if (prep.error === 'not_editable') throw new WebError('not_editable', `${ref} (${el.role} “${el.name}”) is not a text field. Use web__select for lists, web__click for checkboxes and buttons.`);
    if (prep.error === 'read_only') throw new WebError('read_only', `“${el.name}” cannot be changed (it is disabled or read-only).`);
    if (prep.error) throw new WebError('stale_ref', `${ref} is no longer on the page. Read the page again.`);
    const cdp = this.cdp!;
    const sid = p.sessionId!;
    if (!el.multiline && /[\r\n]/.test(value)) throw new WebError('multiline', `“${el.name}” is a single-line field; it cannot hold several lines.`);
    // Real typing first (sites see ordinary input), then the field is read back.
    if (value) await cdp.send('Input.insertText', { text: value }, sid);
    else await this.key(p, parseCombo('delete')!);
    const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
    let got = await this.call<string | null>(p, 'value', [ref]);
    let method: 'typed' | 'set' = 'typed';
    if (norm(got) !== norm(value) && prep.kind !== 'editable') {
      await this.call(p, 'setNative', [ref, value]);
      got = await this.call<string | null>(p, 'value', [ref]);
      method = 'set';
    }
    return { element: { role: el.role, name: el.name }, value: (got ?? '').slice(0, 2000), verified: norm(got) === norm(value), method };
  }

  async select(ref: string, option: string): Promise<{ element: { role: string; name: string }; selected: string; verified: boolean }> {
    const { p, el } = await this.live(ref);
    const r = await this.call<{ error?: string; options?: string[]; role?: string; selected?: string }>(p, 'select', [ref, option]);
    if (r.error === 'not_select') throw new WebError('not_select', `${ref} is a ${r.role || 'control'}, not a drop-down list. For custom lists, web__click it and then web__click the option.`);
    if (r.error === 'no_option') throw new WebError('no_option', `“${el.name}” has no option “${option}”. Its options: ${(r.options ?? []).map((x) => `“${x}”`).join(', ')}.`);
    if (r.error) throw new WebError(r.error, `The option could not be chosen (${r.error.replace(/_/g, ' ')}).`);
    const now = await this.call<string | null>(p, 'value', [ref]);
    return { element: { role: el.role, name: el.name }, selected: r.selected ?? '', verified: (now ?? '') === r.selected };
  }

  async upload(ref: string, files: string[]): Promise<{ element: { role: string; name: string }; files: string[]; method: 'input' | 'chooser'; verified: boolean }> {
    const { p, el } = await this.live(ref);
    const cdp = this.cdp!;
    const sid = p.sessionId!;
    const fi = await this.call<{ isFile: boolean; multiple: boolean; disabled: boolean } | null>(p, 'fileInfo', [ref]);
    if (!fi) throw new WebError('stale_ref', `${ref} is no longer on the page.`);
    const names = files.map((f) => f.split(/[\\/]/).pop()!);
    if (fi.isFile) {
      if (fi.disabled) throw new WebError('disabled', 'That upload field is disabled.');
      if (files.length > 1 && !fi.multiple) throw new WebError('single_file', 'That upload field takes one file.');
      const objectId = await this.call<string>(p, 'el', [ref], true);
      await cdp.send('DOM.setFileInputFiles', { files, objectId }, sid);
      const got = await this.call<string[]>(p, 'files', [ref]);
      return { element: { role: el.role, name: el.name }, files: got, method: 'input', verified: names.every((n) => got.includes(n)) };
    }
    // A button that opens the file picker: catch the picker and fill it instead of showing it.
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid);
    try {
      const chosen = new Promise<number>((resolve, reject) => {
        this.chooser = resolve;
        setTimeout(() => reject(new WebError('no_file_picker', `Clicking “${el.name}” did not open a file picker. Read the page again for a file field.`)), 6000);
      });
      await this.clickRef(p, ref);
      const backendNodeId = await chosen;
      await cdp.send('DOM.setFileInputFiles', { files, backendNodeId }, sid);
      const { object } = await cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId }, sid);
      const r = await cdp.send<{ result: { value: string[] } }>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return Array.prototype.map.call(this.files || [], function (f) { return f.name; }); }', returnByValue: true }, sid);
      const got = r.result.value ?? [];
      return { element: { role: el.role, name: el.name }, files: got, method: 'chooser', verified: names.every((n) => got.includes(n)) };
    } finally {
      this.chooser = null;
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, sid).catch(() => undefined);
    }
  }

  private async key(p: Page, k: NonNullable<ReturnType<typeof parseCombo>>): Promise<void> {
    const cdp = this.cdp!;
    const sid = p.sessionId!;
    const printable = !!k.key.text && !(k.mods & 3);
    const base = { modifiers: k.mods, key: k.key.key, code: k.key.code, windowsVirtualKeyCode: k.key.vk, nativeVirtualKeyCode: k.key.vk };
    for (const [m, vk, key] of [[2, 17, 'Control'], [1, 18, 'Alt'], [8, 16, 'Shift'], [4, 91, 'Meta']] as const) {
      if (k.mods & m) await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, windowsVirtualKeyCode: vk, modifiers: k.mods }, sid);
    }
    await cdp.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: k.key.text, unmodifiedText: k.key.text } : {}) }, sid);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
    for (const [m, vk, key] of [[4, 91, 'Meta'], [8, 16, 'Shift'], [1, 18, 'Alt'], [2, 17, 'Control']] as const) {
      if (k.mods & m) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk, modifiers: 0 }, sid);
    }
  }

  /** The element with the keyboard focus in the current tab. */
  async focused(): Promise<{ ref: string; role: string; name: string; editable: boolean; multiline: boolean; secret: 'password' | 'payment' | null; value: string | null } | null> {
    const p = await this.page();
    const a = await this.call<{ ref: string; role: string; name: string; tag: string; editable: boolean; multiline: boolean; secret: 'password' | 'payment' | null; value: string | null } | null>(p, 'active', []);
    if (a) p.items.set(a.ref, { ...(p.items.get(a.ref) ?? { type: null, id: null, href: null, submits: false, inForm: false }), ...a });
    return a;
  }

  async press(combo: string, ref?: string): Promise<{ url: string; title: string; newTab: WebTab | null; dialog: string | null }> {
    const k = parseCombo(combo);
    if (!k) throw new WebError('unknown_key', `“${combo}” is not a key Keo can press. Use names like enter, tab, escape, up, pagedown, f5 or ctrl+b.`);
    const p = ref ? (await this.live(ref)).p : await this.page();
    if (ref) await this.call(p, 'focusEl', [ref]);
    const before = [...this.opened];
    await this.key(p, k);
    const a = await this.after(p, before, 400);
    return { ...a, dialog: p.dialog };
  }

  /**
   * Types at the keyboard focus (optionally after focusing ref): text as real input, line
   * breaks as Enter; `html` is handed to the editor as a paste.
   */
  async type(text: string, o: { ref?: string; format: 'text' | 'html'; keystrokes: boolean }): Promise<{ target: { role: string; name: string } | null; method: string; verified: boolean | null; value: string | null }> {
    const p = o.ref ? (await this.live(o.ref)).p : await this.page();
    if (o.ref) await this.call(p, 'focusEl', [o.ref]);
    const t = await this.call<{ ref: string; role: string; name: string; editable: boolean; multiline: boolean; secret: string | null; value: string | null } | null>(p, 'active', []);
    if (t?.secret) throw new WebError('secret_field', `The focused field “${t.name}” is a ${t.secret} field. Keo never types passwords, codes or card details: the user types them.`);
    if (t && t.editable && !t.multiline && /[\r\n]/.test(text)) throw new WebError('multiline', `The focused field “${t.name}” is a single line; pressing Enter there may submit the form. Use web__fill for that field.`);
    const cdp = this.cdp!;
    const sid = p.sessionId!;
    let method: string;
    if (o.format === 'html') {
      const plain = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      method = await this.call<string>(p, 'pasteHtml', [text, plain]);
      if (method === 'not_handled' || method === 'no_focus') throw new WebError('paste_not_handled', 'The focused editor did not take the pasted formatting. Type plain text instead (format "text"), or click into the editor first.');
    } else {
      const lines = text.split(/\r?\n/);
      for (const [n, line] of lines.entries()) {
        if (n > 0) await this.key(p, parseCombo('enter')!);
        if (!line) continue;
        if (o.keystrokes) {
          for (const ch of line) {
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch }, sid);
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid);
          }
        } else await cdp.send('Input.insertText', { text: line }, sid);
      }
      method = o.keystrokes ? 'keystrokes' : 'typed';
    }
    await sleep(150);
    const after = await this.call<{ value: string | null; editable: boolean; role: string; name: string } | null>(p, 'active', []);
    const last = text.split(/\r?\n/).filter(Boolean).pop()?.replace(/<[^>]+>/g, '').trim() ?? '';
    // Canvas editors (Google Docs, Slides) keep their text off the page: Keo cannot read it back here.
    const readable = !!after?.editable && after.value !== null && !!after.value;
    return { target: t ? { role: t.role, name: t.name } : null, method, verified: readable && last ? after!.value!.replace(/\s+/g, ' ').includes(last.replace(/\s+/g, ' ').slice(-60)) : null, value: readable ? after!.value!.slice(-500) : null };
  }

  async scroll(o: { ref?: string; direction: 'up' | 'down' | 'left' | 'right'; amount: number }): Promise<{ scrolled: boolean }> {
    if (o.ref) {
      const { p } = await this.live(o.ref);
      await this.call(p, 'point', [o.ref]);
      return { scrolled: true };
    }
    const p = await this.page();
    const { layoutViewport } = await this.cdp!.send<{ layoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, p.sessionId!);
    const step = o.amount * (o.direction === 'up' || o.direction === 'down' ? layoutViewport.clientHeight : layoutViewport.clientWidth) * 0.8;
    await this.cdp!.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: layoutViewport.clientWidth / 2, y: layoutViewport.clientHeight / 2, deltaX: o.direction === 'left' ? -step : o.direction === 'right' ? step : 0, deltaY: o.direction === 'up' ? -step : o.direction === 'down' ? step : 0 },
      p.sessionId!,
    );
    await sleep(250);
    return { scrolled: true };
  }

  async waitFor(o: { text?: string; gone?: string; urlIncludes?: string; timeoutMs: number }, signal: AbortSignal): Promise<{ met: boolean; url: string; title: string; waitedMs: number }> {
    const p = await this.page();
    const t0 = Date.now();
    while (!signal.aborted) {
      const s = await this.call<{ url: string; title: string; ready: string }>(p, 'page', []).catch(() => null);
      let met = !!s && s.ready !== 'loading';
      if (met && o.urlIncludes) met = s!.url.includes(o.urlIncludes);
      if (met && o.text) met = await this.call<boolean>(p, 'hasText', [o.text]).catch(() => false);
      if (met && o.gone) met = !(await this.call<unknown>(p, 'describe', [o.gone]).catch(() => null));
      if (met || Date.now() - t0 > o.timeoutMs) return { met, url: s?.url ?? p.url, title: s?.title ?? p.title, waitedMs: Date.now() - t0 };
      await sleep(250);
    }
    return { met: false, url: p.url, title: p.title, waitedMs: Date.now() - t0 };
  }

  async screenshot(): Promise<{ png: Buffer; url: string; title: string }> {
    const p = await this.page();
    const { data } = await this.cdp!.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, p.sessionId!);
    return { png: Buffer.from(data, 'base64'), url: p.url, title: p.title };
  }

  /** Stops the browser at once (Delete all data). */
  kill(): void {
    const proc = this.proc;
    this.cdp?.close();
    this.reset();
    proc?.kill();
  }

  async close(): Promise<void> {
    const cdp = this.cdp;
    const proc = this.proc;
    if (!cdp) return;
    await withTimeout(cdp.send('Browser.close'), 3000, 'close').catch(() => undefined);
    this.reset();
    if (proc && proc.exitCode === null) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill();
          r();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
