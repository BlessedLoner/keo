import fs from 'node:fs';
import path from 'node:path';
import type { PhotoIndexState } from '../../shared/domain';
import type { Database } from '../db/database';
import { nowIso } from '../util/errors';
import { isInside, queryWords, SKIP_DIRS } from './fileSearch';

/**
 * Finding pictures by what is in them. With the user's switch (Settings → Files) and vision-export
 * consent, the active model (or the fast one, when smart routing allows) looks at each picture once
 * and Keo keeps a short description and keywords in its own database, keyed by path, size and
 * modified time: a changed picture is described again, an unchanged one never. Only folders the
 * user allowed are looked at; tiny pictures and ones whose names suggest passwords, banking or IDs
 * are never sent.
 */

/** Kinds Keo can downscale and send (others stay findable by name only). */
const DESCRIBABLE = /\.(jpe?g|jfif|png)$/i;
/** Smaller files are icons, thumbnails and stickers, not photos worth describing. */
export const MIN_PICTURE_BYTES = 12 * 1024;
/** A picture whose shorter side is smaller than this is skipped. */
const MIN_SIDE = 160;
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;
/** Names that suggest a screenshot of something private: never sent. */
const SENSITIVE_NAME = /(bank|password|passwd|login|sign[-_ ]?in|1password|bitwarden|lastpass|keepass|wallet|seed[-_ ]?phrase|recovery|2fa|otp|authenticator|paypal|venmo|credit[-_ ]?card|debit|statement|passport|licen[cs]e|ssn|social[-_ ]?security|national[-_ ]?id|id[-_ ]?card|tax|payslip|salary|medical|prescription)/i;
/** A rough token count per picture: a downscaled picture plus a short answer. */
const TOKENS_PER_PICTURE = 1000;

/** Words that say "a picture" but nothing about what is in it. */
const STOP = new Set(['photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'image', 'images', 'img', 'snapshot', 'of', 'the', 'a', 'an', 'my', 'me', 'with', 'and', 'in', 'on', 'at', 'from', 'to', 'showing', 'shows', 'that', 'this', 'some', 'jpg', 'jpeg', 'png', 'one']);

/** The words to look for in descriptions (singular, without "photo of the"). */
export function photoWords(text: string): string[] {
  return queryWords(text)
    .filter((w) => !STOP.has(w) && w.length >= 2)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

export function isDescribable(p: string): boolean {
  return DESCRIBABLE.test(p);
}

export function sensitiveName(p: string): boolean {
  return SENSITIVE_NAME.test(path.basename(p));
}

/** Width and height from a PNG or JPEG header; null when unknown. */
export function pictureSize(b: Buffer): { width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (not DHT, JPG, DAC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

export function mediaTypeOf(b: Buffer): 'image/png' | 'image/jpeg' | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return null;
}

export interface PhotoRow {
  path: string;
  size: number;
  mtimeMs: number;
  status: 'described' | 'skipped';
  description: string;
  keywords: string[];
}

const key = (p: string) => path.resolve(p).toLowerCase();

/** Descriptions in Keo's database. */
export class PhotoStore {
  constructor(private readonly db: Database) {}

  /** The stored row when the file is unchanged (same size and modified time); null = describe it. */
  fresh(p: string, size: number, mtimeMs: number): PhotoRow | null {
    const r = this.db.get<{ path: string; size: number; mtime_ms: number; status: string; description: string; keywords: string }>('SELECT path, size, mtime_ms, status, description, keywords FROM photo_descriptions WHERE path_key = ?', [key(p)]);
    if (!r || r.size !== size || r.mtime_ms !== Math.floor(mtimeMs)) return null;
    return { path: r.path, size: r.size, mtimeMs: r.mtime_ms, status: r.status as PhotoRow['status'], description: r.description, keywords: r.keywords ? r.keywords.split(',') : [] };
  }

  put(row: PhotoRow & { provider: string | null; model: string | null }): void {
    this.db.run(
      `INSERT INTO photo_descriptions (path_key, path, size, mtime_ms, status, description, keywords, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, size = excluded.size, mtime_ms = excluded.mtime_ms, status = excluded.status, description = excluded.description,
         keywords = excluded.keywords, provider = excluded.provider, model = excluded.model, created_at = excluded.created_at`,
      [key(row.path), row.path, row.size, Math.floor(row.mtimeMs), row.status, row.description, row.keywords.join(','), row.provider, row.model, nowIso()],
    );
  }

  /** Described pictures whose description, keywords or path hold every word. */
  search(words: string[], limit = 200): PhotoRow[] {
    if (!words.length) return [];
    const where = words.map(() => `instr(lower(description || ' ' || keywords || ' ' || path), ?) > 0`).join(' AND ');
    return this.db
      .all<{ path: string; size: number; mtime_ms: number; description: string; keywords: string }>(`SELECT path, size, mtime_ms, description, keywords FROM photo_descriptions WHERE status = 'described' AND ${where} ORDER BY mtime_ms DESC LIMIT ?`, [...words, limit])
      .map((r) => ({ path: r.path, size: r.size, mtimeMs: r.mtime_ms, status: 'described', description: r.description, keywords: r.keywords ? r.keywords.split(',') : [] }));
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM photo_descriptions')?.n ?? 0;
  }

  clear(): void {
    this.db.run('DELETE FROM photo_descriptions');
  }
}

/** What the model said about one picture. */
export interface PictureVerdict {
  description: string;
  keywords: string[];
  /** The picture shows passwords, banking, IDs or similar: nothing is kept. */
  sensitive: boolean;
  provider: string | null;
  model: string | null;
}

export interface PhotoIndexerDeps {
  store: PhotoStore;
  /** Folders whose pictures are described (already limited to allowed folders). */
  folders(): string[];
  allowed(p: string): boolean;
  /** Folders never entered. */
  excluded(): string[];
  cap(): number;
  /** Why pictures may not be sent now (switch off, no consent, no vision model); null = they may. */
  blocked(): string | null;
  /** Sends one picture to the model. */
  describe(bytes: Buffer, signal: AbortSignal): Promise<PictureVerdict>;
  destination(): string;
  changed(state: PhotoIndexState): void;
  /** A pause between pictures, so the computer and the provider are not hurried (low priority). */
  gapMs?: number;
  /** Time and entry limits for counting pictures. */
  countBudgetMs?: number;
}

interface Candidate {
  path: string;
  size: number;
  mtimeMs: number;
}

export type DescribeOutcome = { path: string; status: 'described'; description: string; keywords: string[]; cached: boolean } | { path: string; status: 'skipped'; reason: string } | { path: string; status: 'failed'; reason: string };

/** Counting, describing in the background (pausable, capped), and describing a few right now. */
export class PhotoIndexer {
  private st: PhotoIndexState;
  private queue: Candidate[] = [];
  private run: AbortController | null = null;
  private pauseAsked = false;

  constructor(private readonly d: PhotoIndexerDeps) {
    this.st = { phase: 'idle', found: 0, described: 0, toDescribe: 0, done: 0, failed: 0, cap: d.cap(), approxTokens: 0, destination: '', folders: [], message: '' };
  }

  state(): PhotoIndexState {
    return { ...this.st, folders: [...this.st.folders] };
  }

  private set(p: Partial<PhotoIndexState>): void {
    this.st = { ...this.st, ...p };
    this.d.changed(this.state());
  }

  get running(): boolean {
    return !!this.run;
  }

  /** Counts the pictures to describe (nothing is sent). */
  async estimate(): Promise<PhotoIndexState> {
    if (this.run) return this.state();
    const folders = this.d.folders();
    this.set({ phase: 'counting', folders, cap: this.d.cap(), destination: this.d.destination(), message: 'Counting pictures…' });
    const found = await this.list(folders);
    const todo = found.filter((c) => !this.d.store.fresh(c.path, c.size, c.mtimeMs));
    const cap = this.d.cap();
    this.queue = todo.slice(0, cap);
    const blocked = this.d.blocked();
    this.set({
      phase: blocked ? 'blocked' : 'ready',
      found: found.length,
      described: found.length - todo.length,
      toDescribe: this.queue.length,
      done: 0,
      failed: 0,
      approxTokens: this.queue.length * TOKENS_PER_PICTURE,
      message: blocked ?? (this.queue.length ? `${this.queue.length} picture${this.queue.length === 1 ? '' : 's'} to describe${todo.length > cap ? ` (the newest ${cap} of ${todo.length})` : ''}.` : 'Every picture here is described.'),
    });
    return this.state();
  }

  /** Describes the counted pictures in the background, newest first. Resumes after a pause. */
  async start(): Promise<PhotoIndexState> {
    if (this.run) return this.state();
    const blocked = this.d.blocked();
    if (blocked) {
      this.set({ phase: 'blocked', message: blocked });
      return this.state();
    }
    if (!this.queue.length || this.st.phase === 'done' || this.st.phase === 'idle') await this.estimate();
    if (this.st.phase === 'blocked') return this.state();
    if (!this.queue.length) {
      this.set({ phase: 'done', message: 'Every picture here is described.' });
      return this.state();
    }
    this.pauseAsked = false;
    const run = new AbortController();
    this.run = run;
    this.set({ phase: 'running', message: 'Describing pictures…' });
    void this.loop(run).finally(() => {
      if (this.run === run) this.run = null;
    });
    return this.state();
  }

  /** Stops after the current picture; start() continues where it stopped. */
  pause(): PhotoIndexState {
    if (this.run) {
      this.pauseAsked = true;
      this.run.abort();
    }
    return this.state();
  }

  /** Forgets every description (pictures will be described again if the user starts again). */
  clear(): PhotoIndexState {
    this.pause();
    this.d.store.clear();
    this.queue = [];
    this.set({ phase: 'idle', found: 0, described: 0, toDescribe: 0, done: 0, failed: 0, approxTokens: 0, message: 'Picture descriptions deleted.' });
    return this.state();
  }

  stop(): void {
    this.run?.abort();
  }

  private async loop(run: AbortController): Promise<void> {
    const gap = this.d.gapMs ?? 1500;
    let failedInARow = 0;
    while (this.queue.length) {
      if (run.signal.aborted) break;
      const blocked = this.d.blocked();
      if (blocked) {
        this.set({ phase: 'blocked', message: blocked });
        return;
      }
      const c = this.queue[0]!;
      const out = await this.describeFile(c.path, run.signal);
      if (out.status === 'failed' && run.signal.aborted) break; // paused mid-picture: it stays first in line
      this.queue.shift();
      if (out.status === 'failed') {
        failedInARow++;
        this.set({ failed: this.st.failed + 1 });
        if (failedInARow >= 3) {
          this.set({ phase: 'failed', message: `Stopped: ${out.reason}` });
          return;
        }
      } else {
        failedInARow = 0;
        this.set({ done: this.st.done + 1, described: this.st.described + (out.status === 'described' ? 1 : 0) });
      }
      if (gap && this.queue.length) await sleep(gap, run.signal);
    }
    if (this.pauseAsked || (run.signal.aborted && this.queue.length)) {
      this.set({ phase: 'paused', message: `Paused with ${this.queue.length} picture${this.queue.length === 1 ? '' : 's'} left.` });
      return;
    }
    this.set({ phase: 'done', message: `Done: ${this.st.done} picture${this.st.done === 1 ? '' : 's'} described${this.st.failed ? `, ${this.st.failed} could not be` : ''}.` });
  }

  /** One picture: the stored description when unchanged, otherwise the model looks at it. */
  async describeFile(p: string, signal: AbortSignal): Promise<DescribeOutcome> {
    if (!isDescribable(p)) return { path: p, status: 'skipped', reason: 'Keo can describe JPEG and PNG pictures only.' };
    if (!this.d.allowed(p)) return { path: p, status: 'skipped', reason: 'Outside the folders Keo may search.' };
    if (sensitiveName(p)) return { path: p, status: 'skipped', reason: 'Its name suggests something private (passwords, banking, IDs); it is not sent.' };
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(p);
    } catch {
      return { path: p, status: 'failed', reason: 'That picture no longer exists.' };
    }
    const cached = this.d.store.fresh(p, st.size, st.mtimeMs);
    if (cached) return cached.status === 'described' ? { path: p, status: 'described', description: cached.description, keywords: cached.keywords, cached: true } : { path: p, status: 'skipped', reason: 'Set aside earlier as private.' };
    if (st.size < MIN_PICTURE_BYTES) return { path: p, status: 'skipped', reason: 'Too small to be a photo.' };
    if (st.size > MAX_PICTURE_BYTES) return { path: p, status: 'skipped', reason: 'Too large.' };
    const blocked = this.d.blocked();
    if (blocked) return { path: p, status: 'failed', reason: blocked };
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(p);
    } catch {
      return { path: p, status: 'failed', reason: 'Windows would not let Keo read it.' };
    }
    if (!mediaTypeOf(bytes)) return { path: p, status: 'skipped', reason: 'Not a JPEG or PNG inside.' };
    const dims = pictureSize(bytes);
    if (dims && Math.min(dims.width, dims.height) < MIN_SIDE) return { path: p, status: 'skipped', reason: 'Too small to be a photo.' };
    let v: PictureVerdict;
    try {
      v = await this.d.describe(bytes, signal);
    } catch (e) {
      return { path: p, status: 'failed', reason: signal.aborted ? 'Stopped.' : (e as Error).message.slice(0, 200) };
    }
    const row = { path: p, size: st.size, mtimeMs: st.mtimeMs, provider: v.provider, model: v.model };
    if (v.sensitive) {
      this.d.store.put({ ...row, status: 'skipped', description: '', keywords: [] });
      return { path: p, status: 'skipped', reason: 'The picture shows something private; no description is kept.' };
    }
    this.d.store.put({ ...row, status: 'described', description: v.description, keywords: v.keywords });
    return { path: p, status: 'described', description: v.description, keywords: v.keywords, cached: false };
  }

  /** The newest describable pictures inside one folder (for "look now"), at most n, undescribed first. */
  async newest(folder: string, n: number): Promise<string[]> {
    const all = await this.list([folder], 2000);
    const todo = all.filter((c) => !this.d.store.fresh(c.path, c.size, c.mtimeMs));
    return todo.slice(0, n).map((c) => c.path);
  }

  /** Pictures Keo may describe in these folders, newest first. Names and sizes only. */
  private async list(folders: string[], max = 50_000): Promise<Candidate[]> {
    const until = Date.now() + (this.d.countBudgetMs ?? 8000);
    const excluded = this.d.excluded();
    const queue = folders.filter((f) => this.d.allowed(f));
    const out: Candidate[] = [];
    const seen = new Set<string>();
    let entries = 0;
    while (queue.length && Date.now() < until && entries < max) {
      const dir = queue.shift()!;
      let list: fs.Dirent[];
      try {
        list = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of list) {
        entries++;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !excluded.some((x) => isInside(full, x))) queue.push(full);
          continue;
        }
        if (!e.isFile() || !isDescribable(e.name) || sensitiveName(e.name)) continue;
        const k = full.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        try {
          const st = await fs.promises.stat(full);
          if (st.size >= MIN_PICTURE_BYTES && st.size <= MAX_PICTURE_BYTES) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone or locked: skip
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}

/** The model's answer as {description, keywords, sensitive}; tolerant of code fences and extra text. */
export function parseVerdict(text: string): { description: string; keywords: string[]; sensitive: boolean } {
  const m = /\{[\s\S]*\}/.exec(text);
  let o: { description?: unknown; keywords?: unknown; sensitive?: unknown } = {};
  try {
    o = m ? (JSON.parse(m[0]) as typeof o) : {};
  } catch {
    o = {};
  }
  const one = (s: string, n: number) => s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);
  const description = one(typeof o.description === 'string' ? o.description : m ? '' : text, 300);
  const keywords = (Array.isArray(o.keywords) ? o.keywords : [])
    .filter((k): k is string => typeof k === 'string')
    .map((k) => one(k, 40).toLowerCase().replace(/,/g, ' '))
    .filter(Boolean)
    .slice(0, 15);
  const sensitive = o.sensitive === true;
  if (!sensitive && !description) throw new Error('The model gave no description.');
  return { description, keywords, sensitive };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
