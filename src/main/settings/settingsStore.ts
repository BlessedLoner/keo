import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, mergeSettings, SettingsSchema, type Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';

/**
 * Validated settings persisted as JSON in Keo's profile. Invalid or corrupt
 * files are preserved as *.invalid-<ts>.json and replaced by defaults, so a bad
 * edit can never disable validation or silently enable a permission.
 */
export class SettingsStore {
  private current: Settings;
  private readonly file: string;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(
    dir: string,
    private readonly log: Logger,
  ) {
    this.file = path.join(dir, 'settings.json');
    this.current = this.load();
  }

  private load(): Settings {
    if (!fs.existsSync(this.file)) return defaultSettings();
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (parsed.success) return parsed.data;
      this.quarantine('schema_invalid');
    } catch {
      this.quarantine('unparseable');
    }
    return defaultSettings();
  }

  private quarantine(reason: string): void {
    const target = this.file.replace(/\.json$/, `.invalid-${Date.now()}.json`);
    try {
      fs.renameSync(this.file, target);
    } catch {
      /* ignore */
    }
    this.log.warn('settings.reset_to_defaults', { reason });
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  update(patch: Record<string, unknown>): Settings {
    const next = mergeSettings(this.current, patch);
    this.persist(next);
    return this.get();
  }

  replace(next: Settings): Settings {
    this.persist(SettingsSchema.parse(next));
    return this.get();
  }

  private persist(next: Settings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    this.current = next;
    for (const l of this.listeners) l(this.get());
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
