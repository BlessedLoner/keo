/**
 * Working on multi-step requests: the checklist the model keeps (plan__update),
 * the guard against repeating the same call, shortening older tool results on
 * long runs, and the check before a reply may call the work finished. All of it
 * is local bookkeeping: none of it makes a model call of its own.
 */
import type { PlanStep, ToolActivity, WorkPlan } from '../../shared/domain';
import type { NeutralMessage, ToolCall, ToolSpec } from '../providers/types';

/** The checklist tool. Handled by the agent loop itself, never by the capability registry. */
export const PLAN_TOOL = 'plan__update';

export const PLAN_TOOL_SPEC: ToolSpec = {
  name: PLAN_TOOL,
  description:
    'Show the user your working checklist for a request that needs several steps or tools, and keep it current. Send the whole list each time: 2–8 short steps, each with a status. Call it in the same reply as your first action, then again as steps finish or fail (record key facts you found in the step note). Never use it for a simple question or a single action. It does not run anything and is not an approval (when the user wants to approve a plan before anything runs, that is task__propose_plan instead — never both).',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the user will have when this is finished, in one line (send it with the first plan).' },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative step, e.g. "Find the cheapest flight".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'] },
            note: { type: 'string', description: 'What was found or checked, or why it failed. Required when a step with doneWhen is marked done: say what you saw that meets it.' },
            doneWhen: { type: 'string', description: 'What will show that this step worked, something you can check: "the page check reports no errors", "the speed measured after holding W is above zero", "the message appears in the chat".' },
          },
          required: ['title', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
};

const STATUSES = new Set<PlanStep['status']>(['pending', 'in_progress', 'done', 'failed', 'skipped']);

/** Validates a plan__update input; returns the plan or a reason it was refused. */
export function parsePlan(input: unknown): { plan: WorkPlan } | { error: string } {
  const steps = (input as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { error: 'steps must be a non-empty list.' };
  if (steps.length > 8) return { error: 'Use at most 8 steps; merge small ones.' };
  const out: PlanStep[] = [];
  for (const [i, s] of steps.entries()) {
    const o = (s ?? {}) as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return { error: `Step ${i + 1} needs a title.` };
    if (!STATUSES.has(o.status as PlanStep['status'])) return { error: `Step ${i + 1} has an unknown status.` };
    const note = typeof o.note === 'string' ? o.note.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const doneWhen = typeof o.doneWhen === 'string' ? o.doneWhen.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    out.push({ title: title.slice(0, 120), status: o.status as PlanStep['status'], ...(note ? { note } : {}), ...(doneWhen ? { doneWhen } : {}) });
  }
  const g = (input as { goal?: unknown }).goal;
  const goal = typeof g === 'string' ? g.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  return { plan: { steps: out, ...(goal ? { goal } : {}) } };
}

/** A newer plan keeps the goal and each step's done-when rule from the one before, when it does not repeat them. */
export function carryPlan(prev: WorkPlan | undefined, next: WorkPlan): WorkPlan {
  if (!prev) return next;
  const rules = new Map(prev.steps.filter((s) => s.doneWhen).map((s) => [s.title.toLowerCase(), s.doneWhen!]));
  const steps = next.steps.map((s) => (s.doneWhen || !rules.has(s.title.toLowerCase()) ? s : { ...s, doneWhen: rules.get(s.title.toLowerCase())! }));
  const goal = next.goal ?? prev.goal;
  return { steps, ...(goal ? { goal } : {}) };
}

/** Steps marked done that had a way to tell, but say nothing about what was seen. */
export function unprovenSteps(plan: WorkPlan | undefined): PlanStep[] {
  return (plan?.steps ?? []).filter((s) => s.status === 'done' && s.doneWhen && !s.note);
}

export function openSteps(plan: WorkPlan | undefined): PlanStep[] {
  return (plan?.steps ?? []).filter((s) => s.status === 'pending' || s.status === 'in_progress');
}

const MARK: Record<PlanStep['status'], string> = { pending: '[ ]', in_progress: '[~]', done: '[x]', failed: '[!]', skipped: '[-]' };

export function renderPlan(plan: WorkPlan): string {
  const steps = plan.steps.map((s) => `${MARK[s.status]} ${s.title}${s.doneWhen ? ` (done when: ${s.doneWhen})` : ''}${s.note ? ` — ${s.note}` : ''}`).join('\n');
  return plan.goal ? `Goal: ${plan.goal}\n${steps}` : steps;
}

/** Per-turn instructions for a request that needs several steps (added to the system text for that turn only). */
export function planContext(planned: boolean, plan: WorkPlan | undefined): string {
  if (plan) {
    return `\n\n# Your working plan (shown to the user as a checklist)\n${renderPlan(plan)}\nKeep it current with ${PLAN_TOOL} as steps finish or fail. A step is done only when its "done when" is met by something you saw in a tool result: put that in its note. Before your final answer, every step must be done, failed or skipped, and the goal must be met or you say plainly what is missing.`;
  }
  if (!planned) return '';
  return `\n\n# This request needs several steps\nFirst be sure what the user will have at the end. In your first reply, call ${PLAN_TOOL} with that goal and a short checklist (2–8 steps, each with doneWhen: what will show the step worked, something a tool can check) together with your first action — not on its own. Then work through it: after each action, check its result (the tool's verification, or re-read the window, page or file) before marking the step done. If a step fails, do not repeat the same call: try another tool or different input, or ask the user. Record key facts in step notes, since older tool results are shortened on long runs. Finish with what was done, what was checked, and what is still open.`;
}

// ---------------------------------------------------------------------------
// Repeated calls

export type CallOutcome = ToolActivity['outcome'];

/** Stable signature of a call: tool name plus its input with keys sorted. */
export function callSignature(call: Pick<ToolCall, 'name' | 'input'>): string {
  return `${call.name}:${stable(call.input)}`;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Stops loops: an identical call is refused when the same call already failed
 * (or was rejected, denied, left unanswered or uncertain) in this reply, when it
 * ran in each of the two previous rounds, or when it already ran three times.
 */
export class RepeatGuard {
  private readonly seen = new Map<string, { count: number; lastOutcome: CallOutcome; lastRound: number; streak: number }>();
  blocked = 0;

  check(call: ToolCall, round: number): string | null {
    const s = this.seen.get(callSignature(call));
    if (!s) return null;
    let reason: string | null = null;
    if (s.lastOutcome !== 'executed' && s.lastOutcome !== 'proposed') {
      reason = `This exact call already ended "${s.lastOutcome}" earlier in this reply, so Keo did not send it again. Try a different tool or different input, or ask the user what to do.`;
    } else if (s.lastRound === round - 1 && s.streak >= 2) {
      reason = 'This exact call already ran in each of the last two rounds, so Keo did not run it again. Use what it returned, or change approach.';
    } else if (s.count >= 3) {
      reason = 'This exact call already ran three times in this reply, so Keo did not run it again. Use the earlier results, or change approach.';
    }
    // A refused attempt still counts toward the streak, so asking every round stays refused.
    if (reason && s.lastRound !== round) {
      s.streak = s.lastRound === round - 1 ? s.streak + 1 : 1;
      s.lastRound = round;
    }
    return reason;
  }

  /** Calls that only look (read a file, list, check): looking again after something changed is not a loop. */
  private readonly looks = new Set<string>();

  record(call: ToolCall, round: number, outcome: CallOutcome, readOnly = false): void {
    const key = callSignature(call);
    if (readOnly) this.looks.add(key);
    else if (outcome === 'executed') {
      // Something changed (a file written, a click made): what was read before may read differently now.
      for (const k of this.looks) this.seen.delete(k);
      this.looks.clear();
    }
    const s = this.seen.get(key);
    if (!s) {
      this.seen.set(key, { count: 1, lastOutcome: outcome, lastRound: round, streak: 1 });
      return;
    }
    s.streak = s.lastRound === round - 1 ? s.streak + 1 : s.lastRound === round ? s.streak : 1;
    s.count++;
    s.lastOutcome = outcome;
    s.lastRound = round;
  }
}

// ---------------------------------------------------------------------------
// Keeping the context sharp on long runs

const KEEP_RESULT_CHARS = 600;

function blockChars(b: NeutralMessage['content'][number]): number {
  switch (b.type) {
    case 'text':
      return b.text.length;
    case 'tool_result':
      return b.content.length;
    case 'tool_call':
      return JSON.stringify(b.input ?? null).length + b.name.length;
    default:
      return 1000;
  }
}

export function messageChars(messages: NeutralMessage[], from = 0): number {
  let n = 0;
  for (const m of messages.slice(from)) for (const b of m.content) n += blockChars(b);
  return n;
}

/** A short, deterministic stand-in for a long tool result: status, error, verification and the first facts. */
export function summariseResult(content: string): string {
  let head = content;
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    const keep: string[] = [];
    for (const k of ['status', 'code', 'error', 'verification', 'verificationDetail']) if (o[k] !== undefined && o[k] !== null) keep.push(`${k}: ${String(o[k]).slice(0, 200)}`);
    const rest = o.result === undefined ? '' : JSON.stringify(o.result);
    head = `${keep.join('; ')}${rest ? `; result starts: ${rest}` : ''}`;
  } catch {
    /* not JSON: keep the beginning as it is */
  }
  return `[Older tool result shortened by Keo to keep the context small (${content.length.toLocaleString('en-US')} chars). ${head.slice(0, KEEP_RESULT_CHARS)}${head.length > KEEP_RESULT_CHARS ? '…' : ''} — call the tool again if you need the full text.]`;
}

/**
 * When the tool rounds of this turn grow past the budget, shortens every tool
 * result except the latest round's. The user's request, the model's own text
 * and the plan (in the system text) stay whole. Returns how many were shortened.
 */
export function compactTurn(messages: NeutralMessage[], turnStart: number, budgetChars: number): number {
  if (messageChars(messages, turnStart) <= budgetChars) return 0;
  let lastResults = -1;
  for (let i = messages.length - 1; i >= turnStart; i--) {
    if (messages[i]?.content.some((b) => b.type === 'tool_result')) {
      lastResults = i;
      break;
    }
  }
  let n = 0;
  for (let i = turnStart; i < messages.length; i++) {
    if (i === lastResults) continue;
    for (const b of messages[i]!.content) {
      if (b.type !== 'tool_result' || b.content.length <= KEEP_RESULT_CHARS * 2 || b.content.startsWith('[Older tool result shortened')) continue;
      b.content = summariseResult(b.content);
      n++;
    }
  }
  return n;
}

/** Tools whose inputs carry whole files or long edits (resent on every later step otherwise). */
const BULKY_CALLS = /^(build__(write|append|edit)|files__write|create__\w+|studio__edit|picture__edit)$/;
const BULKY_FIELD_CHARS = 1500;

/**
 * Long builds resend every earlier file they wrote, inside the old tool calls, on every step. Tool calls
 * older than the last `keep` steps of this turn have their long text fields (file contents, long edits)
 * replaced by a short note: the result already said what was written, and the file is on disk.
 * Returns how many fields were shortened.
 */
export function shrinkOldCalls(messages: NeutralMessage[], turnStart: number, keep = 2): number {
  const steps: number[] = [];
  for (let i = turnStart; i < messages.length; i++) if (messages[i]!.role === 'assistant' && messages[i]!.content.some((b) => b.type === 'tool_call')) steps.push(i);
  const old = new Set(steps.slice(0, Math.max(0, steps.length - keep)));
  let n = 0;
  const shrink = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length <= BULKY_FIELD_CHARS || v.startsWith('[Sent earlier')) return v;
      n++;
      return `[Sent earlier: ${v.length} characters. Read the file again if you need it.]`;
    }
    if (depth > 4 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => shrink(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shrink(x, depth + 1)]));
  };
  for (const i of old)
    for (const b of messages[i]!.content) if (b.type === 'tool_call' && BULKY_CALLS.test(b.name)) b.input = shrink(b.input, 0) as typeof b.input;
  return n;
}

// ---------------------------------------------------------------------------
// Finishing properly

/** Says the whole job is finished. Negated or partial wording does not count. */
const SUCCESS = /\b(all done|done|completed?|finished|success(ful(ly)?)?|all set|everything (is|went) (set|ready|fine|well)|it worked|worked)\b/i;
const HEDGED = /\b(not|n't|couldn't|could not|unable|failed|failure|didn't|did not|wasn't|unverified|not verified|couldn't confirm|could not confirm|partly|partially|except|but|however|still (open|pending|to do)|remaining|left to do|open)\b/i;

/** A consequential action that has not been shown to work (and no later action made up for it). */
export interface Problem {
  activity: ToolActivity;
  why: 'failed' | 'uncertain' | 'unverified';
}

export interface FinishIssue {
  open: PlanStep[];
  problems: Problem[];
  /** Steps called done without a word on what showed it. */
  unproven: PlanStep[];
}

/**
 * Before a reply may end: are there plan steps nobody finished, or a failed,
 * uncertain or unverified action while the reply announces success without a
 * word about it? Returns null when the reply may stand.
 */
export function finishIssues(reply: string, plan: WorkPlan | undefined, problems: Problem[]): FinishIssue | null {
  const open = openSteps(plan);
  const claimsSuccess = SUCCESS.test(reply) && !HEDGED.test(reply);
  const unmentioned = claimsSuccess ? problems : [];
  const unproven = unprovenSteps(plan);
  if (!open.length && !unmentioned.length && !unproven.length) return null;
  return { open, problems: unmentioned, unproven };
}

export function describeProblems(problems: Problem[]): string {
  return problems.map((p) => `${p.activity.summary} (${p.why})`).join('; ');
}

export function finishNote(issue: FinishIssue): string {
  const parts: string[] = [];
  if (issue.open.length) parts.push(`your plan still has open steps: ${issue.open.map((s) => `"${s.title}"`).join(', ')}`);
  if (issue.problems.length) parts.push(`these actions did not succeed or could not be verified: ${describeProblems(issue.problems)}`);
  if (issue.unproven.length) parts.push(`these steps are marked done but nothing says what showed it: ${issue.unproven.map((s) => `"${s.title}" (done when: ${s.doneWhen})`).join(', ')} — check each one now and record what you saw in its note, or mark it failed`);
  return `[Keo application note — not typed by the user] Before you finish: ${parts.join(', and ')}. Do not call the work done. Either continue (try a different tool or input for what failed, or re-check the result), or tell the user plainly what was done, what was verified, and what is still open, and update ${PLAN_TOOL} so no step is left pending.`;
}
