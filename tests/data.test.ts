import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, openDatabase } from '../src/main/db/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/main/db/migrations';
import { resolveProfile } from '../src/main/env/profile';
import { Logger } from '../src/main/logging/logger';
import { ConversationRepo } from '../src/main/repos/conversations';
import { SecretStore } from '../src/main/secrets/secretStore';
import { SettingsStore } from '../src/main/settings/settingsStore';
import { defaultSettings } from '../src/shared/settings';
import { FakeCipher, makeHarness, tempDir, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('profile isolation', () => {
  it('uses Keo-only directories under its own namespace', () => {
    const p = resolveProfile('C:\\Users\\x\\AppData\\Roaming', {}, false);
    expect(p.userData).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'Keo', 'dev'));
    expect(resolveProfile('C:\\A', {}, true).profile).toBe('default');
    expect(resolveProfile('C:\\A', { KEO_PROFILE: 'qa' }, true).userData).toBe(path.join('C:\\A', 'Keo', 'qa'));
    // Invalid profile names fall back instead of escaping the namespace.
    expect(resolveProfile('C:\\A', { KEO_PROFILE: '..\\..\\Kira' }, false).userData).toBe(path.join('C:\\A', 'Keo', 'dev'));
  });
});

describe('database & migrations', () => {
  it('initialises the schema and is idempotent', () => {
    const dir = tempDir();
    const db = openDatabase(path.join(dir, 'keo.db'));
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.migrate()).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    expect(db.integrityOk()).toBe(true);
    db.close();
  });

  it('refuses to open a database from a newer build', () => {
    const db = new Database(':memory:');
    db.migrate([...MIGRATIONS, { version: 99, name: 'future', sql: 'CREATE TABLE future (x INTEGER);' }]);
    expect(() => db.migrate(MIGRATIONS)).toThrow(/newer than this build/);
    db.close();
  });

  it('rolls back a failing migration atomically', () => {
    const db = new Database(':memory:');
    expect(() => db.migrate([{ version: 1, name: 'bad', sql: 'CREATE TABLE a (x INTEGER); THIS IS NOT SQL;' }])).toThrow();
    expect(db.schemaVersion()).toBe(0);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'a'")?.n).toBe(0);
    db.close();
  });

  it('creates a consistent backup containing only Keo data', () => {
    h = makeHarness();
    h.services.conversations.create('backup me');
    const target = path.join(h.dir, 'backups', 'b.db');
    h.services.db.backupTo(target);
    const copy = new Database(target);
    expect(copy.get<{ n: number }>('SELECT count(*) AS n FROM conversations')?.n).toBe(1);
    copy.close();
  });
});

describe('conversation persistence', () => {
  it('survives an application restart', async () => {
    const dir = tempDir();
    h = makeHarness({ dir });
    const c = h.services.conversations.create('Persisted');
    h.services.conversations.addMessage({ conversationId: c.id, role: 'user', content: 'hello', status: 'complete' });
    await h.close();
    h = makeHarness({ dir });
    const again = h.services.conversations.list();
    expect(again.map((x) => x.title)).toEqual(['Persisted']);
    expect(h.services.conversations.messages(c.id)[0]?.content).toBe('hello');
  });

  it('marks streaming messages as interrupted on recovery', () => {
    const db = openDatabase(':memory:');
    const repo = new ConversationRepo(db);
    const c = repo.create();
    const m = repo.addMessage({ conversationId: c.id, role: 'assistant', content: 'partial', status: 'streaming' });
    expect(repo.markInterrupted()).toBe(1);
    expect(repo.getMessage(m.id)?.status).toBe('interrupted');
    expect(repo.getMessage(m.id)?.content).toBe('partial');
  });

  it('supports rename, search, project linking and cascading delete', () => {
    h = makeHarness();
    const s = h.services;
    const p = s.projects.create('Apollo');
    const c = s.conversations.create('First');
    s.conversations.addMessage({ conversationId: c.id, role: 'user', content: 'talk about rockets', status: 'complete' });
    s.conversations.rename(c.id, 'Renamed');
    s.conversations.setProject(c.id, p.id);
    expect(s.conversations.list({ query: 'rockets' }).map((x) => x.id)).toEqual([c.id]);
    expect(s.conversations.list({ query: '100%_' })).toEqual([]);
    expect(s.conversations.list({ projectId: p.id })[0]?.title).toBe('Renamed');
    expect(s.conversations.delete(c.id)).toBe(true);
    expect(s.db.get<{ n: number }>('SELECT count(*) AS n FROM messages')?.n).toBe(0);
  });
});

describe('settings', () => {
  it('defaults every execution permission to off', () => {
    const d = defaultSettings();
    expect(d.permissions.observationEnabled).toBe(false);
    expect(d.permissions.desktopControlEnabled).toBe(false);
    expect(d.permissions.launchEnabled).toBe(false);
    expect(d.permissions.visionExport).toEqual({ anthropic: false, openai: false, openrouter: false, local: false });
    expect(d.voice.audioExportConsent).toBe(false);
    expect(d.activeProvider).toBeNull();
  });

  it('rejects invalid patches and unknown keys without persisting them', () => {
    const dir = tempDir();
    const st = new SettingsStore(dir, new Logger(null));
    expect(() => st.update({ permissions: { desktopControlEnabled: 'yes' } })).toThrow();
    expect(() => st.update({ surprise: true })).toThrow();
    expect(() => st.update({ providers: { local: { baseUrl: 'javascript:alert(1)' } } })).toThrow();
    expect(st.get().permissions.desktopControlEnabled).toBe(false);
    const ok = st.update({ agent: { memoryTopK: 3 } });
    expect(ok.agent.memoryTopK).toBe(3);
    expect(new SettingsStore(dir, new Logger(null)).get().agent.memoryTopK).toBe(3);
  });

  it('ignores prototype-pollution keys', () => {
    const st = new SettingsStore(tempDir(), new Logger(null));
    st.update(JSON.parse('{"__proto__": {"polluted": true}, "agent": {"memoryTopK": 4}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('quarantines a corrupt settings file and falls back to safe defaults', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"permissions": {"desktopControlEnabled": true, "bogus": 1}');
    const st = new SettingsStore(dir, new Logger(null));
    expect(st.get().permissions.desktopControlEnabled).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('settings.invalid-'))).toBe(true);
  });
});

describe('secret storage', () => {
  it('never writes plaintext and refuses when OS encryption is unavailable', () => {
    const dir = tempDir();
    const store = new SecretStore(dir, new FakeCipher(true));
    store.set('anthropic', 'sk-ant-api03-SECRETVALUE123456');
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('SECRETVALUE');
    expect(store.get('anthropic')).toBe('sk-ant-api03-SECRETVALUE123456');
    const locked = new SecretStore(tempDir(), new FakeCipher(false));
    expect(() => locked.set('openai', 'sk-test-abcdefghijklmnopqrst')).toThrow(/unavailable/);
  });
});
