/**
 * Keo's early-access list: the website (heykeo.com) sends an email address, Keo Cloud keeps it in
 * the waitlist table. Only Keo's own website may call it (CORS), each network may add at most 5
 * addresses an hour, and the answer is the same whether the address was new or already listed.
 */
import { fail, json, sha256, type Supabase } from './gateway';

/** The websites allowed to add to the list. */
export const WAITLIST_ORIGINS = ['https://heykeo.com', 'https://www.heykeo.com', 'https://blessedloner.github.io'];

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const cors = (origin: string | null): Record<string, string> =>
  origin && WAITLIST_ORIGINS.includes(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' }
    : {};

/** Handles /v1/waitlist; null for other paths. */
export async function handleWaitlist(req: Request, route: string, db: Supabase, now: number): Promise<Response | null> {
  if (route !== '/v1/waitlist') return null;
  const origin = req.headers.get('origin');
  const headers = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: headers['access-control-allow-origin'] ? 204 : 403, headers });
  if (req.method !== 'POST') return fail(405, 'Method not allowed.', 'method', 'invalid_request_error');
  if (!headers['access-control-allow-origin']) return fail(403, 'Join the list on heykeo.com.', 'origin', 'invalid_request_error');
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; platform?: unknown; source?: unknown; company?: unknown };
  // A hidden field people never fill in: forms filled by bots are quietly accepted and dropped.
  if (typeof body.company === 'string' && body.company.trim()) return json(200, { ok: true }, headers);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) return json(400, { error: { message: 'That email address does not look right.', code: 'bad_email' } }, headers);
  const platform = ['ios', 'android', 'both'].includes(String(body.platform)) ? String(body.platform) : 'windows';
  const source = typeof body.source === 'string' ? body.source.replace(/[^\w-]/g, '').slice(0, 40) || 'site' : 'site';
  // At most 5 sign-ups an hour from one network (the address itself is never stored, only a hash).
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown';
  const ipHash = (await sha256(`keo-waitlist|${ip}`)).slice(0, 32);
  const since = new Date(now - 3_600_000).toISOString();
  const recent = await db.rest<Array<{ email: string }>>(`waitlist?ip_hash=eq.${ipHash}&created_at=gte.${encodeURIComponent(since)}&select=email&limit=6`).catch(() => []);
  if (recent.length >= 5) return json(429, { error: { message: 'Too many sign-ups from here just now. Try again in an hour.', code: 'too_many' } }, headers);
  try {
    await db.rest('waitlist?on_conflict=email', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ email, platform, source, ip_hash: ipHash }),
    });
  } catch {
    return json(503, { error: { message: 'Keo could not save that just now. Please try again in a minute.', code: 'unavailable' } }, headers);
  }
  // The same answer for a new address and one already on the list.
  return json(200, { ok: true }, headers);
}
