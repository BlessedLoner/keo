/**
 * Paying for Keo's plans with Paystack. Card details never reach Keo: the Upgrade page opens
 * Paystack's own secure checkout, and Paystack tells the gateway about payments through a signed
 * webhook. A plan is a monthly Paystack subscription; each successful charge keeps the plan
 * active for another month (plus a few days' grace), and a stopped subscription simply runs out.
 */
import { buildCost, capsFor, fail, json, taskCost, type Env, type Fetch, type Supabase } from './gateway';

export const CURRENCIES = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Which currency a visitor sees first (they can switch on the page). */
export function currencyFor(country: string | null | undefined): Currency {
  return country === 'NG' ? 'NGN' : 'USD';
}

const GRACE_DAYS = 3;
/** Until when one paid month keeps the plan: the same day next month, plus a few days' grace. */
export function paidUntil(paidAt: Date): string {
  const d = new Date(paidAt);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(d.getUTCDate() + GRACE_DAYS);
  return d.toISOString();
}

// ---------------------------------------------------------------- billing tickets
// The Keo app opens the Upgrade page in the browser with a short-lived ticket (not the user's
// sign-in): it only allows billing for that account, and only for 30 minutes.

const TICKET_MINUTES = 30;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function ticketKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SUPABASE_SERVICE_ROLE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', base, new TextEncoder().encode('keo-billing-ticket-v1')));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeTicket(env: Env, user: { id: string; email: string | null }, now: number): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({ u: user.id, e: user.email, x: now + TICKET_MINUTES * 60_000 }));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await ticketKey(env), payload));
  return `kt.${b64url(payload)}.${b64url(sig)}`;
}

export async function readTicket(env: Env, ticket: string, now: number): Promise<{ id: string; email: string | null } | null> {
  const [tag, p, s] = ticket.split('.');
  if (tag !== 'kt' || !p || !s) return null;
  try {
    const payload = fromB64url(p);
    if (!(await crypto.subtle.verify('HMAC', await ticketKey(env), fromB64url(s), payload))) return null;
    const t = JSON.parse(new TextDecoder().decode(payload)) as { u?: string; e?: string | null; x?: number };
    if (!t.u || !t.x || t.x < now) return null;
    return { id: t.u, email: t.e ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Paystack

export async function paystackSignatureOk(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison.
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  return diff === 0;
}

class Paystack {
  constructor(
    private readonly env: Env,
    private readonly fetch: Fetch,
  ) {}
  get live(): boolean {
    return (this.env.PAYSTACK_SECRET_KEY ?? '').startsWith('sk_live_');
  }
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const r = await this.fetch(`${this.env.PAYSTACK_URL ?? 'https://api.paystack.co'}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: unknown };
    if (!r.ok || j.status === false) throw new Error(j.message ?? `Paystack answered ${r.status}.`);
    return j.data as T;
  }
}

interface Price {
  plan: string;
  currency: string;
  amount: number;
}
export interface BillingProfile {
  plan: string;
  plan_until: string | null;
  /** When the current paid month started: the AI allowance and monthly Studio credits follow it. */
  period_start?: string | null;
  billing_status: string | null;
  billing_currency: string | null;
  paystack_customer: string | null;
  paystack_subscription: string | null;
  paystack_email_token: string | null;
}
const PROFILE_FIELDS = 'id,plan,plan_until,billing_status,billing_currency,paystack_customer,paystack_subscription,paystack_email_token';

async function prices(db: Supabase): Promise<Price[]> {
  return (await db.rest<Price[]>('plan_prices?select=plan,currency,amount')).map((p) => ({ ...p, amount: Number(p.amount) }));
}
async function profileBy(db: Supabase, field: 'id' | 'email' | 'paystack_customer' | 'paystack_subscription', value: string): Promise<(BillingProfile & { id: string }) | null> {
  const rows = await db.rest<Array<BillingProfile & { id: string }>>(`profiles?${field}=eq.${encodeURIComponent(value)}&select=${PROFILE_FIELDS}`);
  return rows[0] ?? null;
}
async function patchProfile(db: Supabase, id: string, fields: Partial<BillingProfile>): Promise<void> {
  await db.rest(`profiles?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(fields), headers: { prefer: 'return=minimal' } });
}

/** The Paystack monthly plan for a price (made once per price, separately for test and live keys). */
async function paystackPlan(db: Supabase, ps: Paystack, price: Price, planName: string): Promise<string> {
  const rows = await db.rest<Array<{ plan_code: string }>>(
    `paystack_plans?plan=eq.${price.plan}&currency=eq.${price.currency}&amount=eq.${price.amount}&live=eq.${ps.live}&select=plan_code&limit=1`,
  );
  if (rows[0]) return rows[0].plan_code;
  const made = await ps.call<{ plan_code: string }>('POST', '/plan', { name: `Keo ${planName} (${price.currency})`, interval: 'monthly', amount: price.amount, currency: price.currency });
  await db.rest('paystack_plans', { method: 'POST', body: JSON.stringify({ plan_code: made.plan_code, plan: price.plan, currency: price.currency, amount: price.amount, live: ps.live }), headers: { prefer: 'return=minimal' } });
  return made.plan_code;
}

/** Paystack sends metadata as an object or as a JSON string. */
type Meta = { user_id?: string; plan?: string; pack?: string; topup?: string };
function metaOf(c: { metadata?: unknown }): Meta {
  let m = c.metadata;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return {};
    }
  }
  return m && typeof m === 'object' ? (m as Meta) : {};
}

interface Charge {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  metadata?: Meta | string | null;
  customer?: { customer_code?: string; email?: string };
  plan?: { plan_code?: string } | string | null;
}

/**
 * A successful charge: the account gets (or keeps) its plan for another month. Only a charge for
 * a Keo plan, of exactly that plan's price and currency, counts. Recorded once per reference.
 */
async function applyCharge(db: Supabase, c: Charge, now: number): Promise<{ applied: boolean; why?: string; userId?: string; plan?: string; credits?: number }> {
  if (c.status !== 'success') return { applied: false, why: 'not successful' };
  const meta = metaOf(c);
  if (meta.pack && !c.plan) return applyCreditPack(db, c, meta, now);
  if (meta.topup && !c.plan) return applyTopup(db, c, meta, now);
  const planCode = typeof c.plan === 'object' && c.plan ? c.plan.plan_code : typeof c.plan === 'string' ? c.plan : undefined;
  const known = planCode ? (await db.rest<Array<{ plan: string; currency: string; amount: number }>>(`paystack_plans?plan_code=eq.${encodeURIComponent(planCode)}&select=plan,currency,amount`))[0] : undefined;
  if (!known) return { applied: false, why: 'not a Keo plan' };
  if (Number(known.amount) !== Number(c.amount) || known.currency !== c.currency) return { applied: false, why: 'amount or currency does not match the plan' };
  const profile =
    (meta.user_id ? await profileBy(db, 'id', meta.user_id) : null) ?? (c.customer?.customer_code ? await profileBy(db, 'paystack_customer', c.customer.customer_code) : null);
  if (!profile) return { applied: false, why: 'no Keo account for this payment' };
  // Each payment once (Paystack may send the same event again).
  const inserted = await db.rest<unknown[]>('payments?on_conflict=reference', {
    method: 'POST',
    body: JSON.stringify({ reference: c.reference, user_id: profile.id, plan: known.plan, currency: c.currency, amount: c.amount, status: 'success', paid_at: c.paid_at ?? new Date(now).toISOString() }),
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
  });
  if (!inserted?.length) return { applied: false, why: 'already recorded', userId: profile.id, plan: known.plan };
  const from = c.paid_at ? new Date(c.paid_at) : new Date(now);
  const until = paidUntil(from);
  const keep = profile.plan === known.plan && profile.plan_until && Date.parse(profile.plan_until) > Date.parse(until) ? profile.plan_until : until;
  await patchProfile(db, profile.id, {
    plan: known.plan,
    plan_until: keep,
    // Each payment starts a new billing month: one payment is one month's allowance and credits.
    period_start: from.toISOString(),
    billing_status: 'active',
    billing_currency: c.currency,
    ...(c.customer?.customer_code ? { paystack_customer: c.customer.customer_code } : {}),
  });
  return { applied: true, userId: profile.id, plan: known.plan };
}

/**
 * A paid credit pack: its credits are added once. Only a Keo pack, of exactly its price and
 * currency, counts; recorded once per reference like plan payments.
 */
async function applyCreditPack(db: Supabase, c: Charge, meta: { user_id?: string; pack?: string }, now: number): Promise<{ applied: boolean; why?: string; userId?: string; credits?: number }> {
  const pack = (await db.rest<Array<{ credits: number; amount: number }>>(`credit_packs?id=eq.${encodeURIComponent(meta.pack ?? '')}&currency=eq.${encodeURIComponent(c.currency)}&select=credits,amount`))[0];
  if (!pack) return { applied: false, why: 'not a Keo credit pack' };
  if (Number(pack.amount) !== Number(c.amount)) return { applied: false, why: 'amount does not match the pack' };
  const profile = meta.user_id ? await profileBy(db, 'id', meta.user_id) : null;
  if (!profile) return { applied: false, why: 'no Keo account for this payment' };
  const inserted = await db.rest<unknown[]>('payments?on_conflict=reference', {
    method: 'POST',
    body: JSON.stringify({ reference: c.reference, user_id: profile.id, plan: null, credits: Number(pack.credits), currency: c.currency, amount: c.amount, status: 'success', paid_at: c.paid_at ?? new Date(now).toISOString() }),
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
  });
  if (!inserted?.length) return { applied: false, why: 'already recorded', userId: profile.id, credits: Number(pack.credits) };
  await db.rest('rpc/add_credits', { method: 'POST', body: JSON.stringify({ p_user: profile.id, p_amount: Number(pack.credits) }) });
  return { applied: true, userId: profile.id, credits: Number(pack.credits) };
}

// ---------------------------------------------------------------- AI top-ups

/** Keo's settings (Table Editor → keo_settings), with defaults when a row is missing. */
async function settingsOf(db: Supabase): Promise<(key: string, d: number) => number> {
  const rows = await db.rest<Array<{ key: string; value: number }>>('keo_settings?select=key,value').catch(() => []);
  return (key, d) => {
    const v = Number(rows.find((r) => r.key === key)?.value);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
}

/** The smallest and largest top-up a user may type (smallest unit: cents, kobo). */
export function topupLimits(setting: (key: string, d: number) => number): { min: Record<string, number>; max: Record<string, number> } {
  return {
    min: { USD: Math.round(setting('topup_min_usd', 5) * 100), NGN: Math.round(setting('topup_min_ngn', 7000) * 100) },
    max: { USD: Math.round(setting('topup_max_usd', 100) * 100), NGN: Math.round(setting('topup_max_ngn', 140000) * 100) },
  };
}

/**
 * What a top-up adds (US$ of AI allowance), worked out on the server from what was paid — never from
 * what the app or the payment's metadata says. A pack: its own value. An amount the user typed: a
 * share of it (the Small pack's rate), within the limits. Null when it is not a valid top-up.
 */
export async function topupValue(db: Supabase, pick: string, currency: string, amount: number): Promise<number | null> {
  if (pick !== 'custom') {
    const pack = (await db.rest<Array<{ amount: number; value_usd: number }>>(`topup_packs?id=eq.${encodeURIComponent(pick)}&currency=eq.${encodeURIComponent(currency)}&select=amount,value_usd`))[0];
    return pack && Number(pack.amount) === Number(amount) ? Number(pack.value_usd) : null;
  }
  const setting = await settingsOf(db);
  const { min, max } = topupLimits(setting);
  if (min[currency] === undefined || amount < min[currency]! || amount > max[currency]!) return null;
  const usd = currency === 'NGN' ? amount / 100 / setting('ngn_per_usd', 1380) : amount / 100;
  return Math.floor(usd * setting('topup_custom_share', 0.5) * 10_000) / 10_000;
}

/** What an account paid for top-ups in the last 30 days (US$). */
async function topupsLately(db: Supabase, userId: string, now: number): Promise<number> {
  const setting = await settingsOf(db);
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const rows = await db.rest<Array<{ currency: string; amount: number }>>(`payments?user_id=eq.${encodeURIComponent(userId)}&topup_usd=not.is.null&status=eq.success&created_at=gte.${encodeURIComponent(since)}&select=currency,amount`).catch(() => []);
  return rows.reduce((t, r) => t + (r.currency === 'NGN' ? Number(r.amount) / 100 / setting('ngn_per_usd', 1380) : Number(r.amount) / 100), 0);
}

/** A paid AI top-up: its allowance is added once (recorded once per reference, like plans and packs). */
async function applyTopup(db: Supabase, c: Charge, meta: Meta, now: number): Promise<{ applied: boolean; why?: string; userId?: string; topupUsd?: number }> {
  const value = await topupValue(db, String(meta.topup), c.currency, Number(c.amount));
  if (!value) return { applied: false, why: 'not a valid Keo top-up for this amount' };
  const profile = meta.user_id ? await profileBy(db, 'id', meta.user_id) : null;
  if (!profile) return { applied: false, why: 'no Keo account for this payment' };
  const inserted = await db.rest<unknown[]>('payments?on_conflict=reference', {
    method: 'POST',
    body: JSON.stringify({ reference: c.reference, user_id: profile.id, plan: null, topup_usd: value, currency: c.currency, amount: c.amount, status: 'success', paid_at: c.paid_at ?? new Date(now).toISOString() }),
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
  });
  if (!inserted?.length) return { applied: false, why: 'already recorded', userId: profile.id, topupUsd: value };
  await db.rest('rpc/add_topup', { method: 'POST', body: JSON.stringify({ p_user: profile.id, p_usd: value }) });
  return { applied: true, userId: profile.id, topupUsd: value };
}

// ---------------------------------------------------------------- routes

type Who = { id: string; email: string | null };

/** Handles /v1/billing/* and /paystack/webhook; null for other paths. */
export async function handleBilling(
  req: Request,
  route: string,
  env: Env,
  deps: { fetch: Fetch; now: number; db: Supabase; who: () => Promise<Who | Response>; waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  const { db, now } = deps;
  const ps = new Paystack(env, deps.fetch);
  const configured = !!env.PAYSTACK_SECRET_KEY;

  if (req.method === 'POST' && route === '/paystack/webhook') {
    if (!configured) return fail(503, 'Payments are not set up.', 'billing_off');
    const raw = await req.text();
    if (!(await paystackSignatureOk(env.PAYSTACK_SECRET_KEY!, raw, req.headers.get('x-paystack-signature')))) return fail(401, 'Bad signature.', 'bad_signature');
    let event: { event?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return fail(400, 'Not JSON.', 'bad_json');
    }
    const d = event.data ?? {};
    const customer = (d.customer as { customer_code?: string; email?: string } | undefined) ?? {};
    if (event.event === 'charge.success') await applyCharge(db, d as unknown as Charge, now);
    else if (event.event === 'subscription.create' && customer.customer_code) {
      // It can arrive before charge.success has linked the Paystack customer: then find the account by email.
      const p = (await profileBy(db, 'paystack_customer', customer.customer_code)) ?? (customer.email ? await profileBy(db, 'email', customer.email.toLowerCase()) : null);
      if (p) {
        const code = String(d.subscription_code ?? '');
        const next = typeof d.next_payment_date === 'string' ? d.next_payment_date : null;
        // Switching plan: the previous subscription stops renewing.
        if (p.paystack_subscription && p.paystack_subscription !== code && p.paystack_email_token)
          await ps.call('POST', '/subscription/disable', { code: p.paystack_subscription, token: p.paystack_email_token }).catch(() => undefined);
        await patchProfile(db, p.id, {
          paystack_customer: customer.customer_code,
          paystack_subscription: code,
          paystack_email_token: String(d.email_token ?? ''),
          billing_status: 'active',
          ...(next && (!p.plan_until || Date.parse(next) > Date.parse(p.plan_until)) ? { plan_until: new Date(Date.parse(next) + GRACE_DAYS * 86_400_000).toISOString() } : {}),
        });
      }
    } else if (['subscription.not_renew', 'subscription.disable', 'invoice.payment_failed'].includes(event.event ?? '')) {
      const sub = event.event === 'invoice.payment_failed' ? (d.subscription as { subscription_code?: string } | undefined)?.subscription_code : String(d.subscription_code ?? '');
      const p = sub ? await profileBy(db, 'paystack_subscription', sub) : null;
      // The plan stays until the paid month runs out; only the status changes.
      if (p) await patchProfile(db, p.id, { billing_status: event.event === 'invoice.payment_failed' ? 'attention' : event.event === 'subscription.disable' ? 'cancelled' : 'non-renewing' });
    }
    return json(200, { ok: true });
  }

  if (!route.startsWith('/v1/billing')) return null;

  // Public: plans and prices, in the visitor's currency first.
  if (req.method === 'GET' && route === '/v1/billing/prices') {
    const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
    const [plans, list, packs, models] = await Promise.all([db.plans(), prices(db), db.rest<Array<{ id: string; credits: number; currency: string; amount: number }>>('credit_packs?select=id,credits,currency,amount&order=credits').catch(() => []), db.models()]);
    const model = (id: string) => models.find((m) => m.id === id);
    return json(200, {
      country,
      currency: currencyFor(country),
      currencies: [...new Set(list.map((p) => p.currency))],
      payments: configured,
      trialCredits: Math.max(0, Math.floor(Number(env.TRIAL_CREDITS ?? 150) || 0)),
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        dailyRequests: p.daily_requests,
        dailyTokens: p.daily_tokens,
        features: p.features,
        // What the monthly AI allowance is about worth (the dollars stay inside Keo Cloud).
        allowance: (() => {
          const c = capsFor(p);
          const fast = model('keo-fast');
          const strong = p.max_tier >= 2 ? model('keo-strong') : undefined;
          const best = p.max_tier >= 3 ? model('keo-best') : undefined;
          return {
            fastTasks: fast ? Math.floor(c.month / taskCost(fast)) : 0,
            strongBuilds: strong ? Math.floor(c.month / buildCost(strong)) : 0,
            bestBuilds: best ? Math.floor(c.month / buildCost(best)) : 0,
            dayShare: c.month ? Math.round((c.day / c.month) * 1000) / 1000 : 0.35,
            weekShare: c.month ? Math.round((c.week / c.month) * 1000) / 1000 : 0.6,
          };
        })(),
        prices: Object.fromEntries(list.filter((x) => x.plan === p.id).map((x) => [x.currency, x.amount])),
      })),
      // AI top-ups: packs and an amount the user types (what each is about worth, never dollars).
      topups: await (async () => {
        const [rows, setting] = await Promise.all([db.rest<Array<{ id: string; currency: string; amount: number; value_usd: number }>>('topup_packs?select=id,currency,amount,value_usd&order=amount').catch(() => []), settingsOf(db)]);
        const strong = model('keo-strong');
        const fast = model('keo-fast');
        const worth = (usd: number) => ({ strongBuilds: strong ? Math.floor(usd / buildCost(strong)) : 0, fastTasks: fast ? Math.floor(usd / taskCost(fast)) : 0 });
        const ids = [...new Set(rows.map((r) => r.id))];
        return {
          packs: ids.map((id) => {
            const these = rows.filter((r) => r.id === id);
            return { id, prices: Object.fromEntries(these.map((r) => [r.currency, Number(r.amount)])), worth: worth(Number(these[0]!.value_usd)) };
          }),
          custom: { ...topupLimits(setting), share: setting('topup_custom_share', 0.5), ngnPerUsd: setting('ngn_per_usd', 1380), worthPerUsd: worth(1) },
          monthCapUsd: setting('topup_month_cap_usd', 100),
        };
      })(),
      // Studio credit packs (bought credits never expire).
      packs: [...new Set(packs.map((k) => k.id))].map((id) => {
        const rows = packs.filter((k) => k.id === id);
        return { id, credits: Number(rows[0]!.credits), prices: Object.fromEntries(rows.map((k) => [k.currency, Number(k.amount)])) };
      }),
    });
  }

  const who = await deps.who();
  if (who instanceof Response) return who;

  // The Keo app asks for a link to the Upgrade page.
  if (req.method === 'POST' && route === '/v1/billing/ticket') {
    return json(200, { ticket: await makeTicket(env, who, now) });
  }

  const profile = await profileBy(db, 'id', who.id);
  if (!profile) return fail(403, 'This Keo account is not set up yet.', 'no_profile');

  if (req.method === 'GET' && route === '/v1/billing') {
    const active = profile.plan !== 'free' && (!profile.plan_until || Date.parse(profile.plan_until) > now);
    return json(200, {
      email: who.email,
      plan: active ? profile.plan : 'free',
      planUntil: active ? profile.plan_until : null,
      status: active ? (profile.billing_status ?? 'active') : null,
      currency: profile.billing_currency,
      canManage: active && !!profile.paystack_subscription,
    });
  }

  if (!configured) return fail(503, 'Payments are not set up yet.', 'billing_off');

  if (req.method === 'POST' && route === '/v1/billing/checkout') {
    const body = (await req.json().catch(() => ({}))) as { plan?: unknown; currency?: unknown };
    const plan = (await db.plans()).find((p) => p.id === body.plan && p.id !== 'free');
    if (!plan) return fail(400, 'Choose a paid plan.', 'bad_plan', 'invalid_request_error');
    const currency = typeof body.currency === 'string' ? body.currency : 'USD';
    const price = (await prices(db)).find((p) => p.plan === plan.id && p.currency === currency);
    if (!price) return fail(400, `${plan.name} cannot be paid in ${currency}.`, 'bad_currency', 'invalid_request_error');
    const active = profile.plan !== 'free' && profile.plan_until && Date.parse(profile.plan_until) > now;
    if (active && profile.plan === plan.id && profile.billing_status === 'active') return fail(409, `You already have ${plan.name}.`, 'already_on_plan');
    if (!who.email) return fail(400, 'Your Keo account has no email address.', 'no_email');
    const planCode = await paystackPlan(db, ps, price, plan.name);
    const init = await ps.call<{ access_code: string; reference: string; authorization_url: string }>('POST', '/transaction/initialize', {
      email: who.email,
      amount: price.amount,
      currency: price.currency,
      plan: planCode,
      channels: ['card'],
      // If the popup cannot open, Paystack's page sends the user back here after paying.
      callback_url: new URL('/upgrade', req.url).toString(),
      metadata: { user_id: who.id, plan: plan.id, keo: true },
    });
    return json(200, { accessCode: init.access_code, reference: init.reference, url: init.authorization_url });
  }

  // Buying a Studio credit pack: one payment (not a subscription).
  if (req.method === 'POST' && route === '/v1/billing/credits') {
    const body = (await req.json().catch(() => ({}))) as { pack?: unknown; currency?: unknown };
    const currency = typeof body.currency === 'string' ? body.currency : 'USD';
    const pack = (await db.rest<Array<{ id: string; credits: number; amount: number }>>(`credit_packs?id=eq.${encodeURIComponent(String(body.pack ?? ''))}&currency=eq.${encodeURIComponent(currency)}&select=id,credits,amount`))[0];
    if (!pack) return fail(400, 'Choose a credit pack.', 'bad_pack', 'invalid_request_error');
    if (!who.email) return fail(400, 'Your Keo account has no email address.', 'no_email');
    const init = await ps.call<{ access_code: string; reference: string; authorization_url: string }>('POST', '/transaction/initialize', {
      email: who.email,
      amount: Number(pack.amount),
      currency,
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      callback_url: new URL('/upgrade', req.url).toString(),
      metadata: { user_id: who.id, pack: pack.id, credits: pack.credits, keo: true },
    });
    return json(200, { accessCode: init.access_code, reference: init.reference, url: init.authorization_url });
  }

  // An AI top-up: a pack, or an amount the user types ($5 / ₦7,000 up to $100 / ₦140,000), priced on
  // the server. At most topup_month_cap_usd in 30 days, so nobody is surprised by a bill.
  if (req.method === 'POST' && route === '/v1/billing/topup') {
    const body = (await req.json().catch(() => ({}))) as { pack?: unknown; amount?: unknown; currency?: unknown };
    const currency = typeof body.currency === 'string' ? body.currency : 'USD';
    const pick = typeof body.pack === 'string' && body.pack ? body.pack : 'custom';
    let amount: number;
    if (pick === 'custom') amount = Math.round(Number(body.amount));
    else amount = Number((await db.rest<Array<{ amount: number }>>(`topup_packs?id=eq.${encodeURIComponent(pick)}&currency=eq.${encodeURIComponent(currency)}&select=amount`))[0]?.amount);
    const value = Number.isFinite(amount) && amount > 0 ? await topupValue(db, pick, currency, amount) : null;
    if (!value) {
      const { min, max } = topupLimits(await settingsOf(db));
      const money = (n: number) => (currency === 'NGN' ? `₦${(n / 100).toLocaleString('en-US')}` : `$${(n / 100).toLocaleString('en-US')}`);
      return fail(400, pick === 'custom' && min[currency] !== undefined ? `Choose an amount from ${money(min[currency]!)} to ${money(max[currency]!)}.` : 'Choose a top-up.', 'bad_topup', 'invalid_request_error');
    }
    const setting = await settingsOf(db);
    const usd = currency === 'NGN' ? amount / 100 / setting('ngn_per_usd', 1380) : amount / 100;
    const cap = setting('topup_month_cap_usd', 100);
    if ((await topupsLately(db, who.id, now)) + usd > cap + 0.01) return fail(400, `Top-ups are limited to $${cap} in 30 days for each account. Try a smaller amount, or a bigger plan.`, 'topup_cap', 'invalid_request_error');
    if (!who.email) return fail(400, 'Your Keo account has no email address.', 'no_email');
    const init = await ps.call<{ access_code: string; reference: string; authorization_url: string }>('POST', '/transaction/initialize', {
      email: who.email,
      amount,
      currency,
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      callback_url: new URL('/upgrade', req.url).toString(),
      metadata: { user_id: who.id, topup: pick, keo: true },
    });
    return json(200, { accessCode: init.access_code, reference: init.reference, url: init.authorization_url });
  }

  // Right after paying: check with Paystack instead of waiting for the webhook.
  if (req.method === 'POST' && route === '/v1/billing/confirm') {
    const body = (await req.json().catch(() => ({}))) as { reference?: unknown };
    const ref = typeof body.reference === 'string' ? body.reference.slice(0, 100) : '';
    if (!ref) return fail(400, 'No payment reference.', 'no_reference', 'invalid_request_error');
    const charge = await ps.call<Charge>('GET', `/transaction/verify/${encodeURIComponent(ref)}`);
    if (metaOf(charge).user_id !== who.id) return fail(403, 'This payment belongs to another account.', 'not_yours');
    const r = await applyCharge(db, charge, now);
    return json(200, { ok: charge.status === 'success', plan: r.plan ?? null, credits: r.credits ?? null, applied: r.applied });
  }

  if (req.method === 'POST' && route === '/v1/billing/cancel') {
    if (!profile.paystack_subscription || !profile.paystack_email_token) return fail(400, 'There is no subscription to cancel.', 'no_subscription');
    await ps.call('POST', '/subscription/disable', { code: profile.paystack_subscription, token: profile.paystack_email_token });
    await patchProfile(db, profile.id, { billing_status: 'non-renewing' });
    return json(200, { ok: true, planUntil: profile.plan_until });
  }

  if (req.method === 'GET' && route === '/v1/billing/manage') {
    if (!profile.paystack_subscription) return fail(400, 'There is no subscription to manage.', 'no_subscription');
    const r = await ps.call<{ link: string }>('GET', `/subscription/${encodeURIComponent(profile.paystack_subscription)}/manage/link`);
    return json(200, { link: r.link });
  }

  return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
}
