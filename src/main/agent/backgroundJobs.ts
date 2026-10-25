import { z } from 'zod';
import type { BackgroundJob, Message } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { CapabilityError, defineCapability, type AnyCapability } from '../capabilities/types';
import type { Logger } from '../logging/logger';
import type { AuditRepo } from '../repos/audit';
import type { ConversationRepo } from '../repos/conversations';
import { nowIso } from '../util/errors';
import { newId } from '../util/ids';

const TERMINAL = new Set<BackgroundJob['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const KEEP_JOBS = 50;
const KEEP_HIDDEN = 2000;

/**
 * One owner of the mouse and keyboard across background jobs and the user's
 * own turns. A job keeps it from its first desktop action until it ends, so two
 * jobs never drive the desktop in turns; jobs that only use the web, files or
 * ffmpeg never ask for it and run side by side.
 */
export class DesktopLease {
  private owner: string | null = null;
  private readonly queue: Array<{ owner: string; resolve: () => void }> = [];

  holder(): string | null {
    return this.owner;
  }

  async acquire(owner: string, signal?: AbortSignal): Promise<void> {
    if (this.owner === owner) return;
    if (this.owner === null && !this.queue.length) {
      this.owner = owner;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const w = { owner, resolve };
      this.queue.push(w);
      const abort = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new CapabilityError('cancelled', 'Cancelled while waiting for another job to finish with the desktop.', { dispatched: 'no' }));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  release(owner: string): void {
    if (this.owner !== owner) {
      const i = this.queue.findIndex((w) => w.owner === owner);
      if (i >= 0) this.queue.splice(i, 1);
      return;
    }
    const next = this.queue.shift();
    this.owner = next?.owner ?? null;
    next?.resolve();
  }
}

export interface BackgroundJobDeps {
  conversations: ConversationRepo;
  /** Runs one turn in the job's conversation (AgentService.send / cancel), resolved lazily. */
  agent: () => {
    send(conversationId: string, text: string, opts: { background: true }): { done: Promise<Message> };
    cancel(conversationId: string): boolean;
  };
  getSettings: () => Settings;
  audit: AuditRepo;
  log: Logger;
  /** Where jobs are kept across restarts (Services sets a file in the profile; tests may omit it). */
  store?: { load(): { jobs: BackgroundJob[]; hidden: string[] } | null; save(all: { jobs: BackgroundJob[]; hidden: string[] }): void };
  /** A job finished, failed or was cancelled; its report is already in the parent conversation. */
  finished(job: BackgroundJob, report: Message | null): void;
  changed(): void;
}

export interface StartJob {
  title: string;
  brief: string;
  kind: BackgroundJob['kind'];
  parentConversationId: string;
  /** The scheduled routine that started this job (its consequential actions are never pre-approved). */
  scheduleId?: string | null;
}

/**
 * Background jobs: a long request (research, a video edit, reading many pages)
 * runs as its own agent run in a hidden conversation, with the same provider,
 * tools and approval rules as a normal turn, while the user's conversation
 * stays free. Up to `agent.maxBackgroundJobs` run at once; more wait in order.
 * When a job ends, its report goes into the conversation that started it.
 */
export class BackgroundJobs {
  readonly lease = new DesktopLease();
  private jobs: BackgroundJob[] = [];
  /** Every job conversation Keo made (hidden from the conversation list). */
  private hidden = new Set<string>();
  private loaded = false;
  private closing = false;

  constructor(private readonly d: BackgroundJobDeps) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = this.d.store?.load();
      if (saved) {
        this.jobs = Array.isArray(saved.jobs) ? saved.jobs.filter((j) => j && typeof j.id === 'string' && typeof j.conversationId === 'string') : [];
        this.hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter((x) => typeof x === 'string') : []);
      }
    } catch {
      /* unreadable file: start without jobs */
    }
    for (const j of this.jobs) this.hidden.add(j.conversationId);
  }

  private save(): void {
    this.jobs = this.jobs.slice(-KEEP_JOBS);
    const hidden = [...this.hidden].slice(-KEEP_HIDDEN);
    this.hidden = new Set(hidden);
    try {
      this.d.store?.save({ jobs: this.jobs, hidden });
    } catch (e) {
      this.d.log.warn('jobs.save_failed', { error: (e as Error).name });
    }
    this.d.changed();
  }

  /** Newest first. */
  list(): BackgroundJob[] {
    this.load();
    return [...this.jobs].reverse().map((j) => ({ ...j }));
  }

  get(id: string): BackgroundJob | null {
    this.load();
    const j = this.jobs.find((x) => x.id === id);
    return j ? { ...j } : null;
  }

  active(): BackgroundJob[] {
    return this.list().filter((j) => !TERMINAL.has(j.state));
  }

  isJobConversation(conversationId: string | null | undefined): boolean {
    this.load();
    return !!conversationId && this.hidden.has(conversationId);
  }

  private byConversation(conversationId: string): BackgroundJob | undefined {
    this.load();
    return this.jobs.find((j) => j.conversationId === conversationId);
  }

  /**
   * The conversation whose user messages count as "what the user said" for a
   * turn. A job's brief is written by the model, so a job reads its parent's.
   */
  userConversation(conversationId: string): string {
    return this.byConversation(conversationId)?.parentConversationId ?? conversationId;
  }

  start(i: StartJob): BackgroundJob {
    this.load();
    if (this.closing) throw new CapabilityError('closing', 'Keo is closing.');
    const job: BackgroundJob = {
      id: newId('job_'),
      title: i.title.replace(/\s+/g, ' ').trim().slice(0, 80),
      kind: i.kind,
      parentConversationId: i.parentConversationId,
      conversationId: '',
      state: 'queued',
      waitingForDesktop: false,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      scheduleId: i.scheduleId ?? null,
    };
    const conv = this.d.conversations.create(`Background job: ${job.title}`, this.d.conversations.get(i.parentConversationId)?.projectId ?? null);
    job.conversationId = conv.id;
    this.hidden.add(conv.id);
    this.jobs.push(job);
    this.briefs.set(job.id, i.brief);
    this.d.audit.record({ kind: 'jobs.started', decision: 'queued', detail: { jobId: job.id, kind: job.kind } });
    this.d.log.info('jobs.queued', { jobId: job.id, kind: job.kind });
    this.save();
    this.pump();
    return { ...this.jobs.find((j) => j.id === job.id)! };
  }

  /** Briefs of jobs that have not started yet (kept in memory; a restart interrupts queued jobs anyway). */
  private readonly briefs = new Map<string, string>();

  private running(): number {
    return this.jobs.filter((j) => j.state === 'running').length;
  }

  private pump(): void {
    const max = this.d.getSettings().agent.maxBackgroundJobs;
    for (let next = this.jobs.find((j) => j.state === 'queued'); next && this.running() < max && !this.closing; next = this.jobs.find((j) => j.state === 'queued')) {
      this.run(next);
    }
  }

  private run(job: BackgroundJob): void {
    const brief = this.briefs.get(job.id) ?? job.title;
    this.briefs.delete(job.id);
    job.state = 'running';
    job.startedAt = nowIso();
    this.save();
    let sent: { done: Promise<Message> };
    try {
      sent = this.d.agent().send(job.conversationId, brief, { background: true });
    } catch (e) {
      this.settle(job, null, (e as Error).message);
      return;
    }
    this.d.log.info('jobs.started', { jobId: job.id, kind: job.kind });
    sent.done.then(
      (m) => this.settle(job, m, null),
      (e) => this.settle(job, null, (e as Error).message),
    );
  }

  private readonly settled = new Set<string>();

  private settle(job: BackgroundJob, m: Message | null, thrown: string | null): void {
    if (this.settled.has(job.id)) return;
    this.settled.add(job.id);
    this.lease.release(job.id);
    job.waitingForDesktop = false;
    job.finishedAt = nowIso();
    if (this.closing) job.state = 'interrupted';
    else if (job.state !== 'cancelled') {
      if (m?.status === 'complete') {
        job.state = 'completed';
        job.result = m.content.trim().slice(0, 20_000) || 'Done.';
      } else if (m?.status === 'cancelled') job.state = 'cancelled';
      else {
        job.state = 'failed';
        job.error = (thrown ?? m?.meta.error ?? 'The job stopped without a result.').slice(0, 1000);
      }
    }
    this.d.log.info('jobs.finished', { jobId: job.id, state: job.state });
    this.d.audit.record({ kind: 'jobs.finished', decision: job.state, detail: { jobId: job.id } });
    this.save();
    if (!this.closing) this.d.finished({ ...job }, this.report(job));
    this.pump();
  }

  /** Posts the job's outcome in the conversation that started it. */
  private report(job: BackgroundJob): Message | null {
    if (!this.d.conversations.get(job.parentConversationId)) return null;
    const content =
      job.state === 'completed'
        ? `**Background job done — ${job.title}**\n\n${job.result ?? ''}`
        : job.state === 'cancelled'
          ? `**Background job stopped — ${job.title}.** Nothing more will run for it.`
          : job.state === 'interrupted'
            ? `**Background job interrupted — ${job.title}.** Keo was closed while it ran; it was not restarted. Ask again to run it.`
            : `**Background job failed — ${job.title}.** ${job.error ?? ''}`;
    try {
      return this.d.conversations.addMessage({ conversationId: job.parentConversationId, role: 'assistant', content, status: 'complete', meta: { jobId: job.id } });
    } catch {
      return null; // the conversation was deleted meanwhile
    }
  }

  cancel(id: string): boolean {
    this.load();
    const job = this.jobs.find((j) => j.id === id);
    if (!job || TERMINAL.has(job.state)) return false;
    const wasRunning = job.state === 'running';
    job.state = 'cancelled';
    this.d.audit.record({ kind: 'jobs.cancelled', decision: 'cancelled', detail: { jobId: job.id } });
    if (wasRunning) {
      // The turn ends as cancelled (its waiting approvals are withdrawn); settle() posts the report.
      if (!this.d.agent().cancel(job.conversationId)) this.settle(job, null, null);
      else this.save();
    } else {
      this.briefs.delete(job.id);
      this.settle(job, null, null);
    }
    return true;
  }

  cancelAll(): number {
    let n = 0;
    for (const j of this.active()) if (this.cancel(j.id)) n++;
    return n;
  }

  /** Jobs whose title or brief kind matches the user's words ("the video one"). */
  find(query: string): BackgroundJob[] {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    if (!words.length) return [];
    return this.active().filter((j) => {
      const hay = `${j.title} ${j.kind}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
  }

  /**
   * Called before a desktop-driving action in any turn. A job keeps the desktop
   * until it ends (returns null); the user's own turn holds it for one action
   * (returns the release).
   */
  async desktopGate(conversationId: string, signal: AbortSignal): Promise<(() => void) | null> {
    const job = this.byConversation(conversationId);
    if (job) {
      if (this.lease.holder() !== job.id) {
        job.waitingForDesktop = this.lease.holder() !== null;
        if (job.waitingForDesktop) this.save();
        try {
          await this.lease.acquire(job.id, signal);
        } finally {
          if (job.waitingForDesktop) {
            job.waitingForDesktop = false;
            this.save();
          }
        }
      }
      return null;
    }
    const owner = `turn:${conversationId}`;
    await this.lease.acquire(owner, signal);
    return () => this.lease.release(owner);
  }

  /** True when this conversation belongs to a job started by a scheduled routine. */
  isRoutineConversation(conversationId: string | null | undefined): boolean {
    return !!conversationId && !!this.byConversation(conversationId)?.scheduleId;
  }

  /** Startup: jobs that were running or queued when Keo closed are reported as interrupted, never replayed. */
  recover(): number {
    this.load();
    const stale = this.jobs.filter((j) => !TERMINAL.has(j.state));
    for (const j of stale) {
      j.state = 'interrupted';
      j.finishedAt = nowIso();
      j.waitingForDesktop = false;
      this.report(j);
    }
    if (stale.length) this.save();
    return stale.length;
  }

  shutdown(): void {
    this.closing = true;
    for (const j of this.jobs) if (j.state === 'running') this.d.agent().cancel(j.conversationId);
  }

  /** System-prompt text for a turn inside a job's own conversation. */
  jobContext(conversationId: string): string {
    const job = this.byConversation(conversationId);
    if (!job) return '';
    if (job.scheduleId)
      return `\n\n# Background job\nYou are running the scheduled routine “${job.title}” for the user, at the time they set. The user is not watching this conversation and cannot answer questions here; the request below is the instruction they scheduled. Do it with your tools, then reply with a short report of the result. Anything that sends, buys, deletes or changes something for the user still asks them for approval now, as usual — it was not approved in advance; if it is denied or not answered, say so in the report. If something essential is missing, say so in the report instead of guessing. Do not start other background jobs or schedule anything.`;
    return `\n\n# Background job\nYou are running the background job “${job.title}” for the user. The user is not watching this conversation and cannot answer questions here; the request below was written by Keo from the user's words. Do the whole job with your tools (actions still ask the user for approval as usual), then reply with a short report of the result: what you found or made, where it is saved, and anything that did not work. Keo posts that reply to the user. If something essential is missing, say so in the report instead of guessing. Do not start other background jobs.`;
  }

  /** System-prompt text for the user's own turns: what is running now. */
  statusContext(): string {
    const active = this.active();
    const recent = this.list()
      .filter((j) => TERMINAL.has(j.state) && j.finishedAt && Date.now() - Date.parse(j.finishedAt) < 30 * 60_000)
      .slice(0, 3);
    if (!active.length && !recent.length) return '';
    const line = (j: BackgroundJob) => `- ${j.id} “${j.title}” (${j.kind}): ${j.state}${j.waitingForDesktop ? ', waiting for the desktop' : ''}`;
    return `\n\n# Background jobs\n${[...active, ...recent].map(line).join('\n')}\nUse jobs__cancel to stop one the user names. Their reports appear in the conversation when they finish; do not repeat or invent their results.`;
  }
}

const STOP_WORDS = new Set(['the', 'one', 'job', 'jobs', 'that', 'this', 'stop', 'cancel', 'please', 'background', 'task', 'and', 'for', 'with']);

export function backgroundJobCapabilities(jobs: () => BackgroundJobs): AnyCapability[] {
  const jobView = z.object({ id: z.string(), title: z.string(), kind: z.string(), state: z.string(), waitingForDesktop: z.boolean(), startedAt: z.string().nullable(), finishedAt: z.string().nullable() });
  const view = (j: BackgroundJob) => ({ id: j.id, title: j.title, kind: j.kind, state: j.state, waitingForDesktop: j.waitingForDesktop, startedAt: j.startedAt, finishedAt: j.finishedAt });

  const start = defineCapability({
    id: 'jobs.start_background',
    version: '1.0.0',
    title: 'Start a background job',
    description:
      'Runs a long request in the background so the user can keep talking to you: research that needs several searches and pages, video planning or rendering (video__*), reading many pages or files, or anything you expect to take more than a few seconds or many tool calls. The job is done by another Keo run that sees ONLY the brief, so write a complete, self-contained brief: the goal, every detail the user gave (names, files, folders, preferences, quotes of their words), and what the result should be. It has the same tools and approval rules as you. After calling this, tell the user in one short sentence that you are on it and will report when it is done; do not do the work yourself as well and do not guess its result. Not for quick questions or single actions.',
    input: z
      .object({
        title: z.string().trim().min(3).max(80),
        brief: z.string().trim().min(10).max(6000),
        kind: z.enum(['research', 'video', 'reading', 'other']),
      })
      .strict(),
    output: z.object({ jobId: z.string(), status: z.enum(['running', 'queued']), running: z.number(), queued: z.number(), note: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 10_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The job itself runs every action through the usual approvals.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Start a background job: ${i.title}`, target: null, consequences: ['Keo works on it in the background and reports when it is done.'], dataExport: null }),
    auditView: (i) => ({ kind: i.kind }),
    async execute(i, ctx) {
      const m = jobs();
      if (!ctx.conversationId) throw new CapabilityError('no_conversation', 'Background jobs can be started only from a conversation.');
      if (m.isJobConversation(ctx.conversationId)) throw new CapabilityError('nested_job', 'A background job cannot start another background job. Do this part of the work here.');
      const job = m.start({ title: i.title, brief: i.brief, kind: i.kind, parentConversationId: ctx.conversationId });
      const active = m.active();
      const status = job.state === 'running' ? ('running' as const) : ('queued' as const);
      return {
        jobId: job.id,
        status,
        running: active.filter((j) => j.state === 'running').length,
        queued: active.filter((j) => j.state === 'queued').length,
        note: status === 'running' ? 'Started. Tell the user briefly that you are on it and will report when it is done.' : 'Queued behind other running jobs; it starts when one finishes. Tell the user briefly.',
      };
    },
  });

  const list = defineCapability({
    id: 'jobs.list',
    version: '1.0.0',
    title: 'List background jobs',
    description: 'Lists Keo’s background jobs (running, queued and recently finished) with their state. Use it when the user asks what you are working on.',
    input: z.object({}).strict(),
    output: z.object({ jobs: z.array(jobView) }),
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
    preview: () => ({ summary: 'List background jobs', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { jobs: jobs().list().slice(0, 10).map(view) };
    },
  });

  const cancel = defineCapability({
    id: 'jobs.cancel',
    version: '1.0.0',
    title: 'Stop a background job',
    description: 'Stops a running or queued background job the user wants stopped ("stop the video one"). Give its jobId, or words from its title as query; if several match, ask the user which one.',
    input: z
      .object({ jobId: z.string().trim().min(3).max(80).optional(), query: z.string().trim().min(2).max(200).optional() })
      .strict(),
    output: z.object({ cancelled: z.array(jobView) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Stopping only withdraws Keo’s own work; actions already done stay done.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Stop background job ${i.jobId ?? `“${i.query}”`}`, target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i, ctx) {
      const m = jobs();
      if (m.isJobConversation(ctx.conversationId)) throw new CapabilityError('nested_job', 'A background job cannot stop other jobs.');
      if (!i.jobId && !i.query) throw new CapabilityError('invalid_input', 'Give the jobId or words from the job’s title.');
      const byId = i.jobId ? m.get(i.jobId) : null;
      const hits = byId ? [byId] : i.query ? m.find(i.query) : [];
      if (!hits.length) throw new CapabilityError('not_found', `No running or queued background job matches. Running: ${m.active().map((j) => `“${j.title}” (${j.id})`).join(', ') || 'none'}.`);
      if (hits.length > 1) throw new CapabilityError('ambiguous_target', `Several jobs match: ${hits.map((j) => `“${j.title}” (${j.id})`).join(', ')}. Ask the user which one.`);
      const job = hits[0]!;
      if (!m.cancel(job.id)) throw new CapabilityError('already_finished', `“${job.title}” has already ${job.state}.`);
      return { cancelled: [view(m.get(job.id)!)] };
    },
  });

  return [start, list, cancel];
}
