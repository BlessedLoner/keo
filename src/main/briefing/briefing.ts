import type { BackgroundJob, Briefing, BriefingSection, Task } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import type { CalendarEvent } from '../calendar/googleCalendar';
import type { MailSummary } from '../email/emailService';
import type { FileHit, FileQuery } from '../files/fileSearch';
import type { SearchResult } from '../web/webService';

/**
 * The morning briefing: today's calendar, new email, background work, recently
 * changed files and (only when the user turned it on) weather and news, read in
 * parallel from the user's own connected sources. Every source is optional and
 * read-only; one that is off or not set up is skipped with a one-line note, and
 * one that fails does not stop the others. Nothing is sent, marked or changed.
 */
export interface BriefingSources {
  calendar: {
    /** Why the calendar cannot be read now, or null. */
    unavailable(): string | null;
    list(o: { from: Date; to: Date; max: number }, signal: AbortSignal): Promise<CalendarEvent[]>;
  };
  email: {
    unavailable(): string | null;
    address(): string;
    listNew(o: { limit: number; sinceHours?: number; unreadOnly: boolean }, signal: AbortSignal): Promise<MailSummary[]>;
  };
  work: {
    jobs(): BackgroundJob[];
    /** Tasks that wait for the user (approval, a question, an uncertain outcome). */
    tasksNeedingUser(): Task[];
  };
  files: {
    enabled(): boolean;
    search(q: FileQuery, signal: AbortSignal): Promise<{ hits: FileHit[] }>;
  };
  web: {
    /** Why web search cannot be used now (switch off, no engine), or null. */
    unavailable(settings: Settings): string | null;
    search(query: string, settings: Settings, signal: AbortSignal): Promise<SearchResult[]>;
  };
}

/** Per-source limit, so one slow server does not hold up the whole briefing. */
export const SOURCE_TIMEOUT_MS = 25_000;
const DAY_START = 9 * 60;
const DAY_END = 18 * 60;
const MIN_GAP = 30;
const TEXT = 200;

const clip = (s: string | null | undefined, n = TEXT) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function skipped<T>(note: string): BriefingSection<T> {
  return { status: 'skipped', note, items: [] };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Free stretches of at least 30 minutes in today's working hours (09:00–18:00), from now on. */
export function freeGaps(events: CalendarEvent[], now: Date): Array<{ start: string; end: string; minutes: number }> {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (min: number) => new Date(day.getTime() + min * 60_000).getTime();
  let t = Math.max(at(DAY_START), now.getTime());
  const close = at(DAY_END);
  const busy = events
    .filter((e) => e.busy)
    .map((e) => (e.allDay ? { s: new Date(`${e.start}T00:00`).getTime(), e: new Date(`${e.end}T00:00`).getTime() } : { s: new Date(e.start).getTime(), e: new Date(e.end).getTime() }))
    .filter((b) => b.e > t && b.s < close)
    .sort((a, b) => a.s - b.s);
  const out: Array<{ start: string; end: string; minutes: number }> = [];
  const push = (s: number, e: number) => {
    const minutes = Math.floor((e - s) / 60_000);
    if (minutes >= MIN_GAP) out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), minutes });
  };
  for (const b of busy) {
    if (b.s > t) push(t, Math.min(b.s, close));
    t = Math.max(t, b.e);
    if (t >= close) break;
  }
  if (t < close) push(t, close);
  return out;
}

/** Runs one source with its own time limit; a failure becomes a 'failed' section with the reason. */
async function guarded<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<BriefingSection<T>>): Promise<BriefingSection<T>> {
  const own = AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]);
  try {
    return await fn(own);
  } catch (e) {
    if (signal.aborted) throw e;
    const why = own.aborted ? 'It took too long to answer.' : e instanceof Error ? e.message : 'It could not be read.';
    return { status: 'failed', note: clip(why, 300), items: [] };
  }
}

export async function gatherBriefing(src: BriefingSources, settings: Settings, signal: AbortSignal, now: Date = new Date()): Promise<Briefing> {
  const b = settings.briefing;
  const off = (what: string) => `${what} is turned off for the briefing (Settings → Agent → Morning briefing).`;

  const calendar = async (): Promise<Briefing['calendar']> => {
    if (!b.calendar) return { ...skipped(off('Calendar')), gaps: [] };
    if (src.calendar.unavailable()) return { ...skipped('Connect Google Calendar (Settings → Email & calendar) to include today’s events.'), gaps: [] };
    let events: CalendarEvent[] = [];
    const section = await guarded(signal, async (s) => {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      events = await src.calendar.list({ from, to, max: 50 }, s);
      return {
        status: 'ok' as const,
        note: events.length ? null : 'Nothing in your calendar today.',
        items: events.map((e) => ({ id: e.id, title: clip(e.title) || '(no title)', start: e.start, end: e.end, allDay: e.allDay, location: e.location ? clip(e.location) : null, link: e.link, meetLink: e.meetLink })),
      };
    });
    return { ...section, gaps: section.status === 'ok' ? freeGaps(events, now) : [] };
  };

  const email = async (): Promise<Briefing['email']> => {
    const account = b.email && !src.email.unavailable() ? src.email.address() : '';
    if (!b.email) return { ...skipped(off('Email')), account };
    if (src.email.unavailable()) return { ...skipped('Connect your email (Settings → Email & calendar) to include new mail.'), account };
    const section = await guarded(signal, async (s) => {
      const mail = await src.email.listNew({ limit: 8, unreadOnly: true, sinceHours: 24 }, s);
      return {
        status: 'ok' as const,
        note: mail.length ? null : 'No new unread email since yesterday.',
        items: mail.map((m) => ({ ref: m.ref, from: m.from, fromName: clip(m.fromName, 80), subject: clip(m.subject) || '(no subject)', date: m.date, snippet: clip(m.snippet, 160) })),
      };
    });
    return { ...section, account };
  };

  const jobs = async (): Promise<Briefing['jobs']> => {
    if (!b.jobs) return skipped(off('Background work'));
    return guarded(signal, async () => {
      const since = now.getTime() - 24 * 3600_000;
      const recent = src.work
        .jobs()
        .filter((j) => (j.state === 'running' || j.state === 'queued' ? true : !!j.finishedAt && new Date(j.finishedAt).getTime() >= since))
        .slice(0, 8)
        .map((j) => ({
          id: j.id,
          kind: 'job' as const,
          title: clip(j.title, 120),
          state: j.state,
          needsYou: j.state === 'failed' || j.state === 'interrupted',
          finishedAt: j.finishedAt,
          detail: j.error ? clip(j.error) : j.result ? clip(j.result) : null,
        }));
      const waiting = src.work
        .tasksNeedingUser()
        .slice(0, 8)
        .map((t) => ({ id: t.id, kind: 'task' as const, title: clip(t.title, 120), state: t.state, needsYou: true, finishedAt: t.finishedAt, detail: t.note ? clip(t.note) : null }));
      const items = [...waiting, ...recent];
      return { status: 'ok' as const, note: items.length ? null : 'No background work finished or waiting for you.', items };
    });
  };

  const files = async (): Promise<Briefing['files']> => {
    if (!b.files) return skipped(off('Recent files'));
    if (!src.files.enabled()) return skipped('Turn on “Let Keo find my files” (Settings → Files) to include recently changed files.');
    return guarded(signal, async (s) => {
      const r = await src.files.search({ text: '', kind: 'any', modifiedWithinDays: 1, limit: 12 }, s);
      const items = r.hits
        .filter((h) => h.kind !== 'folder')
        .slice(0, 8)
        .map((h) => ({ path: h.path, name: clip(h.name, 160), folder: h.folder, kind: h.kind, modified: h.modified }));
      return { status: 'ok' as const, note: items.length ? null : 'No files changed since yesterday in your allowed folders.', items };
    });
  };

  const web = async (): Promise<Briefing['web']> => {
    const want: Array<{ topic: 'weather' | 'news'; query: string }> = [];
    if (b.weather && b.weatherPlace) want.push({ topic: 'weather', query: `weather today ${b.weatherPlace}` });
    if (b.news) want.push({ topic: 'news', query: b.newsTopic ? `${b.newsTopic} news today` : 'top news today' });
    if (!want.length) return skipped(b.weather ? 'Add a town or city for the weather (Settings → Agent → Morning briefing).' : 'Weather and news are off (Settings → Agent → Morning briefing).');
    const why = src.web.unavailable(settings);
    if (why) return skipped('Turn on web search (Settings → Web search) to include weather and news.');
    return guarded(signal, async (s) => {
      const found = await Promise.all(want.map(async (w) => ({ w, results: await src.web.search(w.query, settings, s) })));
      const items = found.flatMap(({ w, results }) => results.slice(0, 3).map((r) => ({ topic: w.topic, title: clip(r.title, 160), url: r.url, snippet: clip(r.description) })));
      return { status: 'ok' as const, note: items.length ? null : 'The web search found nothing.', items };
    });
  };

  const [cal, mail, work, recent, webItems] = await Promise.all([calendar(), email(), jobs(), files(), web()]);
  return { date: localDate(now), generatedAt: now.toISOString(), calendar: cal, email: mail, jobs: work, files: recent, web: webItems };
}

/** A Google Calendar event page (the only links the briefing card opens for events). */
export function isCalendarLink(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return url.hostname === 'calendar.google.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/'));
  } catch {
    return false;
  }
}

/** "Show it when I first open Keo each morning": once a day, between 04:00 and noon, only when the switch is on. */
export function morningDue(o: { on: boolean; now: Date; lastShown: string | null }): boolean {
  if (!o.on) return false;
  const h = o.now.getHours();
  return h >= 4 && h < 12 && o.lastShown !== localDate(o.now);
}
