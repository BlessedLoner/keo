import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { launchPowerShellTestWindow, runSelfTest } from '../src/main/desktop/selfTest';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual check on a real Windows desktop (opens Keo's own test window, types,
 * pastes, reads, clicks): KEO_LIVE_SELFTEST=1 npx vitest run tests/live-selftest.test.ts
 * Result: %TEMP%/keo-live-selftest/result.json. Skipped otherwise.
 */
it.runIf(process.env.KEO_LIVE_SELFTEST === '1')('live self-test', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-selftest');
  const b = new Win32Backend(dir, new Logger(dir, false));
  const ps = (cmd: string, input?: string) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { input, encoding: 'utf8' });
  const clipboard = {
    readText: async () => Buffer.from(ps("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw)))").trim(), 'base64').toString('utf8'),
    writeText: async (t: string) => void ps(t ? `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(t, 'utf8').toString('base64')}')))` : 'Set-Clipboard -Value $null'),
  };
  const r = await runSelfTest({ backend: b, launch: launchPowerShellTestWindow, clipboard });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1));
  b.dispose();
}, 90000);

/** Direct delivery (used when Windows refuses simulated input), on the same test window. */
it.runIf(process.env.KEO_LIVE_SELFTEST === '1')('live direct delivery', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-selftest');
  const b = new Win32Backend(dir, new Logger(dir, false));
  const call = (cmd: string, args: Record<string, unknown>) => (b as unknown as { call(c: string, a: Record<string, unknown>, t?: number): Promise<unknown> }).call(cmd, args, 20000);
  const w = launchPowerShellTestWindow('Keo self-test direct');
  let hwnd = '';
  for (let i = 0; i < 60 && !hwnd; i++) {
    hwnd = (await b.list()).find((x) => x.pid === w.pid)?.hwnd ?? '';
    await new Promise((r) => setTimeout(r, 250));
  }
  const out: Record<string, unknown> = {};
  try {
    out.focus = await b.focus(hwnd);
    out.text = await call('post_text', { hwnd, text: 'direct é 123\nline two' });
    out.key = await call('post_key', { hwnd, key: 0x08 }); // backspace
    out.readBack = await b.readText(hwnd);
    const snap = await b.uiaSnapshot(hwnd, { maxNodes: 50, maxDepth: 6, budgetMs: 3000 });
    const btn = snap.nodes.find((n) => n.role === 'button' && /press me/i.test(n.name))!;
    const c = await b.uiaCenter(hwnd, btn.rid);
    out.click = await call('post_click_screen', { hwnd, x: Math.round(c.x), y: Math.round(c.y) });
    await new Promise((r) => setTimeout(r, 200));
    out.button = (await b.uiaDescribe(hwnd, btn.rid))?.name;
  } finally {
    fs.writeFileSync(path.join(dir, 'direct.json'), JSON.stringify(out, null, 1));
    w.close();
    b.dispose();
  }
}, 90000);
