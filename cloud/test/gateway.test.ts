import { beforeEach, describe, expect, it } from 'vitest';
import { addMonths, capsFor, chatHold, clearCache, cutOffCost, handle, today, windowsFor, type Env, type Plan } from '../src/gateway';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or-secret', OPENROUTER_URL: 'https://or.test/api/v1', ADMIN_EMAILS: 'owner@example.test' };
// A Monday.
const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = today(NOW);

type Hold = { user: string; amount: number; kind: string; status: 'open' | 'expired'; created: number };

/**
 * Supabase and OpenRouter in memory. The database functions of 010_billing_v2.sql (reserve_ai,
 * settle_ai) are copied here step for step; like the real ones, each runs in one go, so calls that
 * overlap see each other's holds.
 */
class World {
  users = new Map<string, { id: string; email: string }>([
    ['tok-ana', { id: 'u-ana', email: 'ana@example.test' }],
    ['tok-owner', { id: 'u-owner', email: 'owner@example.test' }],
  ]);
  profiles = new Map<string, { plan: string; plan_until: string | null; blocked: boolean; period_start?: string | null }>([
    ['u-ana', { plan: 'free', plan_until: null, blocked: false }],
    ['u-owner', { plan: 'free', plan_until: null, blocked: false }],
  ]);
  plans: Array<Plan & Record<string, unknown>> = [
    { id: 'free', name: 'Free', daily_requests: 30, daily_tokens: 400000, max_tier: 1, monthly_cost_usd: 0.6, features: { web_search: 2, images: 0, voice_minutes: 1 } },
    { id: 'pro', name: 'Pro', daily_requests: 600, daily_tokens: 8000000, max_tier: 2, monthly_cost_usd: 12, features: { web_search: 50, images: 5, voice_minutes: 60 } },
    { id: 'max', name: 'Max', daily_requests: 2000, daily_tokens: 15000000, max_tier: 3, monthly_cost_usd: 28, features: { web_search: 200, images: 60, voice_minutes: 120 } },
  ];
  models = [
    { id: 'keo-fast', label: 'Keo Fast', upstream: 'openai/gpt-4o-mini', tier: 1, vision: true, tools: true, context_tokens: 128000, max_output_tokens: 4096, price_in_per_m: 0.1, price_out_per_m: 0.5 },
    { id: 'keo-strong', label: 'Keo Strong', upstream: 'anthropic/claude-sonnet-5.5', tier: 2, vision: true, tools: true, context_tokens: 128000, max_output_tokens: 8192, price_in_per_m: 2, price_out_per_m: 10 },
    { id: 'keo-best', label: 'Keo Best', upstream: 'anthropic/claude-opus-5.5', tier: 3, vision: true, tools: true, context_tokens: 128000, max_output_tokens: 8192, price_in_per_m: 4, price_out_per_m: 20 },
  ];
  usage = new Map<string, Record<string, number>>();
  holds = new Map<string, Hold>();
  spend = new Map<string, number>();
  alerts: Array<{ day: string; kind: string; message: string }> = [];
  settings: Record<string, number> = { breaker_openrouter_day_usd: 60, alert_share: 0.8, hold_minutes: 20 };
  clock = NOW;
  upstream: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  pending: Promise<unknown>[] = [];
  upstreamStatus = 200;
  /** Each upstream call waits this long (so calls overlap). */
  upstreamDelayMs = 0;
  /** The stream ends without its usage chunk. */
  streamWithoutUsage = false;
  /** A non-streamed answer without usage. */
  answerWithoutUsage = false;
  private holdNo = 0;

  addUsage(user: string, day: string, b: Record<string, number | undefined>) {
    const k = `${user}|${day}`;
    const cur = this.usage.get(k) ?? {};
    const plus = (f: string, v: number | undefined) => (cur[f] ?? 0) + (v ?? 0);
    this.usage.set(k, {
      requests: plus('requests', b.p_requests),
      input_tokens: plus('input_tokens', b.p_in),
      output_tokens: plus('output_tokens', b.p_out),
      cost_usd: Math.round(plus('cost_usd', b.p_cost) * 1e6) / 1e6,
      web_searches: plus('web_searches', b.p_searches),
      images: plus('images', b.p_images),
      voice_seconds: plus('voice_seconds', b.p_voice_seconds),
    });
  }
  addSpend(day: string, provider: string, usd: number) {
    const k = `${day}|${provider}`;
    this.spend.set(k, Math.round(((this.spend.get(k) ?? 0) + usd) * 1e6) / 1e6);
  }
  raise(day: string, kind: string, message: string) {
    if (!this.alerts.some((a) => a.day === day && a.kind === kind)) this.alerts.push({ day, kind, message });
  }
  /** What the user has spent from a day on (usage rows only). */
  spent(user: string, from: string, only?: string) {
    let t = 0;
    for (const [k, v] of this.usage) {
      const [u, d] = k.split('|') as [string, string];
      if (u === user && (only ? d === only : d >= from)) t += v.cost_usd ?? 0;
    }
    return t;
  }
  openHeld(user?: string) {
    return [...this.holds.values()].filter((h) => h.status === 'open' && (!user || h.user === user)).reduce((t, h) => t + h.amount, 0);
  }

  reserveAi(b: Record<string, unknown>): { ok: true; id: string } | { ok: false; why: string } {
    const user = String(b.p_user);
    const amount = Number(b.p_amount);
    for (const h of this.holds.values()) {
      if (h.user === user && h.status === 'open' && h.created < this.clock - this.settings.hold_minutes! * 60_000) {
        h.status = 'expired';
        const d = new Date(h.created).toISOString().slice(0, 10);
        this.addUsage(user, d, { p_cost: h.amount });
        this.addSpend(d, 'openrouter', h.amount);
      }
    }
    const day = String(b.p_day);
    const usedDay = this.spent(user, day, day);
    const usedWeek = this.spent(user, String(b.p_week_from));
    const usedMonth = this.spent(user, String(b.p_month_from));
    const held = this.openHeld(user);
    const over = (cap: unknown, used: number) => Number(cap) > 0 && used + held + amount > Number(cap) + 1e-9;
    if (over(b.p_month_cap, usedMonth)) return { ok: false, why: 'allowance_month' };
    if (over(b.p_week_cap, usedWeek)) return { ok: false, why: 'allowance_week' };
    if (over(b.p_day_cap, usedDay)) return { ok: false, why: 'allowance_day' };
    const breaker = this.settings.breaker_openrouter_day_usd ?? 0;
    if (breaker > 0) {
      const total = (this.spend.get(`${day}|openrouter`) ?? 0) + this.openHeld() + amount;
      if (total > breaker) {
        this.raise(day, 'breaker_openrouter', `Keo's AI spend reached today's safety limit of $${breaker}.`);
        return { ok: false, why: 'keo_breaker' };
      }
      if (total > breaker * this.settings.alert_share!) this.raise(day, 'near_openrouter', 'Keo’s AI spend passed 80% of its limit.');
    }
    const id = `hold-${++this.holdNo}`;
    this.holds.set(id, { user, amount, kind: String(b.p_kind), status: 'open', created: this.clock });
    return { ok: true, id };
  }

  settleAi(b: Record<string, unknown>): boolean {
    const h = this.holds.get(String(b.p_hold));
    if (!h || h.user !== b.p_user) return false;
    this.holds.delete(String(b.p_hold));
    const cost = Number(b.p_cost);
    const add = h.status === 'expired' ? Math.max(0, cost - h.amount) : Math.max(0, cost);
    this.addUsage(String(b.p_user), String(b.p_day), { ...(b as Record<string, number>), p_cost: add });
    this.addSpend(String(b.p_day), 'openrouter', add);
    return true;
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.host === 'db.test') {
      if (url.pathname === '/auth/v1/user') {
        const u = this.users.get((headers.get('authorization') ?? '').replace('Bearer ', ''));
        return u ? j(200, u) : j(401, { msg: 'invalid' });
      }
      // Everything else needs the service key.
      if (headers.get('authorization') !== 'Bearer service-secret') return j(401, {});
      const q = url.searchParams;
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (url.pathname === '/rest/v1/profiles') {
        const p = this.profiles.get((q.get('id') ?? '').replace('eq.', ''));
        return j(200, p ? [p] : []);
      }
      if (url.pathname === '/rest/v1/plans') return j(200, this.plans);
      if (url.pathname === '/rest/v1/models') return j(200, this.models);
      if (url.pathname === '/rest/v1/usage_daily') {
        const user = (q.get('user_id') ?? '').replace('eq.', '');
        const from = (q.get('day') ?? '').replace(/^(eq|gte)\./, '');
        const rows = [...this.usage.entries()].filter(([k]) => k.startsWith(`${user}|`) && k.slice(user.length + 1) >= from).map(([k, v]) => ({ ...v, day: k.slice(user.length + 1) }));
        return j(200, rows);
      }
      if (url.pathname === '/rest/v1/rpc/reserve_ai') {
        const r = this.reserveAi(body);
        return j(200, r.ok ? r.id : r.why);
      }
      if (url.pathname === '/rest/v1/rpc/settle_ai') return j(200, this.settleAi(body));
      return j(404, {});
    }
    if (url.host === 'or.test') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.upstream.push({ auth: headers.get('authorization'), body });
      if (this.upstreamDelayMs) await new Promise((r) => setTimeout(r, this.upstreamDelayMs));
      if (this.upstreamStatus !== 200) return j(this.upstreamStatus, { error: { message: 'Upstream says no' } });
      if (url.pathname === '/api/v1/images') return j(200, { data: [{ b64_json: 'UElD', media_type: 'image/png' }], usage: { cost: 0.01 } });
      if (body.plugins) {
        const cite = (u: string, t: string) => ({ type: 'url_citation', url_citation: { url: u, title: t, content: `About ${t}\n  text` } });
        return j(200, { choices: [{ message: { content: 'x', annotations: [cite('https://a.test/1', 'A'), cite('https://a.test/1', 'A again'), cite('javascript:alert(1)', 'bad'), cite('https://b.test/2', 'B')] } }], usage: { cost: 0.006 } });
      }
      if (Array.isArray(body.modalities)) {
        // One second of sound (24 kHz, 16-bit) in two pieces.
        const half = btoa(String.fromCharCode(...new Uint8Array(24000)));
        const sse = [`data: {"choices":[{"delta":{"audio":{"data":"${half}","transcript":"Hi"}}}]}`, `data: {"choices":[{"delta":{"audio":{"data":"${half}"}}}]}`, 'data: {"choices":[],"usage":{"cost":0.001}}', 'data: [DONE]', ''].join('\n\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (JSON.stringify(body.messages).includes('input_audio')) return j(200, { choices: [{ message: { content: ' Open Notepad please. ' } }], usage: { cost: 0.0001 } });
      if (body.stream) {
        const lines = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}'];
        if (!this.streamWithoutUsage) lines.push('data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"cost":0.0004}}', 'data: [DONE]');
        return new Response([...lines, ''].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (this.answerWithoutUsage) return j(200, { id: 'x', model: body.model, choices: [{ message: { role: 'assistant', content: 'Hello' } }] });
      return j(200, { id: 'x', model: body.model, choices: [{ message: { role: 'assistant', content: 'Hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0003 } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  async call(path: string, o: { token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
    const req = new Request(`https://keo-cloud.example.workers.dev${path}`, {
      method: o.method ?? (o.body ? 'POST' : 'GET'),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json', ...(o.headers ?? {}) },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    return handle(req, env, { fetch: this.fetch, waitUntil: (p) => void this.pending.push(p), now: () => this.clock });
  }
  chat(model = 'keo-fast', extra: Record<string, unknown> = {}, token = 'tok-ana') {
    return this.call('/v1/chat/completions', { token, body: { model, messages: [{ role: 'user', content: 'hi' }], ...extra } });
  }
  async settle() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
  setPlan(plan: string, periodStart: string | null = '2026-10-20T09:00:00Z', until = '2026-11-23T09:00:00Z') {
    this.profiles.set('u-ana', { plan, plan_until: plan === 'free' ? null : until, blocked: false, period_start: plan === 'free' ? null : periodStart });
    clearCache();
  }
}

const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; window?: string; resetsAt?: string } }).error;

let w: World;
beforeEach(() => {
  clearCache();
  w = new World();
});

describe('Keo Cloud gateway', () => {
  it('refuses requests without a valid Keo sign-in', async () => {
    expect((await w.call('/v1/models')).status).toBe(401);
    const r = await w.call('/v1/models', { token: 'tok-unknown' });
    expect(r.status).toBe(401);
    expect((await err(r)).code).toBe('sign_in_expired');
  });

  it('lists only the models in the user’s plan', async () => {
    const r = await w.call('/v1/models', { token: 'tok-ana' });
    const ids = ((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).toEqual(['keo-fast']);
    w.setPlan('pro');
    const pro = ((await (await w.call('/v1/models', { token: 'tok-ana' })).json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(pro).toEqual(['keo-fast', 'keo-strong']);
  });

  it('forwards a chat to OpenRouter with Keo’s key and the real model, and counts the real cost', async () => {
    const r = await w.chat('keo-fast', { max_tokens: 99999 });
    expect(r.status).toBe(200);
    const data = (await r.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(data.model).toBe('keo-fast');
    expect(data.choices[0]!.message.content).toBe('Hello');
    expect(w.upstream[0]!.auth).toBe('Bearer or-secret');
    expect(w.upstream[0]!.body.model).toBe('openai/gpt-4o-mini');
    expect(w.upstream[0]!.body.max_tokens).toBe(4096); // capped to the model's limit
    expect(String(w.upstream[0]!.body.user)).not.toContain('u-ana'); // only a hash goes upstream
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.0003 });
    // The hold is gone: only the real cost stays.
    expect(w.holds.size).toBe(0);
  });

  it('streams replies through unchanged and reads the usage from the last chunk', async () => {
    const r = await w.chat('keo-fast', { stream: true });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const text = await r.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('[DONE]');
    expect(w.upstream[0]!.body.stream_options).toEqual({ include_usage: true });
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 1, input_tokens: 120, output_tokens: 30, cost_usd: 0.0004 });
    expect(w.holds.size).toBe(0);
  });

  it('refuses a model above the plan', async () => {
    const r = await w.chat('keo-strong');
    expect(r.status).toBe(403);
    expect((await err(r)).message).toMatch(/not in the Free plan/);
    expect(w.upstream).toHaveLength(0);
  });

  it('treats an expired paid plan as Free, and blocks blocked accounts', async () => {
    w.profiles.set('u-ana', { plan: 'pro', plan_until: '2026-10-01T00:00:00Z', blocked: false });
    const r = await w.call('/v1/me', { token: 'tok-ana' });
    expect(((await r.json()) as { plan: { id: string } }).plan.id).toBe('free');
    clearCache();
    w.profiles.set('u-ana', { plan: 'free', plan_until: null, blocked: true });
    expect((await w.call('/v1/me', { token: 'tok-ana' })).status).toBe(403);
  });

  it('passes OpenRouter’s error message on, counts the attempt, and charges nothing for it', async () => {
    w.upstreamStatus = 422;
    const r = await w.chat();
    expect(r.status).toBe(422);
    expect((await err(r)).message).toBe('Upstream says no');
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 1, cost_usd: 0 });
    expect(w.holds.size).toBe(0);
  });

  it('searches the web through OpenRouter, within the plan’s daily searches', async () => {
    const r = await w.call('/v1/search', { token: 'tok-ana', body: { query: 'best budget microphone', count: 5 } });
    expect(r.status).toBe(200);
    const { results } = (await r.json()) as { results: Array<{ title: string; url: string; description: string }> };
    // Duplicates and non-web links are dropped; snippets are tidied.
    expect(results).toEqual([
      { title: 'A', url: 'https://a.test/1', description: 'About A text', age: null },
      { title: 'B', url: 'https://b.test/2', description: 'About B text', age: null },
    ]);
    expect(w.upstream[0]!.body.plugins).toEqual([{ id: 'web', engine: 'exa', max_results: 5 }]);
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ web_searches: 1, requests: 0, cost_usd: 0.006 });
    w.usage.set(`u-ana|${DAY}`, { web_searches: 2 });
    const r2 = await w.call('/v1/search', { token: 'tok-ana', body: { query: 'again' } });
    expect(r2.status).toBe(429);
    expect((await err(r2)).code).toBe('feature_limit');
  });

  it('makes and changes pictures only in plans that include them', async () => {
    const free = await w.call('/v1/images', { token: 'tok-ana', body: { prompt: 'a red bicycle' } });
    expect(free.status).toBe(403);
    expect((await err(free)).message).toMatch(/not in the Free plan/);
    expect(w.upstream).toHaveLength(0);
    w.setPlan('pro');
    const r = await w.call('/v1/images', { token: 'tok-ana', body: { prompt: 'make the sky purple', size: '1536x1024', quality: 'high', background: 'auto', image: { data: 'QUJD', type: 'image/jpeg' } } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ b64: 'UElD', mediaType: 'image/png' });
    const sent = w.upstream[0]!.body;
    expect(sent).toMatchObject({ model: 'openai/gpt-image-1-mini', aspect_ratio: '3:2', quality: 'high', input_references: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] });
    expect(sent.background).toBeUndefined();
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ images: 1, cost_usd: 0.01 });
  });

  it('speaks text in the chosen voice as a WAV file, and counts the seconds', async () => {
    const r = await w.call('/v1/speech', { token: 'tok-ana', body: { text: 'Hello there', voice: 'male' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(bytes.length).toBe(44 + 48000);
    expect(w.upstream[0]!.body).toMatchObject({ model: 'openai/gpt-audio-mini', modalities: ['text', 'audio'], audio: { voice: 'echo', format: 'pcm16' }, stream: true });
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ voice_seconds: 1, cost_usd: 0.001 });
    // The Free plan's one voice minute is used up.
    w.usage.set(`u-ana|${DAY}`, { voice_seconds: 60 });
    expect((await w.call('/v1/speech', { token: 'tok-ana', body: { text: 'More' } })).status).toBe(429);
  });

  it('a problem with Keo’s own AI account is never shown to the user as their credits, and costs them nothing', async () => {
    const said = 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.';
    const base = w.fetch;
    const limits: unknown[] = [];
    w.fetch = async (input, init = {}) => {
      if (new URL(input).host !== 'or.test') return base(input, init);
      limits.push((JSON.parse(String(init.body)) as { max_tokens?: number }).max_tokens);
      return new Response(JSON.stringify({ error: { message: said, code: 402 } }), { status: 402 });
    };
    w.models[0]!.max_output_tokens = 16000;
    const r = await w.chat();
    expect(r.status).toBe(503);
    const e = await err(r);
    expect(e.code).toBe('service_unavailable');
    expect(e.message).not.toContain('your available credits');
    expect(e.message).toContain('Nothing was taken');
    // It tried once more with a shorter answer limit before giving up.
    expect(limits).toEqual([16000, 4096]);
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 0, cost_usd: 0 });
    expect(w.holds.size).toBe(0);
    const { keoSideProblem } = await import('../src/gateway');
    expect(keoSideProblem(400, 'The prompt is too long for this model.')).toBe(false);
    expect(keoSideProblem(429, 'Rate limit exceeded: free-models-per-min.')).toBe(false);
    expect(keoSideProblem(402, 'Insufficient credits')).toBe(true);
  });

  it('marks the instructions for caching on Claude models only', async () => {
    const { withPromptCache } = await import('../src/gateway');
    const body = { messages: [{ role: 'system', content: 'Long Keo instructions' }, { role: 'user', content: 'hi' }] };
    const claude = withPromptCache('anthropic/claude-sonnet-5.5', body) as { messages: Array<{ content: unknown }> };
    expect(claude.messages[0]!.content).toEqual([{ type: 'text', text: 'Long Keo instructions', cache_control: { type: 'ephemeral' } }]);
    expect(claude.messages[1]!.content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
    const long = withPromptCache('anthropic/claude-sonnet-5.5', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'second' }, { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', content: 'result' }] }) as { messages: Array<{ content: unknown }> };
    expect(long.messages[1]!.content).toBe('first');
    expect(long.messages[3]!.content).toEqual([{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
    expect(long.messages[5]!.content).toBe('result');
    expect(withPromptCache('openai/gpt-6-luna', body)).toBe(body);
  });

  it('serves the page the account emails open, without needing a sign-in', async () => {
    const r = await w.call('/account');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('content-security-policy')).toContain('connect-src https://db.test');
    const html = await r.text();
    expect(html).toContain('Your email is confirmed');
    expect(html).toContain('Choose a new password');
    expect(html).not.toContain('service-secret');
    expect(html).not.toContain('or-secret');
  });

  it('turns a recording into text', async () => {
    const { wav } = await import('../src/gateway');
    const rec = wav(new Uint8Array(32000 * 2), 16000); // 2 s at 16 kHz
    const b64 = btoa(String.fromCharCode(...rec));
    const r = await w.call('/v1/transcribe', { token: 'tok-ana', body: { audio: b64, format: 'wav', language: 'en' } });
    expect(await r.json()).toEqual({ text: 'Open Notepad please.' });
    const content = (w.upstream[0]!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(content[1]).toEqual({ type: 'input_audio', input_audio: { data: b64, format: 'wav' } });
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ voice_seconds: 2, cost_usd: 0.0001 });
  });

  it('listens for the meaning across accents, with the app’s context words', async () => {
    const { wav } = await import('../src/gateway');
    const b64 = btoa(String.fromCharCode(...wav(new Uint8Array(16000 * 2), 16000)));
    await w.call('/v1/transcribe', { token: 'tok-ana', body: { audio: b64, format: 'wav', language: 'en', hint: 'Recent conversation: send it to Tunde <script>' } });
    const text = (w.upstream.at(-1)!.body.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content[0]!.text!;
    expect(text).toMatch(/Nigerian/);
    expect(text).toMatch(/Tunde/);
    expect(text).not.toMatch(/<script>/);
  });
});

describe('The AI allowance: billing months, day / week / month windows', () => {
  const pro = { id: 'pro', name: 'Pro', daily_requests: 600, daily_tokens: 8e6, max_tier: 2, features: {}, monthly_cost_usd: 12 } as Plan;

  it('a paid month starts on the day it was paid, not the 1st', () => {
    const w1 = windowsFor(Date.parse('2026-12-01T10:00:00Z'), pro, { plan_until: '2026-12-31T09:00:00Z', period_start: '2026-11-28T09:00:00Z' });
    // Paid on 28 November: 1 December is still in the same month (no second allowance on the 1st).
    expect(w1.monthFrom).toBe('2026-11-28');
    expect(w1.resets.month).toBe('2026-12-28T09:00:00.000Z');
    expect(w1.periodKey).toBe('p2026-11-28T09:00:00');
    // The week started on Monday 30 November; the day at midnight UTC.
    expect(w1.weekFrom).toBe('2026-11-30');
    expect(w1.resets.week).toBe('2026-12-07T00:00:00.000Z');
    expect(w1.resets.day).toBe('2026-12-02T00:00:00.000Z');
  });

  it('the grace days before a renewal give no new allowance; the next payment does', () => {
    const late = windowsFor(Date.parse('2026-12-29T10:00:00Z'), pro, { plan_until: '2026-12-31T09:00:00Z', period_start: '2026-11-28T09:00:00Z' });
    expect(late.monthFrom).toBe('2026-11-28');
    expect(late.resets.month).toBe('2026-12-31T09:00:00.000Z');
    const renewed = windowsFor(Date.parse('2026-12-29T10:00:00Z'), pro, { plan_until: '2027-01-31T09:00:00Z', period_start: '2026-12-28T09:30:00Z' });
    expect(renewed.monthFrom).toBe('2026-12-28');
  });

  it('a week that began before the billing month counts only from the month’s start', () => {
    const w2 = windowsFor(Date.parse('2026-11-28T15:00:00Z'), pro, { plan_until: '2026-12-31T09:00:00Z', period_start: '2026-11-28T09:00:00Z' });
    expect(w2.weekFrom).toBe('2026-11-28');
  });

  it('accounts paid before this update get their month from their plan’s end date', () => {
    const old = windowsFor(Date.parse('2026-11-10T10:00:00Z'), pro, { plan_until: '2026-12-08T00:00:00Z', period_start: null });
    expect(old.monthFrom).toBe('2026-11-05');
  });

  it('Free uses the calendar month', () => {
    const f = windowsFor(NOW, { ...pro, id: 'free' }, null);
    expect(f.monthFrom).toBe('2026-10-01');
    expect(f.resets.month).toBe('2026-11-01T00:00:00.000Z');
    expect(f.periodKey).toBe('2026-10');
  });

  it('month ends are handled: paid on 31 January renews on the last day of February', () => {
    expect(new Date(addMonths(Date.parse('2027-01-31T08:00:00Z'), 1)).toISOString()).toBe('2027-02-28T08:00:00.000Z');
  });

  it('the day and week are shares of the month (15% and 40% unless the plan says otherwise)', () => {
    expect(capsFor(pro)).toEqual({ month: 12, week: 4.8, day: 1.8 });
    expect(capsFor({ ...pro, day_share: 0.2, week_share: 0.5 })).toEqual({ month: 12, week: 6, day: 2.4 });
    // A database not yet updated: 30 times the old daily figure.
    expect(capsFor({ ...pro, monthly_cost_usd: null, daily_cost_usd: 0.35 }).month).toBeCloseTo(10.5);
  });

  it('a used-up day pauses with when it resets; the next day carries on', async () => {
    w.setPlan('pro');
    w.usage.set(`u-ana|${DAY}`, { cost_usd: 1.799 });
    const r = await w.chat();
    expect(r.status).toBe(429);
    const e = await err(r);
    expect(e).toMatchObject({ code: 'allowance_paused', window: 'day', resetsAt: '2026-10-27T00:00:00.000Z' });
    expect(e.message).toContain('today’s share of your Pro AI allowance');
    expect(e.message).toContain('kept your work');
    expect(w.upstream).toHaveLength(0);
    // Tomorrow (same week and month): fine again.
    w.clock = Date.parse('2026-10-27T08:00:00Z');
    clearCache();
    expect((await w.chat()).status).toBe(200);
  });

  it('a used-up week pauses until Monday, even on a fresh day', async () => {
    w.setPlan('pro');
    w.clock = Date.parse('2026-10-29T08:00:00Z'); // Thursday
    w.usage.set('u-ana|2026-10-26', { cost_usd: 1.7 });
    w.usage.set('u-ana|2026-10-27', { cost_usd: 1.7 });
    w.usage.set('u-ana|2026-10-28', { cost_usd: 1.4 });
    const r = await w.chat();
    expect(await err(r)).toMatchObject({ code: 'allowance_paused', window: 'week', resetsAt: '2026-11-02T00:00:00.000Z' });
  });

  it('no reset goes past the monthly ceiling: a new day or week does not bring back a used-up month', async () => {
    w.setPlan('pro');
    // 11.999 of the 12 used in earlier weeks of this billing month.
    w.usage.set('u-ana|2026-10-20', { cost_usd: 4.5 });
    w.usage.set('u-ana|2026-10-21', { cost_usd: 4.5 });
    w.usage.set('u-ana|2026-10-22', { cost_usd: 2.999 });
    // A Monday: a fresh day and a fresh week, but the month is spent.
    const r = await w.chat();
    const e = await err(r);
    expect(e).toMatchObject({ code: 'allowance_paused', window: 'month', resetsAt: '2026-11-20T09:00:00.000Z' });
    expect(e.message).toContain('this month’s Pro AI allowance');
    expect(e.message).toContain('20 November');
    // Usage from before the billing month started does not count.
    w.setPlan('pro', '2026-10-23T09:00:00Z');
    expect((await w.chat()).status).toBe(200);
  });

  it('upgrading starts a new billing month with the new plan’s allowance; a downgrade is a new month at the lower one', async () => {
    w.setPlan('pro', '2026-10-01T09:00:00Z');
    w.usage.set('u-ana|2026-10-05', { cost_usd: 12 });
    expect(await err(await w.chat('keo-strong'))).toMatchObject({ window: 'month' });
    // Paid for Max today: a fresh month of $28, and Best is allowed.
    w.setPlan('max', '2026-10-26T10:00:00Z', '2026-11-29T10:00:00Z');
    w.clock = Date.parse('2026-10-26T12:00:00Z');
    expect((await w.chat('keo-best')).status).toBe(200);
    // Back to Pro on its next payment: a new Pro month; Best is no longer allowed.
    w.setPlan('pro', '2026-11-26T10:00:00Z', '2026-12-29T10:00:00Z');
    w.clock = Date.parse('2026-11-26T12:00:00Z');
    expect((await w.chat('keo-best')).status).toBe(403);
    expect((await w.chat('keo-strong')).status).toBe(200);
  });

  it('runaway loops are still stopped by the day’s step count', async () => {
    w.usage.set(`u-ana|${DAY}`, { requests: 30, cost_usd: 0 });
    expect(await err(await w.chat())).toMatchObject({ code: 'allowance_paused', window: 'day' });
  });

  it('pictures, voice and searches come out of the same allowance', async () => {
    w.setPlan('pro');
    w.usage.set(`u-ana|${DAY}`, { cost_usd: 1.79 });
    // A picture holds $0.08: more than is left today.
    const r = await w.call('/v1/images', { token: 'tok-ana', body: { prompt: 'a red bicycle' } });
    expect(await err(r)).toMatchObject({ code: 'allowance_paused', window: 'day' });
    expect(w.upstream).toHaveLength(0);
  });
});

describe('Reservations: holding before, settling after', () => {
  it('calls running at the same time cannot overspend: each holds its most, the ones that do not fit are paused', async () => {
    w.setPlan('pro');
    // $1.80 a day; each Strong call with an 8,192-token answer holds about $0.082.
    w.usage.set(`u-ana|${DAY}`, { cost_usd: 1.6 });
    w.upstreamDelayMs = 30;
    const answers = await Promise.all(Array.from({ length: 5 }, () => w.chat('keo-strong')));
    const ok = answers.filter((r) => r.status === 200).length;
    const paused = answers.filter((r) => r.status === 429).length;
    expect(ok).toBe(2);
    expect(paused).toBe(3);
    // While they ran, the money held never passed what was left of the day.
    expect(w.upstream).toHaveLength(2);
    await w.settle();
    expect(w.holds.size).toBe(0);
    // Afterwards only their real cost is counted.
    expect(w.usage.get(`u-ana|${DAY}`)!.cost_usd).toBeCloseTo(1.6006, 6);
  });

  it('what is held is the input (as a cache write) plus the longest answer allowed', () => {
    const strong = w.models[1]!;
    const h = chatHold(strong as never, { messages: [{ role: 'user', content: 'x'.repeat(4000) }] }, 8192);
    expect(h.inputTokens).toBeGreaterThanOrEqual(1000);
    expect(h.usd).toBeCloseTo((h.inputTokens * 2 * 1.25 + 8192 * 10) / 1e6, 9);
    // A picture's data counts as about 1,600 tokens, not as its size in characters.
    const pic = chatHold(strong as never, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(400000)}` } }] }] }, 0);
    expect(pic.inputTokens).toBeLessThan(2000);
  });

  it('a stream cut off before its usage arrives is charged from what was sent — never as nothing', async () => {
    w.streamWithoutUsage = true;
    const r = await w.chat('keo-fast', { stream: true });
    await r.text();
    await w.settle();
    const row = w.usage.get(`u-ana|${DAY}`)!;
    expect(row.requests).toBe(1);
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(row.cost_usd).toBeCloseTo(cutOffCost(w.models[0] as never, row.input_tokens!, 5), 6);
    expect(w.holds.size).toBe(0);
  });

  it('when the app stops reading a stream (Stop pressed), the call is still settled', async () => {
    w.streamWithoutUsage = true;
    const r = await w.chat('keo-fast', { stream: true });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel('stopped');
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)!.cost_usd).toBeGreaterThan(0);
    expect(w.holds.size).toBe(0);
  });

  it('an answer without usage is charged what was held', async () => {
    w.answerWithoutUsage = true;
    await w.chat();
    await w.settle();
    const held = chatHold(w.models[0] as never, { messages: [{ role: 'user', content: 'hi' }] }, 4096).usd;
    expect(w.usage.get(`u-ana|${DAY}`)!.cost_usd).toBeCloseTo(held, 6);
  });

  it('a hold the gateway never settled counts in full after 20 minutes; a late settlement adds only what was above it', async () => {
    w.setPlan('pro');
    w.holds.set('lost', { user: 'u-ana', amount: 0.5, kind: 'chat', status: 'open', created: NOW - 30 * 60_000 });
    await w.chat();
    await w.settle();
    expect(w.holds.get('lost')!.status).toBe('expired');
    expect(w.usage.get(`u-ana|${DAY}`)!.cost_usd).toBeCloseTo(0.5003, 6);
    // Its call does come back after all, having cost 0.6: only the 0.1 above the hold is added.
    w.settleAi({ p_hold: 'lost', p_user: 'u-ana', p_day: DAY, p_cost: 0.6, p_requests: 1 });
    expect(w.usage.get(`u-ana|${DAY}`)!.cost_usd).toBeCloseTo(0.6003, 6);
  });
});

describe('Never a silent switch, never Studio credits for chat', () => {
  it('a used-up allowance is a pause, never a quiet move to a cheaper model', async () => {
    w.setPlan('pro');
    w.usage.set('u-ana|2026-10-21', { cost_usd: 12 });
    const r = await w.chat('keo-strong');
    expect(r.status).toBe(429);
    expect(r.headers.get('x-keo-stepped-down')).toBeNull();
    expect(w.upstream).toHaveLength(0);
  });

  it('Studio credits never pay for chat, even when the app asks', async () => {
    w.setPlan('pro');
    w.usage.set('u-ana|2026-10-21', { cost_usd: 12 });
    let touched = false;
    const base = w.fetch;
    w.fetch = async (input, init = {}) => {
      if (/studio_credits|spend_credits/.test(input)) touched = true;
      return base(input, init);
    };
    const r = await w.call('/v1/chat/completions', { token: 'tok-ana', headers: { 'x-keo-credits': 'allow' }, body: { model: 'keo-fast', messages: [] } });
    expect(r.status).toBe(429);
    expect((await err(r)).code).toBe('allowance_paused');
    expect(touched).toBe(false);
  });
});

describe('Keo’s safety breaker', () => {
  it('stops AI calls when Keo’s spend for the day reaches its limit, charges the user nothing, and raises an alert', async () => {
    w.addSpend(DAY, 'openrouter', 59.999);
    const r = await w.chat();
    expect(r.status).toBe(503);
    expect((await err(r)).code).toBe('keo_paused');
    expect(w.upstream).toHaveLength(0);
    expect(w.alerts.map((a) => a.kind)).toContain('breaker_openrouter');
    expect(w.holds.size).toBe(0);
  });

  it('warns once when spend passes 80% of the limit', async () => {
    w.addSpend(DAY, 'openrouter', 49);
    await w.chat();
    await w.chat();
    expect(w.alerts.filter((a) => a.kind === 'near_openrouter')).toHaveLength(1);
  });
});

describe('What the app is told', () => {
  it('the three windows as percentages with their resets, and about how many builds are left — never money', async () => {
    w.setPlan('pro');
    w.usage.set(`u-ana|${DAY}`, { cost_usd: 0.9, requests: 3 });
    w.usage.set('u-ana|2026-10-21', { cost_usd: 2.1 });
    const me = (await (await w.call('/v1/me', { token: 'tok-ana' })).json()) as { plan: Record<string, unknown>; usage: Record<string, unknown> & { windows: Array<{ window: string; used: number; resetsAt: string }>; buildsLeft: Record<string, { now: number; month: number }> } };
    expect(me.usage.windows).toEqual([
      { window: 'day', used: 50, resetsAt: '2026-10-27T00:00:00.000Z' },
      { window: 'week', used: 19, resetsAt: '2026-11-02T00:00:00.000Z' },
      { window: 'month', used: 25, resetsAt: '2026-11-20T09:00:00.000Z' },
    ]);
    expect(me.usage.allowanceUsed).toBe(50);
    expect(me.usage.monthUsed).toBe(25);
    // $9 of the month left (about 19 Strong builds); today only $0.90 (1 build).
    expect(me.usage.buildsLeft['keo-strong']).toEqual({ now: 1, month: 19 });
    expect(Object.keys(me.usage.buildsLeft)).toEqual(['keo-fast', 'keo-strong']);
    const text = JSON.stringify(me);
    expect(text).not.toMatch(/cost_usd|monthly_cost|daily_cost|week_share|day_share/);
  });
});

describe('The deep health check', () => {
  it('is for the owner only; the plain one stays open', async () => {
    expect(await (await w.call('/health')).json()).toEqual({ ok: true, service: 'keo-cloud' });
    expect((await w.call('/health?deep=1')).status).toBe(401);
    expect((await w.call('/health?deep=1', { token: 'tok-ana' })).status).toBe(403);
    const base = w.fetch;
    w.fetch = async (input, init = {}) => (new URL(input).pathname === '/api/v1/key' ? new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 60, usage: 40 } })) : base(input, init));
    const r = await w.call('/health?deep=1', { token: 'tok-owner' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ openrouter: { ok: true, limit: 100 } });
  });
});
