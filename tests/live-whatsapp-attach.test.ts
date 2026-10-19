import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { waOpenChat } from '../src/main/capabilities/advanced';
import type { CapabilityDeps } from '../src/main/capabilities/builtins';
import { Win32Backend } from '../src/main/desktop/backend';
import { DesktopService } from '../src/main/desktop/desktopService';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual exploration in the user's own chat: opens WhatsApp's Attach menu and the Windows file
 * dialog behind it, records the control names, then cancels both. Never sends anything.
 * KEO_LIVE_WA_ATTACH=1 npx vitest run tests/live-whatsapp-attach.test.ts
 */
it.runIf(process.env.KEO_LIVE_WA_ATTACH === '1')('explores the Attach menu and file dialog (cancelled)', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  fs.mkdirSync(dir, { recursive: true });
  const b = new Win32Backend(dir, new Logger(dir, false));
  const desktop = new DesktopService(b);
  const ps = (cmd: string) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  const clipboard = { readText: async () => '', writeText: async (t: string) => void (t ? ps(`Set-Clipboard -Value '${t.replace(/'/g, "''")}'`) : undefined) };
  const d = { desktop, clipboard, focusSettleMs: 400 } as unknown as CapabilityDeps;
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = (hwnd: string) => b.uiaSnapshot(hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName))!;
    const target = { hwnd: w.hwnd, pid: w.pid, processName: w.processName };
    await b.focus(w.hwnd);
    const o = await waOpenChat(d, target, 'Emmanuel (You)', new AbortController().signal);
    out.ownChat = o.opened;
    out.openReason = o.reason;
    out.candidates = o.candidates.length;
    out.header = o.header ? (/(you)/i.test(o.header) ? o.header : '<other chat>') : null;
    if (!o.opened) return;
    let s = await snap(w.hwnd);
    const attach = s.nodes.find((n) => n.role === 'button' && /^attach$/i.test(n.name) && !n.offscreen);
    out.attachButton = !!attach;
    if (!attach) return;
    const before = new Set(s.nodes.map((n) => `${n.role}:${n.name}`));
    await b.uiaAct(w.hwnd, attach.rid, 'invoke');
    await sleep(900);
    s = await snap(w.hwnd);
    const menu = s.nodes.filter((n) => !n.offscreen && n.name && !before.has(`${n.role}:${n.name}`));
    out.menu = menu.map((n) => `${n.role}:${n.name.slice(0, 40)}:${(n.patterns ?? []).join('/')}`).slice(0, 25);
    const photos = menu.find((n) => /photos?|videos?|gallery|image/i.test(n.name));
    out.photosItem = photos ? photos.name : null;
    if (!photos) {
      await b.uiaAct(w.hwnd, attach.rid, 'invoke').catch(() => undefined); // close the menu
      return;
    }
    const winsBefore = new Set((await b.list()).map((x) => x.hwnd));
    await b.uiaAct(w.hwnd, photos.rid, 'invoke').catch((e) => (out.photosInvokeError = String(e)));
    let dlg = null;
    for (let k = 0; k < 20 && !dlg; k++) {
      await sleep(400);
      const all = await b.list();
      dlg = all.find((x) => !winsBefore.has(x.hwnd) && x.pid === w.pid) ?? all.find((x) => !winsBefore.has(x.hwnd) && x.className === '#32770') ?? null;
    }
    out.dialog = dlg ? { processName: dlg.processName, className: dlg.className, title: dlg.title.slice(0, 40), samePid: dlg.pid === w.pid } : null;
    // The common file dialog may also be a child of WhatsApp's window; look inside it too.
    const inner = await snap(w.hwnd);
    out.innerDialog = inner.nodes.filter((n) => n.role === 'window' && n.depth > 0).map((n) => `${n.lct}:${n.name.slice(0, 30)}`).slice(0, 5);
    const dwin = dlg ?? null;
    if (dwin) {
      const ds = await snap(dwin.hwnd);
      out.dialogControls = ds.nodes.filter((n) => ['edit', 'combobox', 'button', 'splitbutton'].includes(n.role) && !n.offscreen).map((n) => `${n.role}:${n.name.slice(0, 30)}:${n.aid ?? ''}:${(n.patterns ?? []).join('/')}`).slice(0, 30);
      const cancel = ds.nodes.find((n) => n.role === 'button' && /^cancel$/i.test(n.name));
      if (cancel) await b.uiaAct(dwin.hwnd, cancel.rid, 'invoke');
      await sleep(600);
      out.dialogClosed = !(await b.list()).some((x) => x.hwnd === dwin.hwnd);
    }
  } catch (e) {
    out.error = String(e).slice(0, 400);
  } finally {
    fs.writeFileSync(path.join(dir, 'attach.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 240000);
