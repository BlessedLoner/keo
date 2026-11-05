import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, handle, type Env } from '../src/gateway';
import { mp4Video } from '../src/studio';

const env: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or-secret', FAL_KEY: 'fal-secret' };
const NOW = Date.parse('2026-11-03T12:00:00Z');
const MONTH = '2026-11';

/** Supabase (with the credit functions) and fal.ai in memory. */
class World {
  profiles = new Map<string, { plan: string; plan_until: string | null; blocked: boolean }>([['u-ana', { plan: 'creator', plan_until: '2026-12-01T00:00:00Z', blocked: false }]]);
  plans = [
    { id: 'free', name: 'Free', daily_requests: 3, daily_tokens: 1000, max_tier: 1, features: { studio_credits: 0 } },
    { id: 'creator', name: 'Creator', daily_requests: 800, daily_tokens: 6e6, max_tier: 2, features: { studio_credits: 1500 } },
  ];
  credits = new Map<string, { month: string; monthly_used: number; bought: number }>();
  jobs = new Map<string, Record<string, unknown>>();
  fal: Array<{ url: string; auth: string | null; body?: unknown }> = [];
  falResult = 200;
  falStatus = 'COMPLETED';

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
          r.monthly_used -= Number(job.from_monthly);
          r.bought += Number(job.from_bought);
          return j(200, true);
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
