import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SelfTestResult, SelfTestStep } from '../../shared/domain';
import type { DesktopBackend, UiaNodeRaw } from './backend';

export type { SelfTestStep };
export type SelfTestReport = SelfTestResult;

/** A disposable test window in its own process (never one of the user's apps). */
export interface TestWindow {
  pid: number;
  title: string;
  close(): void;
}

export interface SelfTestDeps {
  backend: DesktopBackend;
  launch(title: string): TestWindow;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Polling interval/timeout for the window to appear (tests shorten them). */
  findTimeoutMs?: number;
}

const ADVICE: Record<SelfTestStep['id'], string> = {
  helper: 'Keo’s desktop helper (Windows PowerShell) could not start. Check that PowerShell isn’t blocked by antivirus or company policy.',
  window: 'The test window did not appear. Antivirus or company policy may be blocking PowerShell windows.',
  focus: 'Windows refused to bring the window to the front. Close full-screen apps and try again without touching the mouse or keyboard.',
  type: 'Typing did not arrive. If Keo runs normally but the app runs as administrator, Windows blocks input — run both the same way.',
  paste: 'Pasting did not arrive. Another program may be locking the clipboard (clipboard managers, remote desktop).',
  read: 'Keo could not read text back through UI Automation. Accessibility may be restricted on this computer.',
  click: 'Keo could not press a button through UI Automation.',
};

/**
 * "Check this computer": proves, on a throw-away window Keo opens itself,
 * that the desktop helper can find, focus, type, paste, read and click.
 * Nothing is done to the user's own windows; the clipboard is restored.
 */
export async function runSelfTest(d: SelfTestDeps): Promise<SelfTestReport> {
  const steps: SelfTestStep[] = [];
  const nonce = Math.random().toString(36).slice(2, 8);
  const title = `Keo self-test ${nonce}`;
  let win: TestWindow | null = null;
  let hwnd: string | null = null;

  const step = async (id: SelfTestStep['id'], title: string, fn: () => Promise<string>): Promise<boolean> => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ id, title, ok: true, ms: Date.now() - t0, detail });
      return true;
    } catch (e) {
      steps.push({ id, title, ok: false, ms: Date.now() - t0, detail: ((e as Error).message || 'failed').slice(0, 300) });
      return false;
    }
  };
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const read = async () => (await d.backend.readText(hwnd!)) ?? '';

  try {
    const run = async () => {
      if (
        !(await step('helper', 'Start the desktop helper', async () => {
          const sup = d.backend.support();
          if (!sup.supported) fail(sup.reason ?? 'unsupported');
          const info = await d.backend.helperInfo?.();
          if (info && !info.pong) fail('no answer');
          return info?.dpi ? `DPI mode ${info.dpi}` : 'running';
        }))
      )
        return;

      if (
        !(await step('window', 'Open a test window', async () => {
          win = d.launch(title);
          const until = Date.now() + (d.findTimeoutMs ?? 15000);
          while (Date.now() < until) {
            const w = (await d.backend.list()).find((x) => x.pid === win!.pid || x.title === title);
            if (w) {
              hwnd = w.hwnd;
              return `found (${w.width}×${w.height})`;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          return fail('not found');
        }))
      )
        return;

      if (
        !(await step('focus', 'Bring it to the front', async () => {
          const r = await d.backend.focus(hwnd!);
          if (!r.foreground) fail('Windows kept another window in front');
          return 'foreground';
        }))
      )
        return;

      const typed = `typed ${nonce} 123`;
      await step('type', 'Type text', async () => {
        const t = await d.backend.typeText(hwnd!, typed);
        await new Promise((r) => setTimeout(r, 150));
        if (!(await read()).includes(typed)) fail('the text did not appear');
        return t.method === 'direct' ? `${typed.length} characters — typed directly, because Windows blocks simulated keys from Keo on this PC (shortcuts like Ctrl+T can’t work)` : `${typed.length} characters`;
      });

      const pasted = `pasted ${nonce} ✓ 456`;
      await step('paste', 'Paste text', async () => {
        const saved = await d.clipboard.readText().catch(() => '');
        try {
          await d.clipboard.writeText(pasted);
          await d.backend.focus(hwnd!);
          await d.backend.paste(hwnd!);
          await new Promise((r) => setTimeout(r, 200));
        } finally {
          await d.clipboard.writeText(saved).catch(() => undefined);
        }
        if (!(await read()).includes(pasted)) fail('the pasted text did not appear');
        return 'clipboard restored';
      });

      await step('read', 'Read the window', async () => {
        const snap = await d.backend.uiaSnapshot(hwnd!, { maxNodes: 200, maxDepth: 8, budgetMs: 3000 });
        if (!snap.nodes.length) fail('no elements');
        return `${snap.nodes.length} elements`;
      });

      await step('click', 'Press a button', async () => {
        const find = async () => (await d.backend.uiaSnapshot(hwnd!, { maxNodes: 200, maxDepth: 8, budgetMs: 3000 })).nodes.find((n: UiaNodeRaw) => n.role === 'button' && /press me|clicked/i.test(n.name));
        const btn = (await find()) ?? fail('button not found');
        await d.backend.uiaAct(hwnd!, btn.rid, 'invoke');
        await new Promise((r) => setTimeout(r, 150));
        const after = await d.backend.uiaDescribe(hwnd!, btn.rid);
        if (!after || !/clicked/i.test(after.name)) fail('the button did not respond');
        return 'pressed';
      });
    };
    await run();
  } finally {
    try {
      (win as TestWindow | null)?.close();
    } catch {
      /* already closed */
    }
  }
  const bad = steps.find((s) => !s.ok);
  return { ok: !bad, steps, advice: bad ? ADVICE[bad.id] : null };
}

/** WinForms test window in a separate Windows PowerShell process. */
export function launchPowerShellTestWindow(title: string): TestWindow {
  const safe = title.replace(/[^A-Za-z0-9 -]/g, '');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = '${safe}'
$f.Width = 520; $f.Height = 320; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$t = New-Object System.Windows.Forms.TextBox
$t.Multiline = $true; $t.Dock = 'Fill'; $t.AccessibleName = 'Test text'
$b = New-Object System.Windows.Forms.Button
$b.Text = 'Press me'; $b.Dock = 'Bottom'; $b.Height = 40
$b.Add_Click({ $b.Text = 'Clicked' })
$f.Controls.Add($t); $f.Controls.Add($b)
$f.Add_Shown({ $t.Focus() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000; $timer.Add_Tick({ $f.Close() }); $timer.Start()
[void]$f.ShowDialog()
`;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: false,
    stdio: 'ignore',
  });
  return {
    pid: proc.pid ?? -1,
    title: safe,
    close: () => {
      if (proc.exitCode === null) proc.kill();
    },
  };
}
