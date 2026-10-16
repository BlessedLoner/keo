import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { INVOKE_CHANNELS } from '../src/shared/channels';
import { invokeSchemas } from '../src/shared/ipc';
import { builtinCapabilities, parseKeyCombo } from '../src/main/capabilities/builtins';
import { defineCapability } from '../src/main/capabilities/types';
import { createHandlers } from '../src/main/ipc/handlers';
import { dispatch, originOf, senderAllowed, type SenderPolicy } from '../src/main/ipc/router';
import { Logger } from '../src/main/logging/logger';
import { containsSecret, redact, redactString } from '../src/main/logging/redact';
import { isLoopbackUrl } from '../src/main/providers/openaiCompat';
import { buildCsp } from '../src/main/window/csp';
import { makeHarness, tempDir, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const policy: SenderPolicy = { trustedOrigin: 'app://keo', trustedWebContentsId: () => 7 };
const good = { senderId: 7, frameUrl: 'app://keo/index.html', isMainFrame: true };
const host = { appInfo: () => ({ name: 'Keo', version: 't', electron: '', chrome: '', node: '', platform: '', packaged: false, testProviderEnabled: true }), openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined };

describe('IPC boundary', () => {
  it('preload allow-list matches the schema table exactly', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(Object.keys(invokeSchemas).sort());
  });

  it('rejects invalid senders', () => {
    expect(senderAllowed(good, policy).ok).toBe(true);
    expect(senderAllowed({ ...good, senderId: 8 }, policy).reason).toBe('unknown_webcontents');
    expect(senderAllowed({ ...good, isMainFrame: false }, policy).reason).toBe('subframe');
    expect(senderAllowed({ ...good, frameUrl: 'https://evil.example/' }, policy).reason).toBe('untrusted_origin');
    expect(senderAllowed({ ...good, frameUrl: 'file:///C:/x.html' }, policy).ok).toBe(false);
    expect(senderAllowed({ ...good, frameUrl: null }, policy).ok).toBe(false);
    expect(senderAllowed(good, { ...policy, trustedWebContentsId: () => null }).ok).toBe(false);
    expect(senderAllowed({ ...good, frameUrl: 'app://keo.evil/index.html' }, policy).ok).toBe(false);
    expect(originOf('app://keo/x')).toBe('app://keo');
    expect(originOf('http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('validates every request and never leaks internals', async () => {
    h = makeHarness();
    const handlers = createHandlers(h.services, host);
    const log = new Logger(null);
    const bad = await dispatch('conversations:create', { title: 'x' }, { ...good, frameUrl: 'https://evil.example/' }, handlers, policy, log);
    expect(bad).toEqual({ ok: false, error: { code: 'forbidden', message: 'Request rejected.' } });
    expect(h.services.conversations.list()).toHaveLength(0);

    const unknown = await dispatch('fs:readFile', {}, good, handlers, policy, log);
    expect(unknown.ok).toBe(false);
    const extra = await dispatch('conversations:create', { title: 'x', admin: true }, good, handlers, policy, log);
    expect(extra.ok === false && extra.error.code).toBe('invalid_input');
    const wrongType = await dispatch('tasks:approveStep', { stepId: 'abcdefgh', inputHash: 'nothex' }, good, handlers, policy, log);
    expect(wrongType.ok).toBe(false);

    const ok = await dispatch('conversations:create', { title: 'fine' }, good, handlers, policy, log);
    expect(ok.ok).toBe(true);
    const notFound = await dispatch('conversations:rename', { id: 'doesnotexist', title: 'x' }, good, handlers, policy, log);
    expect(notFound).toEqual({ ok: false, error: { code: 'not_found', message: 'Conversation not found.' } });
  });

  it('never returns API keys to the renderer', async () => {
    h = makeHarness();
    const handlers = createHandlers(h.services, host);
    const list = await handlers['providers:setKey']({ providerId: 'anthropic', apiKey: 'sk-ant-api03-TOPSECRET-123456789' });
    expect(JSON.stringify(list)).not.toContain('TOPSECRET');
    expect(list.find((p) => p.id === 'anthropic')?.hasApiKey).toBe(true);
  });

  it('records permission changes in the audit trail', async () => {
    h = makeHarness();
    const handlers = createHandlers(h.services, host);
    await handlers['settings:update']({ patch: { permissions: { desktopControlEnabled: true } } });
    expect(h.services.audit.recent(5).some((a) => a.decision === 'desktopControlEnabled=true')).toBe(true);
  });
});

describe('capability registry', () => {
  it('every built-in capability declares a complete contract', () => {
    h = makeHarness();
    const caps = h.services.registry.list();
    expect(caps.length).toBeGreaterThanOrEqual(15);
    for (const c of caps) {
      expect(c.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.timeoutMs).toBeGreaterThan(0);
      expect(c.inputSchema).toBeTruthy();
      expect(c.outputSchema).toBeTruthy();
      if (c.consequential) expect(c.requiresApproval).toBe(true);
      if (c.permissions.includes('desktop.control')) expect(c.requiresApproval).toBe(true);
    }
  });

  it('refuses to register a consequential capability without approval', () => {
    h = makeHarness();
    const bad = defineCapability({
      id: 'test.sneaky',
      version: '1.0.0',
      title: 'x',
      description: 'x',
      input: z.object({}).strict(),
      output: z.unknown(),
      risk: 'high',
      approval: 'never',
      permissions: [],
      consequential: true,
      idempotent: false,
      timeoutMs: 1000,
      maxAttempts: 1,
      modelVisible: true,
      verificationPolicy: '',
      preview: () => ({ summary: '', target: null, consequences: [], dataExport: null }),
      auditView: () => ({}),
      execute: async () => null,
    });
    expect(() => h.services.registry.register(bad)).toThrow(/must require approval/);
    expect(() => h.services.registry.register({ ...bad, id: 'memory.search', consequential: false })).toThrow(/Duplicate/);
  });

  it('desktop targets must be allow-listed before admission', () => {
    h = makeHarness();
    h.services.settings.update({ permissions: { desktopControlEnabled: true } });
    const a = h.services.registry.admit({ capabilityId: 'desktop.click', input: { target: { hwnd: '1', pid: 1, processName: 'cmd' }, x: 1, y: 1 }, origin: 'model', correlationId: 'c' });
    expect(a.ok === false && a.code).toBe('precondition_failed');
  });

  it('only exposes key combos without the Windows key', () => {
    expect(parseKeyCombo('ctrl+s')).toEqual({ mods: [0x11], key: 0x53 });
    expect(parseKeyCombo('win+r')).toBeNull();
    expect(parseKeyCombo('ctrl+ctrl+s')).toBeNull();
    expect(parseKeyCombo('ctrl+alt+delete')).not.toBeNull();
    expect(parseKeyCombo('rm -rf')).toBeNull();
  });

  it('built-ins are constructible without Electron', () => {
    h = makeHarness();
    expect(builtinCapabilities).toBeTypeOf('function');
  });
});

describe('logging & redaction', () => {
  it('masks credentials and drops content-bearing fields', () => {
    expect(redactString('key sk-ant-api03-abcdefghijklmnopqrstu end')).toBe('key [REDACTED_KEY] end');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED_AUTH]');
    expect(redactString('card 4111 1111 1111 1111')).toContain('[REDACTED_NUMBER]');
    const r = redact({ apiKey: 'sk-1234567890abcdefghij', prompt: 'my secret plans', content: 'private', count: 3, nested: { authorization: 'x' } }) as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toContain('secret plans');
    expect(JSON.stringify(r)).not.toContain('private');
    expect(r.count).toBe(3);
    expect(containsSecret('password: hunter2')).toBe(true);
    expect(containsSecret('I like passwords managers')).toBe(false);
  });

  it('writes no API keys or conversation text to the log file', async () => {
    const dir = tempDir();
    h = makeHarness({ dir, script: () => ({ text: 'Your SSN is safe with me', toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined }) });
    h.services.providers.setKey('anthropic', 'sk-ant-api03-LOGLEAKCHECK-0000000');
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'my diary entry: very private words').done;
    h.services.log.info('test.event', { apiKey: 'sk-ant-api03-LOGLEAKCHECK-0000000', text: 'very private words' });
    await h.close();
    const logText = fs.readdirSync(path.join(dir, 'logs')).map((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n');
    expect(logText.length).toBeGreaterThan(100);
    expect(logText).not.toContain('LOGLEAKCHECK');
    expect(logText).not.toContain('very private words');
    expect(logText).not.toContain('SSN is safe');
    h = makeHarness(); // for afterEach
  });
});

describe('network & content policy', () => {
  it('production CSP forbids inline script, eval and remote connections', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('the local provider only accepts loopback addresses', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.5:11434/v1')).toBe(false);
    expect(isLoopbackUrl('http://localhost.evil.com/v1')).toBe(false);
    h = makeHarness();
    h.services.settings.update({ providers: { local: { baseUrl: 'http://10.0.0.2:11434/v1', model: 'm' } } });
    expect(h.services.providers.get('local').status().kind).toBe('error');
  });
});
