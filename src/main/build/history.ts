import fs from 'node:fs';
import path from 'node:path';

/**
 * A build's history: before Keo changes files, it keeps how they were, so "undo that" or "go back
 * to yesterday's version" works. Changes made close together (one request: many files, a long file
 * written in parts) form one version. Kept in the project's .keo-history folder, never published.
 */
export const HISTORY_DIR = '.keo-history';
/** Changes less than this apart belong to the same version. */
const SAME_VERSION_MS = 2 * 60_000;
/** Older changes are let go after this many. */
const KEEP = 400;

interface Change {
  n: number;
  /** The version it belongs to (the n of its first change). */
  version: number;
  at: string;
  /** Each file as it was before: existed false = it was new (undo removes it). */
  files: Array<{ rel: string; existed: boolean }>;
}

export interface BuildVersion {
  /** Going back to this version undoes it and everything after it. */
  version: number;
  at: string;
  lastAt: string;
  files: string[];
  changes: number;
}

function indexFile(dir: string): string {
  return path.join(dir, HISTORY_DIR, 'index.json');
}

function load(dir: string): Change[] {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(dir), 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Change[]) : [];
  } catch {
    return [];
  }
}

function save(dir: string, all: Change[]): void {
  fs.mkdirSync(path.join(dir, HISTORY_DIR), { recursive: true });
  fs.writeFileSync(indexFile(dir), JSON.stringify(all));
}

/** Keeps how these files are now, before Keo writes them. */
export function recordBefore(dir: string, rels: string[], now = new Date()): void {
  const files = [...new Set(rels)];
  if (!files.length) return;
  const all = load(dir);
  const last = all[all.length - 1];
  const n = (last?.n ?? 0) + 1;
  // A change after a passing check starts a new version, so "back to the last good one" is exact.
  const good = loadChecks(dir).good;
  const version = last && now.getTime() - new Date(last.at).getTime() < SAME_VERSION_MS && !(good && last.n <= good.n) ? last.version : n;
  const keep = path.join(dir, HISTORY_DIR, String(n));
  const change: Change = { n, version, at: now.toISOString(), files: [] };
  for (const rel of files) {
    const full = path.join(dir, rel);
    const existed = fs.existsSync(full);
    if (existed) {
      fs.mkdirSync(path.dirname(path.join(keep, rel)), { recursive: true });
      fs.copyFileSync(full, path.join(keep, rel));
    }
    change.files.push({ rel, existed });
  }
  all.push(change);
  // Let the oldest go.
  while (all.length > KEEP) {
    const old = all.shift()!;
    fs.rmSync(path.join(dir, HISTORY_DIR, String(old.n)), { recursive: true, force: true });
  }
  save(dir, all);
}

/** The versions, newest first. */
export function versions(dir: string): BuildVersion[] {
  const by = new Map<number, BuildVersion>();
  for (const c of load(dir)) {
    const v = by.get(c.version) ?? { version: c.version, at: c.at, lastAt: c.at, files: [], changes: 0 };
    v.lastAt = c.at;
    v.changes++;
    for (const f of c.files) if (!v.files.includes(f.rel)) v.files.push(f.rel);
    by.set(c.version, v);
  }
  return [...by.values()].sort((a, b) => b.version - a.version);
}

/**
 * Undoes a version and every later one (newest first): files go back to how they were, files that
 * were new are removed. No version given: the latest one. Returns what changed.
 */
export function goBack(dir: string, version?: number): { version: number; restored: string[]; removed: string[] } {
  const all = load(dir);
  const target = version ?? all[all.length - 1]?.version;
  if (target === undefined || !all.some((c) => c.version === target)) throw new Error('There is no such version to go back to.');
  const restored = new Set<string>();
  const removed = new Set<string>();
  const checks = loadChecks(dir);
  while (all.length && all[all.length - 1]!.version >= target) {
    const c = all.pop()!;
    // Going back past the last good check: that state is gone, and so is the last check's.
    if (checks.good && c.n <= checks.good.n) checks.good = null;
    checks.last = null;
    const keep = path.join(dir, HISTORY_DIR, String(c.n));
    for (const f of c.files) {
      const full = path.join(dir, f.rel);
      if (f.existed) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.copyFileSync(path.join(keep, f.rel), full);
        restored.add(f.rel);
        removed.delete(f.rel);
      } else {
        fs.rmSync(full, { force: true });
        removed.add(f.rel);
        restored.delete(f.rel);
      }
    }
    fs.rmSync(keep, { recursive: true, force: true });
  }
  save(dir, all);
  saveChecks(dir, checks);
  return { version: target, restored: [...restored].sort(), removed: [...removed].sort() };
}

/**
 * What the last check of the build found, and the last time it passed: Keo keeps fixing and checking
 * until a check after its latest change passes, and can go back to that last good state when fixes
 * only make it worse. `n` is the number of the latest change when the check ran.
 */
export interface BuildCheckRecord {
  at: string;
  ok: boolean;
  /** Short list of what was wrong (errors, missing files, actions that did not work). */
  problems: string[];
  n: number;
}

interface Checks {
  last: BuildCheckRecord | null;
  /** The last check that passed (and, for games and apps, actually used it). */
  good: { at: string; n: number } | null;
}

function checksFile(dir: string): string {
  return path.join(dir, HISTORY_DIR, 'checks.json');
}

function loadChecks(dir: string): Checks {
  try {
    const raw = JSON.parse(fs.readFileSync(checksFile(dir), 'utf8')) as Partial<Checks>;
    return { last: raw.last ?? null, good: raw.good ?? null };
  } catch {
    return { last: null, good: null };
  }
}

function saveChecks(dir: string, c: Checks): void {
  fs.mkdirSync(path.join(dir, HISTORY_DIR), { recursive: true });
  fs.writeFileSync(checksFile(dir), JSON.stringify(c));
}

const latestChange = (dir: string): number => load(dir).at(-1)?.n ?? 0;

/** Remembers a check of the build as it is now; good = it passed and proved it works. */
export function recordCheck(dir: string, r: { ok: boolean; good: boolean; problems: string[] }, now = new Date()): void {
  const c = loadChecks(dir);
  const n = latestChange(dir);
  c.last = { at: now.toISOString(), ok: r.ok, problems: r.problems.slice(0, 8).map((p) => p.slice(0, 200)), n };
  if (r.good) c.good = { at: now.toISOString(), n };
  saveChecks(dir, c);
}

export interface BuildCheckState {
  last: BuildCheckRecord | null;
  good: { at: string } | null;
  /** Files changed since the last check (or never checked after changes). */
  changedSinceCheck: boolean;
  /** Files changed since the last check that passed. */
  changedSinceGood: boolean;
}

export function checkState(dir: string): BuildCheckState {
  const c = loadChecks(dir);
  const n = latestChange(dir);
  return { last: c.last, good: c.good ? { at: c.good.at } : null, changedSinceCheck: n > (c.last?.n ?? 0), changedSinceGood: n > (c.good?.n ?? 0) };
}

/** Goes back to how the build was at its last passing check (every change since is undone). */
export function goBackToGood(dir: string): { version: number; restored: string[]; removed: string[] } {
  const good = loadChecks(dir).good;
  if (!good) throw new Error('This build has not passed a check yet, so there is no good version to go back to.');
  const first = load(dir).find((ch) => ch.n > good.n);
  if (!first) throw new Error('Nothing changed since the last good check.');
  return goBack(dir, first.version);
}
