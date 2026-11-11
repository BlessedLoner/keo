/**
 * Detects replies that *say* an action happened when no matching capability
 * succeeded in the same reply (e.g. "I've typed it into Notepad" with no tool
 * call). Deliberately conservative: only past-tense first-person or passive
 * statements count; future, conditional and negated sentences are ignored.
 */
interface ClaimRule {
  label: string;
  verbs: RegExp;
  /** Capabilities whose success would back the claim: exact ids, or a whole family as "build.". */
  capabilities: string[];
  /** Extra pattern that counts as naming the object (besides DESKTOP_OBJECT). */
  object?: RegExp;
}

const RULES: ClaimRule[] = [
  { label: 'typed or pasted text', verbs: /\b(typed|pasted|entered|inserted|written|wrote)\b/, capabilities: ['desktop.type_text', 'desktop.set_text', 'computer.type', 'web.type', 'web.fill', 'build.', 'create.', 'files.', 'notion.write', 'drive.save', 'studio.'] },
  { label: 'opened or launched an application', verbs: /\b(opened|launched|started|reopened)\b/, capabilities: ['desktop.launch_app', 'files.open', 'browser.open_tab', 'whatsapp.open_chat', 'build.', 'create.', 'studio.', 'apps.', 'web.'] },
  { label: 'focused a window', verbs: /\b(refocused|focused|brought)\b/, capabilities: ['desktop.', 'computer.'] },
  { label: 'clicked', verbs: /\b(clicked|double-clicked)\b/, capabilities: ['desktop.click', 'computer.click', 'web.click'] },
  { label: 'pressed keys or saved', verbs: /\b(pressed|saved)\b/, capabilities: ['desktop.press_keys', 'computer.keys', 'web.press', 'build.', 'create.', 'files.', 'drive.save', 'studio.', 'memory.'] },
  { label: 'searched the web', verbs: /\b(searched|looked up|googled)\b/, capabilities: ['web.', 'research.', 'memory.search', 'email.search', 'notion.search'] },
  // "told Ma Glo …" names a person, which the lower-cased object check cannot see.
  { label: 'sent a message', verbs: /\b(sent|messaged|texted|delivered|told|informed|replied|responded|let (her|him|them) know)\b/, capabilities: ['whatsapp.', 'email.', 'telegram.send', 'slack.send', 'research.send_whatsapp'], object: /\b(told|informed|messaged|texted|replied to|responded to)\s+\w+/ },
  { label: 'read the page or chat', verbs: /\b(reviewed|checked|looked at)\b/, capabilities: ['browser.', 'whatsapp.', 'web.', 'desktop.', 'screen.', 'build.', 'studio.', 'files.', 'email.', 'computer.'] },
];

// Something on the desktop or in an app must be the object, so ordinary talk
// ("I wrote that summary above") is not flagged as a desktop claim.
const DESKTOP_OBJECT = /\b(notepad|window|app|application|program|editor|document|file|field|box|browser|chrome|word|tab|front|foreground|whatsapp|chat|message|page|button|menu|her|him|them)\b/;
const NEGATION = /\b(not|never|unable|couldn't|could not|can't|cannot|didn't|did not|failed|wasn't|weren't|haven't|hasn't|won't|would you|shall i|should i|let me|i'll|i will|going to|about to|try to|attempt)\b|n't\b/;
const FIRST_PERSON_PAST = /\b(i|i've|i have|i just|i've now|we|we've)\b/;
const PASSIVE = /\b(has|have|was|were|is|are)\s+(now\s+)?(been\s+)?(successfully\s+)?(typed|pasted|entered|inserted|written|opened|launched|saved|focused|clicked|sent|delivered)\b/;

/**
 * succeededCapabilities: what worked in this reply and earlier in the same conversation (summing up
 * earlier work is honest, so it is not flagged).
 */
export function unsupportedClaims(text: string, succeededCapabilities: Set<string>): string[] {
  const done = [...succeededCapabilities];
  const backed = (c: string) => (c.endsWith('.') ? done.some((d) => d.startsWith(c)) : succeededCapabilities.has(c));
  const found = new Set<string>();
  const clauses = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[.!?\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (NEGATION.test(clause)) continue;
    const claimShape = FIRST_PERSON_PAST.test(clause) || PASSIVE.test(clause);
    if (!claimShape) continue;
    for (const rule of RULES) {
      if (!rule.verbs.test(clause)) continue;
      if (rule.capabilities.some((c) => /^(desktop|whatsapp|browser)\./.test(c)) && !DESKTOP_OBJECT.test(clause) && !rule.object?.test(clause)) continue;
      if (rule.capabilities.some(backed)) continue;
      found.add(rule.label);
    }
  }
  return [...found];
}
