/**
 * Keo Cloud's AI gateway (a Cloudflare Worker). The Keo app talks to it like any OpenAI-compatible
 * API, with the user's Keo sign-in (a Supabase access token) instead of an API key. Each request:
 * who is it (Supabase), which plan and how much used today, is this model in the plan, then the
 * call goes to OpenRouter with Keo's own key and its usage is added to the user's day.
 *
 * No provider key ever reaches the app; nothing of the conversation is stored here.
 */

import { handleBilling, readTicket } from './billing';
import { adminOnly, handleAdmin } from './admin';
import { accountPage } from './pages';
import { legalPage } from './legal';
import { upgradePage } from './upgradePage';
import { handleStudio } from './studio';
import { handleDna } from './dna';
import { handleWaitlist } from './waitlist';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Secret (wrangler secret put): writes usage, reads profiles. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Secret: Keo's OpenRouter key (with a monthly spending limit set at openrouter.ai). */
  OPENROUTER_API_KEY: string;
  OPENROUTER_URL?: string;
  /** Secret: Paystack's secret key (test or live). Without it, payments are off. */
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_URL?: string;
  /** Secret: Keo's fal.ai key (Keo Studio's AI video, pictures and voices, paid with Studio credits). Without it, Studio AI is off. */
  FAL_KEY?: string;
  /** Secret: the emails allowed into the admin page (/admin), comma-separated. Without it there is no admin page. */
  ADMIN_EMAILS?: string;
  /** Shown on the Terms, Privacy and Refund pages (optional until the address exists). */
  KEO_SUPPORT_EMAIL?: string;
  /** Secret: a Resend API key (heykeo.com) for emailing alerts to the owner. */
  RESEND_API_KEY?: string;
  /** Secret: where alert emails go (the owner's address; comma-separated for several). */
  ALERT_EMAIL?: string;
  /** Who alert emails come from (default: Keo Cloud <alerts@heykeo.com>). */
  ALERT_FROM?: string;
  /** Which OpenRouter models do web search, pictures and voice (wrangler.toml [vars]; change any time). */
  KEO_SEARCH_MODEL?: string;
  KEO_SEARCH_ENGINE?: string;
  KEO_IMAGE_MODEL?: string;
  KEO_TTS_MODEL?: string;
  KEO_STT_MODEL?: string;
  KEO_VOICE_FEMALE?: string;
  KEO_VOICE_MALE?: string;
  /** Studio credits every new account gets once (0 turns the trial off). */
  TRIAL_CREDITS?: string;
  /** Studio credits a referral gives the new account and the friend who invited them. */
  REFERRAL_CREDITS?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Plan {
  id: string;
  name: string;
  daily_requests: number;
  daily_tokens: number;
  max_tier: number;
  features: Record<string, unknown>;
  /** Older databases: what the plan may cost per day (US$); only used when monthly_cost_usd is not set. */
  daily_cost_usd?: number | null;
  /** The plan's hard monthly AI allowance (US$, never shown to users as dollars). */
  monthly_cost_usd?: number | null;
  /** The share of the monthly allowance a week and a day may use (0.40 and 0.15 by default). */
  week_share?: number | null;
  day_share?: number | null;
}
export interface ModelRow {
  id: string;
  label: string;
  upstream: string;
  tier: number;
  vision: boolean;
  tools: boolean;
  context_tokens: number;
  max_output_tokens: number;
  /** List prices per million tokens (for holding what a call could cost). */
  price_in_per_m?: number | null;
  price_out_per_m?: number | null;
}
interface User {
  id: string;
  email: string | null;
}
interface Usage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  images: number;
  voice_seconds: number;
  /** What today's AI calls cost (US$, as OpenRouter charged). */
  cost_usd: number;
  /** This week's AI cost (US$, from Monday or the billing month's start, whichever is later). */
  week_cost_usd: number;
  /** This billing month's AI cost so far (US$), today included. */
  month_cost_usd: number;
}
/** What one call adds to the user's day. */
interface Added {
  requests?: number;
  input?: number;
  output?: number;
  cost?: number;
  searches?: number;
  images?: number;
  voiceSeconds?: number;
}

export const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
/** Errors in OpenAI's shape, so the app shows the message. */
export const fail = (status: number, message: string, code: string, type = 'keo_error') => json(status, { error: { message, type, code } });

/** Today in UTC (usage resets at 00:00 UTC). */
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Short-lived memory inside one Worker instance (sign-ins, plans, models). */
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return value;
}
export function clearCache(): void {
  cache.clear();
}

export class Supabase {
  constructor(
    private readonly env: Env,
    private readonly fetch: Fetch,
  ) {}

  /** The signed-in user for a Keo access token, or null. */
  async user(token: string): Promise<User | null> {
    const key = `user:${await sha256(token)}`;
    return cached(key, 60_000, async () => {
      const r = await this.fetch(`${this.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: this.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const u = (await r.json()) as { id?: string; email?: string };
      return u.id ? { id: u.id, email: u.email ?? null } : null;
    });
  }

  async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.fetch(`${this.env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    // The database's own reason stays in the error (a function's raise, e.g. no_such_code); never shown raw to users.
    if (!r.ok) throw new Error(`database ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async profile(userId: string): Promise<Profile | null> {
    // select=* so a database without the payment columns still works.
    const rows = await this.rest<Profile[]>(`profiles?id=eq.${encodeURIComponent(userId)}&select=*`);
    return rows[0] ?? null;
  }

  plans(): Promise<Plan[]> {
    // select=* so a database without the newer columns still works.
    return cached('plans', 60_000, () => this.rest<Plan[]>('plans?select=*&order=sort'));
  }

  models(): Promise<ModelRow[]> {
    return cached('models', 60_000, () => this.rest<ModelRow[]>('models?enabled=eq.true&select=*&order=tier'));
  }

  /** Today's counts, and the AI cost of today, this week and this billing month. */
  async usage(userId: string, w: Windows): Promise<Usage> {
    // select=* so a database without the newer columns (voice_seconds) still works.
    const from = [w.day, w.weekFrom, w.monthFrom].sort()[0]!;
    const rows = await this.rest<Array<Partial<Usage> & { day?: string }>>(`usage_daily?user_id=eq.${encodeURIComponent(userId)}&day=gte.${from}&select=*`);
    const r = rows.find((x) => x.day === w.day) ?? {};
    const n = (v: unknown) => Number(v) || 0;
    const sum = (since: string) => rows.filter((x) => (x.day ?? '') >= since).reduce((t, x) => t + n(x.cost_usd), 0);
    return {
      requests: n(r.requests),
      input_tokens: n(r.input_tokens),
      output_tokens: n(r.output_tokens),
      web_searches: n(r.web_searches),
      images: n(r.images),
      voice_seconds: n(r.voice_seconds),
      cost_usd: n(r.cost_usd),
      week_cost_usd: sum(w.weekFrom),
      month_cost_usd: sum(w.monthFrom),
    };
  }

  /** Holds what an AI call could cost (see reserve_ai in 010_billing_v2.sql); throws the database's reason. */
  async reserve(userId: string, amount: number, kind: string, w: Windows, caps: Caps): Promise<{ id: string; topup: boolean }> {
    const id = await this.rest<string>('rpc/reserve_ai', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_amount: round6(amount), p_kind: kind, p_day: w.day, p_week_from: w.weekFrom, p_month_from: w.monthFrom, p_day_cap: caps.day, p_week_cap: caps.week, p_month_cap: caps.month }),
    });
    // A refusal comes back as a word (allowance_day/week/month, keo_breaker), not as an error.
    const answer = String(id);
    if (/^(allowance_(day|week|month)|keo_breaker)$/.test(answer)) throw new Error(answer);
    // "topup:<id>": the plan's allowance is used up and the user's AI top-up pays for this call.
    return answer.startsWith('topup:') ? { id: answer.slice(6), topup: true } : { id: answer, topup: false };
  }

  /** The user's AI top-up left (US$ of AI cost; never shown to users as dollars). */
  async topup(userId: string): Promise<number> {
    const rows = await this.rest<Array<{ balance_usd: number }>>(`ai_topups?user_id=eq.${encodeURIComponent(userId)}&select=balance_usd`).catch(() => []);
    return Number(rows[0]?.balance_usd) || 0;
  }

  /** Replaces a hold with the call's real cost and counts. */
  async settle(holdId: string, userId: string, day: string, u: Added): Promise<void> {
    await this.rest('rpc/settle_ai', {
      method: 'POST',
      body: JSON.stringify({
        p_hold: holdId,
        p_user: userId,
        p_day: day,
        p_requests: u.requests ?? 0,
        p_in: u.input ?? 0,
        p_out: u.output ?? 0,
        p_cost: round6(u.cost ?? 0),
        p_searches: u.searches ?? 0,
        p_images: u.images ?? 0,
        p_voice_seconds: Math.ceil(u.voiceSeconds ?? 0),
      }),
    });
  }
}

const round6 = (n: number) => Math.round(Math.max(0, n) * 1e6) / 1e6;

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Profile {
  plan: string;
  plan_until: string | null;
  blocked: boolean;
  billing_status?: string | null;
  /** When the current paid month started (the payment's time). */
  period_start?: string | null;
}

/** The time windows an account's AI allowance is counted in (UTC days, YYYY-MM-DD), and when each resets. */
export interface Windows {
  day: string;
  weekFrom: string;
  monthFrom: string;
  resets: { day: string; week: string; month: string };
  /** The billing month's key (Studio's monthly credits follow it too). */
  periodKey: string;
}
/** What may be spent (US$) in each window; 0 means no limit. */
export interface Caps {
  day: number;
  week: number;
  month: number;
}

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * The windows for an account. A paid plan's month starts when it was paid (one payment is one
 * month's allowance, whatever the calendar says) and does not start again during the few days of
 * grace before the next payment. Free accounts use the calendar month. Weeks start on Monday (or
 * when the billing month started, if later); days at 00:00 UTC.
 */
export function windowsFor(now: number, plan: Plan, profile: Pick<Profile, 'plan_until' | 'period_start'> | null): Windows {
  const dayStart = Date.parse(`${isoDay(now)}T00:00:00Z`);
  const monday = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * DAY_MS;
  let monthStart: number;
  let monthReset: number;
  let periodKey: string;
  const paid = plan.id !== 'free';
  const until = profile?.plan_until ? Date.parse(profile.plan_until) : NaN;
  const anchor = profile?.period_start ? Date.parse(profile.period_start) : Number.isFinite(until) ? addMonths(until - 3 * DAY_MS, -1) : NaN;
  if (paid && Number.isFinite(anchor) && anchor <= now) {
    monthStart = anchor;
    const next = addMonths(anchor, 1);
    // Past the paid month (waiting for the next payment): no new allowance until it arrives.
    monthReset = next > now ? next : Number.isFinite(until) ? until : next;
    periodKey = `p${new Date(anchor).toISOString().slice(0, 19)}`;
  } else {
    const d = new Date(now);
    monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    monthReset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    periodKey = new Date(now).toISOString().slice(0, 7);
  }
  const monthFrom = isoDay(monthStart);
  const weekFrom = isoDay(Math.max(monday, Date.parse(`${monthFrom}T00:00:00Z`)));
  return {
    day: isoDay(now),
    weekFrom,
    monthFrom,
    resets: { day: new Date(dayStart + DAY_MS).toISOString(), week: new Date(monday + 7 * DAY_MS).toISOString(), month: new Date(monthReset).toISOString() },
    periodKey,
  };
}

interface Account {
  user: User;
  plan: Plan;
  usage: Usage;
  day: string;
  windows: Windows;
  /** A paid plan: until when it is paid, and whether it renews (null on Free). */
  billing: { until: string | null; status: string } | null;
}

/** Who is asking, and with which plan and usage (or the error to answer with). */
async function account(req: Request, db: Supabase, now: number): Promise<Account | Response> {
  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (!token) return fail(401, 'Sign in to Keo to use Keo’s AI.', 'not_signed_in', 'authentication_error');
  const user = await db.user(token);
  if (!user) return fail(401, 'Your Keo sign-in has expired. Sign in again.', 'sign_in_expired', 'authentication_error');
  const profile = await db.profile(user.id);
  if (!profile) return fail(403, 'This Keo account is not set up yet. Try again in a minute.', 'no_profile');
  if (profile.blocked) return fail(403, 'This Keo account is blocked. Contact Keo support.', 'blocked');
  const plans = await db.plans();
  // A paid plan that ran out counts as Free.
  const expired = profile.plan !== 'free' && profile.plan_until !== null && Date.parse(profile.plan_until) < now;
  const plan = plans.find((p) => p.id === (expired ? 'free' : profile.plan)) ?? plans.find((p) => p.id === 'free');
  if (!plan) return fail(500, 'Keo’s plans are not set up.', 'no_plans');
  const windows = windowsFor(now, plan, profile);
  const billing = plan.id !== 'free' ? { until: profile.plan_until, status: profile.billing_status ?? 'active' } : null;
  return { user, plan, usage: await db.usage(user.id, windows), day: windows.day, windows, billing };
}

/** The plan's hard AI allowance for its billing month (US$). */
export function monthlyBudget(plan: Plan): number {
  const month = Number(plan.monthly_cost_usd);
  if (month > 0) return month;
  const day = Number(plan.daily_cost_usd);
  return day > 0 ? day * 30 : 0;
}

/** What may be spent in a day, a week and the billing month (the day and week are shares of the month: 35% and 60% unless the plan says otherwise). */
export function capsFor(plan: Plan): Caps {
  const month = monthlyBudget(plan);
  const share = (v: unknown, d: number) => {
    const n = Number(v);
    return n > 0 && n <= 1 ? n : d;
  };
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return { month, week: r6(month * share(plan.week_share, 0.6)), day: r6(month * share(plan.day_share, 0.35)) };
}

export type Window = 'day' | 'week' | 'month';

/** How much of each window is used, 0–100. */
export function windowUse(a: { plan: Plan; usage: Usage }): Record<Window, number> {
  const c = capsFor(a.plan);
  const pct = (used: number, cap: number) => (cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0);
  return { day: pct(a.usage.cost_usd, c.day), week: pct(a.usage.week_cost_usd, c.week), month: pct(a.usage.month_cost_usd, c.month) };
}

/** About what one website or game build costs on a model (measured: ~234k tokens in, 60% from cache, ~25k out). */
export function buildCost(m: Pick<ModelRow, 'price_in_per_m' | 'price_out_per_m'>): number {
  const pin = Number(m.price_in_per_m) || 5;
  const pout = Number(m.price_out_per_m) || 25;
  return (234_000 * 0.4 * pin + 234_000 * 0.6 * pin * 0.1 + 25_000 * pout) / 1e6;
}

/** About what one task that operates the computer costs on a model (measured: ~350k tokens in, 60% from cache, ~8k out). */
export function taskCost(m: Pick<ModelRow, 'price_in_per_m' | 'price_out_per_m'>): number {
  const pin = Number(m.price_in_per_m) || 5;
  const pout = Number(m.price_out_per_m) || 25;
  return (350_000 * 0.4 * pin + 350_000 * 0.6 * pin * 0.1 + 8_000 * pout) / 1e6;
}

const dateWords = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/** The answer when an allowance window is used up: the task pauses (the app keeps its work). */
export function pausedAnswer(a: { plan: Plan; windows: Windows }, window: Window): Response {
  const when = window === 'day' ? 'at 00:00 UTC' : window === 'week' ? 'on Monday at 00:00 UTC' : `on ${dateWords(a.windows.resets.month)}`;
  const what = window === 'day' ? 'today’s share of your' : window === 'week' ? 'this week’s share of your' : 'all of this month’s';
  const more = a.plan.id === 'max' ? ' An AI top-up lets you carry on now.' : ' An AI top-up lets you carry on now, or upgrade your plan for more each month.';
  const message = `You’ve used ${what} ${a.plan.name} AI allowance. Keo paused here and kept your work; it can carry on when the allowance resets ${when}.${more}`;
  return json(429, { error: { message, type: 'plan_limit', code: 'allowance_paused', window, resetsAt: a.windows.resets[window], topup: true } });
}

/** Keo's own daily safety limit was reached: nothing is charged to the user. */
export const breakerAnswer = () =>
  fail(503, 'Keo’s AI is paused for a short while for safety. Nothing was taken from your allowance; please try again later.', 'keo_paused', 'api_error');

/** Today's step and token counts (a guard against runaway loops, on top of the money allowance). */
function overDailyCounts(a: Account): boolean {
  return a.usage.requests >= a.plan.daily_requests || a.usage.input_tokens + a.usage.output_tokens >= a.plan.daily_tokens;
}

/**
 * Holds what a call could cost. Returns the hold's id, or the answer to send (a window used up, or
 * Keo's breaker).
 */
async function hold(db: Supabase, a: Account, amount: number, kind: string, continuing = false): Promise<{ id: string; topup: boolean } | Response> {
  if (overDailyCounts(a)) return pausedAnswer(a, 'day');
  // A later step of a task already under way finishes within the month: today's and this week's
  // shares only pace new work, they never stop a task half-done. The month stays a hard ceiling.
  const caps = capsFor(a.plan);
  try {
    return await db.reserve(a.user.id, amount, kind, a.windows, continuing ? { ...caps, day: 0, week: 0 } : caps);
  } catch (e) {
    const why = /allowance_(day|week|month)|keo_breaker/.exec((e as Error).message);
    if (why?.[0] === 'keo_breaker') return breakerAnswer();
    if (why?.[1]) return pausedAnswer(a, why[1] as Window);
    throw e;
  }
}

/** The most a chat call could cost: its input (as a cache write) and the longest answer allowed. */
export function chatHold(m: ModelRow, body: Record<string, unknown>, maxOut: number): { usd: number; inputTokens: number } {
  const pin = Number(m.price_in_per_m) || 5;
  const pout = Number(m.price_out_per_m) || 25;
  // Pictures count as about 1,600 tokens each, whatever the size of their data.
  let pictures = 0;
  const text = JSON.stringify([body.messages ?? [], body.tools ?? []]).replace(/data:[^"]{40,}/g, () => {
    pictures++;
    return '';
  });
  const inputTokens = Math.ceil(text.length / 4) + pictures * 1600;
  return { usd: (inputTokens * pin * 1.25 + maxOut * pout) / 1e6, inputTokens };
}

/** The cost of a call whose usage never arrived (cut off): its input and the answer streamed so far. */
export function cutOffCost(m: ModelRow, inputTokens: number, outputChars: number): number {
  const pin = Number(m.price_in_per_m) || 5;
  const pout = Number(m.price_out_per_m) || 25;
  return (inputTokens * pin * 1.25 + Math.ceil(outputChars / 3) * pout) / 1e6;
}

/**
 * Claude models: mark Keo's long, unchanging start of each request (instructions and tool list)
 * for caching, so the following steps read it at a fraction of the price.
 */
export function withPromptCache(upstream: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!upstream.startsWith('anthropic/') || !Array.isArray(body.messages)) return body;
  let marked = false;
  const messages = (body.messages as Array<Record<string, unknown>>).map((m) => {
    if (marked || m.role !== 'system') return m;
    marked = true;
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? [...(m.content as Array<Record<string, unknown>>)] : null;
    if (!parts?.length) return m;
    parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...m, content: parts };
  });
  // And the conversation so far, up to the user's latest message: a long task re-sends it on every
  // step, and reads it back at a fraction of the price.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const parts = typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : null) : Array.isArray(m.content) ? [...(m.content as Array<Record<string, unknown>>)] : null;
    const at = parts ? parts.map((p) => p.type).lastIndexOf('text') : -1;
    if (parts && at >= 0) {
      parts[at] = { ...parts[at], cache_control: { type: 'ephemeral' } };
      messages[i] = { ...m, content: parts };
    }
    break;
  }
  return { ...body, messages };
}

/** Reads usage (and OpenRouter's cost) from a finished completion. */
function usageOf(body: { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } } | null): { input: number; output: number; cost: number } {
  const u = body?.usage ?? {};
  return { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0, cost: Number(u.cost) || 0 };
}

type Feature = 'web_search' | 'images' | 'voice_minutes';
const FEATURE_NAME: Record<Feature, string> = { web_search: 'Web search', images: 'Making pictures', voice_minutes: 'Keo’s voice' };

/** A plan's daily allowance for a feature (0 when the plan does not include it). */
export function allowance(plan: Plan, f: Feature): number {
  const v = plan.features?.[f];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** Refuses a feature the plan does not include, or whose daily allowance is used up. */
function featureRefused(a: Account, f: Feature): Response | null {
  const max = allowance(a.plan, f);
  const used = f === 'web_search' ? a.usage.web_searches : f === 'images' ? a.usage.images : a.usage.voice_seconds / 60;
  if (max === 0) return fail(403, `${FEATURE_NAME[f]} is not in the ${a.plan.name} plan. Upgrade your Keo plan to use it.`, 'feature_not_in_plan', 'plan_limit');
  if (used >= max) return fail(429, `You’ve used today’s ${FEATURE_NAME[f].toLowerCase()} allowance in the ${a.plan.name} plan. It resets at midnight UTC — or upgrade for more.`, 'feature_limit', 'plan_limit');
  return null;
}

async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return fail(413, 'That is too large to send.', 'too_large', 'invalid_request_error');
  try {
    const b = (await req.json()) as unknown;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('not an object');
    return b as Record<string, unknown>;
  } catch {
    return fail(400, 'The request is not valid JSON.', 'bad_json', 'invalid_request_error');
  }
}

/** OpenRouter's error, passed on in OpenAI's shape. */
/**
 * Keo's own account with the AI service has a problem (out of credit, a spending limit, a bad key).
 * That is Keo's to fix, never the user's: they must not be told about "your credits".
 */
export function keoSideProblem(status: number, message: string): boolean {
  return status === 402 || status === 401 || status === 403 || /\b(credits?|billing|insufficient|payment|key limit|spend(ing)? limit|no auth|api key)\b/i.test(message);
}

async function upstreamFailed(up: Response): Promise<Response> {
  const text = await up.text();
  let message = `The AI service answered ${up.status}.`;
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    /* not JSON */
  }
  if (keoSideProblem(up.status, message)) {
    // For the owner, in the Worker's log (wrangler tail / the Cloudflare dashboard).
    console.error(`KEO CLOUD NEEDS ATTENTION: the AI service refused Keo's own account (${up.status}): ${message.slice(0, 300)}`);
    return fail(503, 'Keo’s AI service is busy right now. Nothing was taken from your allowance or credits. Please try again in a few minutes.', 'service_unavailable', 'api_error');
  }
  return fail(up.status >= 500 ? 502 : up.status, message, 'upstream_error', 'api_error');
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A WAV file around raw 16-bit mono PCM. */
export function wav(pcm: Uint8Array, rate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** How long a WAV recording is, in seconds (from its header; a rough guess if it has none). */
export function wavSeconds(bytes: Uint8Array): number {
  if (bytes.length > 44 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') {
    const bytesPerSecond = new DataView(bytes.buffer, bytes.byteOffset).getUint32(28, true);
    if (bytesPerSecond > 0) return (bytes.length - 44) / bytesPerSecond;
  }
  return bytes.length / 32000;
}

/** Picture shapes the app asks for, as OpenRouter aspect ratios. */
const ASPECT: Record<string, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' };

/**
 * What is held before a search, picture, voice or listening call (US$): above what each really costs,
 * so the hold is never short. The real cost from OpenRouter replaces it afterwards.
 */
export const HOLD = { search: 0.05, picture: 0.08, voicePerSecond: 0.0015, listenPerSecond: 0.0002 } as const;

export async function handle(req: Request, env: Env, deps: { fetch: Fetch; waitUntil: (p: Promise<unknown>) => void; now?: () => number }): Promise<Response> {
  const url = new URL(req.url);
  const now = deps.now?.() ?? Date.now();
  const db = new Supabase(env, deps.fetch);
  const route = url.pathname.replace(/\/+$/, '');
  try {
    if (route === '' || route === '/health') {
      if (url.searchParams.get('deep') !== '1') return json(200, { ok: true, service: 'keo-cloud' });
      // A setup check for the owner only (it shows Keo's spend and which models are used).
      const denied = await adminOnly(req, env, db);
      if (denied) return denied;
      // Can the gateway reach the database and OpenRouter with its keys? (never the keys themselves)
      const out: Record<string, unknown> = { service: 'keo-cloud' };
      try {
        const [plans, models] = await Promise.all([db.plans(), db.models()]);
        out.database = { ok: true, plans: plans.map((p) => p.id), models: models.map((m) => `${m.id} → ${m.upstream}`) };
      } catch (e) {
        out.database = { ok: false, error: (e as Error).message };
      }
      try {
        const r = await deps.fetch(`${env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1'}/key`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
        const k = (await r.json().catch(() => ({}))) as { data?: { limit?: number | null; limit_remaining?: number | null; usage?: number } };
        out.openrouter = r.ok ? { ok: true, limit: k.data?.limit ?? null, remaining: k.data?.limit_remaining ?? null, used: k.data?.usage ?? null } : { ok: false, error: `OpenRouter answered ${r.status}` };
      } catch (e) {
        out.openrouter = { ok: false, error: (e as Error).message };
      }
      out.ok = (out.database as { ok: boolean }).ok && (out.openrouter as { ok: boolean }).ok;
      return json(200, out);
    }

    // Where the links in Keo's account emails land (Supabase → URL Configuration → Site URL).
    if (req.method === 'GET' && route === '/account') return accountPage(env);
    // Keo's plans and payment page.
    if (req.method === 'GET' && route === '/upgrade') return upgradePage();
    if (req.method === 'GET' && (route === '/terms' || route === '/privacy' || route === '/refunds')) return legalPage(route.slice(1) as 'terms' | 'privacy' | 'refunds', env);
    // The owner's admin page and its data (only the emails in ADMIN_EMAILS).
    const adminAnswer = await handleAdmin(req, route, env, { fetch: deps.fetch, now, db });
    if (adminAnswer) return adminAnswer;

    // Payments: prices, checkout, the Paystack webhook. Billing accepts the user's sign-in or an
    // Upgrade-page ticket.
    const billing = await handleBilling(req, route, env, {
      fetch: deps.fetch,
      now,
      db,
      waitUntil: deps.waitUntil,
      who: async () => {
        const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
        if (!token) return fail(401, 'Sign in to Keo first.', 'not_signed_in', 'authentication_error');
        const who = token.startsWith('kt.') ? await readTicket(env, token, now) : await db.user(token);
        return who ?? fail(401, 'This link has expired. Open the Upgrade page again from Keo.', 'sign_in_expired', 'authentication_error');
      },
    });
    if (billing) return billing;

    // Keo Studio's AI (fal.ai with Keo's key), paid with Studio credits.
    const studio = await handleStudio(req, route, env, { fetch: deps.fetch, now, db, waitUntil: deps.waitUntil, account: () => account(req, db, now) });
    if (studio) return studio;

    // The shared Edit DNA library (blueprints users chose to publish; the editing only).
    const dna = await handleDna(req, route, { db, now, waitUntil: deps.waitUntil, account: () => account(req, db, now) });
    if (dna) return dna;

    // Report a problem: what the user wrote and saw (their recent log with personal details out).
    // The early-access list (from heykeo.com; no sign-in).
    const waitlist = await handleWaitlist(req, route, db, now);
    if (waitlist) return waitlist;

    if (req.method === 'POST' && route === '/v1/report') {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      const body = (await req.json().catch(() => ({}))) as { message?: unknown; report?: unknown; version?: unknown };
      const message = String(body.message ?? '').trim().slice(0, 4000);
      const report = String(body.report ?? '');
      if (message.length < 1) return fail(400, 'Say what happened.', 'bad_request', 'invalid_request_error');
      if (report.length > 200_000) return fail(413, 'The report is too long: leave out the activity log and try again.', 'too_large', 'invalid_request_error');
      // At most 10 a day per account (a stuck loop cannot flood the reports).
      const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const today = await db.rest<Array<{ id: string }>>(`problem_reports?user_id=eq.${encodeURIComponent(a.user.id)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=11`).catch(() => []);
      if (today.length >= 10) return fail(429, 'You have sent 10 reports today: thank you! Try again tomorrow, or save the report to a file.', 'too_many_reports', 'rate_limit_error');
      const saved = await db
        .rest<Array<{ id: string }>>('problem_reports', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ user_id: a.user.id, message, report, version: String(body.version ?? '').slice(0, 40) }) })
        .catch(() => null);
      if (!saved?.[0]) return fail(502, 'The report could not be saved. Save it to a file instead.', 'report_failed', 'api_error');
      return json(200, { id: saved[0].id.slice(0, 8) });
    }

    if (req.method === 'GET' && route === '/v1/models') {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      const models = (await db.models()).filter((m) => m.tier <= a.plan.max_tier);
      return json(200, {
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'keo', keo: { label: m.label, tier: m.tier, vision: m.vision, tools: m.tools, contextTokens: m.context_tokens, maxOutputTokens: m.max_output_tokens } })),
      });
    }

    if (req.method === 'GET' && route === '/v1/me') {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      // Dollar figures stay inside Keo Cloud: the app gets the allowance as percentages, reset times
      // and about how many builds are left on each model the plan includes.
      const { cost_usd: _cost, week_cost_usd: _week, month_cost_usd: _month, ...usage } = a.usage;
      const { daily_cost_usd: _cap, monthly_cost_usd: _monthCap, week_share: _ws, day_share: _ds, ...plan } = a.plan;
      const caps = capsFor(a.plan);
      const use = windowUse(a);
      const left = Math.max(0, Math.min(caps.month - a.usage.month_cost_usd, caps.week - a.usage.week_cost_usd, caps.day - a.usage.cost_usd));
      const monthLeft = Math.max(0, caps.month - a.usage.month_cost_usd);
      const models = (await db.models()).filter((m) => m.tier <= a.plan.max_tier);
      const buildsLeft = Object.fromEntries(models.map((m) => [m.id, { now: Math.floor(left / buildCost(m)), month: Math.floor(monthLeft / buildCost(m)) }]));
      const windows = (['day', 'week', 'month'] as const).map((w) => ({ window: w, used: use[w], resetsAt: a.windows.resets[w] }));
      // The AI top-up (used after the plan's allowance): about how many builds and tasks it is worth.
      const topupUsd = await db.topup(a.user.id);
      const topup = topupUsd > 0 ? { buildsLeft: Object.fromEntries(models.map((m) => [m.id, Math.floor(topupUsd / buildCost(m))])), tasksLeft: Math.floor(topupUsd / taskCost(models[0] ?? {})) } : null;
      return json(200, {
        user: a.user,
        plan,
        usage: { day: a.day, ...usage, allowanceUsed: Math.max(use.day, use.week, use.month), monthUsed: use.month, windows, buildsLeft, topup },
        billing: a.billing,
      });
    }

    const OR = env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1';
    const toOpenRouter = async (path: string, body: Record<string, unknown>, userId: string) =>
      deps.fetch(`${OR}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'Keo', 'http-referer': 'https://blessedloner.github.io/keo/' },
        // OpenRouter can tell abuse apart per user without knowing who they are.
        body: JSON.stringify({ ...body, user: (await sha256(userId)).slice(0, 32) }),
      });
    const media = async (f: Feature) => {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      return featureRefused(a, f) ?? a;
    };
    // Before a paid call: hold what it could cost. After it: the real cost replaces the hold (zero
    // when the call failed, so a failure costs the user nothing).
    const holdFor = (a: Account, usd: number, kind: string, continuing = false) => hold(db, a, usd, kind, continuing);
    const done = (a: Account, h: { id: string }, u: Added) => deps.waitUntil(db.settle(h.id, a.user.id, a.day, u).catch((e) => console.error('settle failed', (e as Error).message)));

    // Web search: results (title, link, snippet) found by OpenRouter's web search.
    if (req.method === 'POST' && route === '/v1/search') {
      const a = await media('web_search');
      if (a instanceof Response) return a;
      const body = await readJson(req, 16_000);
      if (body instanceof Response) return body;
      const query = typeof body.query === 'string' ? body.query.trim().slice(0, 400) : '';
      if (!query) return fail(400, 'Say what to search for.', 'no_query', 'invalid_request_error');
      const count = Math.min(10, Math.max(1, Number(body.count) || 5));
      const h = await holdFor(a, HOLD.search, 'search');
      if (h instanceof Response) return h;
      const up = await toOpenRouter(
        '/chat/completions',
        {
          model: env.KEO_SEARCH_MODEL ?? 'openai/gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Answer in one short sentence using the web results.' },
            { role: 'user', content: query },
          ],
          max_tokens: 80,
          plugins: [{ id: 'web', engine: env.KEO_SEARCH_ENGINE ?? 'exa', max_results: count }],
          usage: { include: true },
        },
        a.user.id,
      );
      if (!up.ok) {
        done(a, h, {});
        return upstreamFailed(up);
      }
      const data = (await up.json()) as { choices?: Array<{ message?: { annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }> } }>; usage?: never };
      const seen = new Set<string>();
      const results: Array<{ title: string; url: string; description: string; age: null }> = [];
      for (const n of data.choices?.[0]?.message?.annotations ?? []) {
        const c = n.type === 'url_citation' ? n.url_citation : undefined;
        if (!c?.url || !/^https?:\/\//i.test(c.url) || seen.has(c.url)) continue;
        seen.add(c.url);
        results.push({ title: (c.title || c.url).slice(0, 300), url: c.url.slice(0, 2000), description: (c.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), age: null });
      }
      const u = usageOf(data);
      done(a, h, { cost: u.cost, searches: 1 });
      return json(200, { results: results.slice(0, count) });
    }

    // Pictures: a new one from a description, or a changed copy of one (base64 in, base64 out).
    if (req.method === 'POST' && route === '/v1/images') {
      const a = await media('images');
      if (a instanceof Response) return a;
      const body = await readJson(req, 30_000_000);
      if (body instanceof Response) return body;
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : '';
      if (!prompt) return fail(400, 'Describe the picture.', 'no_prompt', 'invalid_request_error');
      const image = body.image as { data?: unknown; type?: unknown } | undefined;
      const ref = image && typeof image.data === 'string' && typeof image.type === 'string' && /^image\/(png|jpeg|webp)$/.test(image.type) ? `data:${image.type};base64,${image.data}` : null;
      const quality = typeof body.quality === 'string' && ['low', 'medium', 'high'].includes(body.quality) ? body.quality : undefined;
      const background = body.background === 'transparent' || body.background === 'opaque' ? body.background : undefined;
      const aspect = typeof body.size === 'string' ? ASPECT[body.size] : undefined;
      const h = await holdFor(a, HOLD.picture, 'picture');
      if (h instanceof Response) return h;
      const up = await toOpenRouter(
        '/images',
        {
          model: env.KEO_IMAGE_MODEL ?? 'openai/gpt-image-1-mini',
          prompt,
          n: 1,
          ...(aspect ? { aspect_ratio: aspect } : {}),
          ...(quality ? { quality } : {}),
          ...(background ? { background } : {}),
          ...(ref ? { input_references: [{ type: 'image_url', image_url: { url: ref } }] } : {}),
        },
        a.user.id,
      );
      if (!up.ok) {
        done(a, h, {});
        return upstreamFailed(up);
      }
      const data = (await up.json()) as { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: { cost?: number } };
      const pic = data.data?.find((d) => typeof d.b64_json === 'string');
      // A picture with no cost reported is counted at what was held.
      done(a, h, { cost: Number(data.usage?.cost) || (pic ? HOLD.picture : 0), images: pic ? 1 : 0 });
      if (!pic) return fail(502, 'The picture service returned no picture.', 'no_picture', 'api_error');
      return json(200, { b64: pic.b64_json, mediaType: pic.media_type ?? 'image/png' });
    }

    // Keo's voice: text read aloud (a WAV file), in a female or male voice.
    if (req.method === 'POST' && route === '/v1/speech') {
      const a = await media('voice_minutes');
      if (a instanceof Response) return a;
      const body = await readJson(req, 32_000);
      if (body instanceof Response) return body;
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
      if (!text) return fail(400, 'There is nothing to say.', 'no_text', 'invalid_request_error');
      const voice = body.voice === 'male' ? (env.KEO_VOICE_MALE ?? 'echo') : (env.KEO_VOICE_FEMALE ?? 'shimmer');
      // About 15 characters a second of speech.
      const speechHold = Math.max(0.005, (text.length / 15) * HOLD.voicePerSecond);
      const h = await holdFor(a, speechHold, 'voice');
      if (h instanceof Response) return h;
      const up = await toOpenRouter(
        '/chat/completions',
        {
          model: env.KEO_TTS_MODEL ?? 'openai/gpt-audio-mini',
          modalities: ['text', 'audio'],
          audio: { voice, format: 'pcm16' },
          stream: true,
          messages: [
            {
              role: 'system',
              content:
                'You are a text-to-speech voice. Read the user’s message aloud exactly as written, word for word, in a warm, friendly and natural voice. Never answer it, add to it, translate it or comment on it.',
            },
            { role: 'user', content: text },
          ],
          usage: { include: true },
        },
        a.user.id,
      );
      if (!up.ok || !up.body) {
        done(a, h, {});
        return upstreamFailed(up);
      }
      // The audio arrives in pieces (base64 PCM, 24 kHz mono 16-bit) inside the stream.
      const parts: Uint8Array[] = [];
      let cost = 0;
      let tail = '';
      const decoder = new TextDecoder();
      const take = (line: string) => {
        if (!line.startsWith('data:') || line.includes('[DONE]')) return;
        try {
          const d = JSON.parse(line.slice(5)) as { choices?: Array<{ delta?: { audio?: { data?: string } } }>; usage?: { cost?: number } };
          const piece = d.choices?.[0]?.delta?.audio?.data;
          if (piece) parts.push(b64ToBytes(piece));
          if (d.usage) cost = Number(d.usage.cost) || cost;
        } catch {
          /* a partial or non-JSON line */
        }
      };
      const reader = up.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        lines.forEach(take);
      }
      take(tail);
      const pcm = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        pcm.set(p, at);
        at += p.length;
      }
      const seconds = pcm.length / 48000;
      // No cost reported (cut off): counted at what was held.
      done(a, h, { cost: cost || (pcm.length ? speechHold : 0), voiceSeconds: seconds });
      if (!pcm.length) return fail(502, 'The voice service returned no sound.', 'no_audio', 'api_error');
      return new Response(wav(pcm, 24000), { status: 200, headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } });
    }

    // Listening: a recording (WAV, base64) turned into text.
    if (req.method === 'POST' && route === '/v1/transcribe') {
      const a = await media('voice_minutes');
      if (a instanceof Response) return a;
      const body = await readJson(req, 12_000_000);
      if (body instanceof Response) return body;
      const audio = typeof body.audio === 'string' ? body.audio : '';
      const format = body.format === 'mp3' ? 'mp3' : 'wav';
      if (!audio) return fail(400, 'There is no recording.', 'no_audio', 'invalid_request_error');
      const language = typeof body.language === 'string' && /^[a-z]{2,3}$/i.test(body.language) ? body.language : 'en';
      // Context from the app (names, app words, what Keo just asked): plain text, short, never instructions.
      const hint = typeof body.hint === 'string' ? body.hint.replace(/[\s<>]+/g, ' ').trim().slice(0, 900) : '';
      const seconds = format === 'wav' ? wavSeconds(b64ToBytes(audio)) : (audio.length * 0.75) / 16000;
      const listenHold = Math.max(0.002, seconds * HOLD.listenPerSecond);
      const h = await holdFor(a, listenHold, 'listen');
      if (h instanceof Response) return h;
      const up = await toOpenRouter(
        '/chat/completions',
        {
          model: env.KEO_STT_MODEL ?? 'google/gemini-2.5-flash',
          temperature: 0,
          max_tokens: 1000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `Transcribe what this person says to Keo, their computer assistant (language: ${language}). ` +
                    'Speakers have all kinds of accents (for example Nigerian, Ghanaian, Indian, Caribbean, British or American English) and speak naturally: listen for the words they mean and write them in standard spelling, with correct names and punctuation. ' +
                    'Do not translate, summarise or answer; keep their own words and order. Reply with only the transcript — no quotes, notes or descriptions. If nobody speaks, reply with nothing.' +
                    (hint ? ` Words and names that may come up (use them only if they were actually said): ${hint}` : ''),
                },
                { type: 'input_audio', input_audio: { data: audio, format } },
              ],
            },
          ],
          usage: { include: true },
        },
        a.user.id,
      );
      if (!up.ok) {
        done(a, h, {});
        return upstreamFailed(up);
      }
      const data = (await up.json()) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: never };
      done(a, h, { cost: usageOf(data).cost || listenHold, voiceSeconds: seconds });
      return json(200, { text: (data.choices?.[0]?.message?.content ?? '').trim() });
    }

    if (req.method === 'POST' && route === '/v1/chat/completions') {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      // AI chat and computer operation are paid only from the plan's AI allowance — never with Studio
      // credits, and never by quietly switching to a cheaper model. When a window is used up, the
      // answer says so (allowance_paused) and the app pauses the task with its work kept.
      const body = await readJson(req, 30_000_000);
      if (body instanceof Response) return body;
      const models = await db.models();
      const wanted = typeof body.model === 'string' ? body.model : 'keo-fast';
      const model = models.find((m) => m.id === wanted);
      if (!model) return fail(400, `Keo has no model called ${wanted}.`, 'unknown_model', 'invalid_request_error');
      if (model.tier > a.plan.max_tier) return fail(403, `${model.label} is not in the ${a.plan.name} plan. Upgrade to use it.`, 'model_not_in_plan', 'plan_limit');
      const stream = body.stream === true;
      let maxOut = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? model.max_output_tokens) || model.max_output_tokens, model.max_output_tokens);
      const est = chatHold(model, body, maxOut);
      const h = await holdFor(a, est.usd, 'chat', req.headers.get('x-keo-task') === 'continuing');
      if (h instanceof Response) return h;
      const upstreamBody = {
        ...withPromptCache(model.upstream, body),
        model: model.upstream,
        max_tokens: maxOut,
        max_completion_tokens: undefined,
        usage: { include: true },
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      };
      let up = await toOpenRouter('/chat/completions', upstreamBody, a.user.id);
      // The AI service holds back credit for the longest possible answer: when Keo's own balance is
      // too low for that, a shorter answer limit often still goes through.
      if (up.status === 402 && maxOut > 4096) {
        maxOut = 4096;
        up = await toOpenRouter('/chat/completions', { ...upstreamBody, max_tokens: maxOut }, a.user.id);
      }
      if (!up.ok || !up.body) {
        // Count the attempt (no cost), so a failing loop still uses up the day's steps — unless the
        // problem is Keo's own account, which costs the user nothing.
        done(a, h, up.status !== 402 && up.status !== 401 && up.status !== 403 ? { requests: 1 } : {});
        return upstreamFailed(up);
      }
      if (!stream) {
        const data = (await up.json().catch(() => null)) as (Record<string, unknown> & { usage?: { cost?: number } }) | null;
        const u = usageOf(data as never);
        // No usage in the answer: counted at what was held.
        done(a, h, { requests: 1, ...u, cost: data?.usage && u.cost > 0 ? u.cost : est.usd });
        if (!data) return fail(502, 'The AI service sent an answer Keo could not read.', 'bad_answer', 'api_error');
        return new Response(JSON.stringify({ ...data, model: model.id }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(h.topup ? { 'x-keo-paid-with': 'topup' } : {}) } });
      }
      // Streaming: pass every chunk straight through and read the usage from the last one. If the
      // answer is cut off or the app stops reading, the cost is worked out from what was sent —
      // never recorded as nothing.
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let tail = '';
      let used: { input: number; output: number; cost: number } | null = null;
      let outChars = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (used && used.cost > 0) done(a, h, { requests: 1, ...used });
        else done(a, h, { requests: 1, input: used?.input || est.inputTokens, output: used?.output || Math.ceil(outChars / 3), cost: cutOffCost(model, est.inputTokens, outChars) });
      };
      const readLines = (text: string) => {
        tail += text;
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
          try {
            const d = JSON.parse(l.slice(5)) as { usage?: unknown; choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> } }> };
            const delta = d.choices?.[0]?.delta;
            if (delta) outChars += (delta.content?.length ?? 0) + (delta.reasoning?.length ?? 0) + (delta.tool_calls ?? []).reduce((t, c) => t + (c.function?.arguments?.length ?? 0), 0);
            if (d.usage) used = usageOf(d as never);
          } catch {
            /* a partial or non-JSON line */
          }
        }
      };
      const out = new ReadableStream<Uint8Array>({
        async pull(ctl) {
          try {
            const { value, done: end } = await reader.read();
            if (end) {
              readLines('\n');
              finish();
              ctl.close();
              return;
            }
            readLines(decoder.decode(value, { stream: true }));
            ctl.enqueue(value);
          } catch (e) {
            finish();
            ctl.error(e);
          }
        },
        cancel(reason) {
          // The app stopped reading (the user pressed Stop, or the connection dropped).
          finish();
          return reader.cancel(reason).catch(() => undefined);
        },
      });
      return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...(h.topup ? { 'x-keo-paid-with': 'topup' } : {}) } });
    }

    return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
  } catch (e) {
    return fail(500, `Keo Cloud had a problem: ${(e as Error).message}`.slice(0, 300), 'server_error', 'api_error');
  }
}
