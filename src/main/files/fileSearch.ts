import fs from 'node:fs';
import path from 'node:path';

/**
 * Finding any file or folder on the user's computer, fast.
 *
 * The answer comes from the Windows Search index (milliseconds, names and file contents) through
 * an `IndexBackend`; when the index is unavailable — or knows nothing for a folder that is not
 * indexed — a time-boxed scan of the allowed folders matches names instead. Only folders the user
 * allowed are searched, and Keo's built-in exclusions (AppData, Keo's own data, the recycle bin)
 * plus the user's own are never returned. This module only reads names and metadata.
 */

export const FILE_KINDS = ['any', 'folder', 'document', 'picture', 'video', 'audio', 'archive', 'code'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const EXT: Record<Exclude<FileKind, 'any' | 'folder'>, string[]> = {
  document: ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.xls', '.xlsx', '.ods', '.csv', '.ppt', '.pptx', '.odp', '.pages', '.numbers', '.key', '.epub'],
  picture: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.svg', '.avif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.jfif'],
  video: ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv', '.3gp', '.mts'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma', '.opus', '.aiff'],
  archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.iso'],
  code: ['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.ps1', '.ipynb', '.kt', '.swift'],
};

export function kindOf(p: string, isFolder: boolean): Exclude<FileKind, 'any'> | 'other' {
  if (isFolder) return 'folder';
  const ext = path.extname(p).toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k as Exclude<FileKind, 'any' | 'folder'>;
  return 'other';
}

export interface FileQuery {
  /** Words to find in the name (or, through the index, the contents). May be empty with a kind or date. */
  text: string;
  kind: FileKind;
  /** Only items changed in the last N days. */
  modifiedWithinDays?: number | undefined;
  /** Search only inside this folder (must be inside the allowed folders). */
  folder?: string | undefined;
  limit: number;
}

export interface FileHit {
  path: string;
  name: string;
  folder: string;
  kind: Exclude<FileKind, 'any'> | 'other';
  size: number | null;
  /** ISO time of the last change. */
  modified: string | null;
  /** Where the words matched: the name, only inside the file (index), or a picture's description. */
  match: 'name' | 'content' | 'listing' | 'described';
  /** For a picture Keo described earlier: what is in it (made by the AI model; untrusted). */
  description?: string | undefined;
}

/** A picture described earlier (see photoIndex.ts). */
export interface DescribedPicture {
  path: string;
  size: number;
  mtimeMs: number;
  description: string;
}

export interface IndexRow {
  path: string;
  isFolder: boolean;
  size: number | null;
  modified: string | null;
}

/** The Windows Search index (the app uses a resident PowerShell helper; tests use a fake). */
export interface IndexBackend {
  query(sql: string, signal: AbortSignal): Promise<IndexRow[]>;
  /** Starts the helper and opens the index ahead of the first search. */
  warm?(): void;
  close?(): void;
}

export class IndexUnavailable extends Error {}

/** The words of a request, reduced to characters the index and a LIKE never treat specially. */
export function queryWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .split(/[^\p{L}\p{N}.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 1)
    .slice(0, 8);
}

const sqlText = (s: string) => s.replace(/'/g, "''");
/** A folder as a SCOPE / path prefix in index SQL (forward slashes, no trailing slash). */
const scopePath = (p: string) => sqlText(path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''));

/**
 * The index query. Words use CONTAINS with a prefix term (a leading-wildcard LIKE makes the index
 * scan everything — seconds instead of milliseconds): each word must be in the name or the contents.
 */
export function buildIndexSql(q: FileQuery, roots: string[], now = Date.now()): string {
  const where: string[] = [];
  const scopes = (q.folder ? [q.folder] : roots).map((r) => `SCOPE='file:${scopePath(r)}'`);
  where.push(scopes.length === 1 ? scopes[0]! : `(${scopes.join(' OR ')})`);
  for (const w of queryWords(q.text)) {
    const term = sqlText(w.replace(/"/g, ''));
    where.push(`(CONTAINS(System.FileName, '"${term}*"') OR CONTAINS(*, '"${term}*"'))`);
  }
  if (q.kind === 'folder') where.push(`System.Kind = 'folder'`);
  else if (q.kind !== 'any') where.push(`(${EXT[q.kind].map((e) => `System.FileExtension = '${e}'`).join(' OR ')})`);
  if (q.modifiedWithinDays) {
    const since = new Date(now - q.modifiedWithinDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    where.push(`System.DateModified >= '${since}'`);
  }
  return `SELECT TOP 300 System.ItemPathDisplay, System.ItemType, System.Size, System.DateModified FROM SystemIndex WHERE ${where.join(' AND ')}`;
}

const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

/** Folder names a scan never enters (tool caches, version control, system folders). */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information', 'appdata', '.cache', '__pycache__', '.venv', 'venv', '.gradle', '.nuget', '.vs', '.idea', 'dist', 'build', 'out', '.next', 'target']);

export interface FileSearchDeps {
  index: IndexBackend | null;
  /** Folders the user allowed (empty = none). */
  roots: () => string[];
  /** Folders never searched: Keo's built-ins plus the user's own. */
  excluded: () => string[];
  scanBudgetMs?: number;
  /** Pictures whose description holds the words (none when describing pictures is off). */
  described?: (text: string) => DescribedPicture[];
}

export class FileSearch {
  constructor(private readonly d: FileSearchDeps) {}

  allowed(p: string): boolean {
    return this.d.roots().some((r) => isInside(p, r)) && !this.d.excluded().some((x) => isInside(p, x));
  }

  async search(q: FileQuery, signal: AbortSignal): Promise<{ hits: FileHit[]; via: 'index' | 'scan'; ms: number; total: number }> {
    const t0 = Date.now();
    const roots = this.d.roots();
    if (q.folder && !this.allowed(q.folder)) throw new Error('That folder is not among the folders Keo may search (Settings → Files).');
    const words = queryWords(q.text);
    let rows: IndexRow[] | null = null;
    if (this.d.index) {
      try {
        rows = await this.d.index.query(buildIndexSql(q, roots), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        rows = null; // the index is off or broken: scan instead
      }
    }
    let via: 'index' | 'scan' = 'index';
    let hits: FileHit[];
    if (rows && rows.length) {
      hits = rows.filter((r) => this.allowed(r.path)).map((r) => this.hit(r.path, r.isFolder, r.size, r.modified, words));
    } else {
      // No index, or nothing indexed there (another drive, an excluded-from-index folder): look at names.
      via = 'scan';
      hits = await this.scan(q, words, signal);
    }
    if (words.length && (q.kind === 'any' || q.kind === 'picture')) hits = await this.withDescribed(hits, q);
    hits = hits.filter((h) => q.kind === 'any' || h.kind === q.kind);
    hits.sort((a, b) => rank(b, words) - rank(a, words) || (b.modified ?? '').localeCompare(a.modified ?? ''));
    return { hits: hits.slice(0, q.limit), via, ms: Date.now() - t0, total: hits.length };
  }

  private hit(p: string, isFolder: boolean, size: number | null, modified: string | null, words: string[]): FileHit {
    const name = path.basename(p);
    const lower = name.toLowerCase();
    const match = !words.length ? 'listing' : words.every((w) => lower.includes(w)) ? 'name' : 'content';
    return { path: p, name, folder: path.dirname(p), kind: kindOf(p, isFolder), size: isFolder ? null : size, modified, match };
  }

  /** Adds pictures whose description matches; a picture found by its name keeps that match. */
  private async withDescribed(hits: FileHit[], q: FileQuery): Promise<FileHit[]> {
    const found = this.d.described?.(q.text) ?? [];
    if (!found.length) return hits;
    const since = q.modifiedWithinDays ? Date.now() - q.modifiedWithinDays * 86400_000 : 0;
    const byPath = new Map(hits.map((h) => [h.path.toLowerCase(), h]));
    for (const p of found) {
      if (!this.allowed(p.path) || (q.folder && !isInside(p.path, q.folder)) || (since && p.mtimeMs < since)) continue;
      const known = byPath.get(p.path.toLowerCase());
      if (known) {
        known.description = p.description;
        if (known.match !== 'name') known.match = 'described';
        continue;
      }
      // Only while the picture is still the one that was described.
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(p.path);
      } catch {
        continue;
      }
      if (st.size !== p.size || Math.floor(st.mtimeMs) !== p.mtimeMs) continue;
      const h: FileHit = { path: p.path, name: path.basename(p.path), folder: path.dirname(p.path), kind: kindOf(p.path, false), size: st.size, modified: st.mtime.toISOString(), match: 'described', description: p.description };
      hits.push(h);
      byPath.set(p.path.toLowerCase(), h);
    }
    return hits;
  }

  /** Breadth-first over the allowed folders, names only, within a time budget. */
  private async scan(q: FileQuery, words: string[], signal: AbortSignal): Promise<FileHit[]> {
    const until = Date.now() + (this.d.scanBudgetMs ?? 2500);
    const since = q.modifiedWithinDays ? Date.now() - q.modifiedWithinDays * 86400_000 : 0;
    const queue = q.folder ? [q.folder] : [...this.d.roots()];
    const excluded = this.d.excluded();
    const out: FileHit[] = [];
    let seen = 0;
    while (queue.length && Date.now() < until && !signal.aborted && out.length < 400 && seen < 200_000) {
      const dir = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        seen++;
        const full = path.join(dir, e.name);
        const isDir = e.isDirectory();
        if (isDir) {
          if (SKIP_DIRS.has(e.name.toLowerCase()) || excluded.some((x) => isInside(full, x))) continue;
          queue.push(full);
        }
        if (!isDir && !e.isFile()) continue;
        const lower = e.name.toLowerCase();
        if (words.length && !words.every((w) => lower.includes(w))) continue;
        if (!words.length && q.kind === 'any' && !since) continue;
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
        if (since && st.mtimeMs < since) continue;
        out.push(this.hit(full, isDir, isDir ? null : st.size, st.mtime.toISOString(), words));
      }
    }
    return out;
  }
}

/** Whole-name matches first, then names that start with the words, then described pictures, then content-only matches. */
function rank(h: FileHit, words: string[]): number {
  if (!words.length) return 0;
  const base = path.parse(h.name).name.toLowerCase();
  let s = h.match === 'name' ? 10 : h.match === 'described' ? 6 : 0;
  if (base === words.join(' ')) s += 5;
  if (base.startsWith(words[0]!)) s += 2;
  return s;
}
