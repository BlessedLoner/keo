import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, handle, type Env } from '../src/gateway';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or-secret', FAL_KEY: 'fal-secret' };
const NOW = Date.parse('2026-11-13T12:00:00Z');
const USERS: Record<string, string> = { 'tok-ana': 'u-ana', 'tok-ben': 'u-ben', 'tok-cy': 'u-cy', 'tok-di': 'u-di' };

/** Supabase in memory: the shared library and its reports. */
class World {
  shared = new Map<string, Record<string, unknown>>();
  reports: Array<{ shared_id: string; user_id: string }> = [];
  queries: string[] = [];
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.pathname === '/auth/v1/user') {
      const id = USERS[(headers.get('authorization') ?? '').replace('Bearer ', '')];
      return id ? j(200, { id, email: null }) : j(401, {});
    }
    if (headers.get('authorization') !== 'Bearer service-secret') return j(401, {});
    const q = url.searchParams;
    const eq = (k: string) => (q.get(k) ?? '').replace('eq.', '');
    this.queries.push(decodeURIComponent(url.search));
    switch (url.pathname) {
      case '/rest/v1/profiles':
        return j(200, [{ plan: 'free', plan_until: null, blocked: false }]);
      case '/rest/v1/plans':
        return j(200, [{ id: 'free', name: 'Free', daily_requests: 3, daily_tokens: 1000, max_tier: 1, features: {} }]);
      case '/rest/v1/usage_daily':
        return j(200, []);
      case '/rest/v1/dna_shared': {
        const mine = (r: Record<string, unknown>) => (!q.get('id') || r.id === eq('id')) && (!q.get('user_id') || r.user_id === eq('user_id'));
        if (init.method === 'POST') {
          this.shared.set(String(body.id), { ...body, saves: 0, hidden: false, published_at: new Date(NOW).toISOString() });
          return j(201, [{ id: body.id }]);
        }
        if (init.method === 'PATCH') {
          for (const r of this.shared.values()) if (mine(r)) Object.assign(r, body);
          return new Response(null, { status: 204 });
        }
        if (init.method === 'DELETE') {
          for (const [k, r] of this.shared) if (mine(r)) this.shared.delete(k);
          return new Response(null, { status: 204 });
        }
        const words = [...decodeURIComponent(url.search).matchAll(/name\.ilike\.\*([^*]+)\*/g)].map((m) => m[1]!);
        const rows = [...this.shared.values()].filter((r) => mine(r) && (q.get('hidden') ? !r.hidden : true) && (!q.get('category') || r.category === eq('category')) && words.every((w) => `${r.name} ${r.tags} ${r.description}`.toLowerCase().includes(w)));
        return j(200, rows);
      }
      case '/rest/v1/dna_reports':
        if (init.method === 'POST') {
          if (!this.reports.some((r) => r.shared_id === body.shared_id && r.user_id === body.user_id)) this.reports.push({ shared_id: String(body.shared_id), user_id: String(body.user_id) });
          return new Response(null, { status: 201 });
        }
        return j(200, this.reports.filter((r) => r.shared_id === eq('shared_id')));
      case '/rest/v1/rpc/dna_saved': {
        const r = this.shared.get(String(body.p_id));
        if (r) r.saves = Number(r.saves) + 1;
        return new Response(null, { status: 204 });
      }
    }
    return j(404, {});
  };
}

let w: World;
const call = async (path: string, body: unknown, token = 'tok-ana') => {
  const waits: Array<Promise<unknown>> = [];
  const r = await handle(new Request(`https://keo.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { fetch: w.fetch, waitUntil: (p) => void waits.push(p), now: () => NOW });
  await Promise.all(waits);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test answers are read loosely
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const blueprint = (name = 'Quiet Luxury Glide') => ({ schema: 1, id: 'dna_abcdef12', name, category: 'Luxury', tags: ['elegant', 'slow push'], description: 'Slow push-ins with dissolves.', source: { fileName: 'C:/Users/me/secret client.mp4', seconds: 8, width: 1080, height: 1920, hasAudio: false }, aspect: 'vertical', seconds: 8, shots: [{ id: 's1', start: 0, end: 8 }], history: [{ version: 1, note: 'Measured from secret client.mp4' }], sharing: { state: 'shareable', rights: 'own' } });

beforeEach(() => {
  clearCache();
  w = new World();
});

describe('The shared Edit DNA library', () => {
  it('publishes only with a reason to share, without the file name or history, and others find it and save it', async () => {
    expect((await call('/v1/dna/publish', { blueprint: blueprint(), rights: null })).body.error.code).toBe('rights_needed');
    const p = await call('/v1/dna/publish', { blueprint: blueprint(), rights: 'own' });
    expect(p.status).toBe(200);
    const row = w.shared.get(p.body.id)!;
    expect(JSON.stringify(row.blueprint)).not.toContain('secret client');
    expect(row).toMatchObject({ user_id: 'u-ana', name: 'Quiet Luxury Glide', category: 'Luxury', rights: 'own', shots: 1, tags: 'elegant slow-push' });
    const mine = await call('/v1/dna/list', { query: '', category: '' });
    expect(mine.body.items).toEqual([expect.objectContaining({ id: p.body.id, mine: true, tags: ['elegant', 'slow-push'] })]);
    expect(mine.body.items[0]).not.toHaveProperty('user_id');
    const found = await call('/v1/dna/list', { query: 'luxury glide', category: 'Luxury' }, 'tok-ben');
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].mine).toBe(false);
    expect((await call('/v1/dna/list', { query: 'gaming', category: '' }, 'tok-ben')).body.items).toHaveLength(0);
    const got = await call('/v1/dna/get', { id: p.body.id }, 'tok-ben');
    expect(got.body.blueprint).toMatchObject({ name: 'Quiet Luxury Glide' });
    expect(w.shared.get(p.body.id)!.saves).toBe(1);
  });

  it('keeps search words from becoming query syntax', async () => {
    await call('/v1/dna/list', { query: 'a),hidden.eq.true,(b* luxury', category: 'x);drop' });
    const q = w.queries.at(-1)!;
    expect(q).not.toContain('hidden.eq.true');
    expect(q).not.toContain('drop');
    expect(q).toContain('hidden=eq.false');
  });

  it('updates the user’s own entry in place, and only the owner can remove it', async () => {
    const p = await call('/v1/dna/publish', { blueprint: blueprint(), rights: 'own' });
    const again = await call('/v1/dna/publish', { blueprint: blueprint('Glide v2'), rights: 'technique-only', sharedId: p.body.id });
    expect(again.body.id).toBe(p.body.id);
    expect(w.shared.size).toBe(1);
    expect(w.shared.get(p.body.id)).toMatchObject({ name: 'Glide v2', rights: 'technique-only' });
    // Someone else's "update" makes their own entry instead of touching this one.
    const ben = await call('/v1/dna/publish', { blueprint: blueprint('Ben'), rights: 'own', sharedId: p.body.id }, 'tok-ben');
    expect(ben.body.id).not.toBe(p.body.id);
    expect(w.shared.get(p.body.id)!.name).toBe('Glide v2');
    await call('/v1/dna/unpublish', { id: p.body.id }, 'tok-ben');
    expect(w.shared.has(p.body.id)).toBe(true);
    await call('/v1/dna/unpublish', { id: p.body.id });
    expect(w.shared.has(p.body.id)).toBe(false);
  });

  it('hides a blueprint after three different users report it', async () => {
    const p = await call('/v1/dna/publish', { blueprint: blueprint(), rights: 'licensed' });
    await call('/v1/dna/report', { id: p.body.id, reason: 'stolen' }, 'tok-ben');
    await call('/v1/dna/report', { id: p.body.id, reason: 'stolen' }, 'tok-ben');
    await call('/v1/dna/report', { id: p.body.id, reason: 'stolen' }, 'tok-cy');
    expect(w.shared.get(p.body.id)!.hidden).toBe(false);
    await call('/v1/dna/report', { id: p.body.id, reason: 'stolen' }, 'tok-di');
    expect(w.shared.get(p.body.id)!.hidden).toBe(true);
    expect((await call('/v1/dna/list', { query: '', category: '' }, 'tok-ben')).body.items).toHaveLength(0);
    expect((await call('/v1/dna/get', { id: p.body.id }, 'tok-ben')).status).toBe(404);
  });

  it('needs a sign-in', async () => {
    expect((await call('/v1/dna/list', {}, 'nobody')).status).toBe(401);
  });
});
