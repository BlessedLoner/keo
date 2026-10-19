import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { DesktopService } from '../src/main/desktop/desktopService';
import { analyzeWhatsApp } from '../src/main/desktop/whatsapp';
import { waOpenChat } from '../src/main/capabilities/advanced';
import type { CapabilityDeps } from '../src/main/capabilities/builtins';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual live check (only with the user's OK): opens the user's OWN chat
 * ("<name> (You)") in the WhatsApp app through Keo's open-chat steps. Nothing
 * is typed into the message box and nothing is sent. Writes only booleans.
 * KEO_LIVE_WA_OPEN=1 npx vitest run tests/live-whatsapp-open.test.ts
 */
it.runIf(process.env.KEO_LIVE_WA_OPEN === '1')('opens my own chat in the WhatsApp app', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  const b = new Win32Backend(dir, new Logger(dir, false));
  const desktop = new DesktopService(b);
  const ps = (cmd: string) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  const clipboard = {
    readText: async () => Buffer.from(ps("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw)))").trim(), 'base64').toString('utf8'),
    writeText: async (t: string) => void ps(t ? `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(t, 'utf8').toString('base64')}')))` : 'Set-Clipboard -Value $null'),
  };
  const d = { desktop, clipboard, focusSettleMs: 400 } as unknown as CapabilityDeps;
  const out: Record<string, unknown> = {};
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName))!;
    const target = { hwnd: w.hwnd, pid: w.pid, processName: w.processName };
    out.focused = (await b.focus(w.hwnd)).foreground;
    const snap = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    const v = analyzeWhatsApp(snap.nodes, snap.window);
    out.reader = b.uiaEngine(w.hwnd);
    out.chatsVisible = v.chats.length;
    // The user's own number on this WhatsApp is saved as "Emmanuel" (the user named it for this test).
    const want = process.env.KEO_LIVE_WA_CONTACT ?? 'Emmanuel';
    const tOpen = Date.now();
    let r = await waOpenChat(d, target, want, new AbortController().signal);
    out.openMs = Date.now() - tOpen;
    out.firstTry = { opened: r.opened, candidates: r.candidates.length, selfCandidate: r.candidates.some((c) => /\(you\)/i.test(c)) };
    const self = r.candidates.find((c) => /\(you\)/i.test(c));
    if (!r.opened && self) r = await waOpenChat(d, target, self, new AbortController().signal);
    out.opened = r.opened;
    const after = analyzeWhatsApp((await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 })).nodes, (await b.uiaSnapshot(w.hwnd, { maxNodes: 50, maxDepth: 3, budgetMs: 2000 })).window);
    out.after = { composeFound: !!after.compose, headerFound: !!after.header, headerHasWanted: !!after.header && after.header.toLowerCase().includes(want.toLowerCase()), headerHasYou: !!after.header && /you/i.test(after.header), headerShape: (after.header ?? '').replace(new RegExp(want, 'ig'), '<NAME>'), messages: after.messages.length };
    out.headerMatches = r.opened;
    out.reasonKind = r.reason ? (r.reason.includes('no exact') ? 'no exact match' : r.reason.includes('no matching') ? 'no match' : r.reason.includes('header') ? 'header differs' : 'other') : null;
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 180000);
