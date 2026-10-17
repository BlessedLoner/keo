import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { Win32Backend } from '../src/main/desktop/backend';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual check: direct delivery into a Chromium page (like WhatsApp Desktop /
 * WhatsApp Web) — a throw-away Edge window with an empty profile and a local
 * test page. KEO_LIVE_CHROMIUM=1 npx vitest run tests/live-chromium.test.ts
 */
it.runIf(process.env.KEO_LIVE_CHROMIUM === '1')('direct delivery into a Chromium page', async () => {
  const dir = path.join(os.tmpdir(), 'keo-live-chromium');
  fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, '<!doctype html><title>Keo direct test</title><input id="a" aria-label="Search input textbox" style="width:300px"><div id="b" contenteditable="true" role="textbox" aria-label="Type a message" style="border:1px solid;min-height:40px;width:300px"></div><button onclick="this.textContent=\'Clicked\'">Press me</button>');
  const edge = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const p = spawn(edge, [`--user-data-dir=${path.join(dir, 'profile')}`, '--no-first-run', '--inprivate', '--new-window', '--force-renderer-accessibility', pathToFileURL(page).href], { stdio: 'ignore' });
  const b = new Win32Backend(dir, new Logger(dir, false));
  const call = (cmd: string, args: Record<string, unknown>) => (b as unknown as { call(c: string, a: Record<string, unknown>, t?: number): Promise<unknown> }).call(cmd, args, 20000);
  const out: Record<string, unknown> = {};
  let hwnd = '';
  try {
    for (let i = 0; i < 80 && !hwnd; i++) {
      hwnd = (await b.list()).find((x) => /Keo direct test/.test(x.title))?.hwnd ?? '';
      await new Promise((r) => setTimeout(r, 250));
    }
    out.found = !!hwnd;
    out.focus = await b.focus(hwnd);
    await new Promise((r) => setTimeout(r, 800));
    const find = async (name: RegExp) => (await b.uiaSnapshot(hwnd, { maxNodes: 400, maxDepth: 30, budgetMs: 5000 })).nodes.find((n) => name.test(n.name));
    const input = await find(/Search input textbox/);
    await b.uiaAct(hwnd, input!.rid, 'focus');
    out.inputText = await call('post_text', { hwnd, text: 'Kid bro' });
    await new Promise((r) => setTimeout(r, 300));
    out.inputValue = (await b.uiaDescribe(hwnd, input!.rid))?.value;
    const editor = await find(/Type a message/);
    await b.uiaAct(hwnd, editor!.rid, 'focus');
    out.editorText = await call('post_text', { hwnd, text: 'hello é' });
    await new Promise((r) => setTimeout(r, 300));
    out.editorValue = (await b.uiaDescribe(hwnd, editor!.rid))?.value ?? (await b.uiaDescribe(hwnd, editor!.rid))?.name;
    out.readText = await b.readText(hwnd);
    const btn = await find(/Press me/);
    const c = await b.uiaCenter(hwnd, btn!.rid);
    out.click = await call('post_click_screen', { hwnd, x: Math.round(c.x), y: Math.round(c.y) });
    await new Promise((r) => setTimeout(r, 300));
    out.button = (await find(/Clicked|Press me/))?.name;
  } catch (e) {
    out.error = String(e);
  } finally {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(out, null, 1));
    b.dispose();
    p.kill();
    spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' });
  }
}, 120000);
