import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, handle, today, type Env } from '../src/gateway';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or-secret', OPENROUTER_URL: 'https://or.test/api/v1' };
const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = today(NOW);

/** Supabase and OpenRouter in memory. */
class World {
  users = new Map<string, { id: string; email: string }>([['tok-ana', { id: 'u-ana', email: 'ana@example.test' }]]);
  profiles = new Map<string, { plan: string; plan_until: string | null; blocked: boolean }>([['u-ana', { plan: 'free', plan_until: null, blocked: false }]]);
  plans = [
    { id: 'free', name: 'Free', daily_requests: 3, daily_tokens: 1000, max_tier: 1, features: { web_search: 2, images: 0, voice_minutes: 1 } as Record<string, unknown> },
    { id: 'pro', name: 'Pro', daily_requests: 100, daily_tokens: 100000, max_tier: 2, features: { web_search: 50, images: 5, voice_minutes: 60 } as Record<string, unknown> },
  ];
  models = [
    { id: 'keo-fast', label: 'Keo Fast', upstream: 'openai/gpt-4o-mini', tier: 1, vision: true, tools: true, context_tokens: 128000, max_output_tokens: 4096 },
    { id: 'keo-strong', label: 'Keo Strong', upstream: 'openrouter/auto', tier: 2, vision: true, tools: true, context_tokens: 128000, max_output_tokens: 8192 },
  ];
  usage = new Map<string, Record<string, number>>();
  upstream: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  pending: Promise<unknown>[] = [];
  upstreamStatus = 200;

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
      if (url.pathname === '/rest/v1/profiles') {
        const p = this.profiles.get((q.get('id') ?? '').replace('eq.', ''));
        return j(200, p ? [p] : []);
      }
      if (url.pathname === '/rest/v1/plans') return j(200, this.plans);
      if (url.pathname === '/rest/v1/models') return j(200, this.models);
      if (url.pathname === '/rest/v1/usage_daily') {
        const u = this.usage.get(`${(q.get('user_id') ?? '').replace('eq.', '')}|${(q.get('day') ?? '').replace('eq.', '')}`);
        return j(200, u ? [u] : []);
      }
      if (url.pathname === '/rest/v1/rpc/add_usage') {
        const b = JSON.parse(String(init.body)) as Record<string, number> & { p_user: string; p_day: string };
        const k = `${b.p_user}|${b.p_day}`;
        const cur = this.usage.get(k) ?? {};
        const plus = (f: string, v: number | undefined) => (cur[f] ?? 0) + (v ?? 0);
        this.usage.set(k, {
          requests: plus('requests', b.p_requests),
          input_tokens: plus('input_tokens', b.p_in),
          output_tokens: plus('output_tokens', b.p_out),
          cost: plus('cost', b.p_cost),
          web_searches: plus('web_searches', b.p_searches),
          images: plus('images', b.p_images),
          voice_seconds: plus('voice_seconds', b.p_voice_seconds),
        });
        return new Response(null, { status: 204 });
      }
      return j(404, {});
    }
    if (url.host === 'or.test') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.upstream.push({ auth: headers.get('authorization'), body });
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
        const sse = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"cost":0.0004}}', 'data: [DONE]', ''].join('\n\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return j(200, { id: 'x', model: body.model, choices: [{ message: { role: 'assistant', content: 'Hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0003 } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  async call(path: string, o: { token?: string; body?: unknown; method?: string } = {}) {
    const req = new Request(`https://keo-cloud.example.workers.dev${path}`, {
      method: o.method ?? (o.body ? 'POST' : 'GET'),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), 'content-type': 'application/json' },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    const res = await handle(req, env, { fetch: this.fetch, waitUntil: (p) => void this.pending.push(p), now: () => NOW });
    return res;
  }
  async settle() {
    await Promise.all(this.pending.splice(0));
  }
}

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
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('sign_in_expired');
  });

  it('lists only the models in the user’s plan', async () => {
    const r = await w.call('/v1/models', { token: 'tok-ana' });
    const ids = ((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).toEqual(['keo-fast']);
    w.profiles.set('u-ana', { plan: 'pro', plan_until: '2027-01-01T00:00:00Z', blocked: false });
    clearCache();
    const pro = ((await (await w.call('/v1/models', { token: 'tok-ana' })).json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(pro).toEqual(['keo-fast', 'keo-strong']);
  });

  it('forwards a chat to OpenRouter with Keo’s key and the real model, and counts the usage', async () => {
    const r = await w.call('/v1/chat/completions', { token: 'tok-ana', body: { model: 'keo-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 } });
    expect(r.status).toBe(200);
    const data = (await r.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(data.model).toBe('keo-fast');
    expect(data.choices[0]!.message.content).toBe('Hello');
    expect(w.upstream[0]!.auth).toBe('Bearer or-secret');
    expect(w.upstream[0]!.body.model).toBe('openai/gpt-4o-mini');
    expect(w.upstream[0]!.body.max_tokens).toBe(4096); // capped to the model's limit
    expect(String(w.upstream[0]!.body.user)).not.toContain('u-ana'); // only a hash goes upstream
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 1, input_tokens: 100, output_tokens: 20, cost: 0.0003 });
  });

  it('streams replies through unchanged and reads the usage from the last chunk', async () => {
    const r = await w.call('/v1/chat/completions', { token: 'tok-ana', body: { model: 'keo-fast', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const text = await r.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('[DONE]');
    expect(w.upstream[0]!.body.stream_options).toEqual({ include_usage: true });
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ requests: 1, input_tokens: 120, output_tokens: 30 });
  });

  it('refuses a model above the plan, and the day’s allowance once it is used up', async () => {
    const r = await w.call('/v1/chat/completions', { token: 'tok-ana', body: { model: 'keo-strong', messages: [] } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/not in the Free plan/);
    w.usage.set(`u-ana|${DAY}`, { requests: 3, input_tokens: 10, output_tokens: 10, cost: 0 });
    const r2 = await w.call('/v1/chat/completions', { token: 'tok-ana', body: { model: 'keo-fast', messages: [] } });
    expect(r2.status).toBe(429);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('daily_limit');
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

  it('passes OpenRouter’s error message on, and still counts the attempt', async () => {
    w.upstreamStatus = 402;
    const r = await w.call('/v1/chat/completions', { token: 'tok-ana', body: { model: 'keo-fast', messages: [] } });
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: { message: string } }).error.message).toBe('Upstream says no');
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)?.requests).toBe(1);
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
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ web_searches: 1, requests: 0 });
    w.usage.set(`u-ana|${DAY}`, { web_searches: 2 });
    const r2 = await w.call('/v1/search', { token: 'tok-ana', body: { query: 'again' } });
    expect(r2.status).toBe(429);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('feature_limit');
  });

  it('makes and changes pictures only in plans that include them', async () => {
    const free = await w.call('/v1/images', { token: 'tok-ana', body: { prompt: 'a red bicycle' } });
    expect(free.status).toBe(403);
    expect(((await free.json()) as { error: { message: string } }).error.message).toMatch(/not in the Free plan/);
    expect(w.upstream).toHaveLength(0);
    w.profiles.set('u-ana', { plan: 'pro', plan_until: null, blocked: false });
    clearCache();
    const r = await w.call('/v1/images', { token: 'tok-ana', body: { prompt: 'make the sky purple', size: '1536x1024', quality: 'high', background: 'auto', image: { data: 'QUJD', type: 'image/jpeg' } } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ b64: 'UElD', mediaType: 'image/png' });
    const sent = w.upstream[0]!.body;
    expect(sent).toMatchObject({ model: 'openai/gpt-image-1-mini', aspect_ratio: '3:2', quality: 'high', input_references: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] });
    expect(sent.background).toBeUndefined();
    await w.settle();
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ images: 1, cost: 0.01 });
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
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ voice_seconds: 1 });
    // The Free plan's one voice minute is used up.
    w.usage.set(`u-ana|${DAY}`, { voice_seconds: 60 });
    expect((await w.call('/v1/speech', { token: 'tok-ana', body: { text: 'More' } })).status).toBe(429);
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
    expect(w.usage.get(`u-ana|${DAY}`)).toMatchObject({ voice_seconds: 2 });
  });
});
