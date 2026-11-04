/**
 * Keo Studio's AI work through Keo Cloud: AI shots, character swap, same-face pictures and
 * character voices run on Keo's own fal.ai account (the FAL_KEY secret), paid in Studio credits.
 *
 * The price of every request is worked out here from what is asked (never taken from the app),
 * taken before fal.ai starts, and given back if fal.ai fails. The app never sees Keo's fal.ai key:
 * it gets upload links and request addresses on this gateway.
 */

import { fail, json, type Env, type Fetch, type Plan, type Supabase } from './gateway';

/** 1 credit is 1 US cent to the user and covers half a cent of fal.ai's price. */
export const CREDITS_PER_USD = 200;

const FAL_QUEUE = 'https://queue.fal.run/';
const FAL_UPLOAD = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

/** What may be uploaded for a request (pictures, videos, voice samples). */
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg'];

/** A file fal.ai keeps (what an upload gives back): the only links a request may use. */
const falFile = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/([a-z0-9-]+\.)*fal\.media\/[^\s]{1,1500}$/i.test(v);

const credits = (usd: number) => Math.max(1, Math.ceil(usd * CREDITS_PER_USD - 1e-6));

/** A request Keo runs, with the input rebuilt from known fields only, and its price. */
interface Priced {
  input: Record<string, unknown>;
  credits: number;
}
type Pricer = (input: Record<string, unknown>, o: { seconds?: number; fps?: number; videoSeconds?: number; videoFrames?: number }) => Priced | string;

const ENDPOINTS: Record<string, Pricer> = {
  // AI shots: a picture brought to life.
  'fal-ai/kling-video/v3/pro/image-to-video': (i) => {
    const seconds = Number(i.duration);
    if (!Number.isInteger(seconds) || seconds < 3 || seconds > 10) return 'The clip length must be 3 to 10 seconds.';
    if (!falFile(i.start_image_url)) return 'Upload the picture first.';
    const audio = i.generate_audio === true;
    return { input: { prompt: String(i.prompt ?? '').slice(0, 2500), start_image_url: i.start_image_url, duration: String(seconds), generate_audio: audio }, credits: credits(seconds * (audio ? 0.168 : 0.112)) };
  },
  'fal-ai/veo3.1/fast/image-to-video': (i) => {
    const seconds = { '4s': 4, '6s': 6, '8s': 8 }[String(i.duration)];
    if (!seconds) return 'The clip length must be 4, 6 or 8 seconds.';
    if (!falFile(i.image_url)) return 'Upload the picture first.';
    const audio = i.generate_audio === true;
    const aspect = ['9:16', '16:9', 'auto'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : 'auto';
    return { input: { prompt: String(i.prompt ?? '').slice(0, 2500), image_url: i.image_url, duration: `${seconds}s`, aspect_ratio: aspect, resolution: '720p', generate_audio: audio }, credits: credits(seconds * (audio ? 0.15 : 0.1)) };
  },
  // Character swap: fal.ai bills every 16 frames of the video. The frames are counted from the
  // uploaded file itself when Keo can read it; else from what the app says (never less).
  'fal-ai/wan/v2.2-14b/animate/replace': (i, o) => {
    const rate = { '480p': 0.04, '580p': 0.06, '720p': 0.08 }[String(i.resolution)];
    if (!rate) return 'Choose 480p, 580p or 720p.';
    if (!falFile(i.video_url) || !falFile(i.image_url)) return 'Upload the video and the picture first.';
    const seconds = Math.max(0, Number(o.seconds) || 0, o.videoSeconds ?? 0);
    const frames = Math.max(seconds * Math.max(16, Number(o.fps) || 30), o.videoFrames ?? 0);
    if (frames <= 0) return 'Say how long the video is.';
    if (seconds > 61) return 'Character swap takes up to 60 seconds of video at a time.';
    return { input: { video_url: i.video_url, image_url: i.image_url, resolution: i.resolution, video_quality: 'high' }, credits: credits((frames / 16) * rate) };
  },
  // A new picture of a character with the same face.
  'fal-ai/nano-banana/edit': (i) => {
    const urls = Array.isArray(i.image_urls) ? i.image_urls.filter(falFile).slice(0, 4) : [];
    if (!urls.length) return 'Upload the picture first.';
    const aspect = ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '5:4', '2:3', '3:2', '21:9'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : '4:5';
    return { input: { prompt: String(i.prompt ?? '').slice(0, 2500), image_urls: urls, num_images: 1, output_format: 'png', aspect_ratio: aspect }, credits: credits(0.0398) };
  },
  // Realistic frames and pictures (Nano Banana Pro, 1K or 2K: 4K is not offered, it costs double).
  'fal-ai/nano-banana-pro/edit': (i) => {
    const urls = Array.isArray(i.image_urls) ? i.image_urls.filter(falFile).slice(0, 6) : [];
    if (!urls.length) return 'Upload the picture first.';
    const aspect = ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '5:4', '2:3', '3:2', '21:9'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : 'auto';
    return { input: { prompt: String(i.prompt ?? '').slice(0, 4000), image_urls: urls, num_images: 1, output_format: 'png', aspect_ratio: aspect, resolution: i.resolution === '1K' ? '1K' : '2K' }, credits: credits(0.15) };
  },
  'fal-ai/nano-banana-pro': (i) => {
    const prompt = String(i.prompt ?? '').trim().slice(0, 4000);
    if (!prompt) return 'Describe the picture.';
    const aspect = ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '5:4', '2:3', '3:2', '21:9'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : '9:16';
    return { input: { prompt, num_images: 1, output_format: 'png', aspect_ratio: aspect, resolution: i.resolution === '1K' ? '1K' : '2K' }, credits: credits(0.15) };
  },
  // A stable clone: the character performs the video's moves; priced per second of the video.
  'fal-ai/kling-video/v2.6/pro/motion-control': (i, o) => {
    if (!falFile(i.video_url) || !falFile(i.image_url)) return 'Upload the video and the picture first.';
    const seconds = Math.max(0, Number(o.seconds) || 0, o.videoSeconds ?? 0);
    if (seconds <= 0) return 'Say how long the video is.';
    if (seconds > 30.5) return 'A stable clone takes up to 30 seconds of video at a time.';
    return { input: { video_url: i.video_url, image_url: i.image_url, character_orientation: 'video', keep_original_sound: i.keep_original_sound === true }, credits: credits(Math.ceil(seconds) * 0.112) };
  },
  // The first frame of an AI video shot without a character (from words alone).
  'fal-ai/nano-banana': (i) => {
    const prompt = String(i.prompt ?? '').trim().slice(0, 2500);
    if (!prompt) return 'Describe the picture.';
    const aspect = ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '5:4', '2:3', '3:2', '21:9'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : '9:16';
    return { input: { prompt, num_images: 1, output_format: 'png', aspect_ratio: aspect }, credits: credits(0.039) };
  },
  // A line in a character's own voice (from their voice sample).
  'fal-ai/chatterbox/text-to-speech': (i) => {
    const text = String(i.text ?? '').trim().slice(0, 5000);
    if (!text) return 'There is nothing to say.';
    if (!falFile(i.audio_url)) return 'Upload the voice sample first.';
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return {
      input: { text, audio_url: i.audio_url, exaggeration: clamp(i.exaggeration, 0, 1, 0.35), temperature: clamp(i.temperature, 0.05, 2, 0.7), cfg: clamp(i.cfg, 0, 1, 0.5) },
      credits: credits((text.length / 1000) * 0.025),
    };
  },
  // A voice made from a description.
  'fal-ai/minimax/voice-design': (i) => {
    const prompt = String(i.prompt ?? '').trim().slice(0, 300);
    const line = String(i.preview_text ?? '').trim().slice(0, 500);
    if (prompt.length < 5 || !line) return 'Describe the voice, and give a line for it to say.';
    return { input: { prompt, preview_text: line }, credits: credits((line.length * 30) / 1_000_000) };
  },
};

/** The plan's credits for each month. */
export function monthlyCredits(plan: Plan): number {
  const v = plan.features?.studio_credits;
  return typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
}

const month = (now: number) => new Date(now).toISOString().slice(0, 7);

interface CreditsRow {
  month: string;
  monthly_used: number;
  bought: number;
}
async function balance(db: Supabase, userId: string, plan: Plan, now: number): Promise<{ monthlyAllowance: number; monthlyLeft: number; bought: number; total: number }> {
  const row = (await db.rest<CreditsRow[]>(`studio_credits?user_id=eq.${encodeURIComponent(userId)}&select=month,monthly_used,bought`))[0];
  const allowance = monthlyCredits(plan);
  const used = row && row.month === month(now) ? Number(row.monthly_used) || 0 : 0;
  const monthlyLeft = Math.max(0, allowance - used);
  const bought = Number(row?.bought) || 0;
  return { monthlyAllowance: allowance, monthlyLeft, bought, total: monthlyLeft + bought };
}

// ---------------------------------------------------------------- reading an MP4's length

/**
 * The video track's length and frame count from an MP4's moov box (mvhd/mdhd/stts), for pricing a
 * character swap by the real video. Null when the bytes do not hold a whole moov.
 */
export function mp4Video(bytes: Uint8Array): { seconds: number; frames: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at: number) => String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
  // Find a moov box header whose whole box is in these bytes.
  let moov = -1;
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i + 4] === 0x6d && bytes[i + 5] === 0x6f && bytes[i + 6] === 0x6f && bytes[i + 7] === 0x76) {
      const size = v.getUint32(i);
      if (size >= 16 && i + size <= bytes.length) {
        moov = i;
        break;
      }
    }
  }
  if (moov < 0) return null;
  const children = (start: number, end: number) => {
    const out: Array<{ type: string; start: number; end: number }> = [];
    for (let at = start; at + 8 <= end; ) {
      const size = v.getUint32(at);
      if (size < 8 || at + size > end) break;
      out.push({ type: type(at), start: at + 8, end: at + size });
      at += size;
    }
    return out;
  };
  let best: { seconds: number; frames: number } | null = null;
  for (const trak of children(moov + 8, moov + v.getUint32(moov)).filter((b) => b.type === 'trak')) {
    const mdia = children(trak.start, trak.end).find((b) => b.type === 'mdia');
    if (!mdia) continue;
    const kids = children(mdia.start, mdia.end);
    const hdlr = kids.find((b) => b.type === 'hdlr');
    if (!hdlr || type(hdlr.start + 4) !== 'vide') continue;
    const mdhd = kids.find((b) => b.type === 'mdhd');
    if (!mdhd) continue;
    const version = bytes[mdhd.start]!;
    const scale = version === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
    const dur = version === 1 ? Number(v.getBigUint64(mdhd.start + 24)) : v.getUint32(mdhd.start + 16);
    const stbl = children(kids.find((b) => b.type === 'minf')?.start ?? 0, kids.find((b) => b.type === 'minf')?.end ?? 0).find((b) => b.type === 'stbl');
    const stts = stbl ? children(stbl.start, stbl.end).find((b) => b.type === 'stts') : undefined;
    let frames = 0;
    if (stts) {
      const n = v.getUint32(stts.start + 4);
      for (let k = 0; k < n && stts.start + 8 + k * 8 + 8 <= stts.end; k++) frames += v.getUint32(stts.start + 8 + k * 8);
    }
    const seconds = scale ? dur / scale : 0;
    if (!best || frames > best.frames) best = { seconds, frames };
  }
  return best;
}

/** The uploaded video's length and frames: its start and end are read (the moov box is in one of them). */
async function videoOf(url: string, fetch: Fetch): Promise<{ seconds: number; frames: number } | null> {
  for (const range of ['bytes=0-1048575', 'bytes=-2097152']) {
    try {
      const r = await fetch(url, { headers: { range } });
      if (!r.ok) continue;
      const found = mp4Video(new Uint8Array(await r.arrayBuffer()));
      if (found) return found;
    } catch {
      /* try the other end */
    }
  }
  return null;
}

// ---------------------------------------------------------------- routes

interface StudioAccount {
  user: { id: string };
  plan: Plan;
}

/** Handles /v1/studio/*; null for other paths. */
export async function handleStudio(
  req: Request,
  route: string,
  env: Env,
  deps: { fetch: Fetch; now: number; db: Supabase; account: () => Promise<StudioAccount | Response>; waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  if (!route.startsWith('/v1/studio/')) return null;
  const { db, now } = deps;
  const a = await deps.account();
  if (a instanceof Response) return a;
  const fal = (url: string, init: RequestInit = {}) => deps.fetch(url, { ...init, headers: { authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

  if (req.method === 'GET' && route === '/v1/studio/credits') {
    const b = await balance(db, a.user.id, a.plan, now);
    const packs = await db.rest<Array<{ id: string; credits: number; currency: string; amount: number }>>('credit_packs?select=id,credits,currency,amount&order=credits').catch(() => []);
    return json(200, { ...b, ready: !!env.FAL_KEY, plan: a.plan.id, packs, creditsPerUsd: CREDITS_PER_USD });
  }

  if (!env.FAL_KEY) return fail(503, 'Keo Studio’s AI is not switched on yet. Try again later.', 'studio_off');

  // An upload link for a picture, video or voice sample the request will use.
  if (req.method === 'POST' && route === '/v1/studio/upload') {
    const b = await balance(db, a.user.id, a.plan, now);
    if (b.total <= 0) return noCredits(a.plan);
    const body = (await req.json().catch(() => ({}))) as { content_type?: unknown; file_name?: unknown };
    const type = String(body.content_type ?? '');
    if (!UPLOAD_TYPES.includes(type)) return fail(400, 'Keo can upload pictures, MP4 videos and voice recordings only.', 'bad_type', 'invalid_request_error');
    const name = String(body.file_name ?? 'keo-file').replace(/[^\w.-]/g, '').slice(0, 80) || 'keo-file';
    const r = await fal(FAL_UPLOAD, { method: 'POST', body: JSON.stringify({ content_type: type, file_name: name }) });
    const out = (await r.json().catch(() => ({}))) as { upload_url?: unknown; file_url?: unknown };
    if (!r.ok || typeof out.upload_url !== 'string' || !falFile(out.file_url)) return fail(502, 'The upload could not be started. Try again in a minute.', 'upload_failed', 'api_error');
    return json(200, { upload_url: out.upload_url, file_url: out.file_url });
  }

  // A request: priced, paid with credits, then sent to fal.ai.
  if (req.method === 'POST' && route === '/v1/studio/run') {
    const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown; input?: unknown; seconds?: unknown; fps?: unknown };
    const endpoint = String(body.endpoint ?? '');
    const pricer = ENDPOINTS[endpoint];
    if (!pricer) return fail(400, 'Keo Studio cannot run that.', 'unknown_endpoint', 'invalid_request_error');
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
    const video = (endpoint.includes('/animate/') || endpoint.includes('/motion-control')) && falFile(input.video_url) ? await videoOf(input.video_url, deps.fetch) : null;
    const priced = pricer(input, { seconds: Number(body.seconds) || 0, fps: Number(body.fps) || 0, ...(video ? { videoSeconds: video.seconds, videoFrames: video.frames } : {}) });
    if (typeof priced === 'string') return fail(400, priced, 'bad_request', 'invalid_request_error');
    let spent: { from_monthly: number; from_bought: number; left: number };
    try {
      spent = await db.rest('rpc/spend_credits', { method: 'POST', body: JSON.stringify({ p_user: a.user.id, p_month: month(now), p_allowance: monthlyCredits(a.plan), p_amount: priced.credits }) });
    } catch {
      const b = await balance(db, a.user.id, a.plan, now).catch(() => null);
      return noCredits(a.plan, priced.credits, b?.total);
    }
    const giveBack = async () => {
      await db.rest('rpc/add_credits', { method: 'POST', body: JSON.stringify({ p_user: a.user.id, p_amount: priced.credits }) }).catch(() => undefined);
    };
    let sent: Response;
    try {
      sent = await fal(`${FAL_QUEUE}${endpoint}`, { method: 'POST', body: JSON.stringify(priced.input) });
    } catch {
      await giveBack();
      return fail(502, 'Keo could not reach the AI service. Nothing was charged: try again.', 'upstream_unreachable', 'api_error');
    }
    const q = (await sent.json().catch(() => ({}))) as { request_id?: unknown; status_url?: unknown; response_url?: unknown; cancel_url?: unknown; detail?: unknown };
    if (!sent.ok || typeof q.request_id !== 'string' || typeof q.status_url !== 'string' || typeof q.response_url !== 'string') {
      await giveBack();
      return fail(sent.status === 422 ? 422 : 502, `The AI service could not take this request${typeof q.detail === 'string' ? `: ${q.detail.slice(0, 200)}` : ''}. Nothing was charged.`, 'upstream_refused', 'api_error');
    }
    await db.rest('studio_jobs', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        request_id: q.request_id,
        user_id: a.user.id,
        endpoint,
        credits: priced.credits,
        from_monthly: spent.from_monthly,
        from_bought: spent.from_bought,
        month: month(now),
        status_url: q.status_url,
        response_url: q.response_url,
        cancel_url: typeof q.cancel_url === 'string' ? q.cancel_url : null,
      }),
    });
    const base = `${new URL(req.url).origin}/v1/studio/requests/${encodeURIComponent(q.request_id)}`;
    return json(200, { request_id: q.request_id, status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel`, credits: priced.credits, left: spent.left });
  }

  // A request's progress, result or cancelling: only the account that paid for it.
  const m = /^\/v1\/studio\/requests\/([\w-]{3,100})(\/status|\/cancel)?$/.exec(route);
  if (m) {
    const job = (await db.rest<Array<{ request_id: string; status_url: string; response_url: string; cancel_url: string | null; status: string }>>(`studio_jobs?request_id=eq.${encodeURIComponent(m[1]!)}&user_id=eq.${encodeURIComponent(a.user.id)}&select=request_id,status_url,response_url,cancel_url,status`))[0];
    if (!job) return fail(404, 'Keo has no such request for this account.', 'not_found', 'invalid_request_error');
    const refund = () => db.rest('rpc/refund_credits', { method: 'POST', body: JSON.stringify({ p_request: job.request_id }) }).catch(() => undefined);
    const pass = async (r: Response) => new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (m[2] === '/status' && req.method === 'GET') {
      const r = await fal(job.status_url);
      if (r.ok) {
        const st = (await r.clone().json().catch(() => ({}))) as { status?: string; error?: unknown };
        if (st.status === 'COMPLETED' && st.error) await refund();
      }
      return pass(r);
    }
    if (m[2] === '/cancel' && req.method === 'PUT') {
      // Credits come back for a request that had not started (fal.ai does not charge for it).
      const st = (await (await fal(job.status_url)).json().catch(() => ({}))) as { status?: string };
      const r = await fal(job.cancel_url ?? `${job.response_url}/cancel`, { method: 'PUT' });
      if (st.status === 'IN_QUEUE' && r.ok) await refund();
      return pass(r);
    }
    if (!m[2] && req.method === 'GET') {
      const r = await fal(job.response_url);
      // fal.ai failed it (not "still working"): the credits come back.
      if (!r.ok && r.status !== 202) await refund();
      else if (r.ok && job.status === 'running') deps.waitUntil(db.rest(`studio_jobs?request_id=eq.${encodeURIComponent(job.request_id)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'done' }) }).catch(() => undefined));
      return pass(r);
    }
  }
  return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
}

function noCredits(plan: Plan, needed?: number, have?: number): Response {
  const what = needed ? `This needs ${needed} Studio credits${have !== undefined ? ` and you have ${have}` : ''}.` : 'You have no Studio credits left.';
  return fail(402, `${what} Buy more credits${plan.id === 'creator' ? '' : ' or move to the Creator plan'} in Settings → Keo account.`, 'not_enough_credits', 'plan_limit');
}
