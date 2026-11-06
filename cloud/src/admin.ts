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
import { fail, json, type Env, type Fetch, type Supabase } from './gateway';

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
        rest<Array<{ credits: number; status: string }>>(`studio_jobs?month=eq.${month(now)}&select=credits,status&limit=100000`),
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
          // 200 credits are a dollar to users and cover a dollar of fal.ai (half the price), so fal.ai costs about credits / 200.
          falCostUsd: round(sum(spent.map((j) => j.credits)) / 200),
          payments: paid.length,
          revenue,
        },
        reportsNew: reports.length,
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
    const u = /^\/v1\/admin\/users\/([0-9a-f-]{36})(\/credits|\/plan|\/block)?$/i.exec(route);
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
      if (req.method === 'POST' && u[2] === '/plan') {
        const b = await body();
        const plans = await rest<Array<{ id: string }>>('plans?select=id');
        const plan = String(b.plan ?? '');
        if (!plans.some((p) => p.id === plan)) return fail(400, 'No such plan.', 'bad_request', 'invalid_request_error');
        const until = b.until === null || b.until === '' || b.until === undefined ? null : new Date(String(b.until));
        if (until && (Number.isNaN(until.getTime()) || until.getTime() < now)) return fail(400, 'The end date must be in the future.', 'bad_request', 'invalid_request_error');
        if (plan !== 'free' && !until) return fail(400, 'A paid plan needs an end date (when it stops).', 'bad_request', 'invalid_request_error');
        await rest(`profiles?id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ plan, plan_until: until ? until.toISOString() : null }) });
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
