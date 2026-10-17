import { describe, expect, it } from 'vitest';
import { runSelfTest } from '../src/main/desktop/selfTest';
import type { UiaNodeRaw } from '../src/main/desktop/backend';
import { FakeDesktop } from './helpers';

/** The throw-away test window, simulated: a text box and a "Press me" button. */
function setup() {
  const desk = new FakeDesktop();
  let clip = 'user clipboard';
  const clipboard = { readText: async () => clip, writeText: async (t: string) => void (clip = t) };
  desk.clipboardSource = clipboard;
  let label = 'Press me';
  let closed = false;
  const launch = (title: string) => {
    desk.addApp(
      { hwnd: '7001', pid: 9001, processName: 'powershell', title, className: 'WindowsForms10', minimized: false, x: 0, y: 0, width: 520, height: 320, foreground: false },
      {
        window: { w: 520, h: 320, x: 0, y: 0 },
        extraWindows: [],
        nodes: (): UiaNodeRaw[] => [
          { rid: 'rid.win', role: 'window', name: title, depth: 0, parent: -1 },
          { rid: 'rid.text', role: 'edit', name: 'Test text', depth: 1, parent: 0 },
          { rid: 'rid.btn', role: 'button', name: label, depth: 1, parent: 0 },
        ],
        act: (rid) => {
          if (rid === 'rid.btn') label = 'Clicked';
          return 'invoke';
        },
      },
    );
    return { pid: 9001, title, close: () => void (closed = true) };
  };
  return { desk, clipboard, launch, closed: () => closed, clip: () => clip };
}

describe('Check this computer (self-test)', () => {
  it('passes every step on a working computer, only touches its own window and restores the clipboard', async () => {
    const t = setup();
    const r = await runSelfTest({ backend: t.desk, launch: t.launch, clipboard: t.clipboard, findTimeoutMs: 1000 });
    expect(r.steps.map((s) => [s.id, s.ok])).toEqual([
      ['helper', true],
      ['window', true],
      ['focus', true],
      ['type', true],
      ['paste', true],
      ['read', true],
      ['click', true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.advice).toBeNull();
    expect(t.desk.inputCalls().every((c) => c.args[0] === '7001')).toBe(true);
    expect(t.clip()).toBe('user clipboard');
    expect(t.closed()).toBe(true);
  });

  it('pinpoints the failing step with advice (e.g. typing blocked)', async () => {
    const t = setup();
    t.desk.typeText = async (_h, text) => ({ chars: text.length }); // input swallowed (e.g. elevated app)
    const r = await runSelfTest({ backend: t.desk, launch: t.launch, clipboard: t.clipboard, findTimeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === 'type')?.ok).toBe(false);
    expect(r.advice).toMatch(/Typing did not arrive/);
    expect(t.closed()).toBe(true);
  });

  it('stops early when Windows refuses focus', async () => {
    const t = setup();
    t.desk.focusAllowed = false;
    const r = await runSelfTest({ backend: t.desk, launch: t.launch, clipboard: t.clipboard, findTimeoutMs: 1000 });
    expect(r.steps.map((s) => s.id)).toEqual(['helper', 'window', 'focus']);
    expect(r.advice).toMatch(/bring the window to the front/);
    expect(t.desk.calls.some((c) => c.op === 'type')).toBe(false);
  });
});

describe('diagnostic report', () => {
  it('lists versions, switches and error codes — never keys, app names or typed text', async () => {
    const { diagnosticReport } = await import('../src/main/desktop/diagnosticReport');
    const { SettingsSchema } = await import('../src/shared/settings');
    const settings = SettingsSchema.parse({ activeProvider: 'openai', permissions: { observationEnabled: true, allowedApps: [{ processName: 'SecretBankApp', label: 'My Bank' }], visionExport: { openai: true } } });
    const t = setup();
    const report = await runSelfTest({ backend: t.desk, launch: t.launch, clipboard: t.clipboard, findTimeoutMs: 1000 });
    const text = diagnosticReport({
      version: '1.1.0',
      packaged: true,
      electron: '44.7.2',
      settings,
      providersWithKeys: ['openai'],
      speech: { kind: 'modern', fallbackReason: null, wakeStatus: 'listening' },
      displays: [{ width: 1920, height: 1080, scale: 1.25, primary: true }],
      selfTest: { at: '2026-10-17T10:00:00Z', report },
      recentFailures: [{ capabilityId: 'desktop.type_text', code: 'not_foreground' }],
    });
    expect(text).toMatch(/Keo 1\.1\.0/);
    expect(text).toMatch(/1920×1080 @125% \(main\)/);
    expect(text).toMatch(/1 allowed apps, screenshots to openai/);
    expect(text).toMatch(/Self-test .*PASSED/);
    expect(text).toMatch(/desktop\.type_text:not_foreground/);
    expect(text).not.toMatch(/SecretBankApp|My Bank|typed |pasted /);
  });
});
