/**
 * Using a page while checking it: clicks, keys held down, typing, scrolling and reading a value,
 * so Keo plays the game or fills the form it built instead of only looking at the first screen.
 *
 * Each action becomes a small script that runs inside the build's own sandboxed page (the same
 * place the build's code runs; nothing of Keo is reachable from there). Events are made in the
 * page, so they work in the hidden check window, which never has the keyboard.
 */
import { z } from 'zod';

const Code = z.string().regex(/^[A-Za-z0-9]{1,20}$/, 'A key as KeyboardEvent.code, like KeyW, ArrowUp, Space, Enter, ShiftLeft, Digit1');

export const CheckAction = z.discriminatedUnion('do', [
  z
    .object({
      do: z.literal('click'),
      /** The words on the button or link (preferred). */
      text: z.string().trim().min(1).max(120).optional(),
      selector: z.string().trim().min(1).max(200).optional(),
      /** A point in the page, when there is nothing to name (a canvas). */
      x: z.number().min(0).max(4000).optional(),
      y: z.number().min(0).max(4000).optional(),
    })
    .strict(),
  // Long holds let Keo play for a minute or more: some bugs only show after a while (a car that wears out, a score that stops).
  z.object({ do: z.literal('keys'), keys: z.array(Code).min(1).max(4), holdSeconds: z.number().min(0).max(60).default(0.15) }).strict(),
  z.object({ do: z.literal('type'), text: z.string().max(500), selector: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ do: z.literal('scroll'), y: z.number().min(-20000).max(20000) }).strict(),
  z.object({ do: z.literal('wait'), seconds: z.number().min(0.1).max(60) }).strict(),
  /** A JavaScript expression read in the page, e.g. "window.game.player.mph" or "document.querySelectorAll('.card').length". */
  z.object({ do: z.literal('measure'), expression: z.string().trim().min(1).max(400) }).strict(),
]);
export type CheckAction = z.infer<typeof CheckAction>;

const KEY_NAMES: Record<string, [string, number]> = {
  Space: [' ', 32],
  Enter: ['Enter', 13],
  Escape: ['Escape', 27],
  Tab: ['Tab', 9],
  Backspace: ['Backspace', 8],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  ShiftLeft: ['Shift', 16],
  ShiftRight: ['Shift', 16],
  ControlLeft: ['Control', 17],
  ControlRight: ['Control', 17],
  AltLeft: ['Alt', 18],
};

/** A key code as the page's key events carry it: { code, key, keyCode }. */
export function keyOf(code: string): { code: string; key: string; keyCode: number } {
  const named = KEY_NAMES[code];
  if (named) return { code, key: named[0], keyCode: named[1] };
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return { code, key: letter[1]!.toLowerCase(), keyCode: letter[1]!.charCodeAt(0) };
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return { code, key: digit[1]!, keyCode: 48 + Number(digit[1]) };
  return { code, key: code, keyCode: 0 };
}

/** How the click script marks a link to another page: `[opens <url>]`. */
export const OPENS = '[opens ';

const CLICK = `(function (a) {
  var OPENS = ${JSON.stringify(OPENS)};
  var vis = function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  var words = function (e) { return String(e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase(); };
  var el = null;
  if (a.selector) { try { el = document.querySelector(a.selector); } catch (e) { return 'not found: the selector is not valid'; } }
  else if (a.text) {
    var want = a.text.trim().toLowerCase();
    var all = Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], summary, label, [data-a], [onclick], [tabindex]')).filter(vis);
    el = all.find(function (e) { return words(e) === want; }) || all.find(function (e) { return words(e).indexOf(want) === 0; }) || all.find(function (e) { return words(e).indexOf(want) >= 0; }) || null;
  }
  if (!el && (a.x == null || a.y == null)) return 'not found' + (a.text ? ': nothing on the page says "' + a.text + '"' : '');
  var x = a.x, y = a.y;
  if (el) { el.scrollIntoView({ block: 'center' }); var r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
  var target = el || document.elementFromPoint(x, y) || document.body;
  if (target.disabled) return 'not clicked: "' + words(target).slice(0, 60) + '" is disabled';
  // A link to another page: say where it goes, so the check can see that the page really opened.
  var link = target.closest ? target.closest('a[href]') : null;
  var goes = link && link.target !== '_blank' && !link.hasAttribute('download') && link.href && link.href.split('#')[0] !== location.href.split('#')[0] ? link.href : '';
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
    var E = t.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    target.dispatchEvent(new E(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 }));
  });
  if (typeof target.click === 'function') target.click();
  else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
  return 'clicked ' + (words(target).split('\\n')[0].slice(0, 60) || target.tagName.toLowerCase()) + (goes ? ' ' + OPENS + goes + ']' : '');
})`;

const KEYS = `(function (a) {
  var fire = function (type, k) {
    var t = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    t.dispatchEvent(new KeyboardEvent(type, { code: k.code, key: k.key, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, view: window }));
  };
  a.keys.forEach(function (k) { fire('keydown', k); });
  return new Promise(function (done) {
    setTimeout(function () { a.keys.forEach(function (k) { fire('keyup', k); }); done('held'); }, a.ms);
  });
})`;

const TYPE = `(function (a) {
  var el = null;
  if (a.selector) { try { el = document.querySelector(a.selector); } catch (e) { return 'not found: the selector is not valid'; } }
  else el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true]');
  if (!el) return 'not found: no field to type into';
  el.focus();
  if (el.isContentEditable) el.textContent = a.text;
  else {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var set = Object.getOwnPropertyDescriptor(proto, 'value');
    if (set && set.set) set.set.call(el, a.text); else el.value = a.text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed into ' + (el.name || el.id || el.placeholder || el.tagName.toLowerCase());
})`;

/** The script for one action (null for a plain wait), and how long to let the page settle after it. */
export function actionScript(a: CheckAction): { script: string | null; settleMs: number } {
  switch (a.do) {
    case 'click':
      return { script: `${CLICK}(${JSON.stringify({ text: a.text, selector: a.selector, x: a.x, y: a.y })})`, settleMs: 700 };
    case 'keys':
      return { script: `${KEYS}(${JSON.stringify({ keys: a.keys.map(keyOf), ms: Math.round(a.holdSeconds * 1000) })})`, settleMs: 150 };
    case 'type':
      return { script: `${TYPE}(${JSON.stringify({ text: a.text, selector: a.selector })})`, settleMs: 200 };
    case 'scroll':
      return { script: `(window.scrollBy(0, ${Math.round(a.y)}), 'scrolled to ' + Math.round(window.scrollY))`, settleMs: 500 };
    case 'wait':
      return { script: null, settleMs: Math.round(a.seconds * 1000) };
    case 'measure':
      // The expression is the build's own code talking about the build's own page.
      return {
        script: `(async function () { try { var v = await (${a.expression}); return typeof v === 'string' ? v.slice(0, 500) : String(JSON.stringify(v)).slice(0, 500); } catch (e) { return 'error: ' + (e && e.message ? e.message : e); } })()`,
        settleMs: 0,
      };
  }
}

/** One action in a few words, for the check's report. */
export function actionLabel(a: CheckAction): string {
  switch (a.do) {
    case 'click':
      return a.text ? `click “${a.text}”` : a.selector ? `click ${a.selector}` : `click at ${a.x}, ${a.y}`;
    case 'keys':
      return `hold ${a.keys.join(' + ')} for ${a.holdSeconds}s`;
    case 'type':
      return `type “${a.text.slice(0, 40)}”`;
    case 'scroll':
      return `scroll ${a.y}`;
    case 'wait':
      return `wait ${a.seconds}s`;
    case 'measure':
      return `measure ${a.expression}`;
  }
}
