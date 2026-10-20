import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { WebService } from '../src/main/web/webService';
import { Logger } from '../src/main/logging/logger';

/**
 * Manual check against real sites (read-only): which product pictures Keo finds and can open on
 * a few product pages, and the Wikipedia fallback.
 * KEO_LIVE_IMAGES=1 npx vitest run tests/live-images.test.ts
 */
it.runIf(process.env.KEO_LIVE_IMAGES === '1')('finds real product pictures', async () => {
  const web = new WebService(() => null, new Logger(null));
  const sig = () => AbortSignal.timeout(30000);
  const out: Record<string, unknown> = {};
  for (const url of ['https://www.mbusa.com/en/vehicles/class/gle/coupe', 'https://www.apple.com/iphone/', 'https://www.bestbuy.com/site/apple/iphone/pcmcat305200050000.c?id=pcmcat305200050000']) {
    try {
      await web.fetchPage(url, sig());
      const page = web.visitedPage(url);
      const cands = page?.images ?? [];
      let ok: string | null = null;
      for (const c of cands.slice(0, 6)) {
        const img = await web.fetchImage(c, sig());
        if (img) {
          ok = `${c} (${img.contentType}, ${img.bytes.length} bytes)`;
          break;
        }
      }
      out[url] = { candidates: cands.length, first: cands.slice(0, 3), opened: ok };
    } catch (e) {
      out[url] = { error: String(e).slice(0, 200) };
    }
  }
  for (const name of ['Mercedes-Benz GLE 450 Coupe', 'Apple iPhone 17 Pro Max', 'MacBook Air M4']) {
    const w = await web.wikipediaImage(name, sig());
    const img = w ? await web.fetchImage(w.url, sig()) : null;
    out[`wiki: ${name}`] = w ? { article: w.article, opened: !!img } : null;
  }
  const dir = path.join(os.tmpdir(), 'keo-live-images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(out, null, 1));
}, 180000);
