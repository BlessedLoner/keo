import { beforeEach, describe, expect, it } from 'vitest';
import { currencyFor, makeTicket, paidUntil, readTicket } from '../src/billing';
import { clearCache, handle, type Env } from '../src/gateway';

const env: Env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
  OPENROUTER_API_KEY: 'or-secret',
  OPENROUTER_URL: 'https://or.test/api/v1',
  PAYSTACK_SECRET_KEY: 'sk_test_paystack',
  PAYSTACK_URL: 'https://ps.test',
};
const NOW = Date.parse('2026-10-27T12:00:00Z');

type Profile = Record<string, unknown> & { id: string; email: string; plan: string; plan_until: string | null; blocked: boolean };

/** Supabase (accounts, plans, prices, payments) and Paystack, in memory. */
class World {
  users = new Map<string, { id: string; email: string }>([['tok-ana', { id: 'u-ana', email: 'ana@example.test' }]]);
  profiles: Profile[] = [{ id: 'u-ana', email: 'ana@example.test', plan: 'free', plan_until: null, blocked: false }];
  plans = [
    { id: 'free', name: 'Free', daily_requests: 60, daily_tokens: 300000, max_tier: 1, monthly_cost_usd: 0.6, features: { web_search: 3 } },
    { id: 'pro', name: 'Pro', daily_requests: 600, daily_tokens: 4000000, max_tier: 2, monthly_cost_usd: 12, features: { web_search: 50, images: 10, studio_credits: 200 } },
    { id: 'max', name: 'Max', daily_requests: 2000, daily_tokens: 15000000, max_tier: 3, monthly_cost_usd: 28, features: { web_search: 200, images: 60, studio_credits: 500 } },
  ];
  prices = [
    { plan: 'pro', currency: 'USD', amount: 1500 },
    { plan: 'max', currency: 'USD', amount: 4000 },
    { plan: 'pro', currency: 'NGN', amount: 2000000 },
    { plan: 'max', currency: 'NGN', amount: 5000000 },
  ];
  paystackPlans: Array<{ plan_code: string; plan: string; currency: string; amount: number; live: boolean }> = [];
  payments: Array<Record<string, unknown>> = [];
  paystack: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  verify: Record<string, unknown> = {};
  disabled: string[] = [];
  packs = [{ id: 'medium', credits: 1500, currency: 'USD', amount: 1600 }];
  credits = new Map<string, number>();
  topupPacks = [
    { id: 'small', currency: 'USD', amount: 500, value_usd: 2.5 },
    { id: 'medium', currency: 'USD', amount: 1000, value_usd: 5.5 },
    { id: 'large', currency: 'USD', amount: 2000, value_usd: 12 },
    { id: 'small', currency: 'NGN', amount: 700000, value_usd: 2.5 },
  ];
  topups = new Map<string, number>();
  settings = [
    { key: 'ngn_per_usd', value: 1380 },
    { key: 'topup_custom_share', value: 0.5 },
    { key: 'topup_min_usd', value: 5 },
    { key: 'topup_max_usd', value: 100 },
    { key: 'topup_min_ngn', value: 7000 },
    { key: 'topup_max_ngn', value: 140000 },
    { key: 'topup_month_cap_usd', value: 100 },
  ];

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url.host === 'db.test') {
      if (url.pathname === '/auth/v1/user') {
        const u = this.users.get((headers.get('authorization') ?? '').replace('Bearer ', ''));
        return u ? j(200, u) : j(401, {});
      }
      if (headers.get('authorization') !== 'Bearer service-secret') return j(401, {});
      const q = url.searchParams;
      const eq = (k: string) => q.get(k)?.replace(/^eq\./, '');
      const table = url.pathname.replace('/rest/v1/', '');
      if (table === 'profiles') {
        const key = ['id', 'email', 'paystack_customer', 'paystack_subscription'].find((k) => q.has(k))!;
        const rows = this.profiles.filter((p) => String(p[key]) === eq(key));
        if (init.method === 'PATCH') {
          for (const r of rows) Object.assign(r, body);
          return new Response(null, { status: 204 });
        }
        return j(200, rows);
      }
      if (table === 'plans') return j(200, this.plans);
      if (table === 'models')
        return j(200, [
          { id: 'keo-fast', tier: 1, price_in_per_m: 0.1, price_out_per_m: 0.5 },
          { id: 'keo-strong', tier: 2, price_in_per_m: 2, price_out_per_m: 10 },
          { id: 'keo-best', tier: 3, price_in_per_m: 4, price_out_per_m: 20 },
        ]);
      if (table === 'credit_packs') return j(200, this.packs.filter((k) => (!q.has('id') || k.id === eq('id')) && (!q.has('currency') || k.currency === eq('currency'))));
      if (table === 'topup_packs') return j(200, this.topupPacks.filter((k) => (!q.has('id') || k.id === eq('id')) && (!q.has('currency') || k.currency === eq('currency'))));
      if (table === 'keo_settings') return j(200, this.settings);
      if (table === 'rpc/add_topup') {
        this.topups.set(String(body!.p_user), Math.round(((this.topups.get(String(body!.p_user)) ?? 0) + Number(body!.p_usd)) * 1e4) / 1e4);
        return j(200, this.topups.get(String(body!.p_user)));
      }
      if (table === 'rpc/add_credits') {
        this.credits.set(String(body!.p_user), (this.credits.get(String(body!.p_user)) ?? 0) + Number(body!.p_amount));
        return new Response(null, { status: 204 });
      }
      if (table === 'plan_prices') return j(200, this.prices);
      if (table === 'usage_daily') return j(200, []);
      if (table === 'paystack_plans') {
        if (init.method === 'POST') {
          this.paystackPlans.push(body as never);
          return new Response(null, { status: 201 });
        }
        if (q.has('plan_code')) return j(200, this.paystackPlans.filter((p) => p.plan_code === eq('plan_code')));
        return j(200, this.paystackPlans.filter((p) => p.plan === eq('plan') && p.currency === eq('currency') && String(p.amount) === eq('amount') && String(p.live) === eq('live')));
      }
      if (table === 'payments') {
        if ((init.method ?? 'GET') === 'GET') return j(200, this.payments.filter((p) => p.user_id === eq('user_id') && (!q.has('topup_usd') || p.topup_usd != null) && String(p.created_at ?? p.paid_at ?? '') >= String(q.get('created_at') ?? '').replace('gte.', '')));
        if (this.payments.some((p) => p.reference === body!.reference)) return j(201, []);
        this.payments.push(body!);
        return j(201, [body]);
      }
      return j(404, {});
    }
    if (url.host === 'ps.test') {
      this.paystack.push({ method: init.method ?? 'GET', path: url.pathname, body, auth: headers.get('authorization') });
      if (url.pathname === '/plan') return j(200, { status: true, data: { plan_code: `PLN_${this.paystack.length}` } });
      if (url.pathname === '/transaction/initialize') return j(200, { status: true, data: { access_code: 'ACC_1', reference: 'ref_1', authorization_url: 'https://checkout.paystack.com/ACC_1' } });
      if (url.pathname.startsWith('/transaction/verify/')) return j(200, { status: true, data: this.verify });
      if (url.pathname === '/subscription/disable') {
        this.disabled.push(String(body!.code));
        return j(200, { status: true, message: 'Subscription disabled successfully' });
      }
      if (url.pathname.endsWith('/manage/link')) return j(200, { status: true, data: { link: 'https://paystack.com/manage/subscriptions/x' } });
      return j(404, { status: false, message: 'unknown' });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  async call(path: string, o: { token?: string; body?: unknown; method?: string; headers?: Record<string, string>; raw?: string; country?: string } = {}) {
    const req = new Request(`https://keo-cloud.example.workers.dev${path}`, {
      method: o.method ?? (o.body || o.raw ? 'POST' : 'GET'),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json', ...(o.headers ?? {}) },
      ...(o.raw ? { body: o.raw } : o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    if (o.country) Object.defineProperty(req, 'cf', { value: { country: o.country } });
    return handle(req, env, { fetch: this.fetch, waitUntil: () => undefined, now: () => NOW });
  }

  /** A webhook from Paystack, signed with the secret key (or not). */
  async webhook(event: unknown, secret = 'sk_test_paystack') {
    const raw = JSON.stringify(event);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return this.call('/paystack/webhook', { raw, headers: { 'x-paystack-signature': sig } });
  }
}

let w: World;
beforeEach(() => {
  clearCache();
  w = new World();
});

const ana = () => w.profiles.find((p) => p.id === 'u-ana')!;

describe('Keo Cloud payments', () => {
  it('shows prices in the visitor’s currency: Naira in Nigeria, dollars elsewhere', async () => {
    const ng = (await (await w.call('/v1/billing/prices', { country: 'NG' })).json()) as { currency: string; currencies: string[]; plans: Array<{ id: string; prices: Record<string, number> }> };
    expect(ng.currency).toBe('NGN');
    expect(ng.currencies.sort()).toEqual(['NGN', 'USD']);
    expect(ng.plans.find((p) => p.id === 'pro')!.prices).toEqual({ USD: 1500, NGN: 2000000 });
    const us = (await (await w.call('/v1/billing/prices', { country: 'US' })).json()) as { currency: string };
    expect(us.currency).toBe('USD');
    expect(currencyFor(undefined)).toBe('USD');
  });

  it('tells the Upgrade page what each plan’s monthly AI allowance is about worth — never the dollars', async () => {
    const r = (await (await w.call('/v1/billing/prices', { country: 'US' })).json()) as { plans: Array<{ id: string; allowance: Record<string, number> }> };
    const pro = r.plans.find((p) => p.id === 'pro')!.allowance;
    const max = r.plans.find((p) => p.id === 'max')!.allowance;
    const free = r.plans.find((p) => p.id === 'free')!.allowance;
    // $12 ÷ ~$0.465 a Strong build; $28 ÷ ~$0.93 a Best build.
    expect(pro).toMatchObject({ strongBuilds: 25, bestBuilds: 0, dayShare: 0.15, weekShare: 0.4 });
    expect(max).toMatchObject({ strongBuilds: 60, bestBuilds: 30 });
    expect(free.strongBuilds).toBe(0);
    expect(free.fastTasks).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toMatch(/monthly_cost_usd|price_in_per_m/);
  });

  it('gives the app a short-lived Upgrade-page ticket that cannot be forged', async () => {
    const r = (await (await w.call('/v1/billing/ticket', { token: 'tok-ana', method: 'POST' })).json()) as { ticket: string };
    expect(await readTicket(env, r.ticket, NOW)).toEqual({ id: 'u-ana', email: 'ana@example.test' });
    expect(await readTicket(env, r.ticket, NOW + 31 * 60_000)).toBeNull(); // 30 minutes only
    const [tag, payload, sig] = r.ticket.split('.');
    const forged = `${tag}.${btoa(JSON.stringify({ u: 'u-bob', e: 'bob@x', x: NOW + 60_000 })).replace(/=+$/, '')}.${sig}`;
    expect(await readTicket(env, forged, NOW)).toBeNull();
    expect(await readTicket({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'other' }, `${tag}.${payload}.${sig}`, NOW)).toBeNull();
    // The ticket works for billing...
    expect((await w.call('/v1/billing', { token: r.ticket })).status).toBe(200);
    // ...but not for Keo's AI.
    expect((await w.call('/v1/models', { token: r.ticket })).status).toBe(401);
  });

  it('starts a monthly card subscription for the chosen plan and currency (Paystack plan made once)', async () => {
    const ticket = await makeTicket(env, { id: 'u-ana', email: 'ana@example.test' }, NOW);
    const r = await w.call('/v1/billing/checkout', { token: ticket, body: { plan: 'pro', currency: 'NGN' } });
    expect(await r.json()).toEqual({ accessCode: 'ACC_1', reference: 'ref_1', url: 'https://checkout.paystack.com/ACC_1' });
    const plan = w.paystack.find((c) => c.path === '/plan')!;
    expect(plan.body).toEqual({ name: 'Keo Pro (NGN)', interval: 'monthly', amount: 2000000, currency: 'NGN' });
    expect(plan.auth).toBe('Bearer sk_test_paystack');
    const init = w.paystack.find((c) => c.path === '/transaction/initialize')!;
    expect(init.body).toMatchObject({ email: 'ana@example.test', amount: 2000000, currency: 'NGN', plan: 'PLN_1', channels: ['card'], metadata: { user_id: 'u-ana', plan: 'pro' } });
    expect(w.paystackPlans).toEqual([{ plan_code: 'PLN_1', plan: 'pro', currency: 'NGN', amount: 2000000, live: false }]);
    await w.call('/v1/billing/checkout', { token: ticket, body: { plan: 'pro', currency: 'NGN' } });
    expect(w.paystack.filter((c) => c.path === '/plan')).toHaveLength(1);
    // Not for Free, or a currency without a price.
    expect((await w.call('/v1/billing/checkout', { token: ticket, body: { plan: 'free', currency: 'USD' } })).status).toBe(400);
    expect((await w.call('/v1/billing/checkout', { token: ticket, body: { plan: 'max', currency: 'GHS' } })).status).toBe(400);
  });

  it('switches the plan only on a genuine, signed payment of the right amount — once per payment', async () => {
    w.paystackPlans.push({ plan_code: 'PLN_pro', plan: 'pro', currency: 'USD', amount: 1500, live: false });
    const charge = { reference: 'ref_9', status: 'success', amount: 1500, currency: 'USD', paid_at: '2026-10-27T12:00:00.000Z', metadata: { user_id: 'u-ana', plan: 'pro' }, customer: { customer_code: 'CUS_ana', email: 'ana@example.test' }, plan: { plan_code: 'PLN_pro' } };
    // A forged webhook is refused and changes nothing.
    expect((await w.webhook({ event: 'charge.success', data: charge }, 'sk_test_wrong')).status).toBe(401);
    expect(ana().plan).toBe('free');
    // Too little money for the plan: ignored.
    expect((await w.webhook({ event: 'charge.success', data: { ...charge, reference: 'ref_cheap', amount: 100 } })).status).toBe(200);
    expect(ana().plan).toBe('free');
    // The real one.
    expect((await w.webhook({ event: 'charge.success', data: charge })).status).toBe(200);
    expect(ana()).toMatchObject({ plan: 'pro', billing_status: 'active', billing_currency: 'USD', paystack_customer: 'CUS_ana', plan_until: paidUntil(new Date(charge.paid_at)) });
    expect(ana().plan_until).toBe('2026-11-30T12:00:00.000Z'); // a month + 3 days' grace
    expect(w.payments).toHaveLength(1);
    // Sent again: recorded once.
    await w.webhook({ event: 'charge.success', data: charge });
    expect(w.payments).toHaveLength(1);
    // The plan is now in force for Keo's AI too.
    clearCache();
    const me = (await (await w.call('/v1/me', { token: 'tok-ana' })).json()) as { plan: { id: string }; billing: { until: string; status: string } };
    expect(me.plan.id).toBe('pro');
    expect(me.billing).toEqual({ until: '2026-11-30T12:00:00.000Z', status: 'active' });
  });

  it('each payment starts a new billing month: subscribing, renewing, upgrading and downgrading', async () => {
    w.paystackPlans.push(
      { plan_code: 'PLN_pro', plan: 'pro', currency: 'USD', amount: 2000, live: false },
      { plan_code: 'PLN_pro_old', plan: 'pro', currency: 'USD', amount: 1500, live: false },
      { plan_code: 'PLN_max', plan: 'max', currency: 'USD', amount: 4900, live: false },
    );
    const pay = (ref: string, code: string, amount: number, paidAt: string) =>
      w.webhook({ event: 'charge.success', data: { reference: ref, status: 'success', amount, currency: 'USD', paid_at: paidAt, metadata: { user_id: 'u-ana' }, customer: { customer_code: 'CUS_ana' }, plan: { plan_code: code } } });
    await pay('r1', 'PLN_pro', 2000, '2026-10-28T09:00:00.000Z');
    expect(ana()).toMatchObject({ plan: 'pro', period_start: '2026-10-28T09:00:00.000Z' });
    // Renewed a month later: the next billing month starts.
    await pay('r2', 'PLN_pro', 2000, '2026-11-28T09:05:00.000Z');
    expect(ana()).toMatchObject({ plan: 'pro', period_start: '2026-11-28T09:05:00.000Z' });
    // Upgrade to Max mid-month: a Max month starts at once.
    await pay('r3', 'PLN_max', 4900, '2026-12-05T14:00:00.000Z');
    expect(ana()).toMatchObject({ plan: 'max', period_start: '2026-12-05T14:00:00.000Z', plan_until: '2027-01-08T14:00:00.000Z' });
    // Back down to Pro on its own payment: a Pro month starts then.
    await pay('r4', 'PLN_pro', 2000, '2027-01-05T14:00:00.000Z');
    expect(ana()).toMatchObject({ plan: 'pro', period_start: '2027-01-05T14:00:00.000Z' });
    // Someone still on the old $15 Pro subscription keeps getting Pro for it.
    await pay('r5', 'PLN_pro_old', 1500, '2027-02-05T14:00:00.000Z');
    expect(ana()).toMatchObject({ plan: 'pro', period_start: '2027-02-05T14:00:00.000Z' });
    // A charge for the wrong amount changes nothing.
    await pay('r6', 'PLN_max', 100, '2027-02-06T14:00:00.000Z');
    expect(ana().plan).toBe('pro');
  });

  it('buys a Studio credit pack: checkout for the right price, credits added once, the wrong amount ignored', async () => {
    const ticket = ((await (await w.call('/v1/billing/ticket', { token: 'tok-ana', body: {} })).json()) as { ticket: string }).ticket;
    const r = await w.call('/v1/billing/credits', { token: ticket, body: { pack: 'medium', currency: 'USD' } });
    expect(r.status).toBe(200);
    const init = w.paystack.find((x) => x.path === '/transaction/initialize')!;
    expect(init.body).toMatchObject({ amount: 1600, currency: 'USD', metadata: { user_id: 'u-ana', pack: 'medium', credits: 1500 } });
    const charge = { reference: 'ref_pack', status: 'success', amount: 1600, currency: 'USD', metadata: { user_id: 'u-ana', pack: 'medium' } };
    await w.webhook({ event: 'charge.success', data: charge });
    await w.webhook({ event: 'charge.success', data: charge });
    expect(w.credits.get('u-ana')).toBe(1500);
    await w.webhook({ event: 'charge.success', data: { ...charge, reference: 'ref_cheap', amount: 100 } });
    expect(w.credits.get('u-ana')).toBe(1500);
    // A pack never changes the plan.
    expect(ana().plan).toBe('free');
  });

  it('follows the subscription: renewals by customer, not renewing, failed payments, plan switches', async () => {
    w.paystackPlans.push({ plan_code: 'PLN_pro', plan: 'pro', currency: 'USD', amount: 1500, live: false }, { plan_code: 'PLN_max', plan: 'max', currency: 'USD', amount: 4000, live: false });
    // subscription.create can arrive first: the account is found by email.
    await w.webhook({ event: 'subscription.create', data: { subscription_code: 'SUB_1', email_token: 'tok1', next_payment_date: '2026-11-27T12:00:00.000Z', customer: { customer_code: 'CUS_ana', email: 'ANA@example.test' }, plan: { plan_code: 'PLN_pro' } } });
    expect(ana()).toMatchObject({ paystack_customer: 'CUS_ana', paystack_subscription: 'SUB_1', paystack_email_token: 'tok1' });
    // A renewal has no metadata: the account is found by its Paystack customer.
    await w.webhook({ event: 'charge.success', data: { reference: 'ref_renew', status: 'success', amount: 1500, currency: 'USD', paid_at: '2026-11-27T12:00:00.000Z', customer: { customer_code: 'CUS_ana' }, plan: { plan_code: 'PLN_pro' } } });
    expect(ana()).toMatchObject({ plan: 'pro', plan_until: '2026-12-30T12:00:00.000Z' });
    await w.webhook({ event: 'invoice.payment_failed', data: { subscription: { subscription_code: 'SUB_1' } } });
    expect(ana().billing_status).toBe('attention');
    await w.webhook({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_1' } });
    expect(ana()).toMatchObject({ billing_status: 'non-renewing', plan: 'pro' }); // kept until the paid month ends
    // Switching to Max: the old subscription is stopped.
    await w.webhook({ event: 'subscription.create', data: { subscription_code: 'SUB_2', email_token: 'tok2', customer: { customer_code: 'CUS_ana' } } });
    expect(w.disabled).toEqual(['SUB_1']);
    expect(ana().paystack_subscription).toBe('SUB_2');
  });

  it('confirms a payment right after checkout, only for the account that paid', async () => {
    w.paystackPlans.push({ plan_code: 'PLN_max', plan: 'max', currency: 'NGN', amount: 5000000, live: false });
    const ticket = await makeTicket(env, { id: 'u-ana', email: 'ana@example.test' }, NOW);
    w.verify = { reference: 'ref_2', status: 'success', amount: 5000000, currency: 'NGN', paid_at: '2026-10-27T12:00:00.000Z', metadata: JSON.stringify({ user_id: 'u-bob', plan: 'max' }), plan: 'PLN_max', customer: { customer_code: 'CUS_bob' } };
    expect((await w.call('/v1/billing/confirm', { token: ticket, body: { reference: 'ref_2' } })).status).toBe(403);
    expect(ana().plan).toBe('free');
    w.verify = { ...w.verify, metadata: JSON.stringify({ user_id: 'u-ana', plan: 'max' }), customer: { customer_code: 'CUS_ana' } };
    const r = (await (await w.call('/v1/billing/confirm', { token: ticket, body: { reference: 'ref_2' } })).json()) as { ok: boolean; plan: string };
    expect(r).toMatchObject({ ok: true, plan: 'max' });
    expect(ana()).toMatchObject({ plan: 'max', billing_currency: 'NGN' });
  });

  it('cancels renewal and links to Paystack’s card page', async () => {
    Object.assign(ana(), { plan: 'pro', plan_until: '2026-11-30T12:00:00.000Z', paystack_subscription: 'SUB_1', paystack_email_token: 'tok1', billing_status: 'active' });
    const ticket = await makeTicket(env, { id: 'u-ana', email: 'ana@example.test' }, NOW);
    const st = (await (await w.call('/v1/billing', { token: ticket })).json()) as { plan: string; canManage: boolean };
    expect(st).toMatchObject({ plan: 'pro', canManage: true });
    expect((await (await w.call('/v1/billing/manage', { token: ticket })).json()) as unknown).toEqual({ link: 'https://paystack.com/manage/subscriptions/x' });
    expect((await w.call('/v1/billing/cancel', { token: ticket, method: 'POST' })).status).toBe(200);
    expect(w.disabled).toEqual(['SUB_1']);
    expect(ana()).toMatchObject({ billing_status: 'non-renewing', plan: 'pro' });
  });

  it('serves the Upgrade page without any secret in it', async () => {
    const r = await w.call('/upgrade');
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('content-security-policy')).toContain('https://js.paystack.co');
    const html = await r.text();
    expect(html).toContain('Choose your plan');
    expect(html).not.toMatch(/sk_test|service-secret|or-secret/);
  });

  it('serves the Terms, Privacy and Refund pages, with the support email once it is set', async () => {
    for (const p of ['/terms', '/privacy', '/refunds']) {
      const r = await w.call(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/coming soon/);
    }
    const req = new Request('https://keo-cloud.example.workers.dev/refunds');
    const html = await (await handle(req, { ...env, KEO_SUPPORT_EMAIL: 'help@keo.test' }, { fetch: w.fetch, waitUntil: () => undefined, now: () => NOW })).text();
    expect(html).toContain('mailto:help@keo.test');
    expect(html).toMatch(/Payments are not refunded/);
  });

  it('keeps payments off until a Paystack key is set', async () => {
    const off = { ...env, PAYSTACK_SECRET_KEY: undefined };
    const req = new Request('https://keo-cloud.example.workers.dev/v1/billing/checkout', { method: 'POST', headers: { authorization: 'Bearer tok-ana' }, body: '{"plan":"pro","currency":"USD"}' });
    expect((await handle(req, off, { fetch: w.fetch, waitUntil: () => undefined, now: () => NOW })).status).toBe(503);
    expect(w.paystack).toHaveLength(0);
  });

  it('AI top-ups: packs and a typed amount from $5, priced on the server, added once, within $100 in 30 days', async () => {
    const ticket = ((await (await w.call('/v1/billing/ticket', { token: 'tok-ana', body: {} })).json()) as { ticket: string }).ticket;
    const buy = (b: Record<string, unknown>) => w.call('/v1/billing/topup', { token: ticket, body: b });
    // A pack: the checkout is for its own price, whatever the app says.
    expect((await buy({ pack: 'medium', currency: 'USD', amount: 1 })).status).toBe(200);
    expect(w.paystack.at(-1)!.body).toMatchObject({ amount: 1000, currency: 'USD', metadata: { user_id: 'u-ana', topup: 'medium' } });
    // Typed amounts: from $5 to $100, or ₦7,000 to ₦140,000.
    const low = await buy({ amount: 499, currency: 'USD' });
    expect(low.status).toBe(400);
    expect(((await low.json()) as { error: { message: string } }).error.message).toBe('Choose an amount from $5 to $100.');
    expect((await buy({ amount: 500, currency: 'USD' })).status).toBe(200);
    expect(w.paystack.at(-1)!.body).toMatchObject({ amount: 500, metadata: { topup: 'custom' } });
    expect((await buy({ amount: 10001, currency: 'USD' })).status).toBe(400);
    const naira = await buy({ amount: 699900, currency: 'NGN' });
    expect(((await naira.json()) as { error: { message: string } }).error.message).toBe('Choose an amount from ₦7,000 to ₦140,000.');
    expect((await buy({ amount: 700000, currency: 'NGN' })).status).toBe(200);

    // Paid: the allowance is added once per payment, worked out from what was paid.
    const paid = (reference: string, amount: number, currency: string, topup: string) =>
      w.webhook({ event: 'charge.success', data: { reference, status: 'success', amount, currency, paid_at: '2026-10-27T12:00:00.000Z', metadata: { user_id: 'u-ana', topup } } });
    await paid('t1', 1000, 'USD', 'medium');
    await paid('t1', 1000, 'USD', 'medium');
    expect(w.topups.get('u-ana')).toBe(5.5);
    // A typed $5 adds half of it; ₦7,000 adds half of its dollars.
    await paid('t2', 500, 'USD', 'custom');
    expect(w.topups.get('u-ana')).toBe(8);
    await paid('t3', 700000, 'NGN', 'custom');
    expect(w.topups.get('u-ana')).toBeCloseTo(8 + 2.5362, 4);
    // The wrong amount for a pack, or a typed amount out of range: nothing is added.
    await paid('t4', 900, 'USD', 'medium');
    await paid('t5', 300, 'USD', 'custom');
    expect(w.topups.get('u-ana')).toBeCloseTo(10.5362, 4);
    // A top-up never changes the plan or the Studio credits.
    expect(ana().plan).toBe('free');
    expect(w.credits.get('u-ana')).toBeUndefined();

    // At most $100 in 30 days: about $25.07 is paid so far, so $80 more is too much and $70 is fine.
    for (const x of w.payments) x.created_at = '2026-10-26T00:00:00.000Z';
    const over = await buy({ amount: 8000, currency: 'USD' });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('topup_cap');
    expect((await buy({ amount: 7000, currency: 'USD' })).status).toBe(200);
  });

  it('the Upgrade page is told the top-up packs and the typed-amount limits, as builds and tasks', async () => {
    const r = (await (await w.call('/v1/billing/prices', { country: 'NG' })).json()) as { topups: { packs: Array<{ id: string; prices: Record<string, number>; worth: { strongBuilds: number; fastTasks: number } }>; custom: { min: Record<string, number>; max: Record<string, number> }; monthCapUsd: number } };
    expect(r.topups.packs.map((k) => k.id)).toEqual(['small', 'medium', 'large']);
    expect(r.topups.packs[0]!.prices).toEqual({ USD: 500, NGN: 700000 });
    // $2.50 of AI ≈ 5 builds on Keo Strong; $12 ≈ 25.
    expect(r.topups.packs[0]!.worth.strongBuilds).toBe(5);
    expect(r.topups.packs[2]!.worth.strongBuilds).toBe(25);
    expect(r.topups.custom.min).toEqual({ USD: 500, NGN: 700000 });
    expect(r.topups.custom.max).toEqual({ USD: 10000, NGN: 14000000 });
    expect(r.topups.monthCapUsd).toBe(100);
    expect(JSON.stringify(r.topups)).not.toContain('value_usd');
  });
});
