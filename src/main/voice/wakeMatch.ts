/**
 * Decides whether something the Windows recognizer heard is the user's wake
 * phrase — exactly, as a version the user taught Keo ("Teach Keo your voice"),
 * or as a close sound-alike — and returns any command said in the same breath
 * ("hey keo, open notepad" → "open notepad").
 *
 * Sound-alikes are deliberately conservative: a false wake (Keo starting to
 * listen during a normal conversation) is worse than having to say it again.
 */

export interface WakeMatch {
  phrase: string;
  /** Words spoken after the wake phrase in the same utterance (may be empty). */
  rest: string;
  how: 'exact' | 'learned' | 'sounds_like';
}

export const normWords = (t: string): string[] =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);

/** A rough sound key: similar-sounding spellings ("keo", "kio", "kayo"; "hey", "hay") get the same key. */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/^kn/, 'n')
    .replace(/^wr/, 'r')
    .replace(/^ps/, 's')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/dg/g, 'j')
    .replace(/gh/g, '')
    .replace(/(?<=[aeiouy])h/g, '') // "oh", "ah": silent h
    .replace(/(?<=[aeiouy])w(?=[^aeiouy]|$)/g, ''); // "how" ~ "ho"
  return w.replace(/[aeiouy]+/g, '*').replace(/(.)\1+/g, '$1');
}

const joinKey = (words: string[]) => words.map(soundKey).join('').replace(/\*+/g, '*');

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m]![n]!;
}

/** Whether `heard` (a few words) sounds like `phrase`. */
export function soundsLike(heard: string[], phrase: string[]): boolean {
  if (!heard.length || !phrase.length) return false;
  const a = joinKey(heard);
  const b = joinKey(phrase);
  if (!a || !b) return false;
  // The distinctive last word (the name) must start with the same consonant sound.
  // (vowel-only words like "oh" in "key oh" are skipped).
  const lead = (ws: string[]) => [...ws].reverse().map((w) => soundKey(w).replace(/\*/g, '')).find(Boolean)?.[0];
  const lastA = lead(heard);
  const lastB = lead(phrase);
  if (lastA !== lastB) return false;
  if (a === b) return true;
  // One small slip is tolerated only for longer phrases (short keys are too easy to hit by chance).
  return b.length >= 6 && editDistance(a, b) <= 1;
}

/** What follows the first `n` words of the original text, as spoken (numbers, case and inner punctuation kept). */
function restAfter(text: string, n: number): string {
  const tokens = text.trim().split(/\s+/);
  let seen = 0;
  let i = 0;
  while (i < tokens.length && seen < n) {
    seen += normWords(tokens[i]!).length;
    i++;
  }
  return tokens
    .slice(i)
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}

/**
 * Checks the recognizer's reading and its alternates. The wake phrase must be
 * at the start of what was heard; anything after it is the command.
 */
export function matchWake(readings: string[], phrases: string[], learned: string[]): WakeMatch | null {
  const targets: Array<{ words: string[]; phrase: string; how: WakeMatch['how'] }> = [
    ...phrases.map((p) => ({ words: normWords(p), phrase: p, how: 'exact' as const })),
    ...learned.map((v) => ({ words: normWords(v), phrase: phrases[0] ?? v, how: 'learned' as const })),
  ].filter((t) => t.words.length);
  for (const reading of readings) {
    const words = normWords(reading);
    if (!words.length) continue;
    // Exact or learned: the words themselves (prefix).
    for (const t of targets) {
      if (words.length >= t.words.length && t.words.every((w, i) => words[i] === w)) {
        return { phrase: t.phrase, rest: restAfter(reading, t.words.length), how: t.how };
      }
    }
    // Sound-alike of a phrase: try the first n-1..n+1 words (spellings split or merge words: "key oh" / "keo").
    for (const t of targets.filter((x) => x.how === 'exact')) {
      for (const n of [t.words.length + 1, t.words.length, t.words.length - 1]) {
        if (n < 1 || n > words.length) continue;
        if (soundsLike(words.slice(0, n), t.words)) return { phrase: t.phrase, rest: restAfter(reading, n), how: 'sounds_like' };
      }
    }
  }
  return null;
}

/** Common speech that must never become a learned wake variant. */
const TOO_COMMON = /^(ok|okay|yes|no|yeah|hey|hi|hello|the|a|and|thanks|thank you|right|so|well|oh|uh|um)$/;

/** Turns what the recognizer heard while the user said their phrase into learnable variants. */
export function learnableVariants(readings: string[], phrase: string, existing: string[]): string[] {
  const p = normWords(phrase).join(' ');
  const have = new Set([p, ...existing.map((e) => normWords(e).join(' '))]);
  const out: string[] = [];
  for (const r of readings) {
    const v = normWords(r).join(' ');
    if (!v || have.has(v) || out.includes(v)) continue;
    const words = v.split(' ');
    if (words.length > 5 || v.length < 4 || v.length > 40 || TOO_COMMON.test(v)) continue;
    out.push(v);
  }
  return out;
}
