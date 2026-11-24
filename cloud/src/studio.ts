/**
 * Keo Studio's AI work through Keo Cloud: AI shots, character swap, same-face pictures and
 * character voices run on Keo's own fal.ai account (the FAL_KEY secret), paid in Studio credits.
 *
 * The price of every request is worked out here from what is asked (never taken from the app),
 * taken before fal.ai starts, and given back if fal.ai fails. The app never sees Keo's fal.ai key:
 * it gets upload links and request addresses on this gateway.
 */

import { audioSeconds } from './audioLength';
import { MODEL_3D_USD } from '../../src/shared/aiPrices';
import { fail, json, type Env, type Fetch, type Plan, type Supabase } from './gateway';

/** 1 credit is 1 US cent to the user and covers half a cent of fal.ai's price. */
export const CREDITS_PER_USD = 200;

const FAL_QUEUE = 'https://queue.fal.run/';
const FAL_UPLOAD = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

/** What may be uploaded for a request (pictures, videos, voice samples). */
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg'];

/** A file fal.ai keeps (what an upload gives back). */
const falStored = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/([a-z0-9-]+\.)*fal\.media\/[^\s]{1,1500}$/i.test(v);

/** A picture sent inside the request (when fal.ai's storage cannot take an upload): JPEG, PNG or WebP, up to about 6 MB. */
const inlinePicture = (v: unknown): v is string => typeof v === 'string' && v.length <= 8_000_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);

/** The only files a request may use: fal.ai's own, or a picture sent inline. */
const falFile = (v: unknown): v is string => falStored(v) || inlinePicture(v);

const credits = (usd: number) => Math.max(1, Math.ceil(usd * CREDITS_PER_USD - 1e-6));

/** A request Keo runs, with the input rebuilt from known fields only, and its price. */
interface Priced {
  input: Record<string, unknown>;
  credits: number;
}
type Pricer = (input: Record<string, unknown>, o: { seconds?: number; fps?: number; videoSeconds?: number; videoFrames?: number; audioSeconds?: number | null }) => Priced | string;

/**
 * A talking character (Kling AI Avatar v2): priced by the uploaded voice's own length (read from
 * the file, never less than the app says), up to a minute.
 */
function talking(perSecond: number): Pricer {
  return (i, o) => {
    if (!falFile(i.image_url) || !falStored(i.audio_url)) return 'Upload the picture and the voice first.';
    if (o.audioSeconds === null || o.audioSeconds === undefined) return 'Keo could not read the voice file: send it as WAV or MP3.';
    const seconds = Math.max(o.audioSeconds, Number(o.seconds) || 0);
    if (seconds > 60.5) return 'A talking clip is up to 60 seconds: split the script.';
    return { input: { image_url: i.image_url, audio_url: i.audio_url, prompt: String(i.prompt ?? '').slice(0, 1000) || '.' }, credits: credits(Math.max(1, Math.ceil(seconds)) * perSecond) };
  };
}

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
    if (!falStored(i.video_url) || !falFile(i.image_url)) return 'Upload the video and the picture first.';
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
  // Game models: a picture made into a textured 3D model (GLB), game-sized.
  'fal-ai/trellis-2': (i) => {
    if (!falFile(i.image_url)) return 'Upload the picture first.';
    const detail = Math.max(20_000, Math.min(150_000, Math.round(Number(i.decimation_target) || 90_000)));
    return { input: { image_url: i.image_url, resolution: 1024, texture_size: 2048, decimation_target: detail, remesh: true }, credits: credits(MODEL_3D_USD) };
  },
  'fal-ai/nano-banana-pro': (i) => {
    const prompt = String(i.prompt ?? '').trim().slice(0, 4000);
    if (!prompt) return 'Describe the picture.';
    const aspect = ['1:1', '4:5', '3:4', '9:16', '16:9', '4:3', '5:4', '2:3', '3:2', '21:9'].includes(String(i.aspect_ratio)) ? String(i.aspect_ratio) : '9:16';
    return { input: { prompt, num_images: 1, output_format: 'png', aspect_ratio: aspect, resolution: i.resolution === '1K' ? '1K' : '2K' }, credits: credits(0.15) };
  },
  // A stable clone: the character performs the video's moves; priced per second of the video.
  'fal-ai/kling-video/v2.6/pro/motion-control': (i, o) => {
    if (!falStored(i.video_url) || !falFile(i.image_url)) return 'Upload the video and the picture first.';
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
  // A talking character: their picture lip-synced to a voice.
  'fal-ai/kling-video/ai-avatar/v2/pro': talking(0.115),
  'fal-ai/kling-video/ai-avatar/v2/standard': talking(0.0562),
  // Music made for a video: each started minute of music counted.
  'elevenlabs/music/v2.5': (i) => {
    const prompt = String(i.prompt ?? '').trim().slice(0, 2000);
    const ms = Number(i.music_length_ms);
    if (!prompt) return 'Describe the music.';
    if (!Number.isFinite(ms) || ms < 5000 || ms > 300000) return 'Music is 5 seconds to 5 minutes long.';
    return { input: { prompt, music_length_ms: Math.round(ms), force_instrumental: i.force_instrumental !== false, output_format: 'mp3_48000_192' }, credits: credits(Math.ceil(ms / 60000 - 1e-9) * 0.6) };
  },
  // A sound effect from words, up to 30 seconds.
  'elevenlabs/sound-effects/v3': (i) => {
    const text = String(i.text ?? '').trim().slice(0, 450);
    const seconds = Number(i.duration_seconds);
    if (!text) return 'Describe the sound.';
    if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 30) return 'A sound effect is 0.5 to 30 seconds long.';
    const influence = typeof i.prompt_influence === 'number' && Number.isFinite(i.prompt_influence) ? Math.min(1, Math.max(0, i.prompt_influence)) : 0.3;
    return { input: { text, duration_seconds: seconds, loop: i.loop === true, prompt_influence: influence, output_format: 'mp3_44100_128' }, credits: credits(Math.ceil(seconds) * 0.002) };
  },
  // A line in a character's own voice (from their voice sample).
  'fal-ai/chatterbox/text-to-speech': (i) => {
    const text = String(i.text ?? '').trim().slice(0, 5000);
    if (!text) return 'There is nothing to say.';
    if (!falStored(i.audio_url)) return 'Upload the voice sample first.';
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
/** fal.ai's cost of a number of credits (US$). */
export const falUsd = (credits: number) => credits / CREDITS_PER_USD;

interface CreditsRow {
  month: string;
  monthly_used: number;
  bought: number;
}
/** How many Studio credits the user has (the month's and bought ones). */
export async function balance(db: Supabase, userId: string, plan: Plan, key: string): Promise<{ monthlyAllowance: number; monthlyLeft: number; bought: number; total: number }> {
  const row = (await db.rest<CreditsRow[]>(`studio_credits?user_id=eq.${encodeURIComponent(userId)}&select=month,monthly_used,bought`))[0];
  const allowance = monthlyCredits(plan);
  const used = row && row.month === key ? Number(row.monthly_used) || 0 : 0;
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

/** The uploaded voice's length: its first bytes (headers) and its size (from the range answer). */
async function audioOf(url: string, fetch: Fetch): Promise<number | null> {
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-131071' } });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]) || (r.status === 200 ? bytes.length : 0);
    return total ? audioSeconds(bytes, total) : null;
  } catch {
    return null;
  }
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
  /** The billing month: monthly credits follow it (one payment is one month's credits). */
  windows?: { periodKey: string };
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
  const key = a.windows?.periodKey ?? month(now);
  const day = new Date(now).toISOString().slice(0, 10);
  // Keo's own daily fal.ai safety breaker (negative to give back a job that was refunded).
  const spend = async (usd: number) => {
    const total = await db.rest<string>('rpc/reserve_spend', { method: 'POST', body: JSON.stringify({ p_provider: 'fal', p_day: day, p_amount: Math.round(usd * 1e6) / 1e6 }) });
    if (String(total) === 'keo_breaker') throw new Error('keo_breaker');
    return total;
  };
  const fal = (url: string, init: RequestInit = {}) => deps.fetch(url, { ...init, headers: { authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

  if (req.method === 'GET' && route === '/v1/studio/credits') {
    // The one-time trial: given the first time the account looks at its credits.
    const trial = await giveTrial(db, a.user.id, env);
    const b = await balance(db, a.user.id, a.plan, key);
    const packs = await db.rest<Array<{ id: string; credits: number; currency: string; amount: number }>>('credit_packs?select=id,credits,currency,amount&order=credits').catch(() => []);
    return json(200, { ...b, ready: !!env.FAL_KEY, plan: a.plan.id, packs, creditsPerUsd: CREDITS_PER_USD, ...(trial ? { trialGiven: trial } : {}) });
  }

  // What the credits went on: the last 100 AI requests, newest first.
  if (req.method === 'GET' && route === '/v1/studio/history') {
    const rows = await db.rest<Array<{ endpoint: string; credits: number; status: string; created_at: string }>>(`studio_jobs?user_id=eq.${encodeURIComponent(a.user.id)}&select=endpoint,credits,status,created_at&order=created_at.desc&limit=100`).catch(() => []);
    return json(200, { items: rows.map((r) => ({ what: jobLabel(r.endpoint), credits: Number(r.credits) || 0, refunded: r.status === 'refunded', at: r.created_at })) });
  }

  // The user's invite code and what it earned; redeeming a friend's code (new accounts).
  if (req.method === 'GET' && route === '/v1/studio/referral') {
    const code = await referralCode(db, a.user.id);
    const mine = await db.rest<Array<{ credits: number; rewarded: boolean }>>(`referrals?referrer_id=eq.${encodeURIComponent(a.user.id)}&select=credits,rewarded`).catch(() => []);
    const referred = await db.rest<Array<{ user_id: string }>>(`referrals?user_id=eq.${encodeURIComponent(a.user.id)}&select=user_id`).catch(() => []);
    return json(200, { code, credits: referralCredits(env), joined: mine.length, earned: mine.filter((r) => r.rewarded).reduce((t, r) => t + (Number(r.credits) || 0), 0), referred: referred.length > 0 });
  }
  if (req.method === 'POST' && route === '/v1/studio/referral/redeem') {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) return fail(400, 'That is not an invite code: it is 8 letters and numbers.', 'bad_code', 'invalid_request_error');
    const amount = referralCredits(env);
    if (!amount) return fail(403, 'Invites are switched off right now.', 'referrals_off');
    try {
      const r = await db.rest<{ credits: number; referrer_rewarded: boolean }>('rpc/redeem_referral', { method: 'POST', body: JSON.stringify({ p_user: a.user.id, p_code: code, p_amount: amount, p_max_age_days: 14, p_monthly_limit: 20 }) });
      return json(200, { credits: r.credits });
    } catch (e) {
      const why = e instanceof Error ? e.message : '';
      if (why.includes('no_such_code')) return fail(404, 'There is no such invite code: check it with your friend.', 'no_such_code', 'invalid_request_error');
      if (why.includes('own_code')) return fail(400, 'That is your own invite code: share it with friends instead.', 'own_code', 'invalid_request_error');
      if (why.includes('already_referred')) return fail(409, 'This account has already used an invite code.', 'already_referred', 'invalid_request_error');
      if (why.includes('too_old')) return fail(403, 'Invite codes are for new accounts (in their first 14 days).', 'too_old', 'invalid_request_error');
      return fail(502, 'The invite could not be used right now. Try again in a minute.', 'referral_failed', 'api_error');
    }
  }

  if (!env.FAL_KEY) return fail(503, 'Keo Studio’s AI is not switched on yet. Try again later.', 'studio_off');

  // An upload link for a picture, video or voice sample the request will use.
  if (req.method === 'POST' && route === '/v1/studio/upload') {
    const b = await balance(db, a.user.id, a.plan, key);
    if (b.total <= 0) return noCredits(a.plan);
    const body = (await req.json().catch(() => ({}))) as { content_type?: unknown; file_name?: unknown };
    const type = String(body.content_type ?? '');
    if (!UPLOAD_TYPES.includes(type)) return fail(400, 'Keo can upload pictures, MP4 videos and voice recordings only.', 'bad_type', 'invalid_request_error');
    const name = String(body.file_name ?? 'keo-file').replace(/[^\w.-]/g, '').slice(0, 80) || 'keo-file';
    const r = await fal(FAL_UPLOAD, { method: 'POST', body: JSON.stringify({ content_type: type, file_name: name }) });
    const out = (await r.json().catch(() => ({}))) as { upload_url?: unknown; file_url?: unknown; detail?: unknown };
    if (!r.ok || typeof out.upload_url !== 'string' || !falStored(out.file_url)) {
      // Why fal.ai said no (an empty balance, a locked account, an outage), so it can be put right.
      const why = typeof out.detail === 'string' ? out.detail.slice(0, 200) : '';
      console.error('studio upload refused', r.status, why);
      return fail(502, `The AI service's storage did not take the upload (${r.status}${why ? `: ${why}` : ''}). Nothing was charged.`, 'upload_failed', 'api_error');
    }
    return json(200, { upload_url: out.upload_url, file_url: out.file_url });
  }

  // A request: priced, paid with credits, then sent to fal.ai.
  if (req.method === 'POST' && route === '/v1/studio/run') {
    const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown; input?: unknown; seconds?: unknown; fps?: unknown };
    const endpoint = String(body.endpoint ?? '');
    const pricer = ENDPOINTS[endpoint];
    if (!pricer) return fail(400, 'Keo Studio cannot run that.', 'unknown_endpoint', 'invalid_request_error');
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
    const video = (endpoint.includes('/animate/') || endpoint.includes('/motion-control')) && falStored(input.video_url) ? await videoOf(input.video_url, deps.fetch) : null;
    const audio = endpoint.includes('/ai-avatar/') && falStored(input.audio_url) ? await audioOf(input.audio_url, deps.fetch) : undefined;
    const priced = pricer(input, { seconds: Number(body.seconds) || 0, fps: Number(body.fps) || 0, ...(video ? { videoSeconds: video.seconds, videoFrames: video.frames } : {}), ...(audio !== undefined ? { audioSeconds: audio } : {}) });
    if (typeof priced === 'string') return fail(400, priced, 'bad_request', 'invalid_request_error');
    let spent: { from_monthly: number; from_bought: number; left: number };
    try {
      spent = await db.rest('rpc/spend_credits', { method: 'POST', body: JSON.stringify({ p_user: a.user.id, p_month: key, p_allowance: monthlyCredits(a.plan), p_amount: priced.credits }) });
    } catch {
      const b = await balance(db, a.user.id, a.plan, key).catch(() => null);
      return noCredits(a.plan, priced.credits, b?.total);
    }
    // Exactly what was taken comes back (the month's credits stay the month's).
    const giveBack = async () => {
      await db.rest('rpc/return_credits', { method: 'POST', body: JSON.stringify({ p_user: a.user.id, p_month: key, p_from_monthly: spent.from_monthly, p_from_bought: spent.from_bought }) }).catch(() => undefined);
    };
    try {
      await spend(falUsd(priced.credits));
    } catch (e) {
      await giveBack();
      if (/keo_breaker/.test((e as Error).message)) return fail(503, 'Keo Studio’s AI is paused for a short while for safety. Nothing was charged; please try again later.', 'keo_paused', 'api_error');
      throw e;
    }
    const giveAllBack = async () => {
      await giveBack();
      await spend(-falUsd(priced.credits)).catch(() => undefined);
    };
    let sent: Response;
    try {
      sent = await fal(`${FAL_QUEUE}${endpoint}`, { method: 'POST', body: JSON.stringify(priced.input) });
    } catch {
      await giveAllBack();
      return fail(502, 'Keo could not reach the AI service. Nothing was charged: try again.', 'upstream_unreachable', 'api_error');
    }
    const q = (await sent.json().catch(() => ({}))) as { request_id?: unknown; status_url?: unknown; response_url?: unknown; cancel_url?: unknown; detail?: unknown };
    if (!sent.ok || typeof q.request_id !== 'string' || typeof q.status_url !== 'string' || typeof q.response_url !== 'string') {
      await giveAllBack();
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
        month: key,
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
    const job = (await db.rest<Array<{ request_id: string; status_url: string; response_url: string; cancel_url: string | null; status: string; credits?: number }>>(`studio_jobs?request_id=eq.${encodeURIComponent(m[1]!)}&user_id=eq.${encodeURIComponent(a.user.id)}&select=request_id,status_url,response_url,cancel_url,status,credits`))[0];
    if (!job) return fail(404, 'Keo has no such request for this account.', 'not_found', 'invalid_request_error');
    // A failed or cancelled job: the credits come back once, and fal.ai's spend with them.
    const refund = async () => {
      const given = await db.rest<boolean>('rpc/refund_credits', { method: 'POST', body: JSON.stringify({ p_request: job.request_id }) }).catch(() => false);
      if (given === true) await spend(-falUsd(Number(job.credits) || 0)).catch(() => undefined);
    };
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

// ---------------------------------------------------------------- trial and referrals

const trialCredits = (env: Env) => Math.max(0, Math.floor(Number(env.TRIAL_CREDITS ?? 150) || 0));
const referralCredits = (env: Env) => Math.max(0, Math.floor(Number(env.REFERRAL_CREDITS ?? 200) || 0));

/** Gives the one-time trial (the credits given now, or 0). A database without update 8: nothing. */
async function giveTrial(db: Supabase, userId: string, env: Env): Promise<number> {
  const amount = trialCredits(env);
  if (!amount) return 0;
  const rows = await db.rest<Array<{ trial_given?: boolean }>>(`studio_credits?user_id=eq.${encodeURIComponent(userId)}&select=*`).catch(() => null);
  if (!rows) return 0;
  const row = rows[0];
  // A row without the column: the database has not had update 8 yet.
  if (row && row.trial_given !== false) return 0;
  const given = await db.rest<boolean>('rpc/give_trial', { method: 'POST', body: JSON.stringify({ p_user: userId, p_amount: amount }) }).catch(() => false);
  return given ? amount : 0;
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The user's invite code, made the first time (8 letters and numbers, no look-alikes). */
async function referralCode(db: Supabase, userId: string): Promise<string | null> {
  const have = (await db.rest<Array<{ code: string }>>(`referral_codes?user_id=eq.${encodeURIComponent(userId)}&select=code`).catch(() => null))?.[0];
  if (have) return have.code;
  for (let tries = 0; tries < 4; tries++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
    const made = await db.rest('referral_codes', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, code }) }).then(() => true, () => false);
    if (made) return code;
  }
  return null;
}

/** What an AI request was, in words (for the user's history). */
export function jobLabel(endpoint: string): string {
  if (endpoint.includes('image-to-video')) return endpoint.includes('veo') ? 'AI shot (Veo)' : 'AI shot (Kling)';
  if (endpoint.includes('/animate/')) return 'Character swap';
  if (endpoint.includes('motion-control')) return 'Clone a video';
  if (endpoint.includes('ai-avatar')) return 'Talking character';
  if (endpoint.includes('nano-banana')) return 'Picture / first frame';
  if (endpoint.includes('music')) return 'AI music';
  if (endpoint.includes('sound-effects')) return 'Sound effect';
  if (endpoint.includes('chatterbox') || endpoint.includes('voice')) return 'Character voice';
  if (endpoint.includes('trellis')) return '3D model (games)';
  return 'AI request';
}
