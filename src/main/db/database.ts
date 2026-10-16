import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { KeoError, nowIso } from '../util/errors';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations';

export type Params = SQLInputValue[];
type Row = Record<string, unknown>;

/**
 * Thin wrapper over Node's built-in synchronous SQLite (node:sqlite). Chosen
 * over native addons so Keo ships no compiled modules that must be rebuilt
 * against Electron's ABI. All statements use bound parameters.
 */
export class Database {
  readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  run(sql: string, params: Params = []): { changes: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Runs fn atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.txDepth--;
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  schemaVersion(): number {
    const exists = this.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    );
    if (!exists || exists.n === 0) return 0;
    const r = this.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
    return r?.v ?? 0;
  }

  migrate(migrations: Migration[] = MIGRATIONS): { from: number; to: number } {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const from = this.schemaVersion();
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    if (from > latest) {
      throw new KeoError(
        'db_too_new',
        `Database schema v${from} is newer than this build supports (v${latest}). Refusing to open to avoid data loss.`,
      );
    }
    for (const m of migrations) {
      if (m.version <= from) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.name,
          nowIso(),
        ]);
      });
    }
    return { from, to: this.schemaVersion() };
  }

  integrityOk(): boolean {
    const r = this.get<{ integrity_check: string }>('PRAGMA integrity_check');
    return r?.integrity_check === 'ok';
  }

  /** Consistent online copy of the database (Keo data only). */
  backupTo(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export function openDatabase(file: string): Database {
  const db = new Database(file);
  db.migrate();
  return db;
}

export { LATEST_SCHEMA_VERSION };

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
