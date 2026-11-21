import fs from 'node:fs';
import { headerMatches, holdsText, normName, type WaMessage } from '../desktop/whatsapp';
import { KeoError } from '../util/errors';

/**
 * A chat app in the background (WhatsApp, Telegram): its web version in Keo's own browser, signed
 * in once on the user's phone, then running without a window. Tests use a fake.
 */
export interface ChatBackground {
  /** "WhatsApp" or "Telegram", for messages to the user. */
  readonly appName: string;
  status(): Promise<WebChatStatus>;
  /** Opens the web app in a window so the user can scan the QR code with their phone. */
  link(): Promise<WebChatStatus>;
  /** Opens a chat by the name the app shows; returns the header name. */
  openChat(contact: string, signal?: AbortSignal): Promise<{ opened: boolean; header: string | null; candidates: string[] }>;
  /** The open chat: its name and the latest messages (oldest first). */
  read(): Promise<{ header: string | null; messages: WaMessage[] }>;
  /** Sends a message in the open chat (which must be `contact`) and checks it appears. */
  send(contact: string, text: string, signal?: AbortSignal): Promise<{ appears: boolean }>;
  /** Private chats with unread messages, from the chat list (for answer-everyone). */
  unread(): Promise<Array<{ title: string; count: number }>>;
  /** The linked account (number and/or name), as remembered when it was linked; null when not linked. */
  account(): WebChatAccount | null;
  /** Signs Keo's copy out on this PC (its own data is removed). */
  unlink(): Promise<void>;
  close(): Promise<void>;
}

export interface WebChatAccount {
  phone: string | null;
  name: string | null;
  linkedAt: string;
}

export type WebChatStatus = 'not_linked' | 'linking' | 'loading' | 'ready';

/** The browser features this needs (KeoBrowser has them). */
export interface WebChatBrowser {
  running(): boolean;
  tabs(): Promise<Array<{ tab: string; url: string }>>;
  open(url: string, newTab: boolean): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  clickPoint(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  press(combo: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * How one web app is laid out. Each script is Keo's own text, run in Keo's isolated world of the
 * page; they return plain data.
 */
export interface WebChatSite {
  appName: string;
  url: string;
  /** { ready: chats are showing, qr: the sign-in code is showing } */
  state: string;
  /** { header, messages: [{ from: 'me'|'them'|'unknown', text, status }] } of the open chat. */
  read: string;
  /** Center (and text) of the search box, or null. */
  search: string;
  /** Center (and text) of the message box, or null. */
  compose: string;
  /** (want: normalised name) → chat entries whose title contains it: [{ title, x, y }]. */
  chats: (want: string) => string;
  /** Private chats with unread messages: [{ title, count }]. */
  unread: string;
  /** The signed-in account: { phone, name } (either may be null). */
  account: string;
}

const TEXT_OF = `const textOf = (el) => { let t = ''; for (const n of el.childNodes) t += n.nodeType === 3 ? n.textContent : n.tagName === 'IMG' ? (n.alt || '') : (n.classList && (n.classList.contains('time') || n.classList.contains('reactions'))) ? '' : textOf(n); return t; };`;
const NORM = `const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\\p{L}\\p{N}+ ]+/gu, ' ').replace(/\\s+/g, ' ').trim();`;
const center = (selector: string) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => { const b = e.getBoundingClientRect(); return b.width && b.height; });
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: ((el.value !== undefined ? el.value : el.innerText) || '').trim() };
})()`;
const entries = (titleSel: string, rowSel: string) => (want: string) => `(() => {
  ${NORM}
  const out = [];
  for (const s of document.querySelectorAll(${JSON.stringify(titleSel)})) {
    const title = (s.getAttribute('title') || s.textContent || '').trim();
    if (!title || !norm(title).includes(${JSON.stringify(want)})) continue;
    const row = s.closest(${JSON.stringify(rowSel)}) || s;
    const b = row.getBoundingClientRect();
    if (b.width && b.height) out.push({ title, x: b.left + b.width / 2, y: b.top + b.height / 2 });
  }
  return out.slice(0, 10);
})()`;

/** WhatsApp Web (web.whatsapp.com). */
export const WHATSAPP_SITE: WebChatSite = {
  appName: 'WhatsApp',
  url: 'https://web.whatsapp.com/',
  state: `(() => ({ ready: !!document.querySelector('#pane-side'), qr: !!document.querySelector('canvas[aria-label], [data-ref] canvas') }))()`,
  read: `(() => {
  ${TEXT_OF}
  const main = document.querySelector('#main');
  if (!main) return { header: null, messages: [] };
  const h = main.querySelector('header span[dir="auto"][title]') || main.querySelector('header span[dir="auto"]');
  const header = h ? (h.getAttribute('title') || h.textContent || '').trim() : null;
  const rows = [...main.querySelectorAll('div[role="row"]')].slice(-40);
  const messages = rows.map((r) => {
    const from = r.querySelector('.message-out') ? 'me' : r.querySelector('.message-in') ? 'them' : 'unknown';
    const el = r.querySelector('.copyable-text .selectable-text') || r.querySelector('span.selectable-text');
    const text = el ? textOf(el).replace(/\\s+/g, ' ').trim() : '';
    const icon = r.querySelector('[data-icon^="msg-"]');
    return { from, text, status: icon ? icon.getAttribute('data-icon').replace('msg-', '') : null };
  }).filter((m) => m.text);
  return { header, messages };
})()`,
  search: center('#side div[contenteditable="true"]'),
  compose: center('#main footer div[contenteditable="true"]'),
  chats: entries('#pane-side span[title]', '[role="listitem"], [role="row"]'),
  unread: `(() => {
  const out = [];
  for (const row of document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')) {
    const badge = row.querySelector('[aria-label*="unread message"]');
    const t = row.querySelector('span[title]');
    if (!badge || !t) continue;
    if (row.querySelector('[data-icon="default-group"], [data-icon="group"]')) continue;
    const n = parseInt((badge.getAttribute('aria-label') || '').replace(/\\D+/g, ' '), 10);
    out.push({ title: (t.getAttribute('title') || '').trim(), count: n > 0 ? n : 1 });
  }
  return out;
})()`,
  account: `(() => {
  const raw = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid') || '';
  const num = (raw.replace(/"/g, '').split(/[:@]/)[0] || '').replace(/\\D/g, '');
  return { phone: num ? '+' + num : null, name: null };
})()`,
};

/** Telegram Web, version K (web.telegram.org/k/). */
export const TELEGRAM_SITE: WebChatSite = {
  appName: 'Telegram',
  url: 'https://web.telegram.org/k/',
  state: `(() => ({ ready: !!document.querySelector('#column-left .chatlist a.chatlist-chat, #column-left .chatlist-container'), qr: !!document.querySelector('.auth-image canvas, .qr-container canvas, canvas.qr-canvas') }))()`,
  read: `(() => {
  ${TEXT_OF}
  const center = document.querySelector('#column-center');
  const t = center && center.querySelector('.chat-info .peer-title, .top .peer-title');
  const header = t ? (t.textContent || '').trim() : null;
  if (!center) return { header: null, messages: [] };
  const bubbles = [...center.querySelectorAll('.bubbles .bubble')].filter((b) => !b.classList.contains('service')).slice(-40);
  const messages = bubbles.map((b) => {
    const from = b.classList.contains('is-out') ? 'me' : b.classList.contains('is-in') ? 'them' : 'unknown';
    const el = b.querySelector('.translatable-message') || b.querySelector('.message');
    const text = el ? textOf(el).replace(/\\s+/g, ' ').trim() : '';
    const status = b.classList.contains('is-read') ? 'read' : b.classList.contains('is-sent') ? 'sent' : null;
    return { from, text, status };
  }).filter((m) => m.text);
  return { header, messages };
})()`,
  search: center('#column-left input.input-search-input, #column-left .input-search input'),
  compose: center('#column-center .input-message-input[contenteditable="true"]:not(.input-field-input-fake)'),
  chats: entries('#column-left a.chatlist-chat .peer-title', 'a.chatlist-chat'),
  unread: `(() => {
  const out = [];
  for (const row of document.querySelectorAll('#column-left .chatlist a.chatlist-chat')) {
    const badge = row.querySelector('.dialog-subtitle-badge-unread, .badge-unread, .unread');
    const t = row.querySelector('.peer-title');
    if (!badge || !t || badge.classList.contains('is-muted')) continue;
    const peer = Number(row.getAttribute('data-peer-id') || '0');
    if (peer < 0) continue; // groups and channels
    const n = parseInt((badge.textContent || '').replace(/\\D+/g, ''), 10);
    out.push({ title: (t.textContent || '').trim(), count: n > 0 ? n : 1 });
  }
  return out;
})()`,
  account: `(async () => {
  const out = { phone: null, name: null };
  let id = null;
  try { const a = JSON.parse(localStorage.getItem('user_auth') || 'null'); id = a && a.id; } catch {}
  if (!id) for (const k of Object.keys(localStorage)) {
    if (!/^account\\d+$/.test(k)) continue;
    try { const a = JSON.parse(localStorage.getItem(k) || 'null'); id = a && (a.userId || (a.user_auth && a.user_auth.id)); } catch {}
    if (id) break;
  }
  if (!id || !indexedDB.databases) return out;
  for (const d of (await indexedDB.databases()).filter((x) => /^tweb/.test(x.name || ''))) {
    const db = await new Promise((res) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (!db) continue;
    let u = null;
    if ([...db.objectStoreNames].includes('users')) {
      u = await new Promise((res) => { try { const q = db.transaction('users').objectStore('users').get(id); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); } });
    }
    db.close();
    if (u) {
      out.phone = u.phone ? '+' + String(u.phone).replace(/\\D/g, '') : null;
      out.name = [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
      break;
    }
  }
  return out;
})()`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mineWith = (ms: WaMessage[], text: string) => ms.filter((m) => m.from === 'me' && holdsText(m.text, text)).length;

/**
 * A chat app in the background: its web version in its own copy of Keo's browser (its own
 * profile), linked once to the user's phone like any linked device, then running without a window.
 * Live chats read and send through the page itself — no mouse, keyboard or screen — so the user
 * keeps using the computer.
 */
export class WebChat implements ChatBackground {
  private queue: Promise<unknown> = Promise.resolve();
  private visible = false;
  readonly appName: string;

  constructor(
    private readonly site: WebChatSite,
    private readonly d: {
      browser: WebChatBrowser;
      /** A file whose presence means the user linked it once. */
      linkedFile: string;
      /** Told when the browser should run with a window (linking) or without (afterwards). */
      setVisible: (visible: boolean) => void;
      /** Keo's own profile folder for this app (removed on unlink). */
      profileDir?: string;
      /** Told when it got linked or unlinked (the settings panel refreshes). */
      changed?: () => void;
      log?: (event: string, detail: Record<string, unknown>) => void;
      waitMs?: number;
    },
  ) {
    this.appName = site.appName;
  }

  /** One page action at a time (several live chats share the one page). */
  private one<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private linked(): boolean {
    return fs.existsSync(this.d.linkedFile);
  }

  account(): WebChatAccount | null {
    if (!this.linked()) return null;
    try {
      const j = JSON.parse(fs.readFileSync(this.d.linkedFile, 'utf8')) as Partial<WebChatAccount>;
      return { phone: j.phone ?? null, name: j.name ?? null, linkedAt: j.linkedAt ?? '' };
    } catch {
      return { phone: null, name: null, linkedAt: '' };
    }
  }

  /** Reads which account is signed in and remembers it (best effort: the page may not say). */
  private async rememberAccount(): Promise<void> {
    const a = await this.d.browser.evaluate<{ phone: string | null; name: string | null }>(this.site.account).catch(() => null);
    const was = this.account();
    const next: WebChatAccount = { phone: a?.phone ?? was?.phone ?? null, name: a?.name ?? was?.name ?? null, linkedAt: was?.linkedAt || new Date().toISOString() };
    fs.writeFileSync(this.d.linkedFile, JSON.stringify(next));
  }

  async unlink(): Promise<void> {
    return this.one(async () => {
      this.visible = false;
      if (this.d.browser.running()) await this.d.browser.close();
      fs.rmSync(this.d.linkedFile, { force: true });
      if (this.d.profileDir) fs.rmSync(this.d.profileDir, { recursive: true, force: true });
      this.d.log?.('web_chat.unlinked', { app: this.site.appName });
      this.d.changed?.();
    });
  }

  private async state(): Promise<{ ready: boolean; qr: boolean }> {
    return this.d.browser.evaluate<{ ready: boolean; qr: boolean }>(this.site.state).catch(() => ({ ready: false, qr: false }));
  }

  private readPage(): Promise<{ header: string | null; messages: WaMessage[] }> {
    return this.d.browser.evaluate<{ header: string | null; messages: WaMessage[] }>(this.site.read);
  }

  /** Starts the web app (without a window once linked) and waits until the chats show. */
  private async ensure(): Promise<void> {
    const app = this.site.appName;
    if (!this.linked()) throw new KeoError('not_linked', `${app} in the background is not linked yet: ask the user to link it (Keo shows the QR code to scan with their phone).`);
    if (!this.d.browser.running()) {
      this.visible = false;
      this.d.setVisible(false);
      await this.d.browser.open(this.site.url, true);
    } else if (!(await this.d.browser.tabs()).some((t) => t.url.startsWith(new URL(this.site.url).origin))) await this.d.browser.open(this.site.url, false);
    const until = Date.now() + (this.d.waitMs ?? 60_000);
    for (;;) {
      const s = await this.state();
      if (s.ready) {
        const a = this.account();
        if (a && !a.phone && !a.name) await this.rememberAccount();
        return;
      }
      if (s.qr) {
        // The phone unlinked it: link again.
        fs.rmSync(this.d.linkedFile, { force: true });
        throw new KeoError('not_linked', `${app} in the background was signed out (it shows a QR code again). Ask the user to link it again.`);
      }
      if (Date.now() > until) throw new KeoError('web_chat_loading', `${app} did not finish loading. Try again in a moment.`);
      await sleep(500);
    }
  }

  async status(): Promise<WebChatStatus> {
    if (this.visible && this.d.browser.running()) return (await this.state()).ready ? 'ready' : 'linking';
    if (!this.linked()) return 'not_linked';
    if (!this.d.browser.running()) return 'ready';
    return (await this.state()).ready ? 'ready' : 'loading';
  }

  async link(): Promise<WebChatStatus> {
    return this.one(async () => {
      if (this.d.browser.running()) await this.d.browser.close();
      this.visible = true;
      this.d.setVisible(true);
      await this.d.browser.open(this.site.url, true);
      this.d.log?.('web_chat.linking', { app: this.site.appName });
      // Watch for the chats to appear (the user scanned the code), then carry on without a window.
      void (async () => {
        const until = Date.now() + 10 * 60_000;
        while (Date.now() < until && this.visible && this.d.browser.running()) {
          if ((await this.state()).ready) {
            fs.writeFileSync(this.d.linkedFile, JSON.stringify({ phone: null, name: null, linkedAt: new Date().toISOString() }));
            this.d.log?.('web_chat.linked', { app: this.site.appName });
            await sleep(4000); // let it finish syncing
            await this.rememberAccount();
            this.visible = false;
            await this.d.browser.close();
            this.d.setVisible(false);
            this.d.changed?.();
            return;
          }
          await sleep(1500);
        }
      })();
      return 'linking' as const;
    });
  }

  async openChat(contact: string, signal?: AbortSignal): Promise<{ opened: boolean; header: string | null; candidates: string[] }> {
    return this.one(async () => {
      await this.ensure();
      const b = this.d.browser;
      const now = await this.readPage();
      if (headerMatches(now.header, contact)) return { opened: true, header: now.header, candidates: [] };
      const box = await b.evaluate<{ x: number; y: number } | null>(this.site.search);
      if (!box) throw new KeoError('not_recognized', `Could not find ${this.site.appName}’s search box.`);
      await b.clickPoint(box.x, box.y);
      await b.press('ctrl+a');
      await b.insertText(contact);
      const want = normName(contact);
      let found: Array<{ title: string; x: number; y: number }> = [];
      for (let k = 0; k < 20 && !signal?.aborted; k++) {
        await sleep(250);
        found = await b.evaluate<Array<{ title: string; x: number; y: number }>>(this.site.chats(want));
        if (found.some((f) => normName(f.title) === want)) break;
      }
      const titles = [...new Set(found.map((f) => f.title))];
      const exact = found.find((f) => normName(f.title) === want) ?? (titles.length === 1 ? found[0] : undefined);
      if (!exact) return { opened: false, header: null, candidates: titles };
      await b.clickPoint(exact.x, exact.y);
      for (let k = 0; k < 16; k++) {
        await sleep(250);
        const r = await this.readPage();
        if (headerMatches(r.header, contact) || headerMatches(r.header, exact.title)) {
          await b.press('escape').catch(() => undefined); // clear the search
          return { opened: true, header: r.header, candidates: titles };
        }
      }
      return { opened: false, header: null, candidates: titles };
    });
  }

  async read(): Promise<{ header: string | null; messages: WaMessage[] }> {
    return this.one(async () => {
      await this.ensure();
      return this.readPage();
    });
  }

  async unread(): Promise<Array<{ title: string; count: number }>> {
    return this.one(async () => {
      await this.ensure();
      return this.d.browser.evaluate<Array<{ title: string; count: number }>>(this.site.unread);
    });
  }

  async send(contact: string, text: string, signal?: AbortSignal): Promise<{ appears: boolean }> {
    return this.one(async () => {
      await this.ensure();
      const b = this.d.browser;
      const before = await this.readPage();
      if (!headerMatches(before.header, contact)) throw new KeoError('chat_mismatch', `The open chat is “${before.header ?? 'none'}”, not “${contact}”. Nothing was sent.`);
      const box = await b.evaluate<{ x: number; y: number; text: string } | null>(this.site.compose);
      if (!box) throw new KeoError('not_recognized', 'Could not find the message box. Nothing was sent.');
      if (box.text.trim()) throw new KeoError('draft_present', 'The message box already has text in it, so nothing was sent.');
      await b.clickPoint(box.x, box.y);
      const lines = text.split(/\r?\n/);
      for (const [k, line] of lines.entries()) {
        if (k) await b.press('shift+enter');
        if (line) await b.insertText(line);
      }
      const clear = async () => {
        await b.press('ctrl+a');
        await b.press('delete');
      };
      if (signal?.aborted) {
        await clear();
        throw new KeoError('cancelled', 'Cancelled before sending. Nothing was sent.');
      }
      const typed = await b.evaluate<{ text: string } | null>(this.site.compose);
      if (!typed || !holdsText(typed.text, text)) {
        await clear();
        throw new KeoError('draft_mismatch', 'The message box did not hold exactly the reply, so Keo cleared it and sent nothing.');
      }
      await b.press('enter');
      for (let k = 0; k < 20; k++) {
        await sleep(250);
        // One more of Keo's own messages holding this text than before (an earlier identical one does not count).
        if (mineWith((await this.readPage()).messages, text) > mineWith(before.messages, text)) return { appears: true };
      }
      return { appears: false };
    });
  }

  async close(): Promise<void> {
    this.visible = false;
    await this.d.browser.close();
  }
}
