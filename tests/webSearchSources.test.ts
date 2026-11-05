import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers';

describe('Web search results from every source pass the tool’s check', () => {
  it('Keo Search (signed in), Brave Search and DuckDuckGo are all accepted', async () => {
    const h = makeHarness();
    try {
      const cap = h.services.registry.get('web.search')!;
      for (const source of ['Keo Search', 'Brave Search', 'DuckDuckGo']) {
        const r = cap.output.safeParse({ query: 'Lagos Life game', results: [{ title: 'Lagos Life', url: 'https://example.test', description: 'A game', age: null }], source });
        expect(r.success, source).toBe(true);
      }
    } finally {
      await h.close();
    }
  });
});
