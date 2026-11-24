/// <reference types="node" />
/**
 * The real SQL: every migration (001 → 010) run in order on an in-memory Postgres (PGlite), with a
 * small stand-in for Supabase's own parts (auth.users, auth.uid(), its roles). Then the billing
 * functions of 010 are called as the gateway calls them. Nothing here touches the live database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase');
const SUPABASE_SHIM = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text, created_at timestamptz not null default now());
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`;
const ANA = '00000000-0000-0000-0000-00000000000a';
const BEN = '00000000-0000-0000-0000-00000000000b';

let db: PGlite;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;
const reserve = (user: string, amount: number, caps: [number, number, number], day = '2026-11-25', weekFrom = '2026-11-23', monthFrom = '2026-11-20') =>
  db.query<{ reserve_ai: string }>('select public.reserve_ai($1, $2, $3, $4, $5, $6, $7, $8, $9)', [user, amount, 'chat', day, weekFrom, monthFrom, caps[0], caps[1], caps[2]]);
/** reserve_ai's answer as text: a hold id, or the reason nothing was held. */
const answer = async (user: string, amount: number, caps: [number, number, number], day = '2026-11-25', weekFrom = '2026-11-23', monthFrom = '2026-11-20') => (await reserve(user, amount, caps, day, weekFrom, monthFrom)).rows[0]!.reserve_ai;
const usage = async (user: string) => Number((await one<{ s: string }>('select coalesce(sum(cost_usd), 0) as s from public.usage_daily where user_id = $1', [user])).s);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  const files = readdirSync(DIR).filter((f: string) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(DIR, f), 'utf8'));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`, { cause: e });
    }
  }
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [ANA, 'ana@example.test', BEN, 'ben@example.test']);
  // A new account gets its profile from the sign-up trigger (001); Ana then pays for Pro.
  expect(Number((await one<{ n: string }>('select count(*) as n from public.profiles')).n)).toBe(2);
  await db.query("update public.profiles set plan = 'pro', plan_until = '2026-12-23T09:00:00Z', period_start = '2026-11-20T09:00:00Z' where id = $1", [ANA]);
}, 60_000);

describe('the migrations on a real Postgres', () => {
  it('all run in order, and 010 can run a second time', async () => {
    await db.exec(readFileSync(join(DIR, '010_billing_v2.sql'), 'utf8'));
  });

  it('leave the approved plans, prices and model prices', async () => {
    const plans = (await db.query<{ id: string; price_usd_month: string; monthly_cost_usd: string; week_share: string; day_share: string; max_tier: number; features: Record<string, number> }>('select * from public.plans order by sort')).rows;
    const by = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(Number(by.free!.monthly_cost_usd)).toBe(0.6);
    expect(Number(by.pro!.monthly_cost_usd)).toBe(12);
    expect(Number(by.creator!.monthly_cost_usd)).toBe(12);
    expect(Number(by.max!.monthly_cost_usd)).toBe(28);
    expect([Number(by.pro!.week_share), Number(by.pro!.day_share)]).toEqual([0.4, 0.15]);
    expect(by.free!.features.studio_credits).toBe(0);
    expect(by.pro!.features.studio_credits).toBe(200);
    expect(by.creator!.features.studio_credits).toBe(1500);
    expect(by.max!.features.studio_credits).toBe(500);
    expect(by.max!.max_tier).toBe(3);
    const prices = (await db.query<{ plan: string; currency: string; amount: string }>('select plan, currency, amount from public.plan_prices order by plan, currency')).rows.map((r) => `${r.plan} ${r.currency} ${r.amount}`);
    expect(prices).toEqual(['creator NGN 4000000', 'creator USD 2900', 'max NGN 6800000', 'max USD 4900', 'pro NGN 2800000', 'pro USD 2000']);
    const models = (await db.query<{ id: string; price_in_per_m: string; price_out_per_m: string }>('select id, price_in_per_m, price_out_per_m from public.models order by tier')).rows.map((m) => [m.id, Number(m.price_in_per_m), Number(m.price_out_per_m)]);
    expect(models).toEqual([
      ['keo-fast', 0.1, 0.5],
      ['keo-strong', 2, 10],
      ['keo-best', 4, 20],
    ]);
  });

  it('only the gateway may call the billing functions', async () => {
    const rows = (await db.query<{ proname: string; acl: string | null }>("select proname, proacl::text as acl from pg_proc where proname in ('reserve_ai','settle_ai','reserve_spend','return_credits','refund_credits','raise_alert','keo_setting')")).rows;
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.acl ?? '').not.toMatch(/(^|[{,])(anon|authenticated)=/);
      expect(r.acl ?? '').not.toMatch(/(^|[{,])=X/); // not PUBLIC
    }
  });
});

describe('reserve_ai and settle_ai on a real Postgres', () => {
  it('holds, then settles to the real cost', async () => {
    const id = (await reserve(ANA, 0.5, [1.8, 4.8, 12])).rows[0]!.reserve_ai;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const settled = await one<{ settle_ai: boolean }>('select public.settle_ai($1, $2, $3, 1, 100, 20, 0.12, 0, 0, 0)', [id, ANA, '2026-11-25']);
    expect(settled.settle_ai).toBe(true);
    expect(await usage(ANA)).toBeCloseTo(0.12, 6);
    expect(Number((await one<{ n: string }>('select count(*) as n from public.ai_holds where user_id = $1', [ANA])).n)).toBe(0);
    // Settled once only.
    expect((await one<{ settle_ai: boolean }>('select public.settle_ai($1, $2, $3, 1, 0, 0, 1, 0, 0, 0)', [id, ANA, '2026-11-25'])).settle_ai).toBe(false);
  });

  it('open holds count: what is held plus what is spent never passes a cap', async () => {
    // 0.12 spent today; day cap 1.8: three holds of 0.5 fit (1.62), a fourth does not.
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await reserve(ANA, 0.5, [1.8, 4.8, 12])).rows[0]!.reserve_ai);
    expect(await answer(ANA, 0.5, [1.8, 4.8, 12])).toBe('allowance_day');
    for (const id of ids) await db.query('select public.settle_ai($1, $2, $3, 1, 0, 0, 0, 0, 0, 0)', [id, ANA, '2026-11-25']);
  });

  it('says which window ran out: month first, then week, then day', async () => {
    await db.query("insert into public.usage_daily (user_id, day, cost_usd) values ($1, '2026-11-21', 11.8)", [ANA]);
    expect(await answer(ANA, 0.5, [1.8, 40, 12])).toBe('allowance_month');
    // A new billing month (paid again): the old spend does not count.
    const fresh = await reserve(ANA, 0.5, [1.8, 4.8, 12], '2026-12-21', '2026-12-21', '2026-12-20');
    await db.query('select public.settle_ai($1, $2, $3, 1, 0, 0, 0, 0, 0, 0)', [fresh.rows[0]!.reserve_ai, ANA, '2026-12-21']);
    await db.query("delete from public.usage_daily where user_id = $1 and day = '2026-11-21'", [ANA]);
    await db.query("insert into public.usage_daily (user_id, day, cost_usd) values ($1, '2026-11-23', 4.7)", [ANA]);
    expect(await answer(ANA, 0.5, [10, 4.8, 12])).toBe('allowance_week');
    await db.query("delete from public.usage_daily where user_id = $1 and day = '2026-11-23'", [ANA]);
  });

  it('calls at the same time queue on the user’s row: exactly as many as fit get through', async () => {
    // Ben (Free): $0.60 a month, nothing spent; ten calls of $0.10 at once.
    const tries = await Promise.all(Array.from({ length: 10 }, () => answer(BEN, 0.1, [0, 0, 0.6], '2026-11-25', '2026-11-23', '2026-11-01')));
    expect(tries.filter((t) => /^[0-9a-f-]{36}$/.test(t))).toHaveLength(6);
    expect(tries.filter((t) => t === 'allowance_month')).toHaveLength(4);
    await db.query('delete from public.ai_holds where user_id = $1', [BEN]);
  });

  it('a hold never settled counts in full after 20 minutes; a late settlement adds only what was above it', async () => {
    const id = (await reserve(BEN, 0.2, [0, 0, 0.6], '2026-11-25', '2026-11-23', '2026-11-01')).rows[0]!.reserve_ai;
    await db.query("update public.ai_holds set created_at = now() - interval '30 minutes' where id = $1", [id]);
    const before = await usage(BEN);
    const next = (await reserve(BEN, 0.01, [0, 0, 0.6], '2026-11-25', '2026-11-23', '2026-11-01')).rows[0]!.reserve_ai;
    expect((await one<{ status: string }>('select status from public.ai_holds where id = $1', [id])).status).toBe('expired');
    expect((await usage(BEN)) - before).toBeCloseTo(0.2, 6);
    await db.query('select public.settle_ai($1, $2, $3, 1, 0, 0, 0.25, 0, 0, 0)', [id, BEN, '2026-11-25']);
    expect((await usage(BEN)) - before).toBeCloseTo(0.25, 6);
    await db.query('select public.settle_ai($1, $2, $3, 1, 0, 0, 0, 0, 0, 0)', [next, BEN, '2026-11-25']);
  });

  it('Keo’s daily breaker stops everyone and raises one alert', async () => {
    await db.query("update public.keo_settings set value = 1 where key = 'breaker_openrouter_day_usd'");
    // A $1 limit: a $1.20 call is refused, twice; the alert is written once and kept.
    expect(await answer(ANA, 1.2, [0, 0, 0], '2026-11-26')).toBe('keo_breaker');
    expect(await answer(ANA, 1.2, [0, 0, 0], '2026-11-26')).toBe('keo_breaker');
    expect(Number((await one<{ n: string }>('select count(*) as n from public.ai_holds where user_id = $1', [ANA])).n)).toBe(0);
    const alerts = (await db.query<{ kind: string }>("select kind from public.alerts where day = '2026-11-26'")).rows.map((r) => r.kind);
    expect(alerts.filter((k) => k === 'breaker_openrouter')).toHaveLength(1);
    await db.query("update public.keo_settings set value = 60 where key = 'breaker_openrouter_day_usd'");
  });
});

describe('Studio credits and the fal.ai breaker on a real Postgres', () => {
  it('a refused job gets exactly its credits back; a refund never turns monthly credits into bought ones', async () => {
    const key = 'p2026-11-20T09:00:00';
    await db.query('select public.add_credits($1, 100)', [ANA]);
    const spent = await one<{ spend_credits: { from_monthly: number; from_bought: number } }>('select public.spend_credits($1, $2, 200, 250)', [ANA, key]);
    expect(spent.spend_credits).toMatchObject({ from_monthly: 200, from_bought: 50 });
    await db.query('select public.return_credits($1, $2, 200, 50)', [ANA, key]);
    expect(await one('select monthly_used, bought from public.studio_credits where user_id = $1', [ANA])).toEqual({ monthly_used: 0, bought: 100 });
    // A job from a past month, refunded later: its old monthly credits are not given back as bought ones.
    await db.query("insert into public.studio_jobs (request_id, user_id, endpoint, credits, from_monthly, from_bought, month, status_url, response_url) values ('old', $1, 'x', 150, 150, 0, 'p2026-10-20T09:00:00', 's', 'r')", [ANA]);
    expect((await one<{ refund_credits: boolean }>("select public.refund_credits('old')")).refund_credits).toBe(true);
    expect((await one<{ bought: number }>('select bought from public.studio_credits where user_id = $1', [ANA])).bought).toBe(100);
    expect((await one<{ refund_credits: boolean }>("select public.refund_credits('old')")).refund_credits).toBe(false);
  });

  it('reserve_spend counts fal.ai spend, gives it back, and stops at the breaker', async () => {
    expect(Number((await one<{ reserve_spend: string }>("select public.reserve_spend('fal', '2026-11-25', 30)")).reserve_spend)).toBe(30);
    expect(Number((await one<{ reserve_spend: string }>("select public.reserve_spend('fal', '2026-11-25', -10)")).reserve_spend)).toBe(20);
    expect((await one<{ reserve_spend: string }>("select public.reserve_spend('fal', '2026-11-25', 45)")).reserve_spend).toBe('keo_breaker');
    // Nothing was added for the refused job.
    expect(Number((await one<{ cost_usd: string }>("select cost_usd from public.spend_daily where day = '2026-11-25' and provider = 'fal'")).cost_usd)).toBe(20);
    const kinds = (await db.query<{ kind: string }>("select kind from public.alerts where day = '2026-11-25' order by kind")).rows.map((r) => r.kind);
    expect(kinds).toContain('breaker_fal');
  });
});
