/**
 * Grounding check for automatically saved memories: the model's evidence must
 * appear word-for-word (ignoring case, whitespace and surrounding quote marks
 * or punctuation) in one of the user's own messages.
 */
export function normalizeQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`([{]+|["'`)\]}.,!?;:]+$/g, '')
    .trim();
}

/** Returns the id of the newest message containing the quote, or null. */
export function findQuote(messages: Array<{ id: string; text: string }>, quote: string): string | null {
  const q = normalizeQuote(quote);
  // Very short "quotes" (e.g. "yes", "ok") prove nothing about a fact.
  if (q.length < 6 || q.split(' ').length < 2) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { id: string; text: string };
    if (normalizeQuote(m.text).includes(q)) return m.id;
  }
  return null;
}

/**
 * Whether the user named this person/thing themselves (whole words, any
 * length): used so actions toward a contact can only run without asking when
 * the user mentioned that contact — never one taken from screen content.
 */
export function nameMentioned(messages: Array<{ text: string }>, name: string): boolean {
  const n = normalizeQuote(name);
  if (n.length < 2) return false;
  return messages.some((m) => ` ${normalizeQuote(m.text)} `.includes(` ${n} `));
}
