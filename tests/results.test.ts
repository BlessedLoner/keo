import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawWindow } from '../src/main/desktop/backend';
import { createHandlers } from '../src/main/ipc/handlers';
import { channelAllowed } from '../src/main/ipc/roles';
import { Logger } from '../src/main/logging/logger';
import { folderName, priceOf, reportHtml, ResearchResults, shareText } from '../src/main/research/results';
import { parseDuckDuckGo, WebService } from '../src/main/web/webService';
import type { ProductCard } from '../src/shared/domain';
import { FakeWhatsApp } from './fakeApps';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { DesktopService } from '../src/main/desktop/desktopService';
import { FakeDesktop, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const DATA_PNG = `data:image/png;base64,${PNG.toString('base64')}`;

function card(over: Partial<ProductCard> = {}): ProductCard {
  return {
    name: 'MacBook Air M4 32GB 512GB',
    url: 'https://shop.example.com/air',
    pageTitle: 'MacBook Air',
    merchant: 'Shop',
    price: '1799',
    currency: 'USD',
    priceFrom: 'page data',
    availability: 'InStock',
    image: DATA_PNG,
    imageUrl: 'https://shop.example.com/air.png',
    fit: null,
    pros: ['Light'],
    cons: [],
    specs: ['32 GB RAM'],
    fetchedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  };
}

/** Renders without a real window: tests check what Keo does with the bytes, not Chromium. */
const fakeRender = async (html: string, kind: 'pdf' | 'png') => {
  rendered.push({ kind, html });
  return kind === 'pdf' ? Buffer.from('%PDF-1.7 fake') : PNG;
};
let rendered: Array<{ kind: string; html: string }> = [];

function web() {
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u === 'https://shop.example.com/air.png') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  return new WebService(() => null, new Logger(null), fetchImpl, async () => [{ address: '93.184.216.34', family: 4 }]);
}

function harness() {
  rendered = [];
  h = makeHarness({ web: web(), deps: { renderReport: fakeRender } });
}

function addResult(cards = [card(), card({ name: 'MacBook Pro M4 32GB 512GB', url: 'https://shop.example.com/pro', price: '$2,399', currency: 'USD', imageUrl: null })]) {
  return h.services.results.add({ title: 'MacBook Air vs Pro M4', summary: 'Best prices found.', criteria: ['price'], cards, dropped: [], conversationId: null });
}

describe('research results', () => {
  it('keeps the last ten results and returns the latest by default', () => {
    const r = new ResearchResults();
    const ids = Array.from({ length: 12 }, (_, i) => r.add({ title: `R${i}`, summary: '', criteria: [], cards: [], dropped: [], conversationId: null }).id);
    expect(r.recent()).toHaveLength(10);
    expect(r.get(undefined)?.id).toBe(ids[11]);
    expect(r.get(ids[0]!)).toBeNull();
  });

  it('the report is self-contained (no scripts, only embedded pictures) and escapes page text', () => {
    const r = new ResearchResults().add({ title: '<script>x</script>', summary: 's', criteria: [], cards: [card({ name: 'A <b>' })], dropped: [], conversationId: null });
    const html = reportHtml(r);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(DATA_PNG);
    expect(reportHtml(r, { forImage: true })).not.toContain('href=');
    expect(folderName(r)).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('prices: currency only before a bare number', () => {
    expect(priceOf({ price: '1799', currency: 'USD' })).toBe('USD 1799');
    expect(priceOf({ price: '$2,399', currency: 'USD' })).toBe('$2,399');
    expect(priceOf({ price: null, currency: 'USD' })).toBe('Price not stated');
    const r = new ResearchResults().add({ title: 'T', summary: 'S', criteria: [], cards: [card()], dropped: [], conversationId: null });
    expect(shareText(r)).toContain('• MacBook Air M4 32GB 512GB — USD 1799 (Shop)\nhttps://shop.example.com/air');
  });

  it('Save (a click in the results window) writes the report, the PDF and the product pictures', async () => {
    harness();
    const r = addResult();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const out = await handlers['results:save']({ id: r.id, format: 'pdf' });
    expect(out.ok).toBe(true);
    const folder = out.folder!;
    expect(folder.startsWith(h.services.researchSaveRoot())).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'report.pdf'), 'utf8')).toContain('%PDF');
    expect(fs.readFileSync(path.join(folder, 'report.html'), 'utf8')).toContain('MacBook Air vs Pro M4');
    const pics = fs.readdirSync(path.join(folder, 'pictures')).sort();
    expect(pics).toEqual(['1 MacBook Air M4 32GB 512GB.jpg', '2 MacBook Pro M4 32GB 512GB.png']); // full size from the page, else the preview
    expect(rendered.map((x) => x.kind)).toEqual(['pdf']);
    // A second save does not overwrite the first.
    const again = await handlers['results:save']({ id: r.id, format: 'png' });
    expect(again.folder).not.toBe(folder);
    expect(fs.existsSync(path.join(again.folder!, 'report.png'))).toBe(true);
    // The click is recorded as the user's approval.
    expect(h.services.tasks.list(5).every((t) => t.state === 'completed')).toBe(true);
  });

  it('a failed render saves and sends nothing, and says so', async () => {
    rendered = [];
    h = makeHarness({ web: web(), deps: { renderReport: async () => Promise.reject(new Error('ERR_BLOCKED_BY_CLIENT (-20)')) } });
    const r = addResult();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const out = await handlers['results:save']({ id: r.id, format: 'pdf' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/could not make the PDF.*Nothing was saved/);
    expect(fs.existsSync(h.services.researchSaveRoot()) ? fs.readdirSync(h.services.researchSaveRoot()) : []).toEqual([]);
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'chrome', label: 'Chrome' }] } });
    const wa = new FakeWhatsApp();
    h.desktop.addApp({ hwnd: '4001', pid: 888, processName: 'chrome', title: 'WhatsApp - Google Chrome', className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false }, wa);
    const sent = await handlers['results:send']({ id: r.id, contact: 'Mum', which: 'web' });
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/Nothing was sent/);
    expect(wa.sentFiles).toEqual([]);
    expect(h.services.tasks.list(5).some((t) => t.state === 'outcome_uncertain')).toBe(false);
  });

  it('opens only folders Keo saved research into', async () => {
    harness();
    const opened: string[] = [];
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async (p) => (opened.push(p), true), pickExecutable: async () => null, relaunch: () => undefined });
    expect(await handlers['results:openFolder']({ folder: 'C:/Windows/System32' })).toEqual({ opened: false });
    expect(await handlers['results:openFolder']({ folder: path.join(h.services.researchSaveRoot(), '..', 'x') })).toEqual({ opened: false });
    const r = addResult();
    const { folder } = await handlers['results:save']({ id: r.id, format: 'page' });
    expect(await handlers['results:openFolder']({ folder: folder! })).toEqual({ opened: true });
    expect(opened).toEqual([folder]);
  });

  it('Send puts the prices and links, then the comparison picture, in the named chat, and finds both there', async () => {
    harness();
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'chrome', label: 'Chrome' }] } });
    const wa = new FakeWhatsApp();
    const w: RawWindow = { hwnd: '4001', pid: 888, processName: 'chrome', title: 'WhatsApp - Google Chrome', className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false };
    h.desktop.addApp(w, wa);
    const r = addResult();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const out = await handlers['results:send']({ id: r.id, contact: 'Mum', which: 'web', note: 'Here you go' });
    expect(out.error).toBeNull();
    expect(out.ok).toBe(true);
    expect(wa.sentFiles).toHaveLength(1);
    expect(wa.sentFiles[0]!.to).toBe('Mum');
    expect(wa.sentFiles[0]!.file).toMatch(/\.png$/);
    // The text went first as its own message (no caption box involved).
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe('Mum');
    expect(wa.sent[0]!.text).toContain('Here you go');
    expect(wa.sent[0]!.text).toContain('https://shop.example.com/pro');
    expect(wa.sentFiles[0]!.caption).toBe('');
    expect(rendered.map((x) => x.kind)).toEqual(['png']);
    expect(rendered[0]!.html).not.toContain('href=');
  });

  it('a preview that refuses captions does not matter: the text goes as its own message first', async () => {
    harness();
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'chrome', label: 'Chrome' }] } });
    const wa = new FakeWhatsApp();
    wa.captionRefuses = true;
    wa.rowPerLine = true; // and the text shows as one row per line, like the app
    h.desktop.addApp({ hwnd: '4001', pid: 888, processName: 'chrome', title: 'WhatsApp - Google Chrome', className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false }, wa);
    const r = addResult();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const out = await handlers['results:send']({ id: r.id, contact: 'Mum', which: 'web', note: 'Here you go' });
    expect(out.error).toBeNull();
    expect(out.ok).toBe(true);
    expect(wa.sentFiles).toHaveLength(1);
    expect(wa.sentFiles[0]!.caption).toBe('');
    const mum = wa.chats.find((c) => c.title === 'Mum')!;
    const text = mum.messages.slice(-8).filter((m) => m.from === 'me').map((m) => m.text).join('\n');
    expect(text).toContain('Here you go');
    expect(text).toContain('https://shop.example.com/pro');
    expect(out.detail).toMatch(/prices and links, then the comparison picture/);
  });

  it('a message box that reports only its last paragraph still sends the text, then the picture', async () => {
    harness();
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'chrome', label: 'Chrome' }] } });
    const wa = new FakeWhatsApp();
    wa.valueLastParagraph = true;
    h.desktop.addApp({ hwnd: '4001', pid: 888, processName: 'chrome', title: 'WhatsApp - Google Chrome', className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false }, wa);
    const r = addResult();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const out = await handlers['results:send']({ id: r.id, contact: 'Mum', which: 'web' });
    expect(out.error).toBeNull();
    expect(out.ok).toBe(true);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.text).toContain('https://shop.example.com/pro');
    expect(wa.sentFiles).toHaveLength(1);
  });

  it('the results window can only reach its own channels', () => {
    for (const c of ['results:get', 'results:save', 'results:send', 'results:openFolder', 'results:close', 'app:openUrl'] as const) expect(channelAllowed('results', c)).toBe(true);
    for (const c of ['settings:update', 'tasks:approveStep', 'chat:send', 'web:setKey', 'files:read'] as const) expect(channelAllowed('results', c as never)).toBe(false);
    expect(channelAllowed('companion', 'results:send')).toBe(false);
  });
});

describe('sending a research result by voice or chat', () => {
  const WIN: RawWindow = { hwnd: '4001', pid: 888, processName: 'chrome', title: 'WhatsApp - Google Chrome', className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false };
  let seq = 0;
  const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `v${++seq}`, name, input }], stopReason: 'tool_use', usage: null, model: 'keo-test-1', native: undefined });
  const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

  it('the model is told about the result on screen, a text-only copy is refused, and the picture is sent', async () => {
    rendered = [];
    const systems: string[] = [];
    let refusal = '';
    h = makeHarness({
      web: web(),
      deps: { renderReport: fakeRender },
      script: (req: ChatRequest) => {
        systems.push(req.system);
        const last = JSON.stringify(req.messages.at(-1)?.content ?? '');
        if (last.includes('send it to Mum')) {
          // What the model did before: retype the prices and links as a plain message.
          const r = h.services.results.get(undefined)!;
          return call('whatsapp__send_message', { contact: 'Mum', which: 'web', text: shareText(r) });
        }
        if (last.includes('research__send_whatsapp') && !refusal) {
          refusal = last;
          return call('research__send_whatsapp', { contact: 'Mum', which: 'web' });
        }
        return reply('Sent.');
      },
    });
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'chrome', label: 'Chrome' }] }, agent: { approvalWaitSeconds: 10 } });
    const wa = new FakeWhatsApp();
    h.desktop.addApp(WIN, wa);
    const r = addResult();
    const conv = h.services.conversations.create('v');
    const turn = h.services.agent.send(conv.id, 'send it to Mum');
    await waitFor(() => h.services.tasks.list(5).some((t) => t.steps.some((s) => s.state === 'awaiting_authorization')), 8000);
    for (const t of h.services.tasks.list(5)) for (const st of t.steps) if (st.state === 'awaiting_authorization') h.services.tasks.approveStep(st.id, st.inputHash);
    await turn.done;
    expect(systems[0]).toContain(`resultId ${r.id}`);
    expect(refusal).toMatch(/repeats the research result/);
    expect(wa.sentFiles).toHaveLength(1);
    expect(wa.sentFiles[0]!.file).toMatch(/\.png$/);
    expect(wa.sent.map((m) => m.text).join(' ')).toContain('https://shop.example.com/air');
    // The model's own text-only copy was refused (the result's send carries the text itself).
    expect(h.services.tasks.list(5).flatMap((t) => t.steps).filter((st) => st.capabilityId === 'whatsapp.send_message' && st.state === 'succeeded')).toEqual([]);
  });

  it('an ordinary message that mentions one link is not affected', async () => {
    harness();
    addResult();
    const a = h.services.registry.admit({ capabilityId: 'whatsapp.send_message', input: { contact: 'Mum', which: 'web', text: 'Look at https://shop.example.com/air' }, origin: 'model', correlationId: 'c' });
    expect(a.ok || !/research result/.test(a.reason)).toBe(true);
  });
});

describe("Keo's floating windows step aside during desktop work", () => {
  it('hides before the work and comes back after, also when the work fails', async () => {
    const d = new DesktopService(new FakeDesktop());
    const log: string[] = [];
    d.stepAside = (owner) => {
      log.push(`aside ${owner}`);
      return () => log.push(`back ${owner}`);
    };
    await d.exclusive('a', async () => void log.push('work a'));
    await expect(d.exclusive('b', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(log).toEqual(['aside a', 'work a', 'back a', 'aside b', 'back b']);
  });
});

describe('search without a key', () => {
  const DDG = `<div class="result results_links results_links_deep result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a></div>
<div class="result results_links results_links_deep web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.apple.com%2Fshop%2Fbuy-mac%2Fmacbook-air&amp;rut=abc">Buy <b>MacBook Air</b> &amp; more</a></h2>
<a class="result__snippet" href="x">From <b>$1,099</b>.</a></div>
<div class="result results_links web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad</a></div>
<div class="result results_links web-result"><a class="result__a" href="https://www.bestbuy.com/mba">Best Buy MacBook Air</a><div class="result__snippet">Deals</div></div>`;

  it('reads DuckDuckGo results: unwraps links, drops ads and non-web links', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: 'Buy MacBook Air & more', url: 'https://www.apple.com/shop/buy-mac/macbook-air', description: 'From $1,099.', age: null },
      { title: 'Best Buy MacBook Air', url: 'https://www.bestbuy.com/mba', description: 'Deals', age: null },
    ]);
  });

  it('auto uses DuckDuckGo without a key, Brave with one; "Brave only" without a key is unavailable', async () => {
    const seen: string[] = [];
    let key: string | null = null;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = String(input);
      seen.push(u);
      if (u.startsWith('https://html.duckduckgo.com/')) return new Response(DDG, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b.example/' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const w = new WebService(() => key, new Logger(null), fetchImpl);
    const sig = new AbortController().signal;
    expect((await w.find('macbook', { count: 5, safesearch: 'moderate', engine: 'auto' }, sig)).source).toBe('DuckDuckGo');
    expect(w.sourceFor('brave')).toBeNull();
    await expect(w.find('macbook', { count: 5, safesearch: 'moderate', engine: 'brave' }, sig)).rejects.toMatchObject({ code: 'unconfigured' });
    key = 'brave-key-123';
    expect((await w.find('macbook', { count: 5, safesearch: 'moderate', engine: 'auto' }, sig)).source).toBe('Brave Search');
    expect((await w.find('macbook', { count: 5, safesearch: 'moderate', engine: 'duckduckgo' }, sig)).source).toBe('DuckDuckGo');
    expect(seen.filter((u) => u.includes('duckduckgo'))).toHaveLength(2);
  });

  it('a DuckDuckGo human check stops the search instead of retrying', async () => {
    const fetchImpl = (async () => new Response('<html>Unfortunately, bots use DuckDuckGo too. anomaly-modal</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const w = new WebService(() => null, new Logger(null), fetchImpl);
    await expect(w.find('q', { count: 5, safesearch: 'moderate', engine: 'auto' }, new AbortController().signal)).rejects.toMatchObject({ code: 'rate_limit' });
  });
});
