import type { ProviderErrorKind } from './domain';

/**
 * Problems in normal words: what happened and what the user can do about it. The technical
 * message is kept for "Details" (and for Report a problem), never shown as the main text.
 */
export interface Explained {
  what: string;
  todo: string;
  /** A button that helps: open Settings → Providers, or try the reply again. */
  action?: 'settings' | 'retry';
}

const REPLY: Record<ProviderErrorKind, Explained> = {
  unconfigured: { what: 'Keo has no AI model set up yet.', todo: 'Sign in to your Keo account or add a provider in Settings → Providers.', action: 'settings' },
  auth: { what: 'The AI service did not accept the sign-in or key.', todo: 'Sign in again or check the key in Settings → Providers.', action: 'settings' },
  rate_limit: { what: 'The AI service is busy right now (too many requests at once).', todo: 'Wait a minute, then press Retry.', action: 'retry' },
  quota: { what: 'The credit or allowance for this AI service is used up.', todo: 'Check your plan or credit, or choose another provider in Settings → Providers.', action: 'settings' },
  timeout: { what: 'The AI service took too long to answer.', todo: 'Press Retry. If it keeps happening, check your internet connection.', action: 'retry' },
  network: { what: 'Keo could not reach the AI service.', todo: 'Check your internet connection, then press Retry.', action: 'retry' },
  bad_request: { what: 'The AI service could not handle this request — it may be too long, or this model does not support part of it.', todo: 'Try a shorter message, start a new conversation, or choose another model in Settings → Providers.', action: 'settings' },
  server: { what: 'The AI service had a problem on its side.', todo: 'Press Retry in a moment.', action: 'retry' },
  refusal: { what: 'The model declined this request.', todo: 'Try asking in a different way.' },
  cancelled: { what: 'Stopped.', todo: 'Send it again whenever you are ready.' },
  malformed: { what: 'The AI’s answer came back garbled.', todo: 'Press Retry.', action: 'retry' },
  unknown: { what: 'Something went wrong while Keo was answering.', todo: 'Press Retry. If it keeps happening, use Report a problem in Settings.', action: 'retry' },
};

/** A reply that failed as a whole. */
export function explainReplyError(kind: ProviderErrorKind | undefined, message: string | undefined): Explained {
  const base = REPLY[kind ?? 'unknown'] ?? REPLY.unknown;
  // Keo Cloud's own refusals (plan, daily allowance) are already written for people: keep them.
  if ((kind === 'quota' || kind === 'rate_limit') && message && /\b(plan|allowance|upgrade|today|minutes|credits?)\b/i.test(message) && !/\b\d{3}\b|{|}/.test(message)) {
    return { ...base, what: message };
  }
  return base;
}

const STEP: Array<[RegExp, string]> = [
  [/timed? ?out|timeout|ETIMEDOUT/i, 'It took too long, so Keo stopped waiting.'],
  [/ENOENT|no such file|cannot find (the )?(path|file)|not found on disk/i, 'The file or folder was not found.'],
  [/EACCES|EPERM|access (is )?denied|permission denied/i, 'Windows did not allow access to it.'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|network/i, 'Keo could not connect — check the internet connection.'],
  [/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i, 'The service refused access (sign-in or key).'],
  [/\b429\b|too many requests|rate limit/i, 'The service is busy; it can be tried again shortly.'],
  [/\b50[0234]\b|internal server error|bad gateway|service unavailable/i, 'The service had a problem on its side.'],
  [/Unexpected token|JSON|is not valid json/i, 'The answer came back in a form Keo could not read.'],
];

/**
 * One failed step's detail. Keo's own messages are already plain sentences and stay as they are;
 * raw system errors (codes, stack-like text) become one plain sentence.
 */
export function explainStepError(detail: string | undefined): { text: string; technical: string | null } {
  const d = (detail ?? '').trim();
  if (!d) return { text: 'It did not work.', technical: null };
  const hit = STEP.find(([r]) => r.test(d));
  const looksTechnical = /\b[A-Z]{2,}[A-Z_]{3,}\b|\bat \S+ \(|\b(Error:|errno|stack trace|undefined|null)\b|[{}[\]]|\\\\|\b\d{3}\b|\d{4,} ?ms\b/.test(d) || d.length > 220;
  if (hit && looksTechnical) return { text: hit[1], technical: d };
  if (looksTechnical) return { text: 'It did not work because of a technical problem.', technical: d };
  return { text: d, technical: null };
}
