import type { Recurrence, ScheduledItem, Weekday } from '../../shared/domain';
import { parseJson, type Database } from '../db/database';
import { CapabilityError } from '../capabilities/types';
import type { Logger } from '../logging/logger';
import type { AuditRepo } from '../repos/audit';
import { newId } from '../util/ids';

/** Weekdays in Date#getDay() order. */
export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAME: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A run this much after its time counts as late (Keo was closed, or the computer slept). */
const LATE_MS = 2 * 60_000;
/** The timer wakes at least this often, so a changed clock or a resumed computer is noticed. */
const MAX_WAIT_MS = 60_000;
/** Finished one-off items stay listed this long. */
const KEEP_DONE_MS = 7 * 24 * 3600_000;

interface Row {
  id: string;
  kind: ScheduledItem['kind'];
  title: string;
  text: string;
  conversation_id: string | null;
  at: string;
  recurrence: string;
  state: ScheduledItem['state'];
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  runs: number;
  created_at: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "9:00", "17:30" (local time). */
export function clockText(d: Date): string {
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

/** "Monday 26 October, 9:00" (local time). */
export function whenText(d: Date): string {
  return `${DAY_NAME[WEEKDAYS[d.getDay()]!]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${clockText(d)}`;
}

/** "once", "every day at 9:00", "every Monday and Thursday at 9:00", "every 3 hours". */
export function repeatText(r: Recurrence, at: Date): string {
  if (r.every === 'once') return 'once';
  if (r.every === 'hours') return r.hours === 1 ? 'every hour' : `every ${r.hours} hours`;
  if (r.every === 'day') return `every day at ${clockText(at)}`;
  const days = WEEKDAYS.filter((d) => r.days.includes(d));
  const order = [...days.filter((d) => d !== 'sun'), ...days.filter((d) => d === 'sun')];
  const names =
    order.length === 5 && !order.includes('sat') && !order.includes('sun')
      ? 'weekday'
      : order.length === 7
        ? 'day'
        : order.map((d) => DAY_NAME[d]).join(order.length === 2 ? ' and ' : ', ').replace(/, ([^,]+)$/, ' and $1');
  return `every ${names} at ${clockText(at)}`;
}

/**
 * The first run at or after `from` (epoch ms), or null when there is none. Day and
 * week repeats keep the local wall-clock time of `at`, so 9:00 stays 9:00 across
 * daylight-saving changes; "every N hours" counts real hours from `at`.
 */
export function occurrenceAtOrAfter(r: Recurrence, at: Date, from: number): number | null {
  const anchor = at.getTime();
  if (r.every === 'once') return anchor >= from ? anchor : null;
  if (r.every === 'hours') {
    const step = r.hours * 3600_000;
    if (anchor >= from) return anchor;
    return anchor + Math.ceil((from - anchor) / step) * step;
  }
  const start = new Date(Math.max(from, anchor));
  for (let i = 0; i < 9; i++) {
    const c = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, at.getHours(), at.getMinutes(), 0, 0);
    if (c.getTime() < from || c.getTime() < anchor) continue;
    if (r.every === 'day' || r.days.includes(WEEKDAYS[c.getDay()]!)) return c.getTime();
  }
  return null;
}

/** Checks a recurrence from the model or the UI (well-formed days, a sensible hour count). */
export function normalizeRecurrence(r: { every: string; days?: string[] | undefined; hours?: number | undefined }): Recurrence {
  if (r.every === 'once' || r.every === 'day') return { every: r.every };
  if (r.every === 'week') {
    const days = [...new Set(r.days ?? [])].filter((d): d is Weekday => (WEEKDAYS as string[]).includes(d));
    if (!days.length) throw new CapabilityError('invalid_input', 'A weekly repeat needs at least one day (mon … sun).');
    return { every: 'week', days: WEEKDAYS.filter((d) => days.includes(d)) };
  }
  if (r.every === 'hours') {
    const h = r.hours ?? 0;
    if (!Number.isInteger(h) || h < 1 || h > 168) throw new CapabilityError('invalid_input', 'An hourly repeat needs a whole number of hours from 1 to 168.');
    return { every: 'hours', hours: h };
  }
  throw new CapabilityError('invalid_input', `Unknown repeat “${r.every}”. Use once, day, week or hours.`);
}

export interface SchedulerDeps {
  db: Database;
  audit: AuditRepo;
  log: Logger;
  /** Epoch ms now (tests use a fake clock). */
  now?: () => number;
  /** A reminder is due: notify the user (and speak it in a voice conversation). */
  remind(item: ScheduledItem, late: boolean): void;
  /** A routine is due: start its instruction as a background job. Throws when it could not start. */
  runRoutine(item: ScheduledItem, late: boolean): void;
  changed(): void;
}

export interface NewSchedule {
  kind: ScheduledItem['kind'];
  title: string;
  text: string;
  conversationId: string | null;
  at: Date;
  recurrence: Recurrence;
}

/**
 * Keo's reminders and routines, kept in its database so they survive restarts.
 * One timer waits for the next due item. Items that came due while Keo was
 * closed run once at the next start, marked late; missed repeats are not
 * replayed one by one.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly d: SchedulerDeps) {
    this.now = d.now ?? Date.now;
  }

  private view(r: Row): ScheduledItem {
    const recurrence = parseJson<Recurrence>(r.recurrence, { every: 'once' });
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      text: r.text,
      conversationId: r.conversation_id,
      at: r.at,
      recurrence,
      repeatText: repeatText(recurrence, new Date(r.at)),
      state: r.state,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      runs: r.runs,
      createdAt: r.created_at,
    };
  }

  /** Active and paused items by next run, then recently finished ones. */
  list(): ScheduledItem[] {
    const rows = this.d.db.all<Row>("SELECT * FROM schedules ORDER BY CASE state WHEN 'done' THEN 1 ELSE 0 END, next_run_at IS NULL, next_run_at, created_at");
    return rows.map((r) => this.view(r));
  }

  get(id: string): ScheduledItem | null {
    const r = this.d.db.get<Row>('SELECT * FROM schedules WHERE id = ?', [id]);
    return r ? this.view(r) : null;
  }

  create(i: NewSchedule): ScheduledItem {
    if (Number.isNaN(i.at.getTime())) throw new CapabilityError('invalid_input', 'The time is not a valid date and time.');
    const now = this.now();
    const next = occurrenceAtOrAfter(i.recurrence, i.at, now);
    if (next === null) throw new CapabilityError('time_passed', `${whenText(i.at)} has already passed. Ask the user for a time in the future.`);
    if (next - now > 2 * 366 * 24 * 3600_000) throw new CapabilityError('too_far', 'Keo schedules at most two years ahead.');
    const id = newId('sch_');
    const ts = new Date(now).toISOString();
    this.d.db.run(
      'INSERT INTO schedules (id, kind, title, text, conversation_id, at, recurrence, state, next_run_at, runs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [id, i.kind, i.title.replace(/\s+/g, ' ').trim().slice(0, 80), i.text.trim().slice(0, 4000), i.conversationId, i.at.toISOString(), JSON.stringify(i.recurrence), 'active', new Date(next).toISOString(), ts, ts],
    );
    this.d.audit.record({ kind: 'schedule.created', decision: 'created', detail: { id, kind: i.kind, every: i.recurrence.every } });
    this.d.log.info('schedule.created', { id, kind: i.kind, every: i.recurrence.every });
    this.changed();
    return this.get(id)!;
  }

  /** Pausing keeps the item; resuming continues from now (runs missed while paused are skipped, a one-off past its time runs now). */
  setPaused(id: string, paused: boolean): ScheduledItem | null {
    const item = this.get(id);
    if (!item || item.state === 'done') return null;
    if (paused === (item.state === 'paused')) return item;
    const now = this.now();
    const next = paused ? item.nextRunAt : item.recurrence.every === 'once' ? item.nextRunAt : new Date(occurrenceAtOrAfter(item.recurrence, new Date(item.at), now) ?? now).toISOString();
    this.d.db.run('UPDATE schedules SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?', [paused ? 'paused' : 'active', next, new Date(now).toISOString(), id]);
    this.d.audit.record({ kind: 'schedule.paused', decision: paused ? 'paused' : 'resumed', detail: { id } });
    this.changed();
    return this.get(id);
  }

  delete(id: string): boolean {
    const n = this.d.db.run('DELETE FROM schedules WHERE id = ?', [id]).changes;
    if (n) {
      this.d.audit.record({ kind: 'schedule.deleted', decision: 'deleted', detail: { id } });
      this.changed();
    }
    return n > 0;
  }

  /** Items whose title or text matches the user's words ("the email one"). */
  find(query: string): ScheduledItem[] {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    if (!words.length) return [];
    return this.list().filter((s) => s.state !== 'done' && words.some((w) => `${s.title} ${s.text}`.toLowerCase().includes(w)));
  }

  /** Startup: runs what came due while Keo was closed (once each, late), then waits for the next item. */
  start(): number {
    this.running = true;
    const n = this.tick();
    if (n) this.d.log.info('schedule.caught_up', { items: n });
    return n;
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs every active item that is due now; returns how many ran. */
  tick(): number {
    const now = this.now();
    const due = this.d.db.all<Row>("SELECT * FROM schedules WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", [new Date(now).toISOString()]);
    for (const r of due) this.fire(this.view(r), now);
    const cutoff = new Date(now - KEEP_DONE_MS).toISOString();
    const pruned = this.d.db.run("DELETE FROM schedules WHERE state = 'done' AND updated_at < ?", [cutoff]).changes;
    if (due.length || pruned) this.changed();
    this.arm();
    return due.length;
  }

  private fire(item: ScheduledItem, now: number): void {
    const late = now - Date.parse(item.nextRunAt!) > LATE_MS;
    let status = late ? 'late' : 'on_time';
    try {
      if (item.kind === 'reminder') this.d.remind(item, late);
      else this.d.runRoutine(item, late);
    } catch (e) {
      status = `failed: ${(e as Error).message}`.slice(0, 300);
      this.d.log.warn('schedule.fire_failed', { id: item.id, error: (e as Error).message });
    }
    // The next run is strictly after now: missed repeats are skipped, not replayed.
    const next = item.recurrence.every === 'once' ? null : occurrenceAtOrAfter(item.recurrence, new Date(item.at), now + 1);
    this.d.db.run('UPDATE schedules SET state = ?, next_run_at = ?, last_run_at = ?, last_status = ?, runs = runs + 1, updated_at = ? WHERE id = ?', [
      next === null ? 'done' : 'active',
      next === null ? null : new Date(next).toISOString(),
      new Date(now).toISOString(),
      status,
      new Date(now).toISOString(),
      item.id,
    ]);
    this.d.audit.record({ kind: 'schedule.ran', decision: status.startsWith('failed') ? 'failed' : status, detail: { id: item.id, kind: item.kind } });
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    const r = this.d.db.get<{ t: string | null }>("SELECT min(next_run_at) AS t FROM schedules WHERE state = 'active'");
    const wait = r?.t ? Math.max(0, Date.parse(r.t) - this.now()) : MAX_WAIT_MS;
    this.timer = setTimeout(() => this.tick(), Math.min(wait, MAX_WAIT_MS) + 50);
    this.timer.unref?.();
  }

  private changed(): void {
    this.arm();
    this.d.changed();
  }

  /** System-prompt text for the user's own turns: what is scheduled. */
  statusContext(): string {
    const items = this.list().filter((s) => s.state !== 'done').slice(0, 12);
    if (!items.length) return '';
    const line = (s: ScheduledItem) =>
      `- ${s.id} ${s.kind} “${s.title}”: ${s.repeatText}${s.state === 'paused' ? ', paused' : s.nextRunAt ? `, next ${whenText(new Date(s.nextRunAt))}` : ''}`;
    return `\n\n# Scheduled reminders and routines\n${items.map(line).join('\n')}\nUse reminders__cancel to remove one the user names.`;
  }
}

const STOP_WORDS = new Set(['the', 'one', 'that', 'this', 'cancel', 'delete', 'remove', 'stop', 'please', 'reminder', 'reminders', 'routine', 'remind', 'every', 'and', 'for', 'with', 'about', 'my']);
