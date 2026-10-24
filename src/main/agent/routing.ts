/**
 * Smart routing: a cheap, local decision (no model call) about which model
 * answers a turn. Voice, small talk and quick questions go to the fast model;
 * multi-step tasks, research, coding, planning and long requests go to the
 * strong one. When unsure, short means fast.
 */
export type Route = 'fast' | 'strong';

export interface RouteInput {
  text: string;
  /** The message came from a voice conversation or a spoken command. */
  voice: boolean;
  /** Pictures came with the message (Keo's pencil). */
  images: boolean;
  /** An action is waiting for the user's choice, so this reply continues a task. */
  openQuestion: boolean;
}

export interface RouteDecision {
  route: Route;
  reason: string;
}

/** Kinds of work that need the strongest model, whatever the length. */
const COMPLEX_WORK =
  /\b(research|investigate|compare|comparison|analy[sz]e|analysis|plan|planning|strategy|step[- ]by[- ]step|code|coding|programming|script|debug|refactor|implement|algorithm|regex|sql|spreadsheet|formula|essay|report|proposal|business plan|itinerary|budget|pros and cons|in detail|thorough(ly)?|deep dive)\b/i;

/** Verbs that ask Keo to do something on the computer or online. */
const ACTION =
  /\b(open|launch|start|close|send|message|text|reply|type|write|search|find|look up|download|book|order|buy|draw|paint|play|check|read|fill|copy|paste|save|move|organi[sz]e)\b/gi;

/** Joiners that chain several steps into one request. */
const SEQUENCE = /\b(and then|then|after that|afterwards|once (that|it'?s|you'?re) done|next|finally)\b|;|\n\s*(\d+[.)]|[-*•])\s/i;

const LONG_TYPED = 280;

/** Work that always takes several tool calls (searching and reading, comparing, investigating). */
const MANY_CALLS = /\b(research|investigate|compare|comparison|deep dive|step[- ]by[- ]step)\b/i;

/**
 * Does this request need a working plan (a checklist the user sees)? Only for
 * clearly multi-step work: several actions chained together, a list of things
 * to do, or research and comparisons. Questions and single actions never do.
 */
export function needsPlan(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  const actions = new Set((t.match(ACTION) ?? []).map((v) => v.toLowerCase()));
  if (actions.size >= 2 && SEQUENCE.test(t)) return true;
  if (actions.size >= 3) return true;
  if ((t.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm) ?? []).length >= 2 && actions.size >= 1) return true;
  return MANY_CALLS.test(t) && (actions.size >= 1 || t.length > 40);
}

export function chooseRoute(input: RouteInput): RouteDecision {
  const text = input.text.trim();
  if (input.openQuestion) return { route: 'strong', reason: 'continues a task' };
  if (input.images) return { route: 'strong', reason: 'picture' };
  if (/```|\b(function|const|def|class|import)\b.*[({=:]/.test(text)) return { route: 'strong', reason: 'code' };
  if (COMPLEX_WORK.test(text)) return { route: 'strong', reason: 'complex work' };
  const actions = new Set((text.match(ACTION) ?? []).map((v) => v.toLowerCase()));
  if (actions.size >= 2 && SEQUENCE.test(text)) return { route: 'strong', reason: 'multi-step task' };
  // Spoken transcripts run long without being complex, so length only counts for typed messages.
  if (!input.voice && (text.length > LONG_TYPED || text.split('\n').filter((l) => l.trim()).length >= 4)) return { route: 'strong', reason: 'long request' };
  return { route: 'fast', reason: input.voice ? 'voice' : 'quick question' };
}
