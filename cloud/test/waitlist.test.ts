import { describe, expect, it } from 'vitest';
import { clearCache, handle, type Env } from '../src/gateway';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or' };
const NOW = Date.parse('2026-11-25T12:00:00Z');

function world() {
  const rows: Array<{ email: string; platform: string; source: string; ip_hash: string; created_at: string }> = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === '/rest/v1/waitlist') {
      if (init.method === 'POST') {
        const b = JSON.parse(String(init.body)) as (typeof rows)[number];
        if (!rows.some((r) => r.email === b.email)) rows.push({ ...b, created_at: new Date(NOW).toISOString() });
        return new Response(null, { status: 201 });
      }
      const ip = (url.searchParams.get('ip_hash') ?? '').replace('eq.', '');
      return new Response(JSON.stringify(rows.filter((r) => r.ip_hash === ip)), { status: 200 });
    }
    return new Response('[]', { status: 404 });
  };
  const call = (body: unknown, o: { origin?: string | null; ip?: string; method?: string } = {}) =>
    handle(
      new Request('https://cloud.heykeo.com/v1/waitlist', {
        method: o.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? 'https://heykeo.com' }), 'cf-connecting-ip': o.ip ?? '203.0.113.7' },
        ...(o.method === 'OPTIONS' ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      { fetch, waitUntil: () => undefined, now: () => NOW },
    );
  return { rows, call };
}

describe('The early-access list (heykeo.com)', () => {
  it('keeps an email once, lower-cased, with the platform; the same answer for a new and a known address', async () => {
    clearCache();
    const w = world();
    const a = await w.call({ email: '  Ada@Example.COM ', platform: 'ios', source: 'why-page' });
    expect(a.status).toBe(200);
    expect(a.headers.get('access-control-allow-origin')).toBe('https://heykeo.com');
    expect(await a.json()).toEqual({ ok: true });
    const again = await w.call({ email: 'ada@example.com' });
    expect(await again.json()).toEqual({ ok: true });
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ email: 'ada@example.com', platform: 'ios', source: 'why-page' });
    // The network address is never kept, only a hash of it.
    expect(JSON.stringify(w.rows)).not.toContain('203.0.113.7');
  });

  it('refuses a bad address, other websites, and more than 5 sign-ups an hour from one network', async () => {
    const w = world();
    expect((await w.call({ email: 'not-an-email' })).status).toBe(400);
    expect((await w.call({ email: 'x@example.com' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await w.call({ email: 'x@example.com' }, { origin: null })).status).toBe(403);
    for (let i = 0; i < 5; i++) expect((await w.call({ email: `p${i}@example.com` }, { ip: '198.51.100.1' })).status).toBe(200);
    expect((await w.call({ email: 'p6@example.com' }, { ip: '198.51.100.1' })).status).toBe(429);
    expect((await w.call({ email: 'other@example.com' }, { ip: '198.51.100.2' })).status).toBe(200);
  });

  it('answers the browser’s pre-check only for Keo’s own website; quietly drops forms filled by bots', async () => {
    const w = world();
    const pre = await w.call(null, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect((await w.call(null, { method: 'OPTIONS', origin: 'https://evil.test' })).status).toBe(403);
    expect((await w.call({ email: 'bot@example.com', company: 'Spam Inc' })).status).toBe(200);
    expect(w.rows).toHaveLength(0);
  });
});
