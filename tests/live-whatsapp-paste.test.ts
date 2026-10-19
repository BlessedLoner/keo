import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { analyzeWhatsApp } from '../src/main/desktop/whatsapp';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual check: can a picture be pasted into the WhatsApp app's message box? Works only in the
 * user's own chat ("<name> (You)"), never presses Send, and closes any attachment preview with
 * Escape. Writes control roles/names of the preview only (no message text).
 * KEO_LIVE_WA_PASTE=<picture.png> npx vitest run tests/live-whatsapp-paste.test.ts
 */
it.runIf(!!process.env.KEO_LIVE_WA_PASTE)('pastes a picture into my own chat without sending', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  fs.mkdirSync(dir, { recursive: true });
  const b = new Win32Backend(dir, new Logger(dir, false));
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const read = async (hwnd: string) => {
    const s = await b.uiaSnapshot(hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    return { nodes: s.nodes, view: analyzeWhatsApp(s.nodes, s.window) };
  };
  const controls = (nodes: Array<{ role: string; name: string; offscreen?: boolean }>) => nodes.filter((n) => ['edit', 'button', 'dialog'].includes(n.role) && !n.offscreen).map((n) => `${n.role}:${n.name.slice(0, 40)}`);
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName))!;
    out.focused = (await b.focus(w.hwnd)).foreground;
    await sleep(500);
    const v0 = await read(w.hwnd);
    out.header = v0.view.header?.replace(/^.*?\(You\)/, '<ME> (You)').slice(0, 40) ?? null;
    if (!v0.view.header || !/\(you\)/i.test(v0.view.header) || !v0.view.compose) {
      out.stopped = 'own chat is not open';
      return;
    }
    const before = new Set(controls(v0.nodes));
    for (const how of ['uia-focus', 'click'] as const) {
      await b.setClipboardFiles(process.env.KEO_LIVE_WA_PASTE!, true);
      out[`${how}:clipboardImage`] = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::ContainsImage()'], { encoding: 'utf8' }).trim();
      const compose = (await read(w.hwnd)).view.compose!;
      if (how === 'uia-focus') await b.uiaAct(w.hwnd, compose.rid, 'focus');
      else {
        const c = await b.uiaCenter(w.hwnd, compose.rid);
        await b.clickScreen(w.hwnd, c.x, c.y);
      }
      await sleep(300);
      out[`${how}:fgIsTarget`] = (await b.info(w.hwnd))?.foreground ?? null;
      await b.paste(w.hwnd);
      let added: string[] = [];
      for (let k = 0; k < 6 && !added.length; k++) {
        await sleep(700);
        added = controls((await read(w.hwnd)).nodes).filter((c) => !before.has(c));
      }
      out[`${how}:newControls`] = added.slice(0, 40);
      if (added.length) {
        await b.keys(w.hwnd, [], 0x1b); // Escape closes the preview; nothing is sent
        await sleep(800);
        out[`${how}:closed`] = controls((await read(w.hwnd)).nodes).filter((c) => !before.has(c)).length === 0;
        break;
      }
    }
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(dir, 'paste.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 240000);
