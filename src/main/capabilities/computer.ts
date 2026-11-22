import { z } from 'zod';
import type { Settings } from '../../shared/settings';
import type { PointElement, RawWindow } from '../desktop/backend';
import { isProtectedProcess, type DesktopService } from '../desktop/desktopService';
import type { UiaNodeRaw } from '../desktop/backend';
import { enterTextChecked, stableSnapshot } from './advanced';
import { KEY_CODES, type CapabilityDeps } from './builtins';
import { knowhowFor } from '../desktop/appKnowhow';
import { CapabilityError, defineCapability, type AnyCapability, type CapabilityContext } from './types';

/**
 * Full control: Keo uses the computer the way a person does — it looks at the whole screen
 * (screen__look, positions on a 0–1000 scale), then clicks, types, presses keys, scrolls and drags
 * anywhere, in any app. It is opt-in (Settings → Access & capabilities → Full control).
 *
 * The safety rules that stay on:
 * - Password managers and Windows security prompts are never touched; neither is Keo itself.
 * - Nothing is typed into a password box, and no card number is typed.
 * - An action that sends, posts, pays, deletes, submits or installs must say so (`effect`), and then
 *   the user approves it — every time. A click on a button whose name says “Send”, “Buy”,
 *   “Delete”… without that declaration is refused before anything happens, and so is Enter in a
 *   chat or mail app and Delete in File Explorer.
 * - While Keo is in control a banner with Stop shows, Esc stops everything, and the moment the user
 *   moves the mouse or types, Keo stops and hands the computer back.
 */
export interface ComputerDeps {
  desktop: DesktopService;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** A 0–1000 position on the screen picture Keo last looked at → physical screen pixels (throws when there is none). */
  toScreen(x: number, y: number): { x: number; y: number };
  /**
   * Called right before each action: shows the banner (Keo steps aside), stops when the user took
   * over, and clears the Stop key for Keo's own Esc. Returns what to call when the action is done.
   */
  begin(ctx: CapabilityContext, opts: { point?: { x: number; y: number }; pressesEscape?: boolean }): Promise<() => void>;
  ownPid: number;
  /** Pause after bringing a window to the front (tests use 0). */
  focusSettleMs?: number;
}

export const EFFECTS = ['none', 'sends', 'posts', 'pays', 'deletes', 'submits', 'installs'] as const;
type Effect = (typeof EFFECTS)[number];
const Effect = z
  .enum(EFFECTS)
  .default('none')
  .describe('What this action does beyond the screen: "sends" (a message or mail), "posts" (publishes), "pays" (buys, orders, transfers), "deletes", "submits" (a form), "installs". Say it honestly — the user then approves it. "none" for everything else (opening, typing, navigating, selecting).');

const EFFECT_WORDS: Record<Exclude<Effect, 'none'>, string> = {
  sends: 'sends something',
  posts: 'posts or publishes something',
  pays: 'spends money',
  deletes: 'deletes something',
  submits: 'submits a form',
  installs: 'installs or uninstalls software',
};

/** Buttons, links and menu items whose name says they send, pay, delete…: the click must declare it. */
const RISKY_NAME = /\b(send|post|publish|tweet|share now|pay|buy|purchase|place order|order now|checkout|check out|transfer|withdraw|delete|remove|erase|discard|empty recycle bin|uninstall|install|format|reset|submit|sign out|log ?out|unsubscribe|deactivate|close account)\b/i;
const CLICKABLE = /^(Button|SplitButton|MenuItem|Hyperlink|ListItem|TabItem|CheckBox|RadioButton)$/;

/** Apps where Enter usually sends a message. */
const MESSAGING_APP = /^(whatsapp(\.root)?|telegram|signal|slack|discord|teams|ms-teams|msteams|skype|outlook|olk|hxoutlook|thunderbird|mailspring|messenger|viber|zoom|element|wechat|line)$/i;
const MESSAGING_TITLE = /\b(whatsapp|messenger|telegram|slack|discord|gmail|inbox|outlook|mail|teams|instagram|direct|chat)\b/i;

/** Modifiers in Full control: the Windows key too (Win+R, Win+D, Win+E…). */
const MODIFIERS: Record<string, number> = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b };
const MORE_KEYS: Record<string, number> = { esc: 0x1b, return: 0x0d, del: 0x2e, insert: 0x2d, ins: 0x2d, printscreen: 0x2c, menu: 0x5d, capslock: 0x14, ',': 0xbc, '.': 0xbe, '-': 0xbd, '=': 0xbb, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0 };

export function parseComputerCombo(combo: string): { mods: number[]; key: number; keyName: string; names: string[] } | null {
  const parts = combo.toLowerCase().replace(/\s+/g, '').split(/\+(?!$)/).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const keyName = parts[parts.length - 1] as string;
  const key = KEY_CODES[keyName] ?? MORE_KEYS[keyName] ?? (keyName === 'win' || keyName === 'windows' ? 0x5b : undefined);
  if (key === undefined) return null;
  const mods: number[] = [];
  for (const m of parts.slice(0, -1)) {
    const vk = MODIFIERS[m];
    if (vk === undefined || mods.includes(vk)) return null;
    mods.push(vk);
  }
  return { mods, key, keyName, names: parts };
}

/** A real card number (13–19 digits passing the Luhn check) somewhere in the text. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.match(/(?:\d[ -]?){12,18}\d/g) ?? []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let n = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

const coord = z.number().min(0).max(1000);

/** Boxes text can go into: edit fields, rich editors (an email body), editable combo boxes (Gmail's To). */
function isTextBox(n: UiaNodeRaw): boolean {
  if (n.disabled || n.readonly) return false;
  if (n.role === 'edit') return true;
  if (n.role === 'combobox' || n.role === 'document' || n.role === 'custom' || n.role === 'group') return !!n.patterns?.includes('value') || n.role === 'document';
  return false;
}

/** Other names forms use for the same box. */
const FIELD_ALIASES: Record<string, string[]> = {
  to: ['to', 'to recipients', 'recipients', 'recipient', 'send to', 'add recipients'],
  cc: ['cc', 'cc recipients', 'carbon copy'],
  bcc: ['bcc', 'bcc recipients', 'blind carbon copy'],
  subject: ['subject', 'add a subject', 'title'],
  message: ['message body', 'message', 'body', 'compose', 'write a message', 'type a message', 'email body', 'mail body'],
  body: ['message body', 'body', 'message', 'compose', 'email body'],
  search: ['search', 'search box', 'search mail', 'find'],
};

const normField = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The box whose name best matches: exact, a known alias, then a whole-word match; visible boxes first. */
export function bestBox(boxes: UiaNodeRaw[], field: string): UiaNodeRaw | null {
  const want = normField(field);
  const aliases = FIELD_ALIASES[want] ?? [want];
  const score = (n: UiaNodeRaw): number => {
    const names = [normField(n.name ?? ''), normField(n.aid ?? '')].filter(Boolean);
    let best = 0;
    for (const name of names) {
      if (name === want) best = Math.max(best, 100);
      else if (aliases.includes(name)) best = Math.max(best, 90);
      else if (aliases.some((a) => name.startsWith(`${a} `) || name.endsWith(` ${a}`))) best = Math.max(best, 70);
      else if (want.length >= 3 && ` ${name} `.includes(` ${want} `)) best = Math.max(best, 50);
    }
    // A message body is the big rich editor when nothing is named so.
    if (!best && (want === 'message' || want === 'body') && n.role === 'document') best = 30;
    return best - (n.offscreen ? 5 : 0);
  };
  let pick: UiaNodeRaw | null = null;
  let top = 0;
  for (const n of boxes) {
    const s = score(n);
    if (s > top) {
      top = s;
      pick = n;
    }
  }
  return top >= 30 ? pick : null;
}
/** Roles a person clicks. */
const CLICK_ROLES = new Set(['button', 'splitbutton', 'menuitem', 'hyperlink', 'link', 'listitem', 'tabitem', 'checkbox', 'radiobutton', 'treeitem', 'dataitem', 'edit', 'combobox', 'text', 'image']);

/**
 * The element a person means by its name (“Save”, “Search”, “New chat”): exact name first, then a
 * name that starts with it, then one that contains it as whole words; visible and clickable first.
 * `role` narrows it (“button”, “link”, “tab”, “edit”…).
 */
export function bestElement(nodes: UiaNodeRaw[], name: string, role?: string): UiaNodeRaw | null {
  const want = normField(name);
  if (!want) return null;
  const roleWant = role ? normField(role).replace(/\s+/g, '') : null;
  const roleOk = (r: string) => !roleWant || r === roleWant || (roleWant === 'button' && r === 'splitbutton') || (roleWant === 'link' && r === 'hyperlink') || (roleWant === 'tab' && r === 'tabitem') || (roleWant === 'menu' && r === 'menuitem') || (roleWant === 'box' && (r === 'edit' || r === 'combobox'));
  let pick: UiaNodeRaw | null = null;
  let top = 0;
  for (const n of nodes) {
    if (!roleOk(n.role) || n.disabled) continue;
    const names = [normField(n.name ?? ''), normField(n.aid ?? '')].filter(Boolean);
    let sc = 0;
    for (const nm of names) {
      if (nm === want) sc = Math.max(sc, 100);
      else if (nm.startsWith(`${want} `)) sc = Math.max(sc, 70);
      else if (want.length >= 3 && ` ${nm} `.includes(` ${want} `)) sc = Math.max(sc, 50);
    }
    if (!sc) continue;
    if (CLICK_ROLES.has(n.role) || n.patterns?.includes('invoke')) sc += 10;
    if (n.offscreen || !n.w || !n.h) sc -= 40;
    if (sc > top) {
      top = sc;
      pick = n;
    }
  }
  return top >= 40 ? pick : null;
}

/** One line per element a person can see, for the map Keo returns after acting. */
export function elementLines(nodes: UiaNodeRaw[], limit: number): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let omitted = 0;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.offscreen || !n.w || !n.h) continue;
    const named = (n.name ?? '').trim();
    const interesting = CLICK_ROLES.has(n.role) || n.role === 'document' || n.role === 'window' || n.patterns?.includes('invoke') || n.patterns?.includes('value');
    if (!interesting || (!named && n.value === undefined)) continue;
    const states = [n.focused ? 'focused' : '', n.selected ? 'selected' : '', n.disabled ? 'disabled' : '', n.toggle === 'on' ? 'checked' : ''].filter(Boolean);
    const line = `${n.role} “${named.slice(0, 70)}”${n.value ? ` = “${n.value.slice(0, 60)}”` : ''}${states.length ? ` (${states.join(', ')})` : ''}`;
    if (seen.has(line)) continue;
    seen.add(line);
    if (lines.length >= limit) {
      omitted++;
      continue;
    }
    lines.push(line);
  }
  return { lines, omitted };
}

const fullControlOff = (s: Settings) => (s.permissions.fullControl ? null : 'Full control is off. The user can turn it on in Access & capabilities → Full control.');

function effectTier(effect: Effect, what: string) {
  return effect === 'none'
    ? { tier: 'routine' as const }
    : { tier: 'critical' as const, reason: `This ${what} ${EFFECT_WORDS[effect]}: the user approves it every time.` };
}

const elementLabel = (e: PointElement) => (e.name || e.type ? `${e.type ? `${e.type} ` : ''}“${(e.name ?? '').slice(0, 80)}”` : 'nothing Keo can name');

export function computerCapabilities(d: ComputerDeps): AnyCapability[] {
  const backend = d.desktop.backend;
  const need = <K extends 'windowAt' | 'clickAt' | 'elementAt' | 'focusedElement'>(k: K): NonNullable<(typeof backend)[K]> => {
    const f = backend[k];
    if (!f) throw new CapabilityError('unsupported', 'Full control is not available on this computer.', { dispatched: 'no' });
    return f.bind(backend) as NonNullable<(typeof backend)[K]>;
  };

  /** The window that would get the action: never Keo itself, a password manager or a security prompt. */
  const check = (w: RawWindow | null, where: string): RawWindow => {
    if (!w) throw new CapabilityError('target_gone', `There is no app window ${where}. Look at the screen again (screen__look).`, { dispatched: 'no' });
    if (w.pid === d.ownPid) throw new CapabilityError('target_not_allowed', `That is Keo’s own window ${where}; Keo never clicks or types in itself. Open the app the user means first (apps__open), or look again.`, { dispatched: 'no' });
    if (isProtectedProcess(w.processName)) throw new CapabilityError('target_not_allowed', `${w.processName} is a password manager or a Windows security prompt. Keo never operates it, even in Full control — the user does that part.`, { dispatched: 'no' });
    return w;
  };

  const toFront = async (w: RawWindow): Promise<void> => {
    if (w.foreground) return;
    const r = await backend.focus(w.hwnd);
    if (!r.foreground) throw new CapabilityError('focus_failed', `Windows did not let Keo bring ${w.processName} to the front, so nothing was done.`, { dispatched: 'no' });
    const settle = d.focusSettleMs ?? 150;
    if (settle > 0) await new Promise((res) => setTimeout(res, settle));
  };

  const foreground = async (): Promise<RawWindow> => {
    const a = await backend.userActivity();
    const w = a.foreground ? await backend.info(a.foreground) : null;
    return check(w, 'in front');
  };

  const base = {
    version: '1.0.0',
    approval: 'always' as const,
    permissions: ['desktop.control' as const],
    consequential: true,
    idempotent: false,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    unavailableReason: fullControlOff,
  };

  const click = defineCapability({
    ...base,
    id: 'computer.click',
    title: 'Click on the screen',
    description:
      'Full control: click anywhere on the screen, in any app, like a person. x and y are on the 0–1000 scale of the screen picture from your latest screen__look (look first, and look again after the screen changed). Say in `what` what you are clicking (“the Save button”, “the search box”). Set `effect` when the click sends, posts, pays, deletes, submits or installs — the user approves those. The result says which app and element was under the pointer; check the outcome with screen__look.',
    input: z
      .object({
        x: coord,
        y: coord,
        what: z.string().trim().min(2).max(120).describe('What you are clicking, in a few words'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
        double: z.boolean().default(false),
        effect: Effect,
      })
      .strict(),
    output: z.object({ clicked: z.boolean(), app: z.string(), window: z.string(), element: z.string() }),
    risk: 'high',
    verificationPolicy: 'Keo checks the app and element under the point before clicking; the effect is checked with a fresh look.',
    autonomy: (i) => effectTier(i.effect, 'click'),
    preview: (i) => ({
      summary: `${i.double ? 'Double-click' : i.button === 'right' ? 'Right-click' : 'Click'} ${i.what}${i.effect !== 'none' ? ` (${EFFECT_WORDS[i.effect]})` : ''}`,
      target: `The screen at (${Math.round(i.x)}, ${Math.round(i.y)}) of 1000`,
      consequences: i.effect === 'none' ? ['A click in whichever app is there.'] : [`This click ${EFFECT_WORDS[i.effect]}.`],
      dataExport: null,
    }),
    auditView: (i) => ({ x: i.x, y: i.y, button: i.button, double: i.double, effect: i.effect }),
    async execute(i, ctx) {
      const p = d.toScreen(i.x, i.y);
      const done = await d.begin(ctx, { point: p });
      try {
        const w = check(await need('windowAt')(p.x, p.y), 'at that point');
        const el = await need('elementAt')(p.x, p.y);
        if (i.effect === 'none' && el.type && CLICKABLE.test(el.type) && (RISKY_NAME.test(el.name ?? '') || RISKY_NAME.test(el.aid ?? ''))) {
          throw new CapabilityError(
            'needs_approval',
            `Under the pointer is ${elementLabel(el)} in ${w.processName}, which looks like it sends, pays, deletes or submits. Nothing was clicked. If that is what the user wants, call computer__click again with the right \`effect\` so they can approve it.`,
            { dispatched: 'no' },
          );
        }
        // Like a person: the click itself brings the window forward (the taskbar and Start menu cannot be focused first).
        await need('clickAt')(w.hwnd, p.x, p.y, i.button, i.double);
        return { clicked: true, app: w.processName, window: w.title.slice(0, 120), element: elementLabel(el) };
      } finally {
        done();
      }
    },
    async verify() {
      return { verified: null, detail: 'Click delivered; look at the screen to see what changed.' };
    },
  });

  const type = defineCapability({
    ...base,
    id: 'computer.type',
    title: 'Type on the keyboard',
    description:
      'Full control: put text where the keyboard focus is (click the box first with computer__click), all at once and exactly. `replace: true` replaces everything already in that box or document with this text (use it whenever the box already has text you want gone — never delete it by hand). It does not press Enter — use computer__keys for that. The result says whether Keo read the text back (`confirmed`) and shows the end of what is now in the app (`nowInApp`): trust it, do not look again to check, and never type the same text twice. Keo never types into a password box or types a card number.',
    input: z
      .object({
        text: z.string().min(1).max(20000),
        replace: z.boolean().default(false).describe('true = select everything in the focused box/document first, so this text replaces it'),
        method: z.enum(['auto', 'paste', 'keys']).default('auto').describe('auto pastes the text in one go (exact and instant); "keys" presses each key, for the rare app that refuses pasting'),
      })
      .strict(),
    output: z.object({ typed: z.number(), app: z.string(), into: z.string(), replaced: z.boolean(), confirmed: z.boolean().nullable(), nowInApp: z.string().nullable(), note: z.string() }),
    risk: 'high',
    verificationPolicy: 'Keo checks the focused box is not a password box first, then reads the text back from the app.',
    autonomy: () => ({ tier: 'routine' }),
    precheck: (i) => (looksLikeCardNumber(i.text) ? 'That text contains a card number. Keo never types card numbers — the user enters payment details themselves.' : null),
    preview: (i) => ({ summary: `${i.replace ? 'Replace the text with' : 'Type'} “${i.text.length > 80 ? `${i.text.slice(0, 80)}…` : i.text}”`, target: 'The app in front, where the cursor is', consequences: [i.replace ? 'What was in the box is replaced.' : 'Text appears where the keyboard focus is.'], dataExport: null }),
    auditView: (i) => ({ length: i.text.length, replace: i.replace }),
    async execute(i, ctx) {
      const done = await d.begin(ctx, {});
      try {
        const w = await foreground();
        const el = await need('focusedElement')();
        if (el.password) throw new CapabilityError('password_field', 'The focused box is a password box. Keo never types passwords — the user types it.', { dispatched: 'no' });
        const norm = (t: string) => t.replace(/\r/g, '');
        const wanted = norm(i.text);
        const read = async () => {
          const t = await backend.readText(w.hwnd).catch(() => null);
          return t === null ? null : norm(t);
        };
        const count = (hay: string) => hay.split(wanted).length - 1;
        const before = await read();
        const landed = (now: string | null): boolean | null => {
          if (now === null || before === null) return null;
          if (i.replace) return now !== before || now.trim() === wanted.trim() ? count(now) >= 1 : false;
          return count(now) > count(before);
        };
        if (i.replace) {
          await backend.keys(w.hwnd, [0x11], 0x41); // Ctrl+A: what is typed next replaces it
          await new Promise((r) => setTimeout(r, 120));
        }
        const usePaste = i.method !== 'keys' && (i.method === 'paste' || i.text.length > 1);
        let saved: string | null = null;
        if (usePaste) {
          saved = await d.clipboard.readText().catch(() => '');
          await d.clipboard.writeText(i.text);
        }
        let confirmed: boolean | null = null;
        let now: string | null = null;
        try {
          if (usePaste) await backend.paste(w.hwnd);
          else await backend.typeText(w.hwnd, i.text);
          // Wait until the app shows it (read back, up to ~2.5 s). The user's clipboard is only put
          // back after that: an app that handles Ctrl+V late would otherwise paste the old clipboard.
          for (let n = 0; n < 10 && !ctx.signal.aborted; n++) {
            await new Promise((r) => setTimeout(r, 250));
            now = await read();
            confirmed = landed(now);
            if (confirmed !== false) break;
          }
          if (confirmed === null) await new Promise((r) => setTimeout(r, 900)); // unreadable app: give it time
        } finally {
          if (saved !== null) await d.clipboard.writeText(saved).catch(() => undefined);
        }
        const note =
          confirmed === true
            ? 'The text is in the app (read back). Do not type it again or look to check it.'
            : confirmed === false
              ? 'Sent, but Keo could not find it in the app yet. Look once before doing anything else; do not retype unless it is clearly missing.'
              : 'Sent; this app does not let Keo read its text back. A screen picture may lag a moment — do not retype part of it.';
        const tail = now === null ? null : now.length > 400 ? `…${now.slice(-400)}` : now;
        return { typed: i.text.length, app: w.processName, into: elementLabel(el), replaced: i.replace, confirmed, nowInApp: tail, note };
      } finally {
        done();
      }
    },
  });

  const keys = defineCapability({
    ...base,
    id: 'computer.keys',
    title: 'Press keys',
    description:
      'Full control: press a key or shortcut in the app in front, e.g. "enter", "ctrl+s", "alt+tab", "win+r", "win+d", "ctrl+shift+t", "escape", "f5". Modifiers: ctrl, shift, alt, win. Set `effect` when the key sends (Enter in a chat or mail), deletes (Delete on files), submits or pays — the user approves those.',
    input: z
      .object({
        combo: z.string().min(1).max(40).refine((c) => parseComputerCombo(c) !== null, 'Unsupported key or combination'),
        repeat: z.number().int().min(1).max(20).default(1),
        effect: Effect,
      })
      .strict(),
    output: z.object({ sent: z.boolean(), app: z.string() }),
    risk: 'high',
    verificationPolicy: 'Delivered by the OS input queue; look at the screen to see the effect.',
    autonomy: (i) => {
      if (i.effect !== 'none') return effectTier(i.effect, 'key press');
      const c = i.combo.toLowerCase().replace(/\s+/g, '');
      // Closing a whole app can lose unsaved work.
      if (/^alt\+f4$|^ctrl\+q$|^ctrl\+shift\+w$/.test(c)) return { tier: 'important' as const, reason: 'This closes a window or an app.' };
      return { tier: 'routine' as const };
    },
    preview: (i) => ({ summary: `Press ${i.combo.toUpperCase()}${i.repeat > 1 ? ` ×${i.repeat}` : ''}${i.effect !== 'none' ? ` (${EFFECT_WORDS[i.effect]})` : ''}`, target: 'The app in front', consequences: ['Keys act on whatever app is in front.'], dataExport: null }),
    auditView: (i) => ({ combo: i.combo, repeat: i.repeat, effect: i.effect }),
    async execute(i, ctx) {
      const k = parseComputerCombo(i.combo);
      if (!k) throw new CapabilityError('invalid_input', 'Unsupported key combination.');
      const done = await d.begin(ctx, { pressesEscape: k.key === 0x1b });
      try {
        const w = await foreground();
        const enter = k.key === 0x0d;
        const del = k.key === 0x2e;
        if (i.effect === 'none' && enter && (MESSAGING_APP.test(w.processName) || MESSAGING_TITLE.test(w.title))) {
          throw new CapabilityError('needs_approval', `Enter in ${w.processName} (“${w.title.slice(0, 60)}”) may send a message. Nothing was pressed. If it should send, call computer__keys again with effect "sends" so the user can approve it.`, { dispatched: 'no' });
        }
        if (i.effect === 'none' && del && /^explorer$/i.test(w.processName)) {
          throw new CapabilityError('needs_approval', 'Delete in File Explorer deletes files. Nothing was pressed. If that is what the user wants, call computer__keys again with effect "deletes" so they can approve it.', { dispatched: 'no' });
        }
        for (let n = 0; n < i.repeat; n++) {
          if (ctx.signal.aborted) throw new CapabilityError('cancelled', 'Stopped.', { dispatched: n ? 'unknown' : 'no' });
          await backend.keys(w.hwnd, k.mods, k.key);
          if (i.repeat > 1) await new Promise((r) => setTimeout(r, 40));
        }
        return { sent: true, app: w.processName };
      } finally {
        done();
      }
    },
  });

  const scroll = defineCapability({
    ...base,
    id: 'computer.scroll',
    title: 'Scroll',
    description: 'Full control: scroll the mouse wheel over a point of the screen (0–1000 scale of your latest screen__look).',
    input: z.object({ x: coord, y: coord, direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(30).default(5).describe('Wheel notches') }).strict(),
    output: z.object({ scrolled: z.boolean(), app: z.string() }),
    risk: 'low',
    idempotent: false,
    verificationPolicy: 'Delivered; look again to see the new position.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Scroll ${i.direction} ${i.amount}`, target: `The screen at (${Math.round(i.x)}, ${Math.round(i.y)}) of 1000`, consequences: [], dataExport: null }),
    auditView: (i) => ({ direction: i.direction, amount: i.amount }),
    async execute(i, ctx) {
      const p = d.toScreen(i.x, i.y);
      const done = await d.begin(ctx, { point: p });
      try {
        const w = check(await need('windowAt')(p.x, p.y), 'at that point');
        const notches = i.direction === 'up' ? i.amount : -i.amount;
        if (backend.wheelAt) await backend.wheelAt(w.hwnd, p.x, p.y, notches);
        else {
          await toFront(w);
          await backend.wheel(w.hwnd, p.x, p.y, -notches); // the older helper counts down as positive
        }
        return { scrolled: true, app: w.processName };
      } finally {
        done();
      }
    },
  });

  const drag = defineCapability({
    ...base,
    id: 'computer.drag',
    title: 'Drag with the mouse',
    description: 'Full control: press the left button at one point and drag to another inside the same window (move a slider, select text, move an item, resize a selection). Points are on the 0–1000 scale of your latest screen__look.',
    input: z.object({ fromX: coord, fromY: coord, toX: coord, toY: coord, what: z.string().trim().min(2).max(120) }).strict(),
    output: z.object({ dragged: z.boolean(), app: z.string() }),
    risk: 'high',
    verificationPolicy: 'Delivered; look again to see the result.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Drag ${i.what}`, target: `From (${Math.round(i.fromX)}, ${Math.round(i.fromY)}) to (${Math.round(i.toX)}, ${Math.round(i.toY)}) of 1000`, consequences: ['Moves or selects something in that app.'], dataExport: null }),
    auditView: (i) => ({ fromX: i.fromX, fromY: i.fromY, toX: i.toX, toY: i.toY }),
    async execute(i, ctx) {
      const a = d.toScreen(i.fromX, i.fromY);
      const b = d.toScreen(i.toX, i.toY);
      const done = await d.begin(ctx, { point: a });
      try {
        const w = check(await need('windowAt')(a.x, a.y), 'where the drag starts');
        if (!backend.draw) throw new CapabilityError('unsupported', 'Dragging is not available on this computer.', { dispatched: 'no' });
        await toFront(w);
        const steps = 16;
        const stroke: Array<[number, number]> = Array.from({ length: steps + 1 }, (_, n) => [Math.round(a.x + ((b.x - a.x) * n) / steps), Math.round(a.y + ((b.y - a.y) * n) / steps)]);
        try {
          await backend.draw(w.hwnd, [stroke]);
        } catch (e) {
          if (e instanceof CapabilityError && /outside|obscured/.test(e.code + e.message)) {
            throw new CapabilityError(e.code, `Keo can only drag inside one window (${w.processName}); the end point is outside it or covered.`, { dispatched: 'no' });
          }
          throw e;
        }
        return { dragged: true, app: w.processName };
      } finally {
        done();
      }
    },
  });

  const fillForm = defineCapability({
    ...base,
    id: 'computer.fill_form',
    title: 'Fill in a form',
    description:
      'Full control: fill several boxes of the form in front in ONE step, each with its own text — e.g. an email: [{field:"To", text:"ann@example.com"}, {field:"Subject", text:"Monday"}, {field:"Message", text:"Hi Ann…"}]. Keo finds each box by its name (To, Cc, Subject, Message/Body, Name, Search…), replaces what was in it, and reads each one back. No screen look or clicking needed, and text never lands in the wrong box. It never presses Send or Submit: do that afterwards with computer__click (effect "sends"/"submits"), so the user approves it. If a box is not found, the result lists the boxes the form has — call again with those names.',
    input: z
      .object({
        fields: z
          .array(z.object({ field: z.string().trim().min(1).max(60).describe('The box’s name as shown: To, Cc, Subject, Message…'), text: z.string().max(20000) }).strict())
          .min(1)
          .max(10),
      })
      .strict(),
    output: z.object({ app: z.string(), filled: z.array(z.object({ field: z.string(), box: z.string(), confirmed: z.boolean() })), note: z.string() }),
    risk: 'high',
    verificationPolicy: 'Each box is found by its accessible name and read back after filling. Nothing is sent or submitted.',
    autonomy: () => ({ tier: 'routine' }),
    precheck: (i) => (i.fields.some((f) => looksLikeCardNumber(f.text)) ? 'That contains a card number. Keo never types card numbers — the user enters payment details themselves.' : null),
    preview: (i) => ({
      summary: `Fill in ${i.fields.map((f) => f.field).join(', ')}`,
      target: 'The form in front',
      consequences: i.fields.map((f) => `${f.field}: “${f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text}”`).concat('Nothing is sent or submitted.'),
      dataExport: null,
    }),
    auditView: (i) => ({ fields: i.fields.map((f) => f.field), chars: i.fields.reduce((n, f) => n + f.text.length, 0) }),
    async execute(i, ctx) {
      const done = await d.begin(ctx, {});
      try {
        const w = await foreground();
        const target = { hwnd: w.hwnd, pid: w.pid, processName: w.processName };
        const helperDeps = { desktop: d.desktop, clipboard: d.clipboard, focusSettleMs: d.focusSettleMs } as unknown as CapabilityDeps;
        const raw = await stableSnapshot(helperDeps, target);
        const boxes = raw.nodes.filter(isTextBox);
        const used = new Set<string>();
        const plan: Array<{ field: string; text: string; node: UiaNodeRaw }> = [];
        for (const f of i.fields) {
          const node = bestBox(boxes.filter((b) => !used.has(b.rid)), f.field);
          if (!node) {
            const names = [...new Set(boxes.map((b) => b.name || b.aid || '').filter(Boolean))].slice(0, 20);
            throw new CapabilityError(
              'field_not_found',
              `No “${f.field}” box in ${w.processName} (“${w.title.slice(0, 60)}”). ${names.length ? `Its boxes: ${names.map((n) => `“${n}”`).join(', ')}.` : 'It has no boxes Keo can read: is the form open and in front?'} Nothing was filled.`,
              { dispatched: 'no' },
            );
          }
          if (node.password) throw new CapabilityError('password_field', `“${f.field}” is a password box. Keo never types passwords — the user types it.`, { dispatched: 'no' });
          used.add(node.rid);
          plan.push({ field: f.field, text: f.text, node });
        }
        const filled: Array<{ field: string; box: string; confirmed: boolean }> = [];
        for (const p of plan) {
          if (ctx.signal.aborted) throw new CapabilityError('cancelled', 'Stopped.', { dispatched: filled.length ? 'yes' : 'no' });
          const ok = await enterTextChecked(helperDeps, target, p.node, p.text, false);
          filled.push({ field: p.field, box: p.node.name || p.node.aid || p.node.role, confirmed: ok });
        }
        const missing = filled.filter((f) => !f.confirmed).map((f) => f.field);
        return {
          app: w.processName,
          filled,
          note: missing.length
            ? `Filled, but Keo could not read back: ${missing.join(', ')}. Look once to check those boxes only; do not refill the others.`
            : 'Every box holds its text (read back). Do not type any of it again. Nothing was sent.',
        };
      } finally {
        done();
      }
    },
  });

  /** A quick read of the window in front (a few seconds at most), for finding elements and the after-map. */
  const quickRead = async (w: RawWindow) => backend.uiaSnapshot(w.hwnd, { maxNodes: 900, maxDepth: 50, budgetMs: 3500 });

  const Step = z.discriminatedUnion('do', [
    z
      .object({
        do: z.literal('click'),
        name: z.string().trim().min(1).max(120).describe('The button, link, tab, box or item’s name as shown (“Save”, “New chat”, “Search”)'),
        role: z.string().trim().max(20).optional().describe('Optional: button, link, tab, menu, box, listitem, checkbox…'),
        double: z.boolean().default(false),
        button: z.enum(['left', 'right']).default('left'),
        effect: Effect,
      })
      .strict(),
    z.object({ do: z.literal('click_at'), x: coord, y: coord, what: z.string().trim().min(2).max(120), double: z.boolean().default(false), effect: Effect }).strict(),
    z.object({ do: z.literal('type'), text: z.string().min(1).max(20000), replace: z.boolean().default(false) }).strict(),
    z.object({ do: z.literal('keys'), combo: z.string().min(1).max(40).refine((c) => parseComputerCombo(c) !== null, 'Unsupported key or combination'), repeat: z.number().int().min(1).max(20).default(1), effect: Effect }).strict(),
    z.object({ do: z.literal('wait_for'), name: z.string().trim().min(1).max(120).describe('Text of an element, or of the window title, that shows the app is ready'), seconds: z.number().min(0.5).max(15).default(5) }).strict(),
  ]);
  type StepT = z.infer<typeof Step>;
  const stepEffect = (st: StepT): Effect => ('effect' in st ? st.effect : 'none');
  const stepLabel = (st: StepT): string =>
    st.do === 'click'
      ? `${st.double ? 'double-click' : st.button === 'right' ? 'right-click' : 'click'} “${st.name}”`
      : st.do === 'click_at'
        ? `click ${st.what}`
        : st.do === 'type'
          ? `${st.replace ? 'replace with' : 'type'} “${st.text.length > 60 ? `${st.text.slice(0, 60)}…` : st.text}”`
          : st.do === 'keys'
            ? `press ${st.combo.toUpperCase()}${st.repeat > 1 ? ` ×${st.repeat}` : ''}`
            : `wait for “${st.name}”`;

  const clickByName = async (st: Extract<StepT, { do: 'click' }>, ctx: CapabilityContext): Promise<string> => {
    const done = await d.begin(ctx, {});
    try {
      const w = await foreground();
      const raw = await quickRead(w);
      const node = bestElement(raw.nodes, st.name, st.role);
      if (!node) {
        const { lines } = elementLines(raw.nodes, 25);
        throw new CapabilityError('element_not_found', `No “${st.name}”${st.role ? ` (${st.role})` : ''} in ${w.processName} (“${w.title.slice(0, 60)}”). What is there: ${lines.join('; ') || 'nothing Keo can read — use screen__look and click_at'}.`, { dispatched: 'no' });
      }
      if (st.effect === 'none' && (RISKY_NAME.test(node.name ?? '') || RISKY_NAME.test(node.aid ?? ''))) {
        throw new CapabilityError('needs_approval', `“${node.name}” in ${w.processName} looks like it sends, pays, deletes or submits. Nothing was clicked. If that is what the user wants, give this step the right \`effect\` so they can approve it.`, { dispatched: 'no' });
      }
      const c = await backend.uiaCenter(w.hwnd, node.rid);
      await need('clickAt')(w.hwnd, c.x, c.y, st.button, st.double);
      return `${node.role} “${(node.name || node.aid || st.name).slice(0, 80)}” in ${w.processName}`;
    } finally {
      done();
    }
  };

  const waitFor = async (st: Extract<StepT, { do: 'wait_for' }>, ctx: CapabilityContext): Promise<string> => {
    const until = Date.now() + st.seconds * 1000;
    const want = normField(st.name);
    for (;;) {
      if (ctx.signal.aborted) throw new CapabilityError('cancelled', 'Stopped.', { dispatched: 'no' });
      const a = await backend.userActivity();
      const w = a.foreground ? await backend.info(a.foreground) : null;
      if (w && normField(w.title).includes(want)) return `the window “${w.title.slice(0, 80)}”`;
      if (w) {
        const node = bestElement((await quickRead(w)).nodes, st.name);
        if (node) return `${node.role} “${(node.name || st.name).slice(0, 80)}”`;
      }
      if (Date.now() >= until) throw new CapabilityError('not_appeared', `“${st.name}” did not appear within ${st.seconds} s.`, { dispatched: 'no' });
      await new Promise((r) => setTimeout(r, d.focusSettleMs === 0 ? 0 : 300));
    }
  };

  const runOne = async (st: StepT, ctx: CapabilityContext): Promise<string> => {
    switch (st.do) {
      case 'click':
        return `clicked ${await clickByName(st, ctx)}`;
      case 'click_at': {
        const r = await click.execute({ x: st.x, y: st.y, what: st.what, button: 'left', double: st.double, effect: st.effect }, ctx);
        return `clicked ${r.element} in ${r.app}`;
      }
      case 'type': {
        const r = await type.execute({ text: st.text, replace: st.replace, method: 'auto' }, ctx);
        // Some boxes (an address bar, a search box) cannot be read back: the run carries on, and the
        // next steps (enter, wait_for) show whether it worked. It is never typed again.
        return `typed into ${r.into}${r.confirmed ? ' (read back)' : r.confirmed === false ? ' (could not read it back; not typed again)' : ''}`;
      }
      case 'keys': {
        const before = (await backend.userActivity().catch(() => null))?.foreground ?? null;
        await keys.execute({ combo: st.combo, repeat: st.repeat, effect: st.effect }, ctx);
        // Keys that open a window (win+r, win+e, ctrl+n, ctrl+o, ctrl+s the first time…): the next step
        // waits until that window is in front, so typing never lands in the window behind it.
        if (/^(win(dows)?\+[a-z]|ctrl\+(n|o|s|shift\+s|p|f|h|g)|f12|alt\+(d|f4)|win(dows)?)$/i.test(st.combo.replace(/\s+/g, ''))) {
          const until = Date.now() + (d.focusSettleMs === 0 ? 0 : 2500);
          for (;;) {
            const now = (await backend.userActivity().catch(() => null))?.foreground ?? null;
            if ((now && now !== before) || Date.now() >= until) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          if (d.focusSettleMs !== 0) await new Promise((r) => setTimeout(r, 250));
        }
        return `pressed ${st.combo.toUpperCase()}`;
      }
      case 'wait_for':
        return `saw ${await waitFor(st, ctx)}`;
    }
  };

  /** The app the last run ended in: its know-how is given again only when a run reaches another app. */
  let lastApp: string | null = null;

  const doSteps = defineCapability({
    ...base,
    id: 'computer.do',
    title: 'Do several steps in an app',
    timeoutMs: 180000,
    description:
      'Full control, the fast way to use an app like a person: up to 8 steps in ONE call, run one after another in the app in front — click a button, link, tab or box BY ITS NAME ({do:"click", name:"New chat"}), click a point from your latest look ({do:"click_at", x, y, what}), type at the keyboard focus ({do:"type", text, replace}), press keys ({do:"keys", combo:"ctrl+l"}), wait until something appears ({do:"wait_for", name:"Inbox"}). It stops at the first step that fails and says why. The result ends with `after`: the window in front and the elements a person can see on it now (role, name, value, focused…) — use it to plan the next steps instead of screen__look. Give a step `effect` when it sends, posts, pays, deletes, submits or installs (e.g. clicking Send, Enter in a chat): the user approves the run once. Keo never types passwords or card numbers.',
    input: z
      .object({
        steps: z.array(Step).min(1).max(8),
        look: z.boolean().default(true).describe('Return the window’s elements afterwards (on by default)'),
      })
      .strict(),
    output: z.object({
      done: z.number(),
      total: z.number(),
      steps: z.array(z.string()),
      stopped: z.string().nullable(),
      after: z.object({ app: z.string(), window: z.string(), elements: z.array(z.string()), omitted: z.number(), tips: z.array(z.string()).optional() }).nullable(),
    }),
    risk: 'high',
    verificationPolicy: 'Each step is checked as it runs (the element is found by name before clicking; typed text is read back); the window’s elements are read afterwards.',
    autonomy: (i) => {
      const effects = [...new Set(i.steps.map(stepEffect).filter((e) => e !== 'none'))] as Array<Exclude<Effect, 'none'>>;
      if (effects.length) return { tier: 'critical' as const, reason: `These steps ${effects.map((e) => EFFECT_WORDS[e]).join(' and ')}: the user approves it every time.` };
      if (i.steps.some((st) => st.do === 'keys' && /^alt\+f4$|^ctrl\+q$|^ctrl\+shift\+w$/.test(st.combo.toLowerCase().replace(/\s+/g, '')))) return { tier: 'important' as const, reason: 'This closes a window or an app.' };
      return { tier: 'routine' as const };
    },
    precheck: (i) => (i.steps.some((st) => st.do === 'type' && looksLikeCardNumber(st.text)) ? 'That text contains a card number. Keo never types card numbers — the user enters payment details themselves.' : null),
    preview: (i) => {
      const effects = i.steps.filter((st) => stepEffect(st) !== 'none');
      return {
        summary: `${i.steps.length} step${i.steps.length > 1 ? 's' : ''}: ${i.steps.map(stepLabel).join(', then ')}`.slice(0, 300),
        target: 'The app in front',
        consequences: effects.length ? effects.map((st) => `“${stepLabel(st)}” ${EFFECT_WORDS[stepEffect(st) as Exclude<Effect, 'none'>]}.`) : ['Clicks, typing and keys in whichever app is in front.'],
        dataExport: null,
      };
    },
    auditView: (i) => ({ steps: i.steps.map((st) => st.do), effects: i.steps.map(stepEffect).filter((e) => e !== 'none') }),
    async execute(i, ctx) {
      const results: string[] = [];
      let stopped: string | null = null;
      for (const [k, st] of i.steps.entries()) {
        if (ctx.signal.aborted) {
          stopped = `Stopped before step ${k + 1}.`;
          break;
        }
        try {
          results.push(await runOne(st, ctx));
        } catch (e) {
          // Nothing done yet: a plain failure (nothing to report but why). Otherwise report how far it got.
          if (k === 0 && e instanceof CapabilityError && e.dispatched === 'no') throw e;
          stopped = `Step ${k + 1} (${stepLabel(st)}) did not work: ${(e as Error).message}`;
          break;
        }
      }
      let after: { app: string; window: string; elements: string[]; omitted: number; tips?: string[] } | null = null;
      if (i.look && !ctx.signal.aborted) {
        try {
          // A moment for the app to react to the last step, like a person glancing at it.
          if (d.focusSettleMs !== 0) await new Promise((r) => setTimeout(r, 250));
          const w = await foreground();
          const { lines, omitted } = elementLines((await quickRead(w)).nodes, 70);
          // Know-how for an app the first time a run lands in it (a person knows the shortcuts).
          const tips = lastApp !== w.processName ? knowhowFor(w.processName, w.title)?.tips : undefined;
          lastApp = w.processName;
          after = { app: w.processName, window: w.title.slice(0, 120), elements: lines, omitted, ...(tips ? { tips } : {}) };
        } catch {
          after = null;
        }
      }
      return { done: results.length, total: i.steps.length, steps: results, stopped, after };
    },
    async verify(_i, o) {
      return o.stopped ? { verified: false, detail: o.stopped } : { verified: true, detail: `All ${o.total} steps done.` };
    },
  });

  return [click, type, keys, scroll, drag, fillForm, doSteps];
}
