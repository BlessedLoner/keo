import { afterEach, describe, expect, it } from 'vitest';
import { imageCandidates } from '../src/main/web/productData';
import { WebService } from '../src/main/web/webService';
import { Logger } from '../src/main/logging/logger';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
let seq = 0;
const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `i${++seq}`, name, input }], stopReason: 'tool_use', usage: null, model: 'keo-test-1', native: undefined });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('product pictures on a page', () => {
  it('finds the product picture among the page’s pictures, best first, and skips logos and icons', () => {
    const html = `<html><head><title>GLE Coupe</title></head><body>
      <img src="/img/logo.png" alt="Mercedes logo">
      <img src="/img/icon-search.svg" alt="search">
      <img src="/img/hero-small.jpg" srcset="/img/hero-800.jpg 800w, /img/hero-1600.jpg 1600w" alt="Mercedes-Benz GLE Coupe in white">
      <img data-src="/img/interior.jpg" alt="Interior" width="900">
      <img src="/img/tiny.jpg" alt="thing" width="40">
    </body></html>`;
    const c = imageCandidates(html, 'https://www.mbusa.com/en/vehicles/class/gle/coupe', 'Mercedes-Benz GLE 450 Coupe');
    expect(c[0]).toBe('https://www.mbusa.com/img/hero-1600.jpg'); // the largest of the matching picture's sizes
    expect(c).toContain('https://www.mbusa.com/img/interior.jpg');
    expect(c.some((u) => /logo|icon|tiny/.test(u))).toBe(false);
  });
});

describe('research card pictures', () => {
  function setup(pages: Record<string, { type: string; body: string | Buffer }>, wiki: unknown) {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      asked.push(u);
      if (u.startsWith('https://en.wikipedia.org/w/api.php')) return new Response(JSON.stringify(wiki), { status: 200, headers: { 'content-type': 'application/json' } });
      void init;
      const p = pages[u];
      if (!p) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(p.body, { status: 200, headers: { 'content-type': p.type } });
    }) as typeof fetch;
    const web = new WebService(() => 'k', new Logger(null), fetchImpl, async () => [{ address: '93.184.216.34', family: 4 }]);
    return { web, asked };
  }

  async function cardsFor(web: WebService, url: string, name: string) {
    h = makeHarness({
      web,
      script: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content ?? '');
        if (last.includes('show me')) return call('web__fetch_page', { url });
        if (!last.includes('resultId')) return call('research__show_products', { summary: 's', criteria: [], products: [{ name, url }] });
        return reply('done');
      },
    });
    h.services.settings.update({ permissions: { webFetchEnabled: true } });
    const conv = h.services.conversations.create('r');
    const m = await h.services.agent.send(conv.id, 'show me').done;
    return (m.meta.tools?.find((t) => t.capabilityId === 'research.show_products')?.cards as { cards: Array<{ image: string | null; imageFrom?: string | null; imageUrl?: string | null }> }).cards;
  }

  it('skips a picture Keo cannot open (WebP) and takes the next one the page offers', async () => {
    const { web } = setup(
      {
        'https://shop.example.com/p': { type: 'text/html', body: '<html><head><meta property="og:image" content="https://shop.example.com/a.webp"></head><body><img src="/b.jpg" alt="Phone X Pro" width="800"></body></html>' },
        'https://shop.example.com/a.webp': { type: 'image/webp', body: PNG },
        'https://shop.example.com/b.jpg': { type: 'image/jpeg', body: PNG },
      },
      {},
    );
    const [c] = await cardsFor(web, 'https://shop.example.com/p', 'Phone X Pro');
    expect(c!.image).toMatch(/^data:image\/png;base64,/);
    expect(c!.imageFrom).toBe('page');
    expect(c!.imageUrl).toBe('https://shop.example.com/b.jpg');
  });

  it('uses the matching Wikipedia article’s picture when the page has none, and says so', async () => {
    const { web, asked } = setup(
      {
        'https://www.mbusa.com/gle': { type: 'text/html', body: '<html><head><title>GLE Coupe</title></head><body>No pictures in the HTML.</body></html>' },
        'https://upload.wikimedia.org/gle.jpg': { type: 'image/jpeg', body: PNG },
      },
      { query: { pages: { '1': { title: 'Mercedes-Benz GLE-Class', index: 1, thumbnail: { source: 'https://upload.wikimedia.org/gle.jpg' } } } } },
    );
    const [c] = await cardsFor(web, 'https://www.mbusa.com/gle', 'Mercedes-Benz GLE 450 Coupe');
    expect(c!.image).toMatch(/^data:image\/png;base64,/);
    expect(c!.imageFrom).toBe('wikipedia');
    expect(asked.some((u) => u.includes('gsrsearch=Mercedes-Benz+GLE+450+Coupe'))).toBe(true);
  });
});
