import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual check: draws on a new, unsaved Paint canvas with simulated mouse input and with direct
 * window messages, and saves screenshots of the window. Paint is left open (nothing is saved).
 * KEO_LIVE_PAINT=<output folder> npx vitest run tests/live-paint.test.ts
 */
it.runIf(!!process.env.KEO_LIVE_PAINT)('draws in Paint', async () => {
  const outDir = process.env.KEO_LIVE_PAINT!;
  fs.mkdirSync(outDir, { recursive: true });
  const dir = path.join(os.tmpdir(), 'keo-live-paint');
  const b = new Win32Backend(dir, new Logger(dir, false));
  const out: Record<string, unknown> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = (name: string, w: { x: number; y: number; width: number; height: number }) =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $b=New-Object Drawing.Bitmap ${w.width},${w.height}; $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${w.x},${w.y},0,0,$b.Size); $b.Save('${path.join(outDir, name)}')`]);
  try {
    let w = (await b.list()).find((x) => /^mspaint$/i.test(x.processName)) ?? null;
    if (!w) execFileSync('powershell.exe', ['-NoProfile', '-Command', String.raw`Start-Process explorer.exe 'shell:AppsFolder\Microsoft.Paint_8wekyb3d8bbwe!App'`]);
    for (let k = 0; k < 60 && !w; k++) {
      await sleep(500);
      w = (await b.list()).find((x) => /^mspaint$/i.test(x.processName)) ?? null;
    }
    if (!w) throw new Error('Paint did not open');
    out.window = { processName: w.processName, w: w.width, h: w.height };
    out.focused = (await b.focus(w.hwnd)).foreground;
    await sleep(1200);
    w = (await b.info(w.hwnd))!;
    const snap = await b.uiaSnapshot(w.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
    out.big = snap.nodes.filter((n) => (n.w ?? 0) > w!.width * 0.4 && (n.h ?? 0) > w!.height * 0.4).map((n) => `${n.role}:${n.name.slice(0, 30)}:${(n.aid ?? '').slice(0, 30)}:${n.lct ?? ''}:${n.x},${n.y},${n.w},${n.h}`);
    shot('paint-0-before.png', w);
    const cx = w.x + Math.round(w.width / 2);
    const cy = w.y + Math.round(w.height * 0.55);
    const circle = (ox: number, oy: number, r: number) => Array.from({ length: 33 }, (_, k) => [ox + r * Math.cos((k / 32) * 2 * Math.PI), oy + r * Math.sin((k / 32) * 2 * Math.PI)] as [number, number]);
    const t0 = Date.now();
    const r1 = await b.draw(w.hwnd, [circle(cx - 90, cy, 50), [[cx - 140, cy + 80], [cx - 40, cy + 80]]]);
    out.mouse = { ...r1, ms: Date.now() - t0 };
    await sleep(500);
    shot('paint-1-mouse.png', w);
    // Direct window messages (what Keo uses when Windows refuses simulated input).
    const direct = (b as unknown as { call<T>(c: string, a: Record<string, unknown>, t?: number): Promise<T> }).call<{ points: number }>('post_draw', {
      hwnd: w.hwnd,
      points: [...circle(cx + 90, cy, 50).flatMap(([x, y]) => [Math.round(x), Math.round(y)]), 2147483647, 2147483647],
    }, 30000);
    out.direct = await direct.catch((e) => String(e));
    await sleep(500);
    shot('paint-2-direct.png', w);
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(outDir, 'paint.json'), JSON.stringify(out, null, 1));
    b.dispose();
  }
}, 180000);
