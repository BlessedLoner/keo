import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { meaningfulNodes, Win32Backend, type UiaSnapshotRaw } from '../src/main/desktop/backend';
import { analyzeWhatsApp, waReadiness } from '../src/main/desktop/whatsapp';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual, read-only check against the installed WhatsApp app: what the classic
 * and the modern UI Automation readers see. Nothing is clicked or typed; only
 * counts, states and field labels are written (no chat names or messages).
 * KEO_LIVE_WA=1 npx vitest run tests/live-whatsapp.test.ts
 */
it.runIf(process.env.KEO_LIVE_WA === '1')('reads the WhatsApp app', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-wa');
  const b = new Win32Backend(dir, new Logger(dir, false));
  const call = (cmd: string, args: Record<string, unknown>) => (b as unknown as { uiCall<T>(c: string, a: Record<string, unknown>, t?: number): Promise<T> }).uiCall<UiaSnapshotRaw>(cmd, args, 40000);
  const out: Record<string, unknown> = {};
  try {
    const w = (await b.list()).find((x) => /^whatsapp/i.test(x.processName));
    out.window = w ? { processName: w.processName, w: w.width, h: w.height, minimized: w.minimized, hwnd: w.hwnd } : null;
    out.allWa = (await b.list()).filter((x) => /^whatsapp/i.test(x.processName)).map((x) => ({ hwnd: x.hwnd, w: x.width, h: x.height, cls: x.className, title: x.title.slice(0, 20) }));
    if (!w) return;
    out.children = await b.childClasses(w.hwnd);
    const opts = { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 };
    const classic = await call('uia_snapshot', { hwnd: w.hwnd, ...opts });
    const modern = await call('uia3_snapshot', { hwnd: w.hwnd, ...opts });
    const routed = await b.uiaSnapshot(w.hwnd, opts);
    const summary = (s: UiaSnapshotRaw) => {
      const v = analyzeWhatsApp(s.nodes, s.window);
      const roles: Record<string, number> = {};
      for (const n of s.nodes) roles[n.role] = (roles[n.role] ?? 0) + 1;
      const state = waReadiness(s.nodes, v);
      return {
        nodes: s.nodes.length,
        meaningful: meaningfulNodes(s.nodes),
        roles,
        state,
        search: !!v.search,
        compose: !!v.compose,
        chats: v.chats.length,
        fields: s.nodes.filter((n) => ['edit', 'combobox'].includes(n.role)).map((n) => `${n.role}:${/search/i.test(n.name) ? 'search' : n.name ? 'named' : 'unnamed'}`),
        // UI wording of the login screen only (never shown when signed in).
        loginTexts: state === 'signed_out' ? s.nodes.filter((n) => n.role === 'text' && n.name).map((n) => n.name.slice(0, 60)).slice(0, 8) : [],
      };
    };
    out.classic = summary(classic);
    out.modern = summary(modern);
    out.routedEngine = b.uiaEngine(w.hwnd);
    out.routed = summary(routed);
  } catch (e) {
    out.error = String(e);
  } finally {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 120000);
