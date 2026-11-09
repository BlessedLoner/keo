import { beforeEach, describe, expect, it } from 'vitest';
import { adminEmails } from '../src/admin';
import { clearCache, handle, type Env } from '../src/gateway';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or', ADMIN_EMAILS: 'Owner@Keo.test, second@keo.test' };
const NOW = Date.parse('2026-11-06T12:00:00Z');
const OWNER = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const REPORT = '33333333-3333-3333-3333-333333333333';

/** Supabase in memory: sign-ins, profiles, usage, jobs, payments, reports, the admin log. */
function world() {
  const users: Record<string, { id: string; email: string }> = { 'tok-owner': { id: OWNER, email: 'owner@keo.test' }, 'tok-ana': { id: ANA, email: 'ana@example.com' } };
  const db = {
    profiles: [
      { id: OWNER, email: 'owner@keo.test', plan: 'max', plan_until: '2027-01-01T00:00:00Z', blocked: false, created_at: '2026-10-01T00:00:00Z' },
      { id: ANA, email: 'ana@example.com', plan: 'free', plan_until: null as string | null, blocked: false, created_at: '2026-11-05T00:00:00Z' },
    ],
    usage: [{ user_id: ANA, day: '2026-11-06', requests: 12, input_tokens: 1000, output_tokens: 500, cost_usd: 0.04, web_searches: 1, images: 0 }],
    jobs: [
      { request_id: 'r1', user_id: ANA, endpoint: 'fal-ai/kling-video/ai-avatar/v2/pro', credits: 460, status: 'done', month: '2026-11', created_at: '2026-11-06T10:00:00Z' },
      { request_id: 'r2', user_id: ANA, endpoint: 'elevenlabs/music/v2.5', credits: 120, status: 'refunded', month: '2026-11', created_at: '2026-11-06T11:00:00Z' },
    ],
    payments: [{ reference: 'p1', user_id: ANA, plan: null, credits: 500, currency: 'NGN', amount: 500000, status: 'success', paid_at: '2026-11-06T09:00:00Z', created_at: '2026-11-06T09:00:00Z' }],
    reports: [{ id: REPORT, user_id: ANA, created_at: '2026-11-06T08:00:00Z', version: '1.18.1', message: 'Captions stopped', report: 'Keo problem report…', status: 'new' }],
    credits: [{ user_id: ANA, month: '2026-11', monthly_used: 0, bought: 40 }],
    actions: [] as Array<Record<string, unknown>>,
    plans: [{ id: 'free', name: 'Free' }, { id: 'pro', name: 'Pro' }, { id: 'creator', name: 'Creator' }, { id: 'max', name: 'Max' }],
  };
  const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname === '/auth/v1/user') {
      const u = users[(headers.get('authorization') ?? '').replace('Bearer ', '')];
      return u ? j(200, u) : j(401, {});
    }
    const q = url.searchParams;
    const eq = (k: string) => (q.get(k) ?? '').replace(/^eq\./, '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    switch (url.pathname) {
      case '/rest/v1/profiles': {
        if (method === 'PATCH') {
          const p = db.profiles.find((x) => x.id === eq('id'))!;
          Object.assign(p, body);
          return new Response(null, { status: 204 });
        }
        let rows = db.profiles;
        if (q.get('id')?.startsWith('eq.')) rows = rows.filter((x) => x.id === eq('id'));
        if (q.get('id')?.startsWith('in.')) rows = rows.filter((x) => q.get('id')!.includes(x.id));
        if (q.get('email')) rows = rows.filter((x) => x.email.includes(q.get('email')!.replace('ilike.', '').replace(/\*/g, '')));
        return j(200, rows);
      }
      case '/rest/v1/usage_daily':
        return j(200, db.usage.filter((u) => !q.get('user_id') || q.get('user_id')!.includes(u.user_id)));
      case '/rest/v1/studio_jobs':
        return j(200, db.jobs.filter((x) => !q.get('user_id') || x.user_id === eq('user_id')));
      case '/rest/v1/payments':
        return j(200, db.payments);
      case '/rest/v1/studio_credits':
        return j(200, db.credits.filter((c) => !q.get('user_id') || q.get('user_id')!.includes(c.user_id)));
      case '/rest/v1/plans':
        return j(200, db.plans);
      case '/rest/v1/problem_reports': {
        if (method === 'PATCH') {
          Object.assign(db.reports.find((r) => r.id === eq('id'))!, body);
          return new Response(null, { status: 204 });
        }
        let rows = db.reports;
        if (q.get('status')) rows = rows.filter((r) => r.status === eq('status'));
        if (q.get('id')) rows = rows.filter((r) => r.id === eq('id'));
        if (q.get('user_id')) rows = rows.filter((r) => r.user_id === eq('user_id'));
        return j(200, rows);
      }
      case '/rest/v1/admin_actions':
        if (method === 'POST') {
          db.actions.push(body);
          return new Response(null, { status: 201 });
        }
        return j(200, db.actions.map((a, i) => ({ id: i, at: '2026-11-06T12:00:00Z', ...a })));
      case '/rest/v1/rpc/add_credits': {
        const c = db.credits.find((x) => x.user_id === body.p_user)!;
        c.bought += Number(body.p_amount);
        return new Response(null, { status: 204 });
      }
    }
    return j(404, {});
  };
  return { fetch, db };
}

let w: ReturnType<typeof world>;
const call = async (method: string, path: string, body?: unknown, token = 'tok-owner', e: Env = env) => {
  const r = await handle(new Request(`https://keo.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), e, { fetch: w.fetch, waitUntil: () => undefined, now: () => NOW });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test answers are read loosely
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { html: text };
  }
  return { status: r.status, body: parsed, headers: r.headers };
};

beforeEach(() => {
  clearCache();
  w = world();
});

describe('Keo Cloud admin', () => {
  it('only the emails in ADMIN_EMAILS get in; without the list there is no admin', async () => {
    expect(adminEmails(env)).toEqual(['owner@keo.test', 'second@keo.test']);
    expect((await call('GET', '/v1/admin/me')).body).toEqual({ email: 'owner@keo.test' });
    expect((await call('GET', '/v1/admin/overview', undefined, 'tok-ana')).status).toBe(403);
    expect((await call('GET', '/v1/admin/overview', undefined, 'nobody')).status).toBe(401);
    expect((await call('GET', '/admin', undefined, 'x', { ...env, ADMIN_EMAILS: '' })).status).toBe(404);
    expect((await call('GET', '/v1/admin/me', undefined, 'tok-owner', { ...env, ADMIN_EMAILS: undefined })).status).toBe(404);
  });

  it('serves the page locked down (its own script only, no framing, nothing cached)', async () => {
    const r = await call('GET', '/admin', undefined, '');
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('KEO ADMIN');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src \'self\' https://db.test');
    expect(r.headers.get('cache-control')).toBe('no-store');
    // The service key never reaches the page (only the public anon key).
    expect(r.body.html).not.toContain('service-secret');
  });

  it('adds up the overview', async () => {
    const o = (await call('GET', '/v1/admin/overview')).body;
    expect(o).toMatchObject({ users: 2, newUsers7d: 1, blocked: 0, reportsNew: 1, today: { activeUsers: 1, requests: 12, costUsd: 0.04 } });
    // The refunded job does not count.
    expect(o.month).toMatchObject({ studioJobs: 1, studioCredits: 460, falCostUsd: 2.3, payments: 1, revenue: { NGN: 500000 } });
    expect(o.plans.find((p: { id: string }) => p.id === 'max').users).toBe(1);
  });

  it('lists and finds users, and shows one in full', async () => {
    const all = (await call('GET', '/v1/admin/users')).body.users;
    expect(all).toHaveLength(2);
    const found = (await call('GET', '/v1/admin/users?q=ana')).body.users;
    expect(found.map((u: { email: string }) => u.email)).toEqual(['ana@example.com']);
    expect(found[0]).toMatchObject({ today: { requests: 12 }, credits: { bought: 40 } });
    const one = (await call('GET', `/v1/admin/users/${ANA}`)).body;
    expect(one.profile.email).toBe('ana@example.com');
    expect(one.jobs).toHaveLength(2);
    expect(one.reports).toHaveLength(1);
  });

  it('gives credits, sets a plan, blocks, and logs each change with who made it', async () => {
    expect((await call('POST', `/v1/admin/users/${ANA}/credits`, { amount: 200, note: 'sorry for the bug' })).status).toBe(200);
    expect(w.db.credits[0]!.bought).toBe(240);
    expect((await call('POST', `/v1/admin/users/${ANA}/credits`, { amount: 0 })).status).toBe(400);
    expect((await call('POST', `/v1/admin/users/${ANA}/plan`, { plan: 'creator' })).status).toBe(400); // a paid plan needs an end date
    expect((await call('POST', `/v1/admin/users/${ANA}/plan`, { plan: 'creator', until: '2026-12-31T23:59:59Z' })).status).toBe(200);
    expect(w.db.profiles[1]).toMatchObject({ plan: 'creator', plan_until: '2026-12-31T23:59:59.000Z' });
    expect((await call('POST', `/v1/admin/users/${ANA}/block`, { blocked: true })).status).toBe(200);
    expect(w.db.profiles[1]!.blocked).toBe(true);
    // An admin cannot block an admin here.
    expect((await call('POST', `/v1/admin/users/${OWNER}/block`, { blocked: true })).status).toBe(400);
    expect(w.db.actions.map((a) => a.action)).toEqual(['credits.give', 'plan.set', 'user.block']);
    expect(w.db.actions.every((a) => a.admin_email === 'owner@keo.test')).toBe(true);
    // Not an admin: nothing changes.
    expect((await call('POST', `/v1/admin/users/${ANA}/credits`, { amount: 500 }, 'tok-ana')).status).toBe(403);
    expect(w.db.credits[0]!.bought).toBe(240);
  });

  it('reads problem reports and marks them', async () => {
    const list = (await call('GET', '/v1/admin/reports?status=new')).body.reports;
    expect(list[0]).toMatchObject({ id: REPORT, email: 'ana@example.com', message: 'Captions stopped' });
    expect((await call('GET', `/v1/admin/reports/${REPORT}`)).body.report).toBe('Keo problem report…');
    expect((await call('POST', `/v1/admin/reports/${REPORT}`, { status: 'fixed' })).status).toBe(200);
    expect(w.db.reports[0]!.status).toBe('fixed');
    expect((await call('POST', `/v1/admin/reports/${REPORT}`, { status: 'deleted' })).status).toBe(400);
  });
});
