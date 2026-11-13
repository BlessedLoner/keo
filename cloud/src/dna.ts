/**
 * Keo Cloud — the shared Edit DNA library.
 *
 * A Keo user can publish one of their Edit DNA blueprints (the editing only: shots, timing,
 * transitions, camera, text styles and words, effects — never footage, music or file names) after
 * saying why they may share it. Every signed-in user can search the library and save a blueprint to
 * their own Edit DNA. Publishing is always the user's own action, never automatic; they can remove
 * it at any time. Three reports from different users hide a blueprint until Keo's team looks at it.
 *
 *   POST /v1/dna/list       { query, category }        → { items }
 *   POST /v1/dna/get        { id }                     → { blueprint }
 *   POST /v1/dna/publish    { blueprint, rights, sharedId? } → { id }
 *   POST /v1/dna/unpublish  { id }                     → { removed }
 *   POST /v1/dna/report     { id, reason }             → { sent }
 */
import { fail, json, type Supabase } from './gateway';

const RIGHTS = ['own', 'licensed', 'technique-only'] as const;
const MAX_BYTES = 400_000;
const PER_DAY = 20;
const HIDE_AFTER = 3;

interface Row {
  id: string;
  user_id: string;
  name: string;
  category: string;
  tags: string;
  description: string;
  rights: string;
  seconds: number;
  shots: number;
  aspect: string;
  saves: number;
  published_at: string;
}

const shortId = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
};
const okId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v);
/** Words for a search (letters, digits and spaces only: nothing reaches the query as syntax). */
const words = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 6);

/** The blueprint, checked loosely here (the app checks it fully before it is used) and with its file name removed. */
function cleanBlueprint(v: unknown): { ok: true; b: Record<string, unknown>; text: string } | { ok: false; why: string } {
  if (!v || typeof v !== 'object') return { ok: false, why: 'That is not an Edit DNA blueprint.' };
  const b = v as Record<string, unknown>;
  if (b.schema !== 1 || typeof b.name !== 'string' || !Array.isArray(b.shots) || b.shots.length < 1 || b.shots.length > 400) return { ok: false, why: 'That is not an Edit DNA blueprint Keo Cloud can keep.' };
  const source = (b.source && typeof b.source === 'object' ? b.source : {}) as Record<string, unknown>;
  const clean = { ...b, source: { ...source, fileName: 'reference' }, history: [], related: [], favorite: false };
  delete (clean as Record<string, unknown>).sharing;
  const text = JSON.stringify(clean);
  if (text.length > MAX_BYTES) return { ok: false, why: 'That blueprint is too large to share.' };
  return { ok: true, b: clean, text };
}

export async function handleDna(req: Request, route: string, deps: { db: Supabase; now: number; account: () => Promise<{ user: { id: string } } | Response>; waitUntil: (p: Promise<unknown>) => void }): Promise<Response | null> {
  if (!route.startsWith('/v1/dna/')) return null;
  if (req.method !== 'POST') return fail(405, 'Use POST.', 'bad_request', 'invalid_request_error');
  const a = await deps.account();
  if (a instanceof Response) return a;
  const { db } = deps;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const me = a.user.id;

  if (route === '/v1/dna/list') {
    const q = words(body.query);
    const cat = typeof body.category === 'string' && /^[\p{L} &-]{1,40}$/u.test(body.category) ? body.category : '';
    const like = (w: string) => `or(name.ilike.*${encodeURIComponent(w)}*,tags.ilike.*${encodeURIComponent(w)}*,description.ilike.*${encodeURIComponent(w)}*)`;
    const where = ['hidden=eq.false', ...(cat ? [`category=eq.${encodeURIComponent(cat)}`] : []), ...(q.length ? [`and=(${q.map(like).join(',')})`] : [])];
    const rows = await db.rest<Row[]>(`dna_shared?${where.join('&')}&select=id,user_id,name,category,tags,description,rights,seconds,shots,aspect,saves,published_at&order=saves.desc,published_at.desc&limit=60`).catch(() => null);
    if (!rows) return fail(502, 'The shared library could not be read. Try again in a minute.', 'dna_unavailable', 'api_error');
    return json(200, { items: rows.map(({ user_id, tags, ...r }) => ({ ...r, tags: tags.split(' ').filter(Boolean), mine: user_id === me })) });
  }

  if (route === '/v1/dna/get') {
    if (!okId(body.id)) return fail(400, 'That is not a shared Edit DNA.', 'bad_request', 'invalid_request_error');
    const rows = await db.rest<Array<{ blueprint: unknown; user_id: string }>>(`dna_shared?id=eq.${encodeURIComponent(body.id)}&hidden=eq.false&select=blueprint,user_id`).catch(() => null);
    if (!rows) return fail(502, 'The shared library could not be read. Try again in a minute.', 'dna_unavailable', 'api_error');
    const row = rows[0];
    if (!row) return fail(404, 'That Edit DNA is no longer shared.', 'not_found', 'invalid_request_error');
    if (row.user_id !== me) deps.waitUntil(db.rest('rpc/dna_saved', { method: 'POST', body: JSON.stringify({ p_id: body.id }) }).catch(() => undefined));
    return json(200, { blueprint: row.blueprint });
  }

  if (route === '/v1/dna/publish') {
    const rights = RIGHTS.find((r) => r === body.rights);
    if (!rights) return fail(400, 'Say why you may share it: you made the reference, you have a licence, or it is the technique only.', 'rights_needed', 'invalid_request_error');
    const c = cleanBlueprint(body.blueprint);
    if (!c.ok) return fail(400, c.why, 'bad_blueprint', 'invalid_request_error');
    const b = c.b;
    const fields = {
      name: String(b.name).trim().slice(0, 80) || 'Edit DNA',
      category: typeof b.category === 'string' ? b.category.slice(0, 40) : 'Experimental',
      tags: (Array.isArray(b.tags) ? b.tags : [])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 30))
        .slice(0, 16)
        .join(' '),
      description: typeof b.description === 'string' ? b.description.slice(0, 400) : '',
      rights,
      seconds: Math.max(0, Math.min(36000, Number(b.seconds) || 0)),
      shots: (b.shots as unknown[]).length,
      aspect: b.aspect === 'landscape' || b.aspect === 'square' ? b.aspect : 'vertical',
      blueprint: b,
      updated_at: new Date(deps.now).toISOString(),
    };
    // An update of the user's own shared blueprint keeps its id (and its saves).
    if (okId(body.sharedId)) {
      const own = await db.rest<Array<{ id: string }>>(`dna_shared?id=eq.${encodeURIComponent(body.sharedId)}&user_id=eq.${encodeURIComponent(me)}&select=id`).catch(() => []);
      if (own[0]) {
        await db.rest(`dna_shared?id=eq.${encodeURIComponent(body.sharedId)}&user_id=eq.${encodeURIComponent(me)}`, { method: 'PATCH', body: JSON.stringify(fields) });
        return json(200, { id: body.sharedId });
      }
    }
    const since = new Date(deps.now - 24 * 60 * 60 * 1000).toISOString();
    const today = await db.rest<Array<{ id: string }>>(`dna_shared?user_id=eq.${encodeURIComponent(me)}&published_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_DAY + 1}`).catch(() => []);
    if (today.length >= PER_DAY) return fail(429, `You have published ${PER_DAY} Edit DNA today. Try again tomorrow.`, 'too_many_published', 'rate_limit_error');
    const id = shortId();
    const saved = await db.rest<Array<{ id: string }>>('dna_shared', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ id, user_id: me, ...fields }) }).catch(() => null);
    if (!saved?.[0]) return fail(502, 'It could not be published. Try again in a minute.', 'publish_failed', 'api_error');
    return json(200, { id: saved[0].id });
  }

  if (route === '/v1/dna/unpublish') {
    if (!okId(body.id)) return fail(400, 'That is not a shared Edit DNA.', 'bad_request', 'invalid_request_error');
    await db.rest(`dna_shared?id=eq.${encodeURIComponent(body.id)}&user_id=eq.${encodeURIComponent(me)}`, { method: 'DELETE' }).catch(() => undefined);
    return json(200, { removed: true });
  }

  if (route === '/v1/dna/report') {
    if (!okId(body.id)) return fail(400, 'That is not a shared Edit DNA.', 'bad_request', 'invalid_request_error');
    const reason = String(body.reason ?? '').trim().slice(0, 500) || 'Reported';
    await db.rest('dna_reports', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify({ shared_id: body.id, user_id: me, reason }) }).catch(() => undefined);
    const count = await db.rest<Array<{ user_id: string }>>(`dna_reports?shared_id=eq.${encodeURIComponent(body.id)}&select=user_id&limit=${HIDE_AFTER}`).catch(() => []);
    if (count.length >= HIDE_AFTER) await db.rest(`dna_shared?id=eq.${encodeURIComponent(body.id)}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) }).catch(() => undefined);
    return json(200, { sent: true });
  }

  return fail(404, 'Not found.', 'not_found', 'invalid_request_error');
}
