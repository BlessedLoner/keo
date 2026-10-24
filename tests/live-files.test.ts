import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSearch } from '../src/main/files/fileSearch';
import { WindowsSearchIndex } from '../src/main/files/windowsSearch';

/**
 * The real Windows Search index on this PC, read-only (names and dates; nothing is opened).
 * KEO_LIVE_FILES=<folder> npx vitest run tests/live-files.test.ts — searches only inside that folder.
 */
const folder = process.env.KEO_LIVE_FILES;

describe.skipIf(!folder)('live: Windows Search index', () => {
  it('finds files by name words and kind in well under a second once warm', async () => {
    const index = new WindowsSearchIndex();
    const search = new FileSearch({ index, roots: () => [folder!], excluded: () => [] });
    try {
      const t0 = Date.now();
      const cold = await search.search({ text: 'whatsapp preview', kind: 'video', limit: 5 }, new AbortController().signal);
      const coldMs = Date.now() - t0;
      const warm = await search.search({ text: 'whatsapp', kind: 'any', limit: 10 }, new AbortController().signal);
      const recent = await search.search({ text: '', kind: 'video', modifiedWithinDays: 3, limit: 10 }, new AbortController().signal);
      const folders = await search.search({ text: 'edits', kind: 'folder', limit: 5 }, new AbortController().signal);
      const show = (r: typeof cold) => `${r.via} ${r.ms} ms: ${r.hits.map((x) => `${path.relative(folder!, x.path)} [${x.kind}, ${x.match}, ${x.modified}]`).join(' | ')}`;
      console.log(`cold ${coldMs} ms → ${show(cold)}\nwarm → ${show(warm)}\nrecent videos → ${show(recent)}\nfolders → ${show(folders)}`);
      expect(cold.via).toBe('index');
      expect(cold.hits[0]!.name).toBe('WhatsApp preview.mp4');
      expect(warm.ms).toBeLessThan(1000);
      expect(folders.hits.some((x) => x.kind === 'folder')).toBe(true);
    } finally {
      index.close();
    }
  }, 60000);
});
