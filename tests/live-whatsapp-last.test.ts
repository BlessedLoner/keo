import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { analyzeWhatsApp } from '../src/main/desktop/whatsapp';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual, read-only check of the user's own chat in the WhatsApp app after a live send test:
 * how Keo's reader sees the latest outgoing message (start of its text, its controls).
 * KEO_LIVE_WA_LAST=1 npx vitest run tests/live-whatsapp-last.test.ts
 */
it.runIf(process.env.KEO_LIVE_WA_LAST === '1')('reads the latest message in my own chat', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  fs.mkdirSync(dir, { recursive: true });
  const b = new Win32Backend(dir, new Logger(dir, false));
  const out: Record<string, unknown> = {};
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName))!;
    await b.focus(w.hwnd);
    await new Promise((r) => setTimeout(r, 600));
    const s = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    const v = analyzeWhatsApp(s.nodes, s.window);
    if (!v.header || !/\(you\)/i.test(v.header)) {
      out.stopped = 'own chat is not open';
      return;
    }
    out.mine = v.messages.filter((m) => m.from === 'me').slice(-3).map((m) => ({ text: m.text.slice(0, 90), row: !!m.row }));
    // Controls near the bottom of the chat (last ~25 nodes with names), to see how a picture message is exposed.
    out.tail = s.nodes.filter((n) => n.name && !n.offscreen && ['button', 'image', 'text', 'listitem', 'group'].includes(n.role)).slice(-25).map((n) => `${n.role}:${n.name.slice(0, 70)}`);
    out.pictures = s.nodes.filter((n) => n.role === 'button' && /^open picture$/i.test(n.name)).length;
    out.testCaptions = s.nodes.filter((n) => n.role === 'image' && /^keo test:/i.test(n.name)).length;
    // Element ids of the existing picture captions must stay the same between reads (Keo tells a new picture by its id).
    const ids = (nodes: typeof s.nodes) => nodes.filter((n) => n.role === 'image' && /^keo test:/i.test(n.name)).map((n) => n.rid).join(',');
    const s2 = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    out.idsStable = ids(s.nodes) !== '' && ids(s.nodes) === ids(s2.nodes);
    out.previewOpen = s.nodes.some((n) => n.role === 'button' && /^send \d+ selected/i.test(n.name));
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 120000);
