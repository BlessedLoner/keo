/**
 * How a reply ended, honestly: one of five endings, worked out from what actually happened in the
 * turn (the steps that ran, their checks, the plan), never from what the reply says. Keo never
 * upgrades one ending to a better one.
 *
 * done_checked   finished, and every step that mattered was confirmed
 * done_unchecked finished, but something could not be confirmed (says what to look at)
 * partly_done    some of it was done; says what was not
 * blocked        waiting on the user (an approval, a choice)
 * failed         nothing useful was done, with the reason
 *
 * A plain answer with no steps has no ending: there was no work to account for.
 */
import type { Message, MessageMeta, TurnEnding } from '../../shared/domain';
import type { Problem } from './workPlan';

const list = (items: string[], max = 3) => {
  const shown = items.slice(0, max).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 80));
  return shown.join('; ') + (items.length > max ? ` and ${items.length - max} more` : '');
};

export function turnEnding(status: Message['status'], meta: MessageMeta, problems: Problem[], cut: string | null = null): TurnEnding | undefined {
  const tools = meta.tools ?? [];
  const steps = meta.plan?.steps ?? [];
  if (status === 'error') return { kind: 'failed', why: (meta.error ?? 'Something went wrong.').slice(0, 300) };
  if (!tools.length && !steps.length) return undefined;
  const ran = tools.filter((t) => t.outcome === 'executed').length;
  if (status === 'cancelled') return ran ? { kind: 'partly_done', why: 'You stopped it part-way.' } : { kind: 'failed', why: 'You stopped it before anything was done.' };

  const waiting = tools.filter((t) => t.outcome === 'awaiting_authorization' || t.outcome === 'proposed');
  if (waiting.length) return { kind: 'blocked', why: `Waiting for your approval: ${list(waiting.map((t) => t.summary))}.` };
  const choose = tools.filter((t) => t.outcome !== 'executed' && t.choices?.length);
  if (choose.length) return { kind: 'blocked', why: `Waiting for you to choose: ${list(choose.map((t) => t.summary))}.` };

  // What did not get done.
  const notDone: string[] = [];
  for (const p of problems) if (p.why === 'failed') notDone.push(p.activity.summary);
  for (const s of steps) if (s.status === 'pending' || s.status === 'in_progress' || s.status === 'failed') notDone.push(s.title);
  for (const t of tools) if (t.outcome === 'denied') notDone.push(`${t.summary} (you declined)`);
  if (cut) notDone.push(cut);
  if (notDone.length) return ran ? { kind: 'partly_done', why: `Not done: ${list(notDone)}.` } : { kind: 'failed', why: `Not done: ${list(notDone)}.` };

  // Done, but was it confirmed?
  const unsure: string[] = [];
  for (const p of problems) if (p.why !== 'failed') unsure.push(`${p.activity.summary} (${p.why === 'uncertain' ? 'may not have gone through' : 'not confirmed'})`);
  for (const s of steps) if (s.status === 'done' && s.doneWhen && !s.note?.trim()) unsure.push(s.title);
  for (const c of meta.unsupportedClaims ?? []) unsure.push(`the reply says Keo ${c}`);
  if (unsure.length) return { kind: 'done_unchecked', why: `Check: ${list(unsure)}.` };

  if (!ran) return { kind: 'failed', why: 'None of the steps ran.' };
  return { kind: 'done_checked' };
}

/** The ending in a few plain words (for a job report and for speech). */
export function endingWords(e: TurnEnding): string {
  switch (e.kind) {
    case 'done_checked':
      return 'Done and checked.';
    case 'done_unchecked':
      return `Done, but not checked. ${e.why ?? ''}`.trim();
    case 'partly_done':
      return `Partly done. ${e.why ?? ''}`.trim();
    case 'blocked':
      return `Waiting on you. ${e.why ?? ''}`.trim();
    case 'failed':
      return `It did not work. ${e.why ?? ''}`.trim();
  }
}
