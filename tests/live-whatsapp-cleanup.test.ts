import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual clean-up after tests/live-whatsapp-paste.test.ts: closes an unsent attachment preview in
 * the WhatsApp app with its own "Remove attachment" button (never Send).
 * KEO_LIVE_WA_CLEANUP=1 npx vitest run tests/live-whatsapp-cleanup.test.ts
 */
it.runIf(process.env.KEO_LIVE_WA_CLEANUP === '1')('closes an unsent attachment preview', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  fs.mkdirSync(dir, { recursive: true });
  const b = new Win32Backend(dir, new Logger(dir, false));
  const out: Record<string, unknown> = {};
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName))!;
    await b.focus(w.hwnd);
    for (let k = 0; k < 3; k++) {
      const s = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
      const remove = s.nodes.find((n) => n.role === 'button' && /^remove attachment$/i.test(n.name) && !n.offscreen);
      out[`round${k}`] = !!remove;
      if (!remove) break;
      await b.uiaAct(w.hwnd, remove.rid, 'invoke');
      await new Promise((r) => setTimeout(r, 900));
    }
    const s = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    out.previewOpen = s.nodes.some((n) => n.role === 'button' && /^send \d+ selected/i.test(n.name));
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(dir, 'cleanup.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 120000);
