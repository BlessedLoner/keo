import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, handle, type Env } from '../src/gateway';
import { mp4Video } from '../src/studio';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or-secret', FAL_KEY: 'fal-secret' };
const NOW = Date.parse('2026-11-03T12:00:00Z');
// Creator paid on 1 November: its billing month (and monthly credits) run from then.
const MONTH = 'p2026-11-01T00:00:00';

/** Supabase (with the credit functions) and fal.ai in memory. */
class World {
  profiles = new Map<string, { plan: string; plan_until: string | null; blocked: boolean; period_start?: string | null }>([['u-ana', { plan: 'creator', plan_until: '2026-12-04T00:00:00Z', blocked: false, period_start: '2026-11-01T00:00:00Z' }]]);
  /** Keo's fal.ai spend per day (the safety breaker), and its daily limit. */
  spend = new Map<string, number>();
  falBreaker = 60;
  alerts: string[] = [];
  plans = [
    { id: 'free', name: 'Free', daily_requests: 3, daily_tokens: 1000, max_tier: 1, features: { studio_credits: 0 } },
    { id: 'creator', name: 'Creator', daily_requests: 800, daily_tokens: 6e6, max_tier: 2, features: { studio_credits: 1500 } },
  ];
  credits = new Map<string, { month: string; monthly_used: number; bought: number }>();
  jobs = new Map<string, Record<string, unknown>>();
  fal: Array<{ url: string; auth: string | null; body?: unknown }> = [];
  falResult = 200;
  falStatus = 'COMPLETED';
  uploadRefused = false;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.host === 'db.test') {
      if (url.pathname === '/auth/v1/user') return headers.get('authorization') === 'Bearer tok-ana' ? j(200, { id: 'u-ana', email: 'ana@example.test' }) : j(401, {});
      if (headers.get('authorization') !== 'Bearer service-secret') return j(401, {});
      const q = url.searchParams;
      const eq = (k: string) => (q.get(k) ?? '').replace('eq.', '');
      switch (url.pathname) {
        case '/rest/v1/profiles':
          return j(200, this.profiles.has(eq('id')) ? [this.profiles.get(eq('id'))] : []);
        case '/rest/v1/plans':
          return j(200, this.plans);
        case '/rest/v1/usage_daily':
          return j(200, []);
        case '/rest/v1/credit_packs':
          return j(200, [{ id: 'small', credits: 500, currency: 'USD', amount: 600 }]);
        case '/rest/v1/studio_credits': {
          const r = this.credits.get(eq('user_id'));
          return j(200, r ? [r] : []);
        }
        case '/rest/v1/studio_jobs':
          if (init.method === 'POST') {
            this.jobs.set(String(body.request_id), { ...body, status: 'running' });
            return new Response(null, { status: 201 });
          }
          if (init.method === 'PATCH') {
            const job = this.jobs.get(eq('request_id'));
            if (job) Object.assign(job, body);
            return new Response(null, { status: 204 });
          }
          return j(200, [...this.jobs.values()].filter((x) => x.request_id === eq('request_id') && x.user_id === eq('user_id')));
        case '/rest/v1/rpc/spend_credits': {
          const r = this.credits.get(String(body.p_user)) ?? { month: '', monthly_used: 0, bought: 0 };
          if (r.month !== body.p_month) Object.assign(r, { month: body.p_month, monthly_used: 0 });
          const left = Math.max(0, Number(body.p_allowance) - r.monthly_used);
          const amount = Number(body.p_amount);
          if (left + r.bought < amount) return j(400, { message: 'not_enough_credits' });
          const m = Math.min(left, amount);
          r.monthly_used += m;
          r.bought -= amount - m;
          this.credits.set(String(body.p_user), r);
          return j(200, { from_monthly: m, from_bought: amount - m, left: left - m + r.bought });
        }
        case '/rest/v1/rpc/refund_credits': {
          const job = this.jobs.get(String(body.p_request));
          if (!job || job.status === 'refunded') return j(200, false);
          job.status = 'refunded';
          const r = this.credits.get(String(job.user_id))!;
          if (r.month === job.month) r.monthly_used = Math.max(0, r.monthly_used - Number(job.from_monthly));
          r.bought += Number(job.from_bought);
          return j(200, true);
        }
        case '/rest/v1/rpc/return_credits': {
          const r = this.credits.get(String(body.p_user));
          if (r) {
            if (r.month === body.p_month) r.monthly_used = Math.max(0, r.monthly_used - Number(body.p_from_monthly));
            r.bought += Number(body.p_from_bought);
          }
          return new Response(null, { status: 204 });
        }
        case '/rest/v1/rpc/reserve_spend': {
          const k = `${body.p_day}|${body.p_provider}`;
          const cur = this.spend.get(k) ?? 0;
          const amount = Number(body.p_amount);
          if (amount > 0 && cur + amount > this.falBreaker) {
            this.alerts.push(`breaker_${body.p_provider}`);
            return j(200, 'keo_breaker');
          }
          this.spend.set(k, Math.max(0, Math.round((cur + amount) * 1e6) / 1e6));
          return j(200, String(this.spend.get(k)));
        }
        case '/rest/v1/rpc/add_credits': {
          const r = this.credits.get(String(body.p_user)) ?? { month: '', monthly_used: 0, bought: 0 };
          r.bought += Number(body.p_amount);
          this.credits.set(String(body.p_user), r);
          return new Response(null, { status: 204 });
        }
      }
      return j(404, {});
    }
    if (url.host === 'rest.fal.ai' || url.host === 'queue.fal.run') {
      this.fal.push({ url: input, auth: headers.get('authorization'), ...(init.body ? { body } : {}) });
      if (url.host === 'rest.fal.ai' && this.uploadRefused) return j(403, { detail: 'User is locked. Reason: Exhausted balance.' });
      if (url.host === 'rest.fal.ai') return j(200, { upload_url: 'https://upload.fal.media/x', file_url: 'https://v3.fal.media/files/a.jpg' });
      if (url.pathname.endsWith('/status')) return j(200, { status: this.falStatus });
      if (url.pathname.endsWith('/cancel')) return j(202, { status: 'CANCELLATION_REQUESTED' });
      if (url.pathname.includes('/requests/')) return this.falResult === 200 ? j(200, { video: { url: 'https://v3.fal.media/files/out.mp4' } }) : j(this.falResult, { detail: 'No face found' });
      const id = `req-${this.fal.length}`;
      return j(200, { request_id: id, status_url: `https://queue.fal.run/fal-ai/x/requests/${id}/status`, response_url: `https://queue.fal.run/fal-ai/x/requests/${id}`, cancel_url: `https://queue.fal.run/fal-ai/x/requests/${id}/cancel` });
    }
    // The uploaded video cannot be read here (its length comes from the app).
    return new Response('', { status: 404 });
  };
}

let w: World;
const call = async (method: string, path: string, body?: unknown, token = 'tok-ana') => {
  const r = await handle(new Request(`https://keo.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { fetch: w.fetch, waitUntil: () => undefined, now: () => NOW });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test answers are read loosely
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const kling = { endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', input: { prompt: 'she smiles', start_image_url: 'https://v3.fal.media/files/a.jpg', duration: '5', generate_audio: false } };

beforeEach(() => {
  clearCache();
  w = new World();
});

describe('Studio credits (Keo’s fal.ai key, a fake fal.ai: nothing is paid)', () => {
  it('shows the month’s credits and the packs', async () => {
    const r = await call('GET', '/v1/studio/credits');
    expect(r.body).toMatchObject({ monthlyAllowance: 1500, monthlyLeft: 1500, bought: 0, total: 1500, ready: true, plan: 'creator' });
    expect(r.body.packs).toHaveLength(1);
  });

  it('prices on the server, takes the credits, runs it with Keo’s key, and gives addresses on the gateway', async () => {
    const r = await call('POST', '/v1/studio/run', { ...kling, credits: 1 });
    expect(r.status).toBe(200);
    // 5 s × $0.112 = $0.56 → 112 credits (the app's own number is ignored).
    expect(r.body).toMatchObject({ credits: 112, left: 1388 });
    expect(r.body.status_url).toMatch(/^https:\/\/keo\.test\/v1\/studio\/requests\/req-\d+\/status$/);
    const sent = w.fal.find((x) => x.url === 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video')!;
    expect(sent.auth).toBe('Key fal-secret');
    expect(sent.body).toEqual(kling.input);
    // The key never reaches the app.
    expect(JSON.stringify(r.body)).not.toContain('fal-secret');
  });

  it('refuses unknown models, links that are not fal.ai uploads, and unknown fields', async () => {
    expect((await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/flux-pro', input: {} })).status).toBe(400);
    expect((await call('POST', '/v1/studio/run', { ...kling, input: { ...kling.input, start_image_url: 'https://evil.test/a.jpg' } })).status).toBe(400);
    await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/nano-banana/edit', input: { prompt: 'p', image_urls: ['https://v3.fal.media/files/a.jpg'], num_images: 50 } });
    expect(w.fal.at(-1)!.body).toMatchObject({ num_images: 1 });
  });

  it('a character swap is priced by its frames, 16 to a billed second', async () => {
    const swap = { endpoint: 'fal-ai/wan/v2.2-14b/animate/replace', input: { video_url: 'https://v3.fal.media/files/v.mp4', image_url: 'https://v3.fal.media/files/a.jpg', resolution: '480p' } };
    // 15 s at 16 fps = 15 billed seconds × $0.04 = $0.60 → 120 credits; at 30 fps almost twice.
    expect((await call('POST', '/v1/studio/run', { ...swap, seconds: 15, fps: 16 })).body.credits).toBe(120);
    expect((await call('POST', '/v1/studio/run', { ...swap, seconds: 15, fps: 30 })).body.credits).toBe(225);
    expect((await call('POST', '/v1/studio/run', { ...swap, seconds: 90, fps: 16 })).status).toBe(400);
  });

  it('not enough credits: refused before anything is sent, with what to do', async () => {
    w.profiles.set('u-ana', { plan: 'free', plan_until: null, blocked: false });
    const r = await call('POST', '/v1/studio/run', kling);
    expect(r.status).toBe(402);
    expect(r.body.error.message).toMatch(/needs 112 Studio credits.*Creator plan/);
    expect(w.fal.length).toBe(0);
    // Bought credits pay for it.
    w.credits.set('u-ana', { month: MONTH, monthly_used: 0, bought: 200 });
    expect((await call('POST', '/v1/studio/run', kling)).body.left).toBe(88);
  });

  it('a request fal.ai fails gives the credits back (once); only its owner can see it', async () => {
    const run = await call('POST', '/v1/studio/run', kling);
    const id = String(run.body.request_id);
    expect(w.credits.get('u-ana')!.monthly_used).toBe(112);
    w.falResult = 422;
    const result = await call('GET', `/v1/studio/requests/${id}`);
    expect(result.status).toBe(422);
    expect(result.body.detail).toBe('No face found');
    expect(w.credits.get('u-ana')!.monthly_used).toBe(0);
    await call('GET', `/v1/studio/requests/${id}`);
    expect(w.credits.get('u-ana')!.monthly_used).toBe(0);
    expect((await call('GET', `/v1/studio/requests/${id}`, undefined, 'tok-nobody')).status).toBe(401);
  });

  it('a finished request is passed through; cancelling one still queued gives the credits back', async () => {
    const run = await call('POST', '/v1/studio/run', kling);
    expect((await call('GET', `/v1/studio/requests/${run.body.request_id}/status`)).body.status).toBe('COMPLETED');
    expect((await call('GET', `/v1/studio/requests/${run.body.request_id}`)).body.video.url).toContain('out.mp4');
    const second = await call('POST', '/v1/studio/run', kling);
    w.falStatus = 'IN_QUEUE';
    await call('PUT', `/v1/studio/requests/${second.body.request_id}/cancel`);
    expect(w.credits.get('u-ana')!.monthly_used).toBe(112);
  });

  it('uploads go through Keo’s key, for pictures, videos and voices only', async () => {
    const r = await call('POST', '/v1/studio/upload', { content_type: 'image/jpeg', file_name: 'a.jpg' });
    expect(r.body.file_url).toBe('https://v3.fal.media/files/a.jpg');
    expect(w.fal[0]!.auth).toBe('Key fal-secret');
    expect((await call('POST', '/v1/studio/upload', { content_type: 'application/x-msdownload', file_name: 'a.exe' })).status).toBe(400);
  });

  it('a refused upload says why; a picture may then go inside the request, a video or voice may not', async () => {
    w.uploadRefused = true;
    const r = await call('POST', '/v1/studio/upload', { content_type: 'image/jpeg', file_name: 'a.jpg' });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('403: User is locked. Reason: Exhausted balance.');
    w.uploadRefused = false;
    const inline = 'data:image/jpeg;base64,' + btoa('a picture');
    const ok = await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/nano-banana-pro/edit', input: { prompt: 'p', image_urls: [inline, 'https://v3.fal.media/files/a.jpg'] } });
    expect(ok.status).toBe(200);
    expect((w.fal.at(-1)!.body as { image_urls: string[] }).image_urls[0]).toBe(inline);
    // Not a picture, or not inline-able: refused before anything is paid.
    expect((await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/nano-banana-pro/edit', input: { prompt: 'p', image_urls: ['data:text/html;base64,PGI+'] } })).status).toBe(400);
    expect((await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/wan/v2.2-14b/animate/replace', input: { video_url: 'data:image/jpeg;base64,AAAA', image_url: inline } })).status).toBe(400);
  });

  it('monthly credits follow the billing month: paid on 28 October, 3 November is the same month', async () => {
    w.profiles.set('u-ana', { plan: 'creator', plan_until: '2026-12-01T00:00:00Z', blocked: false, period_start: '2026-10-28T10:00:00Z' });
    clearCache();
    w.credits.set('u-ana', { month: 'p2026-10-28T10:00:00', monthly_used: 1400, bought: 0 });
    const r = await call('GET', '/v1/studio/credits');
    // Not a fresh 1,500 on 1 November: 100 are left of the month paid for.
    expect(r.body).toMatchObject({ monthlyAllowance: 1500, monthlyLeft: 100, total: 100 });
    expect((await call('POST', '/v1/studio/run', kling)).status).toBe(402);
  });

  it('a request fal.ai refuses at once gives back exactly what it took: monthly credits stay monthly', async () => {
    w.credits.set('u-ana', { month: MONTH, monthly_used: 1450, bought: 200 });
    const base = w.fetch;
    w.fetch = async (input, init = {}) => (new URL(input).host === 'queue.fal.run' && init.method === 'POST' ? new Response(JSON.stringify({ detail: 'Invalid image' }), { status: 422 }) : base(input, init));
    const r = await call('POST', '/v1/studio/run', kling);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('Nothing was charged');
    // 50 monthly + 62 bought were taken, and the same came back to each.
    expect(w.credits.get('u-ana')).toMatchObject({ monthly_used: 1450, bought: 200 });
    // fal.ai's spend for the day is back where it was.
    expect([...w.spend.values()]).toEqual([0]);
  });

  it('Keo’s daily fal.ai safety limit stops Studio AI before anything is sent, and costs the user nothing', async () => {
    w.falBreaker = 0.5;
    const r = await call('POST', '/v1/studio/run', kling);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('keo_paused');
    expect(w.fal).toHaveLength(0);
    expect(w.credits.get('u-ana')!.monthly_used).toBe(0);
    expect(w.alerts).toEqual(['breaker_fal']);
  });

  it('what Studio spends at fal.ai is counted, and a refunded job takes it off again', async () => {
    const run = await call('POST', '/v1/studio/run', kling);
    expect([...w.spend.values()]).toEqual([0.56]);
    w.falResult = 422;
    await call('GET', `/v1/studio/requests/${run.body.request_id}`);
    expect([...w.spend.values()]).toEqual([0]);
  });

  it('without Keo’s fal.ai key, Studio AI says it is off', async () => {
    const off = { ...env, FAL_KEY: undefined };
    const r = await handle(new Request('https://keo.test/v1/studio/run', { method: 'POST', headers: { authorization: 'Bearer tok-ana' }, body: JSON.stringify(kling) }), off, { fetch: w.fetch, waitUntil: () => undefined, now: () => NOW });
    expect(r.status).toBe(503);
  });
});

describe('Reading a video’s frames from its MP4 header', () => {
  it('counts the video track’s frames and length', () => {
    const box = (type: string, ...parts: Uint8Array[]) => {
      const size = 8 + parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(size);
      new DataView(out.buffer).setUint32(0, size);
      out.set([...type].map((c) => c.charCodeAt(0)), 4);
      let at = 8;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const u32 = (...n: number[]) => {
      const b = new Uint8Array(n.length * 4);
      n.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x));
      return b;
    };
    const hdlr = box('hdlr', u32(0, 0), new TextEncoder().encode('vide'), u32(0, 0, 0));
    const mdhd = box('mdhd', u32(0, 0, 0, 1000, 15000, 0));
    const stts = box('stts', u32(0, 1, 450, 33));
    const moov = box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stts)))));
    expect(mp4Video(new Uint8Array([...new Uint8Array(20), ...moov]))).toEqual({ seconds: 15, frames: 450 });
    expect(mp4Video(new Uint8Array(100))).toBeNull();
  });
});

describe('New Studio models through Keo Cloud', () => {
  it('a stable clone is priced per second of the video (up to 30 s); realistic frames at 2K', async () => {
    const clone = { endpoint: 'fal-ai/kling-video/v2.6/pro/motion-control', input: { video_url: 'https://v3.fal.media/files/v.mp4', image_url: 'https://v3.fal.media/files/a.jpg' } };
    // 15 s × $0.112 = $1.68 → 336 credits.
    expect((await call('POST', '/v1/studio/run', { ...clone, seconds: 15 })).body.credits).toBe(336);
    expect((await call('POST', '/v1/studio/run', { ...clone, seconds: 40 })).status).toBe(400);
    await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/nano-banana-pro/edit', input: { prompt: 'p', image_urls: ['https://v3.fal.media/files/a.jpg'], resolution: '4K' } });
    expect(w.fal.at(-1)!.body).toMatchObject({ resolution: '2K' });
  });

  it('a 3D model for a game: priced on the server ($0.35 → 70 credits), game-sized whatever the app asks', async () => {
    const r = await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/trellis-2', input: { image_url: 'https://v3.fal.media/files/car.png', decimation_target: 5_000_000, texture_size: 4096, resolution: 1536 } });
    expect(r.body.credits).toBe(70);
    expect(w.fal.at(-1)!.body).toEqual({ image_url: 'https://v3.fal.media/files/car.png', resolution: 1024, texture_size: 2048, decimation_target: 150_000, remesh: true });
    expect((await call('POST', '/v1/studio/run', { endpoint: 'fal-ai/trellis-2', input: { image_url: 'https://evil.example/x.png' } })).status).toBe(400);
  });
});

/** A 16-bit mono WAV header (and a little of its data) for a recording `seconds` long at 16 kHz. */
function wavHead(seconds: number): { bytes: Uint8Array; total: number } {
  const data = Math.round(seconds * 16000) * 2;
  const b = new Uint8Array(44 + 2000);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (b[at + i] = ch.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, data, true);
  return { bytes: b, total: 44 + data };
}

describe('Talking characters through Keo Cloud', () => {
  const avatar = { endpoint: 'fal-ai/kling-video/ai-avatar/v2/pro', input: { image_url: 'https://v3.fal.media/files/a.jpg', audio_url: 'https://v3.fal.media/files/voice.wav', prompt: 'smiling' } };
  /** fal.ai's storage serves the uploaded voice (its first bytes, and its size in the range answer). */
  const serveVoice = (seconds: number) => {
    const plain = w.fetch;
    const { bytes, total } = wavHead(seconds);
    w.fetch = async (input: string, init: RequestInit = {}) =>
      input === 'https://v3.fal.media/files/voice.wav' ? new Response(bytes.slice().buffer, { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${total}` } }) : plain(input, init);
  };

  it('is priced by the uploaded voice’s own length, never less than the app says', async () => {
    serveVoice(20);
    // The app says 5 s; the file is 20 s: 20 × $0.115 = $2.30 → 460 credits.
    const r = await call('POST', '/v1/studio/run', { ...avatar, seconds: 5 });
    expect(r.status).toBe(200);
    expect(r.body.credits).toBe(460);
    expect(w.fal.find((x) => x.url === 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro')!.body).toEqual(avatar.input);
    // Standard: 20 × $0.0562 = $1.124 → 225 credits.
    expect((await call('POST', '/v1/studio/run', { ...avatar, endpoint: 'fal-ai/kling-video/ai-avatar/v2/standard', seconds: 5 })).body.credits).toBe(225);
  });

  it('refuses a voice it cannot read, and one over a minute', async () => {
    // Not served (unreadable): refused before anything is paid.
    const r = await call('POST', '/v1/studio/run', { ...avatar, seconds: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/could not read the voice/);
    serveVoice(75);
    expect((await call('POST', '/v1/studio/run', { ...avatar, seconds: 5 })).status).toBe(400);
    expect(w.fal.some((x) => x.url.includes('ai-avatar'))).toBe(false);
  });
});

describe('AI music and sound effects through Keo Cloud', () => {
  it('music is priced by each started minute; sound effects by the second; limits checked on the server', async () => {
    const music = (ms: number) => call('POST', '/v1/studio/run', { endpoint: 'elevenlabs/music/v2.5', input: { prompt: 'calm lo-fi', music_length_ms: ms, force_instrumental: true } });
    // 45 s → 1 minute × $0.60 → 120 credits; 90 s → 2 minutes → 240.
    expect((await music(45000)).body.credits).toBe(120);
    expect((await music(90000)).body.credits).toBe(240);
    expect((await music(400000)).status).toBe(400);
    expect(w.fal.at(-1)!.body).toMatchObject({ music_length_ms: 90000, force_instrumental: true });
    const sfx = await call('POST', '/v1/studio/run', { endpoint: 'elevenlabs/sound-effects/v3', input: { text: 'door creak', duration_seconds: 4, loop: true } });
    // 4 s × $0.002 = $0.008 → 2 credits.
    expect(sfx.body.credits).toBe(2);
    expect(w.fal.at(-1)!.body).toEqual({ text: 'door creak', duration_seconds: 4, loop: true, prompt_influence: 0.3, output_format: 'mp3_44100_128' });
    expect((await call('POST', '/v1/studio/run', { endpoint: 'elevenlabs/sound-effects/v3', input: { text: 'x', duration_seconds: 45 } })).status).toBe(400);
  });
});

describe('Problem reports through Keo Cloud', () => {
  it('saves what the user sent, at most 10 a day, and only for a signed-in account', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const plain = w.fetch;
    w.fetch = async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.pathname === '/rest/v1/problem_reports') {
        if ((init.method ?? 'GET') === 'POST') {
          const row = { id: `00000000-aaaa-bbbb-cccc-${String(saved.length).padStart(12, '0')}`, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
          saved.push(row);
          return new Response(JSON.stringify([row]), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify(saved.map((r) => ({ id: r.id }))), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return plain(input, init);
    };
    const r = await call('POST', '/v1/report', { message: 'Captions stopped half way.', report: 'Keo problem report\n…', version: '1.18.1' });
    expect(r.status).toBe(200);
    expect(r.body.id).toHaveLength(8);
    expect(saved[0]).toMatchObject({ message: 'Captions stopped half way.', version: '1.18.1' });
    expect(typeof saved[0]!.user_id).toBe('string');
    expect((await call('POST', '/v1/report', { message: '', report: 'x' })).status).toBe(400);
    expect((await call('POST', '/v1/report', { message: 'x', report: 'y'.repeat(200_001) })).status).toBe(413);
    for (let i = 0; i < 9; i++) await call('POST', '/v1/report', { message: `again ${i}`, report: 'x' });
    expect((await call('POST', '/v1/report', { message: 'one too many', report: 'x' })).status).toBe(429);
    expect((await call('POST', '/v1/report', { message: 'x', report: 'x' }, 'bad-token')).status).toBe(401);
  });
});

describe('Trial credits, history and referrals', () => {
  /** The database functions of update 8, in memory, over the World above. */
  const withUpdate8 = () => {
    const trial = new Set<string>();
    const codes = new Map<string, string>([['u-bob', 'BOBCODE2']]);
    const refs: Array<{ user_id: string; referrer_id: string; credits: number; rewarded: boolean }> = [];
    const base = w.fetch;
    w.fetch = async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
      const eq = (k: string) => (url.searchParams.get(k) ?? '').replace('eq.', '');
      if (url.host === 'db.test' && url.pathname === '/rest/v1/studio_credits') {
        const r = w.credits.get(eq('user_id'));
        return j(200, r ? [{ ...r, trial_given: trial.has(eq('user_id')) }] : []);
      }
      if (url.host === 'db.test' && url.pathname === '/rest/v1/rpc/give_trial') {
        const u = String(body.p_user);
        if (trial.has(u)) return j(200, false);
        trial.add(u);
        const r = w.credits.get(u) ?? { month: '', monthly_used: 0, bought: 0 };
        r.bought += Number(body.p_amount);
        w.credits.set(u, r);
        return j(200, true);
      }
      if (url.host === 'db.test' && url.pathname === '/rest/v1/referral_codes') {
        if (init.method === 'POST') {
          codes.set(String(body.user_id), String(body.code));
          return new Response(null, { status: 201 });
        }
        const c = codes.get(eq('user_id'));
        return j(200, c ? [{ code: c }] : []);
      }
      if (url.host === 'db.test' && url.pathname === '/rest/v1/referrals') return j(200, refs.filter((r) => (url.searchParams.has('referrer_id') ? r.referrer_id === eq('referrer_id') : r.user_id === eq('user_id'))));
      if (url.host === 'db.test' && url.pathname === '/rest/v1/rpc/redeem_referral') {
        const ref = [...codes.entries()].find(([, c]) => c === body.p_code)?.[0];
        if (!ref) return j(400, { message: 'no_such_code' });
        if (ref === body.p_user) return j(400, { message: 'own_code' });
        if (refs.some((r) => r.user_id === body.p_user)) return j(400, { message: 'already_referred' });
        refs.push({ user_id: String(body.p_user), referrer_id: ref, credits: Number(body.p_amount), rewarded: true });
        return j(200, { credits: body.p_amount, referrer_rewarded: true });
      }
      return base(input, init);
    };
    return { codes, refs };
  };

  it('a new account gets its trial credits once', async () => {
    withUpdate8();
    const first = await call('GET', '/v1/studio/credits');
    expect(first.body).toMatchObject({ trialGiven: 150, bought: 150, total: 1650 });
    const again = await call('GET', '/v1/studio/credits');
    expect(again.body.trialGiven).toBeUndefined();
    expect(again.body.bought).toBe(150);
  });

  it('shows what the credits went on, in words', async () => {
    await call('POST', '/v1/studio/run', kling);
    // The fake lists jobs by request: the history reads the user's own.
    const base = w.fetch;
    w.fetch = async (input: string, init: RequestInit = {}) => (new URL(input).pathname === '/rest/v1/studio_jobs' && !init.method ? new Response(JSON.stringify([...w.jobs.values()].map((x) => ({ ...x, created_at: '2026-11-03T12:00:00Z' })))) : base(input, init));
    const r = await call('GET', '/v1/studio/history');
    expect(r.body.items[0]).toMatchObject({ what: 'AI shot (Kling)', credits: 112, refunded: false });
  });

  it('gives an invite code, and a friend’s code gives credits once (not your own)', async () => {
    const { refs } = withUpdate8();
    const mine = await call('GET', '/v1/studio/referral');
    expect(mine.body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(mine.body).toMatchObject({ credits: 200, joined: 0, earned: 0, referred: false });
    expect((await call('POST', '/v1/studio/referral/redeem', { code: mine.body.code })).body.error.code).toBe('own_code');
    expect((await call('POST', '/v1/studio/referral/redeem', { code: 'NOPE1234' })).status).toBe(404);
    const ok = await call('POST', '/v1/studio/referral/redeem', { code: 'bobcode2' });
    expect(ok.body).toEqual({ credits: 200 });
    expect(refs).toHaveLength(1);
    expect((await call('POST', '/v1/studio/referral/redeem', { code: 'BOBCODE2' })).status).toBe(409);
  });
});

describe('Creative assets through Keo Cloud (cut-outs, vectors, styled words, elements)', () => {
  const run = (endpoint: string, input: Record<string, unknown>) => call('POST', '/v1/studio/run', { endpoint, input });
  const pic = 'https://v3.fal.media/files/a.png';

  it('prices each one on the server at twice fal.ai’s price, sending only known fields', async () => {
    // Background removal: $0.018 → 4 credits; with "what to keep", $0.03 → 6.
    expect((await run('fal-ai/bria/background/remove', { image_url: pic, sync_mode: true })).body.credits).toBe(4);
    expect(w.fal.at(-1)!.body).toEqual({ image_url: pic });
    expect((await run('fal-ai/bria/background/remove', { image_url: pic, prompt: 'the cup' })).body.credits).toBe(6);
    // Recraft: $0.04 raster → 8; a vector style $0.08 → 16; brand colours become RGB.
    expect((await run('fal-ai/recraft/v3/text-to-image', { prompt: 'a fox', style: 'digital_illustration/hand_drawn' })).body.credits).toBe(8);
    const vec = await run('fal-ai/recraft/v3/text-to-image', { prompt: 'a rocket icon', style: 'vector_illustration/line_art', colors: ['#FF5500', 'nope'], enable_safety_checker: false });
    expect(vec.body.credits).toBe(16);
    expect(w.fal.at(-1)!.body).toEqual({ prompt: 'a rocket icon', style: 'vector_illustration/line_art', image_size: 'square_hd', colors: [{ r: 255, g: 85, b: 0 }] });
    // An unknown style falls back to an illustration (never a free vector).
    expect((await run('fal-ai/recraft/v3/text-to-image', { prompt: 'x', style: 'vector_illustration; drop table' })).body.credits).toBe(8);
    // Vectorize: $0.01 → 2.
    expect((await run('fal-ai/recraft/vectorize', { image_url: pic })).body.credits).toBe(2);
    // Ideogram: TURBO $0.03 → 6, BALANCED $0.06 → 12, QUALITY $0.09 → 18; anything else is BALANCED.
    expect((await run('fal-ai/ideogram/v3', { prompt: 'SALE in neon letters', rendering_speed: 'TURBO' })).body.credits).toBe(6);
    expect((await run('fal-ai/ideogram/v3', { prompt: 'SALE', rendering_speed: 'ULTRA' })).body.credits).toBe(12);
    expect((await run('fal-ai/ideogram/v3/generate-transparent', { prompt: 'a gold star sticker', rendering_speed: 'QUALITY', aspect_ratio: '7:7' })).body.credits).toBe(18);
    expect(w.fal.at(-1)!.body).toEqual({ prompt: 'a gold star sticker', rendering_speed: 'QUALITY', aspect_ratio: '1:1', num_images: 1, enable_prompt_expansion: false });
  });

  it('refuses links that are not fal.ai uploads and empty descriptions, before anything is paid', async () => {
    expect((await run('fal-ai/bria/background/remove', { image_url: 'https://evil.test/a.png' })).status).toBe(400);
    expect((await run('fal-ai/recraft/vectorize', { image_url: 'file:///C:/secret.png' })).status).toBe(400);
    expect((await run('fal-ai/ideogram/v3', { prompt: '   ' })).status).toBe(400);
    expect(w.fal).toHaveLength(0);
    expect(w.credits.get('u-ana')?.monthly_used ?? 0).toBe(0);
  });
});
