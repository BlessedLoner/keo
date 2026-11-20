/**
 * Recovering from a step that did not work: a concrete second way to try (per kind of tool), a
 * quiet retry for read-only lookups that hit a passing glitch, and stopping a chain of on-screen
 * steps once one of them fails (the next ones would act on the wrong window or the wrong text).
 */

/**
 * Said with every failure: keep going like a person would — work out why, try another way (up to
 * three different ones), check by looking — and ask the user only when the task cannot go on
 * without their answer. Never the same call again.
 */
const THEN_ASK =
  'Do not repeat this exact call. Work out why it failed and try another way — a different tool, different input, or (with Full control) look at the screen and do it as a person would — up to three different ways, checking each by looking. Ask the user only when you truly cannot continue without their answer (two different people match, something only they know), and then say what you tried.';

/** A setting or permission stopped it: working around that is not allowed. */
const BLOCKED_BY_SETTING = /\b(not allowed|turned off|is off|disabled|permission|not permitted|allow-?list|in settings)\b/i;

const WAYS: Array<[RegExp, string]> = [
  [/^(apps\.open|desktop\.launch_app)$/, 'Open it another way: apps__find to see the exact installed names and call apps__open with that appId; with Full control you can also press computer__keys "win", computer__type the app name and computer__keys "enter". If it is not installed, tell the user.'],
  [/^(computer\.type|desktop\.type_text|desktop\.set_text)$/, 'The text may not be where you meant. Look once (desktop__inspect_window, or one screen__look asking where the text cursor is), click the right box, then type with replace: true — never type the same text again on top of what is there.'],
  [/^(computer\.(click|drag|scroll)|desktop\.(click|invoke_element|scroll|draw))$/, 'The control was not where expected. Get its exact position again (desktop__inspect_window for the element, or one screen__look asking for it), then act once.'],
  [/^computer\.fill_form$/, 'Some boxes were not found by their names. Look once to find the missing boxes, click each one and computer__type it with replace: true.'],
  [/^computer\.keys$|^desktop\.press_keys$/, 'Make sure the right window is in front first (apps__open with its name), then press the keys once.'],
  [/^whatsapp\./, 'Make sure WhatsApp is open and in front (apps__open "WhatsApp"), then try again: WhatsApp may still have been loading. If the chat was not found, read the chat list (desktop__inspect_window, or screen__look) and use the name exactly as it is shown there. Only when two different people match, ask which one.'],
  [/^web\.fetch_page$/, 'Read a different result from your search instead of this page.'],
  [/^web\.search$/, 'Search again with fewer, simpler words.'],
  [/^browser\./, 'Make sure the browser is open (apps__open), then try once more; or read the page with web__fetch_page if you know its address.'],
  [/^files\./, 'Find the file with files__search first and use the exact path it returns.'],
  [/^(email|calendar)\./, 'Check the account is connected (the error says if not) and the addresses or times are complete; fix the input rather than retrying as is.'],
  [/^(screen\.look|vision\.)/, 'Try desktop__list_windows and desktop__inspect_window instead of a picture of the screen.'],
];

/** What the model is told after a failed step: a concrete different way, then ask. */
export function recoverHint(capabilityId: string, error = ''): string {
  if (BLOCKED_BY_SETTING.test(error)) return `This is blocked by a setting or permission: tell the user which setting controls it instead of working around it. ${THEN_ASK}`;
  const way = WAYS.find(([r]) => r.test(capabilityId))?.[1];
  return way ? `${way} ${THEN_ASK}` : `Try a different tool or different input, or re-check the current state. ${THEN_ASK}`;
}

/** What the model is told when it is unknown whether a step took effect. */
export const CHECK_FIRST =
  'It is unknown whether this took effect. Check the current state once (look at the window, read the chat, list windows) before doing anything else; never repeat it blindly. If it cannot be checked, tell the user.';

/** A passing glitch (slow helper, dropped connection, busy service) — worth one quiet retry for a read-only lookup. */
export function isTransient(message: string): boolean {
  return /\b(timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|temporarily|temporary|busy|try again|rate limit|too many requests|50[234]|429)\b/i.test(message);
}

/** Outcomes after which the rest of a chain of on-screen steps must not run. */
const BREAKS_CHAIN = new Set(['failed', 'uncertain', 'denied', 'rejected', 'awaiting_authorization']);

export function breaksChain(outcome: string): boolean {
  return BREAKS_CHAIN.has(outcome);
}

/** Told to the model for an on-screen step that was skipped because an earlier one in the same reply did not work. */
export const SKIPPED_NOTE =
  'Not run: an earlier on-screen step in this reply did not work, so this one could have acted on the wrong window or text. Fix that step first (see its result), then continue from there.';
