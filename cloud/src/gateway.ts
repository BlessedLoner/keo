/**
 * Keo Cloud's AI gateway (a Cloudflare Worker). The Keo app talks to it like any OpenAI-compatible
 * API, with the user's Keo sign-in (a Supabase access token) instead of an API key. Each request:
 * who is it (Supabase), which plan and how much used today, is this model in the plan, then the
 * call goes to OpenRouter with Keo's own key and its usage is added to the user's day.
 *
 * No provider key ever reaches the app; nothing of the conversation is stored here.
 */

import { handleBilling, readTicket } from './billing';
import { handleAdmin } from './admin';
import { accountPage } from './pages';
import { legalPage } from './legal';
import { upgradePage } from './upgradePage';
import { handleStudio } from './studio';

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
  /** What the plan may cost per day in AI charges (US$), whichever models are used; null: no cap. */
  daily_cost_usd?: number | null;
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

  async profile(userId: string): Promise<{ plan: string; plan_until: string | null; blocked: boolean; billing_status?: string | null } | null> {
    // select=* so a database without the payment columns still works.
    const rows = await this.rest<Array<{ plan: string; plan_until: string | null; blocked: boolean; billing_status?: string | null }>>(`profiles?id=eq.${encodeURIComponent(userId)}&select=*`);
    return rows[0] ?? null;
  }

  plans(): Promise<Plan[]> {
    // select=* so a database without the newer columns (daily_cost_usd) still works.
    return cached('plans', 60_000, () => this.rest<Plan[]>('plans?select=*&order=sort'));
  }

  models(): Promise<ModelRow[]> {
    return cached('models', 60_000, () => this.rest<ModelRow[]>('models?enabled=eq.true&select=id,label,upstream,tier,vision,tools,context_tokens,max_output_tokens&order=tier'));
  }

  async usage(userId: string, day: string): Promise<Usage> {
    // select=* so a database without the newer columns (voice_seconds) still works.
    const rows = await this.rest<Array<Partial<Usage>>>(`usage_daily?user_id=eq.${encodeURIComponent(userId)}&day=eq.${day}&select=*`);
    const r = rows[0] ?? {};
    const n = (v: unknown) => Number(v) || 0;
    return { requests: n(r.requests), input_tokens: n(r.input_tokens), output_tokens: n(r.output_tokens), web_searches: n(r.web_searches), images: n(r.images), voice_seconds: n(r.voice_seconds), cost_usd: n(r.cost_usd) };
  }

  async addUsage(userId: string, day: string, u: Added): Promise<void> {
    const body: Record<string, unknown> = { p_user: userId, p_day: day, p_requests: u.requests ?? 0, p_in: u.input ?? 0, p_out: u.output ?? 0, p_cost: u.cost ?? 0, p_searches: u.searches ?? 0, p_images: u.images ?? 0 };
    // Only sent when there is some (databases set up before voice was metered have no such parameter).
    if (u.voiceSeconds) body.p_voice_seconds = Math.ceil(u.voiceSeconds);
    await this.rest('rpc/add_usage', { method: 'POST', body: JSON.stringify(body) });
  }
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Account {
  user: User;
  plan: Plan;
  usage: Usage;
  day: string;
  /** A paid plan: until when it is paid, and whether it renews (null on Free). */
  billing: { until: string | null; status: string } | null;
}

/** Who is asking, and with which plan and usage today (or the error to answer with). */
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
  const day = today(now);
  const billing = plan.id !== 'free' ? { until: profile.plan_until, status: profile.billing_status ?? 'active' } : null;
  return { user, plan, usage: await db.usage(user.id, day), day, billing };
}

/** Today's spending cap reached (bigger models use it up faster than small ones). */
function overBudget(a: Account): boolean {
  const cap = Number(a.plan.daily_cost_usd);
  return cap > 0 && a.usage.cost_usd >= cap;
}

function overLimit(a: Account): Response | null {
  if (a.usage.requests >= a.plan.daily_requests || a.usage.input_tokens + a.usage.output_tokens >= a.plan.daily_tokens || overBudget(a))
    return fail(429, `You’ve used today’s ${a.plan.name} allowance. It resets at midnight UTC — or upgrade your plan for more.`, 'daily_limit', 'plan_limit');
  return null;
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
  if (overBudget(a)) return fail(429, `You’ve used today’s ${a.plan.name} allowance. It resets at midnight UTC — or upgrade your plan for more.`, 'daily_limit', 'plan_limit');
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
async function upstreamFailed(up: Response): Promise<Response> {
  const text = await up.text();
  let message = `The AI service answered ${up.status}.`;
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    /* not JSON */
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

export async function handle(req: Request, env: Env, deps: { fetch: Fetch; waitUntil: (p: Promise<unknown>) => void; now?: () => number }): Promise<Response> {
  const url = new URL(req.url);
  const now = deps.now?.() ?? Date.now();
  const db = new Supabase(env, deps.fetch);
  const route = url.pathname.replace(/\/+$/, '');
  try {
    if (route === '' || route === '/health') {
      if (url.searchParams.get('deep') !== '1') return json(200, { ok: true, service: 'keo-cloud' });
      // A setup check: can the gateway reach the database and OpenRouter with its keys? (never the keys themselves)
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

    // Report a problem: what the user wrote and saw (their recent log with personal details out).
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
      return json(200, { user: a.user, plan: a.plan, usage: { day: a.day, ...a.usage }, billing: a.billing });
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
    const add = (a: Account, u: Added) => deps.waitUntil(db.addUsage(a.user.id, a.day, u).catch(() => undefined));

    // Web search: results (title, link, snippet) found by OpenRouter's web search.
    if (req.method === 'POST' && route === '/v1/search') {
      const a = await media('web_search');
      if (a instanceof Response) return a;
      const body = await readJson(req, 16_000);
      if (body instanceof Response) return body;
      const query = typeof body.query === 'string' ? body.query.trim().slice(0, 400) : '';
      if (!query) return fail(400, 'Say what to search for.', 'no_query', 'invalid_request_error');
      const count = Math.min(10, Math.max(1, Number(body.count) || 5));
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
      if (!up.ok) return upstreamFailed(up);
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
      add(a, { cost: u.cost, searches: 1 });
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
      if (!up.ok) return upstreamFailed(up);
      const data = (await up.json()) as { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: { cost?: number } };
      const pic = data.data?.find((d) => typeof d.b64_json === 'string');
      add(a, { cost: Number(data.usage?.cost) || 0, images: pic ? 1 : 0 });
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
      if (!up.ok || !up.body) return upstreamFailed(up);
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
      add(a, { cost, voiceSeconds: seconds });
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
      if (!up.ok) return upstreamFailed(up);
      const data = (await up.json()) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: never };
      add(a, { cost: usageOf(data).cost, voiceSeconds: seconds });
      return json(200, { text: (data.choices?.[0]?.message?.content ?? '').trim() });
    }

    if (req.method === 'POST' && route === '/v1/chat/completions') {
      const a = await account(req, db, now);
      if (a instanceof Response) return a;
      const limit = overLimit(a);
      if (limit) return limit;
      const body = await readJson(req, 30_000_000);
      if (body instanceof Response) return body;
      const models = await db.models();
      const wanted = typeof body.model === 'string' ? body.model : 'keo-fast';
      const model = models.find((m) => m.id === wanted);
      if (!model) return fail(400, `Keo has no model called ${wanted}.`, 'unknown_model', 'invalid_request_error');
      if (model.tier > a.plan.max_tier) return fail(403, `${model.label} is not in the ${a.plan.name} plan. Upgrade to use it.`, 'model_not_in_plan', 'plan_limit');
      const stream = body.stream === true;
      const maxOut = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? model.max_output_tokens) || model.max_output_tokens, model.max_output_tokens);
      const upstreamBody = {
        ...withPromptCache(model.upstream, body),
        model: model.upstream,
        max_tokens: maxOut,
        max_completion_tokens: undefined,
        usage: { include: true },
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      };
      const up = await toOpenRouter('/chat/completions', upstreamBody, a.user.id);
      const record = (u: { input: number; output: number; cost: number }) => add(a, { requests: 1, ...u });
      if (!up.ok || !up.body) {
        // Count the attempt (no tokens), so a failing loop still uses up the day's requests.
        record({ input: 0, output: 0, cost: 0 });
        return upstreamFailed(up);
      }
      if (!stream) {
        const data = (await up.json()) as Record<string, unknown> & { model?: string };
        record(usageOf(data as never));
        return json(200, { ...data, model: model.id });
      }
      // Streaming: pass every chunk straight through, and read the usage from the last one.
      let tail = '';
      let used = { input: 0, output: 0, cost: 0 };
      const decoder = new TextDecoder();
      const watch = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          ctl.enqueue(chunk);
          tail += decoder.decode(chunk, { stream: true });
          const lines = tail.split('\n');
          tail = lines.pop() ?? '';
          for (const l of lines) {
            if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
            try {
              const d = JSON.parse(l.slice(5)) as { usage?: unknown };
              if (d.usage) used = usageOf(d as never);
            } catch {
              /* a partial or non-JSON line */
            }
          }
        },
        flush() {
          record(used);
        },
      });
      return new Response(up.body.pipeThrough(watch), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
    }

    return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
  } catch (e) {
    return fail(500, `Keo Cloud had a problem: ${(e as Error).message}`.slice(0, 300), 'server_error', 'api_error');
  }
}
