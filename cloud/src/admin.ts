/**
 * Keo Cloud's admin: the owner's view of users, plans, usage, Studio credits, AI jobs, payments
 * and problem reports, at /admin (the page) and /v1/admin/* (its data).
 *
 * Only accounts whose email is in ADMIN_EMAILS (a comma-separated list set with
 * `wrangler secret put ADMIN_EMAILS`) get in; it is checked on every request. Without it the admin
 * does not exist (404). Every change an admin makes (credits, plan, block, report status) is
 * written to admin_actions with who did it.
 */

import { adminPage } from './adminPage';
import { buildCost, fail, json, windowsFor, type Env, type Fetch, type Plan, type Supabase } from './gateway';

interface AdminDeps {
  fetch: Fetch;
  now: number;
  db: Supabase;
}

/** The emails allowed in (lower case). */
export function adminEmails(env: { ADMIN_EMAILS?: string }): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(/[,\s;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

/** Paystack's fee for a payment in US$ (with 7.5% VAT on the fee): local Naira cards 1.5% + ₦100 (capped at ₦2,000), others 3.9% + ₦100. */
export function paystackFeeUsd(currency: string, amount: number, ngnPerUsd: number): number {
  if (currency === 'NGN') {
    const naira = amount / 100;
    return (Math.min(0.015 * naira + (naira >= 2500 ? 100 : 0), 2000) * 1.075) / ngnPerUsd;
  }
  return (0.039 * (amount / 100) + 100 / ngnPerUsd) * 1.075;
}

/** The key of a profile's current billing month (as Studio's monthly credits use it). */
function periodKey(p: { plan: string; plan_until: string | null; period_start?: string | null }, now: number): string {
  return windowsFor(now, { id: p.plan } as Plan, p).periodKey;
}

/** null when the request carries an admin's sign-in; otherwise the answer to send (404 without admins). */
export async function adminOnly(req: Request, env: Env, db: Supabase): Promise<Response | null> {
  const allowed = adminEmails(env);
  if (!allowed.length) return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
  if (!token) return fail(401, 'Sign in first.', 'not_signed_in', 'authentication_error');
  const who = await db.user(token);
  if (!who) return fail(401, 'Your sign-in has expired. Sign in again.', 'sign_in_expired', 'authentication_error');
  if (!who.email || !allowed.includes(who.email.toLowerCase())) return fail(403, 'This account is not a Keo admin.', 'not_admin', 'permission_error');
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const month = (now: number) => new Date(now).toISOString().slice(0, 7);

interface Profile {
  id: string;
  email: string | null;
  plan: string;
  plan_until: string | null;
  blocked: boolean;
  created_at: string;
}

/** Handles /admin and /v1/admin/*; null for other paths. */
export async function handleAdmin(req: Request, route: string, env: Env, deps: AdminDeps): Promise<Response | null> {
  if (route !== '/admin' && !route.startsWith('/v1/admin/')) return null;
  const allowed = adminEmails(env);
  if (!allowed.length) return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
  if (route === '/admin') return req.method === 'GET' ? adminPage(env) : fail(405, 'Method not allowed.', 'method', 'invalid_request_error');

  // Every data request: a signed-in Keo account whose email is on the list.
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
  if (!token) return fail(401, 'Sign in first.', 'not_signed_in', 'authentication_error');
  const who = await deps.db.user(token);
  if (!who) return fail(401, 'Your sign-in has expired. Sign in again.', 'sign_in_expired', 'authentication_error');
  if (!who.email || !allowed.includes(who.email.toLowerCase())) return fail(403, 'This account is not a Keo admin.', 'not_admin', 'permission_error');
  const admin = who.email.toLowerCase();
  const { db, now } = deps;
  const rest = <T>(path: string, init?: RequestInit) => db.rest<T>(path, init);
  const log = (action: string, target: string | null, detail: Record<string, unknown>) =>
    rest('admin_actions', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ admin_email: admin, action, target_user: target, detail }) }).catch(() => undefined);
  const body = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const emails = async (ids: string[]) => {
    const unique = [...new Set(ids.filter((x) => UUID.test(x)))];
    if (!unique.length) return new Map<string, string | null>();
    const rows = await rest<Array<{ id: string; email: string | null }>>(`profiles?id=in.(${unique.join(',')})&select=id,email`);
    return new Map(rows.map((r) => [r.id, r.email]));
  };

  try {
    if (req.method === 'GET' && route === '/v1/admin/me') return json(200, { email: admin });

    // The numbers at a glance.
    if (req.method === 'GET' && route === '/v1/admin/overview') {
      const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
      const [profiles, usageToday, usageMonth, jobs, payments, reports, plans] = await Promise.all([
        rest<Array<{ plan: string; blocked: boolean; created_at: string }>>('profiles?select=plan,blocked,created_at&limit=100000'),
        rest<Array<{ user_id: string; requests: number; cost_usd: number }>>(`usage_daily?day=eq.${day(now)}&select=user_id,requests,cost_usd&limit=100000`),
        rest<Array<{ requests: number; cost_usd: number }>>(`usage_daily?day=gte.${month(now)}-01&select=requests,cost_usd&limit=100000`),
        rest<Array<{ credits: number; status: string }>>(`studio_jobs?created_at=gte.${month(now)}-01&select=credits,status&limit=100000`),
        rest<Array<{ currency: string; amount: number; status: string }>>(`payments?created_at=gte.${month(now)}-01&select=currency,amount,status&limit=100000`),
        rest<Array<{ status: string }>>('problem_reports?status=eq.new&select=status&limit=10000').catch(() => []),
        rest<Array<{ id: string; name: string }>>('plans?select=id,name&order=sort'),
      ]);
      const byPlan: Record<string, number> = {};
      for (const p of profiles) byPlan[p.plan] = (byPlan[p.plan] ?? 0) + 1;
      const paid = payments.filter((p) => p.status === 'success');
      const revenue: Record<string, number> = {};
      for (const p of paid) revenue[p.currency] = (revenue[p.currency] ?? 0) + Number(p.amount);
      const spent = jobs.filter((j) => j.status !== 'refunded');
      return json(200, {
        users: profiles.length,
        newUsers7d: profiles.filter((p) => p.created_at >= weekAgo).length,
        blocked: profiles.filter((p) => p.blocked).length,
        plans: plans.map((p) => ({ id: p.id, name: p.name, users: byPlan[p.id] ?? 0 })),
        today: { activeUsers: usageToday.length, requests: sum(usageToday.map((u) => u.requests)), costUsd: round(sum(usageToday.map((u) => Number(u.cost_usd)))) },
        month: {
          requests: sum(usageMonth.map((u) => u.requests)),
          aiCostUsd: round(sum(usageMonth.map((u) => Number(u.cost_usd)))),
          studioJobs: spent.length,
          studioCredits: sum(spent.map((j) => j.credits)),
          // 200 credits are $2 to users and cover $1 of fal.ai, so fal.ai costs about credits / 200.
          falCostUsd: round(sum(spent.map((j) => j.credits)) / 200),
          payments: paid.length,
          revenue,
        },
        reportsNew: reports.length,
      });
    }

    // Money: revenue, provider costs and gross margin per plan for a calendar month, what Keo still
    // owes in Studio credits, Keo's spend against its safety limits, and alerts.
    if (req.method === 'GET' && route === '/v1/admin/finance') {
      const asked = new URL(req.url).searchParams.get('month') ?? '';
      const m = /^\d{4}-\d{2}$/.test(asked) ? asked : month(now);
      const [y, mo] = m.split('-').map(Number) as [number, number];
      const next = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
      const [profiles, plans, payments, usage, jobs, credits, spend, settings, alerts, topups] = await Promise.all([
        rest<Array<{ id: string; plan: string; plan_until: string | null; period_start?: string | null }>>('profiles?select=id,plan,plan_until,period_start&limit=100000'),
        rest<Array<{ id: string; name: string; features: Record<string, unknown> }>>('plans?select=*&order=sort'),
        rest<Array<{ user_id: string | null; plan: string | null; credits: number | null; topup_usd?: number | null; currency: string; amount: number; status: string }>>(
          `payments?created_at=gte.${m}-01&created_at=lt.${next}&select=*&limit=100000`,
        ),
        rest<Array<{ user_id: string; cost_usd: number; topup_cost_usd?: number }>>(`usage_daily?day=gte.${m}-01&day=lt.${next}&select=*&limit=100000`),
        rest<Array<{ user_id: string; credits: number; status: string }>>(`studio_jobs?created_at=gte.${m}-01&created_at=lt.${next}&select=user_id,credits,status&limit=100000`),
        rest<Array<{ user_id: string; month: string; monthly_used: number; bought: number }>>('studio_credits?select=user_id,month,monthly_used,bought&limit=100000'),
        rest<Array<{ day: string; provider: string; cost_usd: number }>>(`spend_daily?day=gte.${m}-01&day=lt.${next}&select=day,provider,cost_usd`).catch(() => []),
        rest<Array<{ key: string; value: number }>>('keo_settings?select=key,value').catch(() => []),
        rest<Array<{ day: string; kind: string; message: string; created_at: string }>>('alerts?select=day,kind,message,created_at&order=created_at.desc&limit=30').catch(() => []),
        rest<Array<{ balance_usd: number }>>('ai_topups?select=balance_usd&limit=100000').catch(() => []),
      ]);
      const setting = (k: string, d: number) => Number(settings.find((x) => x.key === k)?.value) || d;
      const rate = setting('ngn_per_usd', 1380);
      const planOf = new Map(profiles.map((p) => [p.id, p.plan]));
      type Row = { revenueUsd: number; feesUsd: number; aiUsd: number; falUsd: number; payers: number; users: number };
      const rows: Record<string, Row> = {};
      const row = (id: string): Row => (rows[id] ??= { revenueUsd: 0, feesUsd: 0, aiUsd: 0, falUsd: 0, payers: 0, users: 0 });
      for (const p of plans) row(p.id);
      row('credit packs');
      row('AI top-ups');
      for (const p of profiles) row(p.plan).users++;
      for (const p of payments.filter((x) => x.status === 'success')) {
        const r = row(p.plan ?? (p.topup_usd ? 'AI top-ups' : 'credit packs'));
        r.revenueUsd += p.currency === 'NGN' ? Number(p.amount) / 100 / rate : Number(p.amount) / 100;
        r.feesUsd += paystackFeeUsd(p.currency, Number(p.amount), rate);
        if (p.plan) r.payers++;
      }
      for (const u of usage) {
        row(planOf.get(u.user_id) ?? 'free').aiUsd += Number(u.cost_usd) || 0;
        // AI paid from top-ups is the top-ups' cost.
        row('AI top-ups').aiUsd += Number(u.topup_cost_usd) || 0;
      }
      for (const j of jobs.filter((x) => x.status !== 'refunded')) row(planOf.get(j.user_id) ?? 'free').falUsd += (Number(j.credits) || 0) / 200;
      const marginOf = (r: { revenueUsd: number; feesUsd: number; aiUsd: number; falUsd: number }) => r.revenueUsd - r.feesUsd - r.aiUsd - r.falUsd;
      const pct = (margin: number, revenue: number) => (revenue > 0 ? Math.round((margin / revenue) * 100) : null);
      const byPlan = Object.entries(rows).map(([id, r]) => ({
        plan: id,
        revenueUsd: round(r.revenueUsd),
        feesUsd: round(r.feesUsd),
        aiUsd: round(r.aiUsd),
        falUsd: round(r.falUsd),
        payers: r.payers,
        users: r.users,
        marginUsd: round(marginOf(r)),
        marginPct: pct(marginOf(r), r.revenueUsd),
      }));
      const t = Object.values(rows).reduce((a, r) => ({ revenueUsd: a.revenueUsd + r.revenueUsd, feesUsd: a.feesUsd + r.feesUsd, aiUsd: a.aiUsd + r.aiUsd, falUsd: a.falUsd + r.falUsd }), { revenueUsd: 0, feesUsd: 0, aiUsd: 0, falUsd: 0 });
      // What Keo still owes in Studio credits, at fal.ai's cost (a credit covers $0.005).
      const bought = sum(credits.map((c) => Number(c.bought) || 0));
      let monthlyLeft = 0;
      for (const p of profiles) {
        if (p.plan === 'free' || !p.plan_until || Date.parse(p.plan_until) < now) continue;
        const allowance = Number(plans.find((x) => x.id === p.plan)?.features?.studio_credits) || 0;
        const c = credits.find((x) => x.user_id === p.id);
        const key = periodKey(p, now);
        monthlyLeft += Math.max(0, allowance - (c && c.month === key ? Number(c.monthly_used) || 0 : 0));
      }
      const today = day(now);
      return json(200, {
        month: m,
        ngnPerUsd: rate,
        byPlan,
        total: { revenueUsd: round(t.revenueUsd), feesUsd: round(t.feesUsd), aiUsd: round(t.aiUsd), falUsd: round(t.falUsd), marginUsd: round(marginOf(t)), marginPct: pct(marginOf(t), t.revenueUsd) },
        providerSpend: {
          openrouterUsd: round(sum(spend.filter((x) => x.provider === 'openrouter').map((x) => Number(x.cost_usd)))),
          falUsd: round(sum(spend.filter((x) => x.provider === 'fal').map((x) => Number(x.cost_usd)))),
        },
        // Unused AI top-ups are owed at their AI cost (they never expire).
        liabilities: { boughtCredits: bought, monthlyCreditsLeft: monthlyLeft, falCostUsd: round((bought + monthlyLeft) / 200), topupUsd: round(sum(topups.map((t) => Number(t.balance_usd) || 0))) },
        breakers: ['openrouter', 'fal'].map((pr) => ({
          provider: pr,
          limitUsd: setting(`breaker_${pr}_day_usd`, 0),
          todayUsd: round(Number(spend.find((x) => x.day === today && x.provider === pr)?.cost_usd) || 0),
        })),
        alerts,
      });
    }

    // Users: newest first, or found by email.
    if (req.method === 'GET' && route === '/v1/admin/users') {
      const q = new URL(req.url).searchParams.get('q')?.trim().slice(0, 100) ?? '';
      const filter = q ? `&email=ilike.*${enc(q.replace(/[*(),]/g, ''))}*` : '';
      const users = await rest<Profile[]>(`profiles?select=id,email,plan,plan_until,blocked,created_at&order=created_at.desc&limit=100${filter}`);
      const ids = users.map((u) => u.id).join(',');
      const [today, credits] = users.length
        ? await Promise.all([
            rest<Array<{ user_id: string; requests: number; cost_usd: number }>>(`usage_daily?day=eq.${day(now)}&user_id=in.(${ids})&select=user_id,requests,cost_usd`),
            rest<Array<{ user_id: string; month: string; monthly_used: number; bought: number }>>(`studio_credits?user_id=in.(${ids})&select=user_id,month,monthly_used,bought`),
          ])
        : [[], []];
      return json(200, {
        users: users.map((u) => {
          const t = today.find((x) => x.user_id === u.id);
          const c = credits.find((x) => x.user_id === u.id);
          return { ...u, today: { requests: t?.requests ?? 0, costUsd: round(Number(t?.cost_usd ?? 0)) }, credits: { usedThisMonth: c && c.month === month(now) ? c.monthly_used : 0, bought: c?.bought ?? 0 } };
        }),
      });
    }

    // One user: everything about them.
    const u = /^\/v1\/admin\/users\/([0-9a-f-]{36})(\/credits|\/plan|\/block|\/topup)?$/i.exec(route);
    if (u && UUID.test(u[1]!)) {
      const id = u[1]!;
      const profile = (await rest<Profile[]>(`profiles?id=eq.${id}&select=id,email,plan,plan_until,blocked,created_at`))[0];
      if (!profile) return fail(404, 'No such user.', 'not_found', 'invalid_request_error');
      if (req.method === 'GET' && !u[2]) {
        const since = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
        const [usage, credits, jobs, payments, reports] = await Promise.all([
          rest(`usage_daily?user_id=eq.${id}&day=gte.${since}&select=day,requests,input_tokens,output_tokens,cost_usd,web_searches,images&order=day.desc`),
          rest<Array<{ month: string; monthly_used: number; bought: number }>>(`studio_credits?user_id=eq.${id}&select=month,monthly_used,bought`),
          rest(`studio_jobs?user_id=eq.${id}&select=request_id,endpoint,credits,status,created_at&order=created_at.desc&limit=50`),
          rest(`payments?user_id=eq.${id}&select=reference,plan,credits,currency,amount,status,paid_at,created_at&order=created_at.desc&limit=50`),
          rest(`problem_reports?user_id=eq.${id}&select=id,created_at,version,message,status&order=created_at.desc&limit=50`).catch(() => []),
        ]);
        const c = credits[0];
        return json(200, { profile, usage, credits: { usedThisMonth: c && c.month === month(now) ? c.monthly_used : 0, bought: c?.bought ?? 0 }, jobs, payments, reports });
      }
      if (req.method === 'POST' && u[2] === '/credits') {
        const b = await body();
        const amount = Math.round(Number(b.amount));
        if (!Number.isFinite(amount) || amount < 1 || amount > 100_000) return fail(400, 'Give 1 to 100,000 credits.', 'bad_request', 'invalid_request_error');
        await rest('rpc/add_credits', { method: 'POST', body: JSON.stringify({ p_user: id, p_amount: amount }) });
        await log('credits.give', id, { amount, note: String(b.note ?? '').slice(0, 300) });
        return json(200, { ok: true });
      }
      // AI top-up given by an admin (for example the owner's own testing): in builds on Keo Strong.
      if (req.method === 'POST' && u[2] === '/topup') {
        const b = await body();
        const builds = Math.round(Number(b.builds));
        if (!Number.isFinite(builds) || builds < 1 || builds > 1000) return fail(400, 'Give 1 to 1,000 builds.', 'bad_request', 'invalid_request_error');
        const strong = (await rest<Array<{ price_in_per_m: number; price_out_per_m: number }>>('models?id=eq.keo-strong&select=price_in_per_m,price_out_per_m'))[0];
        const usd = Math.round(builds * buildCost(strong ?? {}) * 10_000) / 10_000;
        await rest('rpc/add_topup', { method: 'POST', body: JSON.stringify({ p_user: id, p_usd: usd }) });
        await log('topup.give', id, { builds, usd, note: String(b.note ?? '').slice(0, 300) });
        return json(200, { ok: true, usd });
      }
      if (req.method === 'POST' && u[2] === '/plan') {
        const b = await body();
        const plans = await rest<Array<{ id: string }>>('plans?select=id');
        const plan = String(b.plan ?? '');
        if (!plans.some((p) => p.id === plan)) return fail(400, 'No such plan.', 'bad_request', 'invalid_request_error');
        const until = b.until === null || b.until === '' || b.until === undefined ? null : new Date(String(b.until));
        if (until && (Number.isNaN(until.getTime()) || until.getTime() < now)) return fail(400, 'The end date must be in the future.', 'bad_request', 'invalid_request_error');
        if (plan !== 'free' && !until) return fail(400, 'A paid plan needs an end date (when it stops).', 'bad_request', 'invalid_request_error');
        await rest(`profiles?id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ plan, plan_until: until ? until.toISOString() : null, period_start: plan === 'free' ? null : new Date(now).toISOString() }) });
        await log('plan.set', id, { from: profile.plan, to: plan, until: until?.toISOString() ?? null, note: String(b.note ?? '').slice(0, 300) });
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && u[2] === '/block') {
        const b = await body();
        const blocked = b.blocked === true;
        if (blocked && profile.email && allowed.includes(profile.email.toLowerCase())) return fail(400, 'An admin cannot be blocked here.', 'bad_request', 'invalid_request_error');
        await rest(`profiles?id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ blocked }) });
        await log(blocked ? 'user.block' : 'user.unblock', id, { note: String(b.note ?? '').slice(0, 300) });
        return json(200, { ok: true });
      }
    }

    // Problem reports.
    if (req.method === 'GET' && route === '/v1/admin/reports') {
      const status = new URL(req.url).searchParams.get('status') ?? 'new';
      const filter = ['new', 'seen', 'fixed', 'closed'].includes(status) ? `&status=eq.${status}` : '';
      const rows = await rest<Array<{ id: string; user_id: string; created_at: string; version: string; message: string; status: string }>>(`problem_reports?select=id,user_id,created_at,version,message,status&order=created_at.desc&limit=200${filter}`);
      const who = await emails(rows.map((r) => r.user_id));
      return json(200, { reports: rows.map((r) => ({ ...r, email: who.get(r.user_id) ?? null })) });
    }
    const r = /^\/v1\/admin\/reports\/([0-9a-f-]{36})$/i.exec(route);
    if (r && UUID.test(r[1]!)) {
      const id = r[1]!;
      if (req.method === 'GET') {
        const row = (await rest<Array<Record<string, unknown> & { user_id: string }>>(`problem_reports?id=eq.${id}&select=id,user_id,created_at,version,message,report,status`))[0];
        if (!row) return fail(404, 'No such report.', 'not_found', 'invalid_request_error');
        return json(200, { ...row, email: (await emails([row.user_id])).get(row.user_id) ?? null });
      }
      if (req.method === 'POST') {
        const status = String((await body()).status ?? '');
        if (!['new', 'seen', 'fixed', 'closed'].includes(status)) return fail(400, 'Status is new, seen, fixed or closed.', 'bad_request', 'invalid_request_error');
        await rest(`problem_reports?id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status }) });
        await log('report.status', null, { report: id, status });
        return json(200, { ok: true });
      }
    }

    // Studio's AI jobs (newest first).
    if (req.method === 'GET' && route === '/v1/admin/jobs') {
      const rows = await rest<Array<{ request_id: string; user_id: string; endpoint: string; credits: number; status: string; created_at: string }>>('studio_jobs?select=request_id,user_id,endpoint,credits,status,created_at&order=created_at.desc&limit=200');
      const who = await emails(rows.map((x) => x.user_id));
      return json(200, { jobs: rows.map((x) => ({ ...x, email: who.get(x.user_id) ?? null })) });
    }

    // What admins changed.
    if (req.method === 'GET' && route === '/v1/admin/actions') {
      const rows = await rest<Array<{ target_user: string | null }>>('admin_actions?select=id,at,admin_email,action,target_user,detail&order=at.desc&limit=200').catch(() => []);
      const who = await emails(rows.map((x) => x.target_user ?? ''));
      return json(200, { actions: rows.map((x) => ({ ...x, target_email: x.target_user ? (who.get(x.target_user) ?? null) : null })) });
    }
  } catch {
    return fail(502, 'The database did not answer. Check that update 7 (cloud/supabase/007_admin.sql) was run, then try again.', 'database', 'api_error');
  }
  return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const round = (n: number) => Math.round(n * 100) / 100;
