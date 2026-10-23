import type { FetchLike, GoogleAuth } from './googleAuth';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Google answered with an error status: the request was refused, so nothing changed. */
export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO date-time, or YYYY-MM-DD for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  attendees: Array<{ email: string; status: string }>;
  meetLink: string | null;
  link: string | null;
  /** Free (transparent) or declined events do not block time. */
  busy: boolean;
}

export interface EventDraft {
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  location?: string;
  description?: string;
  attendees?: string[];
  meet?: boolean;
}

/**
 * Google Calendar v3 over HTTPS with the user's access token (refreshed by
 * GoogleAuth). One retry after a 401 with a forced refresh.
 */
export class GoogleCalendar {
  private readonly fetch: FetchLike;

  constructor(
    private readonly auth: GoogleAuth,
    private readonly calendarId: () => string,
    opts: { fetch?: FetchLike; base?: string } = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.base = opts.base ?? CALENDAR_API;
  }

  private readonly base: string;

  private async call(method: string, path: string, signal: AbortSignal, body?: unknown, query?: Record<string, string>): Promise<Record<string, unknown> | null> {
    const url = new URL(`${this.base}/calendars/${encodeURIComponent(this.calendarId())}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken(attempt > 0);
      const r = await this.fetch(url.toString(), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 204) return null;
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new CalendarApiError(r.status, apiError(r.status, j));
      return j;
    }
    throw new Error('Google Calendar did not accept the sign-in. Sign in again in Settings → Email & calendar.');
  }

  async list(o: { from: Date; to: Date; query?: string; max: number }, signal: AbortSignal): Promise<CalendarEvent[]> {
    const j = await this.call('GET', '/events', signal, undefined, {
      timeMin: o.from.toISOString(),
      timeMax: o.to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(o.max),
      ...(o.query ? { q: o.query } : {}),
    });
    return ((j?.items as unknown[]) ?? []).map((e) => toEvent(e as Record<string, unknown>));
  }

  async create(e: EventDraft, signal: AbortSignal): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {
      summary: e.title,
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
      ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.attendees?.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
      ...(e.meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
    };
    const j = await this.call('POST', '/events', signal, body, { conferenceDataVersion: e.meet ? '1' : '0', sendUpdates: e.attendees?.length ? 'all' : 'none' });
    return toEvent(j ?? {});
  }

  async update(id: string, patch: Partial<EventDraft>, notify: boolean, signal: AbortSignal): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (patch.title) body.summary = patch.title;
    if (patch.start) body.start = { dateTime: patch.start.toISOString(), timeZone: patch.timeZone };
    if (patch.end) body.end = { dateTime: patch.end.toISOString(), timeZone: patch.timeZone };
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.attendees) body.attendees = patch.attendees.map((email) => ({ email }));
    const j = await this.call('PATCH', `/events/${encodeURIComponent(id)}`, signal, body, { sendUpdates: notify ? 'all' : 'none' });
    return toEvent(j ?? {});
  }

  async remove(id: string, notify: boolean, signal: AbortSignal): Promise<void> {
    await this.call('DELETE', `/events/${encodeURIComponent(id)}`, signal, undefined, { sendUpdates: notify ? 'all' : 'none' });
  }
}

function toEvent(e: Record<string, unknown>): CalendarEvent {
  const s = (e.start ?? {}) as { dateTime?: string; date?: string };
  const en = (e.end ?? {}) as { dateTime?: string; date?: string };
  const attendees = ((e.attendees as Array<{ email?: string; responseStatus?: string; self?: boolean }>) ?? []).filter((a) => a.email);
  const declined = attendees.some((a) => a.self && a.responseStatus === 'declined');
  const entry = ((e.conferenceData as { entryPoints?: Array<{ entryPointType?: string; uri?: string }> })?.entryPoints ?? []).find((p) => p.entryPointType === 'video');
  return {
    id: String(e.id ?? ''),
    title: typeof e.summary === 'string' ? e.summary : '(no title)',
    start: s.dateTime ?? s.date ?? '',
    end: en.dateTime ?? en.date ?? '',
    allDay: !s.dateTime,
    location: typeof e.location === 'string' ? e.location : null,
    description: typeof e.description === 'string' ? e.description.slice(0, 1500) : null,
    attendees: attendees.map((a) => ({ email: a.email!, status: a.responseStatus ?? 'needsAction' })),
    meetLink: (typeof e.hangoutLink === 'string' ? e.hangoutLink : entry?.uri) ?? null,
    link: typeof e.htmlLink === 'string' ? e.htmlLink : null,
    busy: e.transparency !== 'transparent' && !declined && e.status !== 'cancelled',
  };
}

function apiError(status: number, j: Record<string, unknown>): string {
  const reason = ((j.error as { errors?: Array<{ reason?: string }> })?.errors ?? [])[0]?.reason ?? '';
  if (status === 403 && /insufficient|forbidden/i.test(reason + JSON.stringify(j.error ?? ''))) return 'Google Calendar refused: Keo was not given access to change this calendar. Sign in again and allow calendar access.';
  if (status === 403 && /accessNotConfigured|disabled/i.test(JSON.stringify(j.error ?? ''))) return 'The Google Calendar API is not turned on in your Google Cloud project (see the setup steps).';
  if (status === 404) return 'Google Calendar could not find that calendar or event.';
  if (status === 429) return 'Google Calendar is busy (rate limit). Try again in a minute.';
  return `Google Calendar answered with an error (${status}).`;
}

/**
 * Free slots of `minutes` between `from` and `to`, inside working hours
 * (minutes after local midnight), skipping busy events and weekends if asked.
 */
export function freeSlots(
  busy: Array<{ start: Date; end: Date }>,
  o: { from: Date; to: Date; minutes: number; dayStart: number; dayEnd: number; weekdaysOnly: boolean; max: number },
): Array<{ start: Date; end: Date }> {
  const blocks = busy.filter((b) => b.end > o.from && b.start < o.to).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Array<{ start: Date; end: Date }> = [];
  const step = 15 * 60_000;
  const len = o.minutes * 60_000;
  const day = new Date(o.from);
  day.setHours(0, 0, 0, 0);
  for (; day < o.to && out.length < o.max; day.setDate(day.getDate() + 1)) {
    if (o.weekdaysOnly && (day.getDay() === 0 || day.getDay() === 6)) continue;
    const open = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, o.dayStart);
    const close = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, o.dayEnd);
    let t = Math.max(open.getTime(), o.from.getTime());
    t = Math.ceil(t / step) * step;
    while (t + len <= Math.min(close.getTime(), o.to.getTime()) && out.length < o.max) {
      const clash = blocks.find((b) => b.start.getTime() < t + len && b.end.getTime() > t);
      if (clash) {
        t = Math.ceil(clash.end.getTime() / step) * step;
        continue;
      }
      out.push({ start: new Date(t), end: new Date(t + len) });
      // Offer spread-out choices: the next one starts after this slot.
      t += len;
    }
  }
  return out;
}
