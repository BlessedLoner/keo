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
    plans: [
      { id: 'free', name: 'Free', features: { studio_credits: 0 } },
      { id: 'pro', name: 'Pro', features: { studio_credits: 200 } },
      { id: 'creator', name: 'Creator', features: { studio_credits: 1500 } },
      { id: 'max', name: 'Max', features: { studio_credits: 500 } },
    ],
    spend: [] as Array<{ day: string; provider: string; cost_usd: number }>,
    settings: [{ key: 'ngn_per_usd', value: 1380 }, { key: 'breaker_openrouter_day_usd', value: 60 }, { key: 'breaker_fal_day_usd', value: 40 }],
    alerts: [] as Array<{ day: string; kind: string; message: string; created_at: string }>,
    topups: new Map<string, number>(),
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
      case '/rest/v1/spend_daily':
        return j(200, db.spend);
      case '/rest/v1/keo_settings':
        return j(200, db.settings);
      case '/rest/v1/alerts':
        return j(200, db.alerts);
      case '/rest/v1/ai_topups':
        return j(200, [...db.topups.entries()].map(([user_id, balance_usd]) => ({ user_id, balance_usd })));
      case '/rest/v1/models':
        return j(200, [{ id: 'keo-strong', price_in_per_m: 2, price_out_per_m: 10 }]);
      case '/rest/v1/rpc/add_topup':
        db.topups.set(String(body.p_user), (db.topups.get(String(body.p_user)) ?? 0) + Number(body.p_usd));
        return j(200, db.topups.get(String(body.p_user)));
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

  it('shows the month’s money: revenue, fees, AI and Studio costs and gross margin per plan, what Keo owes in credits, safety limits and alerts', async () => {
    const owner = w.db.profiles[0]! as Record<string, unknown>;
    owner.period_start = '2026-11-02T00:00:00Z';
    (w.db.payments as Array<Record<string, unknown>>).push({ reference: 'p2', user_id: OWNER, plan: 'max', credits: null as unknown as number, currency: 'USD', amount: 4900, status: 'success', paid_at: '2026-11-02T00:00:00Z', created_at: '2026-11-02T00:00:00Z' });
    w.db.usage.push({ user_id: OWNER, day: '2026-11-03', requests: 400, input_tokens: 9e6, output_tokens: 3e5, cost_usd: 10, web_searches: 0, images: 0 });
    w.db.credits.push({ user_id: OWNER, month: 'p2026-11-02T00:00:00', monthly_used: 100, bought: 0 });
    w.db.spend.push({ day: '2026-11-06', provider: 'openrouter', cost_usd: 50 }, { day: '2026-11-06', provider: 'fal', cost_usd: 2.3 });
    w.db.alerts.push({ day: '2026-11-06', kind: 'near_openrouter', message: 'Keo’s AI spend today passed 80% of its $60 safety limit.', created_at: '2026-11-06T11:00:00Z' });
    const r = await call('GET', '/v1/admin/finance?month=2026-11');
    expect(r.status).toBe(200);
    const max = r.body.byPlan.find((x: { plan: string }) => x.plan === 'max');
    // $49 in, Paystack about $2.13, $10 of AI: about $36.87 (75%).
    expect(max).toMatchObject({ revenueUsd: 49, feesUsd: 2.13, aiUsd: 10, falUsd: 0, marginUsd: 36.87, marginPct: 75, payers: 1 });
    const free = r.body.byPlan.find((x: { plan: string }) => x.plan === 'free');
    // A refunded Studio job costs nothing; the done one is 460 credits = $2.30 at fal.ai.
    expect(free).toMatchObject({ revenueUsd: 0, aiUsd: 0.04, falUsd: 2.3, marginPct: null });
    const packs = r.body.byPlan.find((x: { plan: string }) => x.plan === 'credit packs');
    // ₦5,000 at ₦1,380 to $1; a local card's fee is 1.5% + ₦100.
    expect(packs).toMatchObject({ revenueUsd: 3.62, feesUsd: 0.14 });
    // Owed: 40 bought + 400 of Max's 500 monthly credits left = 440 credits = $2.20 at fal.ai.
    expect(r.body.liabilities).toEqual({ boughtCredits: 40, monthlyCreditsLeft: 400, falCostUsd: 2.2, topupUsd: 0 });
    expect(r.body.breakers).toEqual([
      { provider: 'openrouter', limitUsd: 60, todayUsd: 50 },
      { provider: 'fal', limitUsd: 40, todayUsd: 2.3 },
    ]);
    expect(r.body.alerts).toHaveLength(1);
    expect(r.body.total.revenueUsd).toBe(52.62);
    // Not for anyone else.
    expect((await call('GET', '/v1/admin/finance', undefined, 'tok-ana')).status).toBe(403);
  });

  it('gives an AI top-up (in builds on Keo Strong), logs it, and counts top-ups on the money page', async () => {
    const r = await call('POST', `/v1/admin/users/${OWNER}/topup`, { builds: 100, note: 'owner testing' });
    expect(r.status).toBe(200);
    // 100 builds × about $0.465.
    expect(w.db.topups.get(OWNER)).toBeCloseTo(46.53, 2);
    expect(w.db.actions.at(-1)).toMatchObject({ action: 'topup.give', target_user: OWNER, detail: { builds: 100, note: 'owner testing' } });
    expect((await call('POST', `/v1/admin/users/${OWNER}/topup`, { builds: 0 })).status).toBe(400);
    expect((await call('POST', `/v1/admin/users/${ANA}/topup`, { builds: 5 }, 'tok-ana')).status).toBe(403);
    // A bought top-up and AI it paid for.
    (w.db.payments as Array<Record<string, unknown>>).push({ reference: 't1', user_id: ANA, plan: null, credits: null, topup_usd: 5.5, currency: 'USD', amount: 1000, status: 'success', paid_at: '2026-11-06T09:30:00Z', created_at: '2026-11-06T09:30:00Z' });
    (w.db.usage as Array<Record<string, unknown>>).push({ user_id: ANA, day: '2026-11-06', requests: 3, input_tokens: 0, output_tokens: 0, cost_usd: 0, topup_cost_usd: 1.2, web_searches: 0, images: 0 });
    const f = await call('GET', '/v1/admin/finance?month=2026-11');
    const t = f.body.byPlan.find((x: { plan: string }) => x.plan === 'AI top-ups');
    expect(t).toMatchObject({ revenueUsd: 10, aiUsd: 1.2, payers: 0 });
    expect(t.marginUsd).toBeCloseTo(10 - t.feesUsd - 1.2, 2);
    expect(f.body.liabilities.topupUsd).toBeCloseTo(46.53, 2);
  });
});
