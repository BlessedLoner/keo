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
