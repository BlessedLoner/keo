import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isBlank as isBlankForTest } from '../src/main/vision/blank';
import { DesktopService } from '../src/main/desktop/desktopService';
import { chrome, makeHarness, notepad, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function allowNotepad(h: Harness, extra: Record<string, unknown> = {}) {
  h.services.settings.update({ permissions: { observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }], ...extra } });
}

describe('target identity', () => {
  it('revalidates identity and never substitutes another window', async () => {
    h = makeHarness();
    allowNotepad(h);
    const s = h.services.settings.get();
    const d = new DesktopService(h.desktop);
    await expect(d.resolve(notepad, s)).resolves.toMatchObject({ hwnd: '1001' });
    await expect(d.resolve({ ...notepad, pid: 9999 }, s)).rejects.toMatchObject({ code: 'target_changed' });
    await expect(d.resolve({ ...notepad, hwnd: '4040' }, s)).rejects.toMatchObject({ code: 'target_gone' });
    await expect(d.resolve(chrome, s)).rejects.toMatchObject({ code: 'target_not_allowed' });
    // Same hwnd reused by a different, allow-listed-looking process is still refused.
    h.desktop.windows[0]!.pid = 1234;
    await expect(d.resolve(notepad, s)).rejects.toMatchObject({ code: 'target_changed' });
  });
});

describe('capture provenance', () => {
  it('records a fresh observation with identity, time and hash', async () => {
    h = makeHarness();
    allowNotepad(h);
    const o = await h.services.vision.capture(notepad, h.services.settings.get(), 'user', null);
    expect(o.fresh).toBe(true);
    expect(o.target).toMatchObject({ hwnd: '1001', processName: 'notepad' });
    expect(o.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(h.dir, 'observations', `${o.id}.png`))).toBe(true);
    const o2 = await h.services.vision.capture(notepad, h.services.settings.get(), 'user', null);
    expect(o2.id).not.toBe(o.id);
    expect(o2.sha256).not.toBe(o.sha256);
    expect(h.capture.calls).toHaveLength(2); // repeated request = new capture
    // Requested at the window's own size, so the image is never scaled up past the window's pixels.
    const w = h.desktop.windows.find((x) => x.hwnd === '1001')!;
    expect(h.capture.sizes[0]).toEqual({ width: w.width, height: w.height });
  });

  it.each([
    ['source_not_found', { ok: false as const, code: 'source_not_found' as const, message: 'gone' }],
    ['blank_capture', { ok: false as const, code: 'blank_capture' as const, message: 'blank' }],
  ])('a failed capture (%s) produces no observation', async (code, outcome) => {
    h = makeHarness();
    allowNotepad(h);
    h.capture.next = outcome;
    await expect(h.services.vision.capture(notepad, h.services.settings.get(), 'user', null)).rejects.toMatchObject({ code });
    expect(h.services.vision.list(10)).toHaveLength(0);
  });

  it('refuses minimized windows and disabled observation', async () => {
    h = makeHarness();
    await expect(h.services.vision.capture(notepad, h.services.settings.get(), 'user', null)).rejects.toMatchObject({ code: 'permission_disabled' });
    allowNotepad(h);
    h.desktop.windows[0]!.minimized = true;
    await expect(h.services.vision.capture(notepad, h.services.settings.get(), 'user', null)).rejects.toMatchObject({ code: 'target_minimized' });
    expect(h.capture.calls).toHaveLength(0);
  });

  it('stored observations are distinguishable from fresh captures', async () => {
    h = makeHarness();
    allowNotepad(h);
    const o = await h.services.vision.capture(notepad, h.services.settings.get(), 'user', null);
    const cap = h.services.registry.admit({ capabilityId: 'vision.get_observation', input: { observationId: o.id }, origin: 'model', correlationId: 'c' });
    if (!cap.ok) throw new Error(cap.reason);
    const out = (await h.services.registry.runDirect(cap, { signal: new AbortController().signal, idempotencyKey: 'k', correlationId: 'c', conversationId: null, sourceMessageId: null, taskId: null, settings: h.services.settings.get() })) as { fresh: boolean; capturedAt: string };
    expect(out.fresh).toBe(false);
    expect(out.capturedAt).toBe(o.capturedAt);
  });

  it('analysis requires an explicit export permission for the destination', async () => {
    h = makeHarness();
    allowNotepad(h);
    h.services.settings.update({ activeProvider: 'anthropic' });
    const o = await h.services.vision.capture(notepad, h.services.settings.get(), 'user', null);
    // Anthropic has no key -> unavailable; switch to test provider (in-process) which needs no export.
    await expect(h.services.vision.analyze(o.id, 'what?', h.services.settings.get(), new AbortController().signal)).rejects.toThrow();
    h.services.settings.update({ activeProvider: 'test' });
    h.provider.setScript(() => ({ text: 'A notepad window with text.', toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined }));
    const a = await h.services.vision.analyze(o.id, 'what?', h.services.settings.get(), new AbortController().signal);
    expect(a.observationId).toBe(o.id);
    expect(h.provider.lastRequest!.messages[0]!.content[0]!.type).toBe('image');
    expect(h.services.vision.exportAllowed('anthropic', h.services.settings.get())).toBe(false);
  });

  it('vision.observe_window precheck blocks undeclared export destinations', () => {
    h = makeHarness();
    allowNotepad(h);
    h.services.settings.update({ activeProvider: 'anthropic' });
    const a = h.services.registry.admit({ capabilityId: 'vision.observe_window', input: { target: notepad, question: 'what?' }, origin: 'model', correlationId: 'c' });
    expect(a.ok === false && a.reason).toMatch(/not enabled/);
  });

  it('retention purges images but keeps provenance metadata', async () => {
    h = makeHarness();
    allowNotepad(h);
    const o = await h.services.vision.capture(notepad, h.services.settings.get(), 'user', null);
    expect(h.services.vision.purgeExpired(-1)).toBe(1);
    expect(h.services.vision.readImage(o.id)).toBeNull();
    expect(h.services.vision.get(o.id)?.hasImage).toBe(false);
    expect(h.services.vision.get(o.id)?.sha256).toBe(o.sha256);
  });

  it('blank-detection flags single-colour frames', () => {
    expect(isBlankForTest(Buffer.alloc(100 * 100 * 4), 100, 100)).toBe(true);
    const b = Buffer.alloc(100 * 100 * 4);
    b.writeUInt32LE(0xffffffff, (50 * 100 + 50) * 4);
    expect(isBlankForTest(b, 100, 100)).toBe(false);
  });
});
