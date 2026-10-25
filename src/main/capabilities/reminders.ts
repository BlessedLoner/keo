import { z } from 'zod';
import type { ScheduledItem } from '../../shared/domain';
import { normalizeRecurrence, whenText, type Scheduler } from '../schedule/scheduler';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

export interface ReminderDeps {
  scheduler: Scheduler;
  /** True for a background job's own conversation (jobs may not schedule anything). */
  isJobConversation(conversationId: string | null): boolean;
}

const WEEKDAY = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
/** A local date and time as the model writes it: 2026-10-26T09:00 (optionally with seconds or an offset). */
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

const itemView = z.object({
  id: z.string(),
  kind: z.enum(['reminder', 'routine']),
  title: z.string(),
  text: z.string(),
  repeat: z.string(),
  state: z.enum(['active', 'paused', 'done']),
  nextRun: z.string().nullable(),
  lastRun: z.string().nullable(),
  lastStatus: z.string().nullable(),
});

function view(s: ScheduledItem): z.infer<typeof itemView> {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    text: s.text,
    repeat: s.repeatText,
    state: s.state,
    nextRun: s.nextRunAt ? whenText(new Date(s.nextRunAt)) : null,
    lastRun: s.lastRunAt ? whenText(new Date(s.lastRunAt)) : null,
    lastStatus: s.lastStatus,
  };
}

/** The exact time to say back to the user: "Monday 26 October, 17:00" or "every Monday at 9:00 (first: Monday 26 October, 9:00)". */
function confirmText(s: ScheduledItem): string {
  const next = s.nextRunAt ? whenText(new Date(s.nextRunAt)) : '';
  return s.recurrence.every === 'once' ? next : `${s.repeatText} (first: ${next})`;
}

export function reminderCapabilities(d: ReminderDeps): AnyCapability[] {
  const create = defineCapability({
    id: 'reminders.create',
    version: '1.0.0',
    title: 'Schedule a reminder or routine',
    description:
      'Schedules something for later, in the user’s local time. kind "reminder": at the time Keo shows a Windows notification with `text` (spoken too in a voice conversation) and posts it here ("remind me at 5 to call Ana" → text "Call Ana"). kind "routine": at each time Keo runs `text` as an instruction in a background job ("every Monday at 9, summarize my unread email and what’s on my calendar"); write it as a complete, self-contained instruction, because the job sees only that text. `at` is the first time as a local ISO date-time without offset, e.g. 2026-10-26T17:00, worked out from "Current local time"; `repeat` is {every:"once"}, {every:"day"}, {every:"week", days:["mon",…]} or {every:"hours", hours:N} (day and week keep the time of day of `at`). Afterwards tell the user the exact time from the result’s `confirm` (e.g. "Monday 9:00 every week"). A routine’s actions that send, buy or delete still ask the user for approval when it runs; never promise they will happen on their own.',
    input: z
      .object({
        kind: z.enum(['reminder', 'routine']),
        title: z.string().trim().min(2).max(80),
        text: z.string().trim().min(2).max(4000),
        at: z.string().trim().regex(ISO_LOCAL, 'Use a local ISO date-time such as 2026-10-26T17:00.'),
        repeat: z
          .object({
            every: z.enum(['once', 'day', 'week', 'hours']),
            days: z.array(WEEKDAY).max(7).optional(),
            hours: z.number().int().min(1).max(168).optional(),
          })
          .strict(),
      })
      .strict(),
    output: z.object({ id: z.string(), kind: z.enum(['reminder', 'routine']), title: z.string(), repeat: z.string(), nextRun: z.string(), confirm: z.string(), note: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 5_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Saved in Keo’s database; a routine’s actions still go through the usual approvals each time it runs.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Schedule ${i.kind === 'routine' ? 'a routine' : 'a reminder'}: ${i.title}`, target: null, consequences: [i.kind === 'routine' ? 'Keo runs the instruction in the background at each time; anything consequential still asks you.' : 'Keo notifies you at that time.'], dataExport: null }),
    auditView: (i) => ({ kind: i.kind, every: i.repeat.every }),
    async execute(i, ctx) {
      if (!ctx.conversationId) throw new CapabilityError('no_conversation', 'Reminders can be scheduled only from a conversation.');
      if (d.isJobConversation(ctx.conversationId)) throw new CapabilityError('nested_job', 'A background job or routine cannot schedule reminders or routines.');
      const recurrence = normalizeRecurrence(i.repeat);
      const item = d.scheduler.create({ kind: i.kind, title: i.title, text: i.text, conversationId: ctx.conversationId, at: new Date(i.at), recurrence });
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        repeat: item.repeatText,
        nextRun: whenText(new Date(item.nextRunAt!)),
        confirm: confirmText(item),
        note: 'Scheduled. Tell the user the exact time from `confirm` in one short sentence, so they can correct it.',
      };
    },
  });

  const list = defineCapability({
    id: 'reminders.list',
    version: '1.0.0',
    title: 'List reminders and routines',
    description: 'Lists the user’s scheduled reminders and routines with their repeat, next run and last result. Use it for "what reminders do I have?".',
    input: z.object({}).strict(),
    output: z.object({ items: z.array(itemView) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'List reminders and routines', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { items: d.scheduler.list().slice(0, 30).map(view) };
    },
  });

  const cancel = defineCapability({
    id: 'reminders.cancel',
    version: '1.0.0',
    title: 'Cancel a reminder or routine',
    description: 'Deletes a scheduled reminder or routine the user wants gone ("cancel the Monday email one"). Give its id, or words from its title as query; if several match, ask the user which one.',
    input: z.object({ id: z.string().trim().min(3).max(80).optional(), query: z.string().trim().min(2).max(200).optional() }).strict(),
    output: z.object({ cancelled: itemView }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Removes Keo’s own schedule entry; nothing outside Keo changes.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Cancel scheduled item ${i.id ?? `“${i.query}”`}`, target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i, ctx) {
      if (d.isJobConversation(ctx.conversationId)) throw new CapabilityError('nested_job', 'A background job or routine cannot cancel scheduled items.');
      if (!i.id && !i.query) throw new CapabilityError('invalid_input', 'Give the id or words from the title.');
      const byId = i.id ? d.scheduler.get(i.id) : null;
      const hits = byId ? [byId] : i.query ? d.scheduler.find(i.query) : [];
      const names = (xs: ScheduledItem[]) => xs.map((s) => `“${s.title}” (${s.id})`).join(', ');
      if (!hits.length) throw new CapabilityError('not_found', `Nothing scheduled matches. Scheduled: ${names(d.scheduler.list().filter((s) => s.state !== 'done')) || 'nothing'}.`);
      if (hits.length > 1) throw new CapabilityError('ambiguous_target', `Several items match: ${names(hits)}. Ask the user which one.`);
      const item = hits[0]!;
      d.scheduler.delete(item.id);
      return { cancelled: view(item) };
    },
  });

  return [create, list, cancel];
}
