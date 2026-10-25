/**
 * Single-file web games and apps. The model writes the page; Keo saves it only when it is
 * self-contained (no remote scripts, styles, fonts, images, frames or network calls) and adds a
 * Content-Security-Policy that blocks every network request anyway, so a missed pattern still
 * cannot reach the internet when the page runs in the user's browser.
 */

export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** XML namespace names are identifiers, not requests; everything else with a scheme is refused. */
const NAMESPACE = /^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1999\/xlink|1998\/Math\/MathML|XML\/1998\/namespace)$/i;

const RULES: Array<[RegExp, string]> = [
  [/<script\b[^>]*\bsrc\s*=/i, 'an external script (<script src>)'],
  [/<link\b[^>]*\bhref\s*=/i, 'a linked file (<link href>)'],
  [/<(iframe|frame|object|embed|applet|portal)\b/i, 'an embedded frame or object'],
  [/<base\b/i, 'a <base> tag'],
  [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, 'a page redirect'],
  [/<form\b[^>]*\baction\s*=/i, 'a form that submits somewhere'],
  [/@import\b/i, 'a CSS @import'],
  [/\b(fetch|importScripts)\s*\(/, 'a network request (fetch)'],
  [/\bXMLHttpRequest\b/, 'a network request (XMLHttpRequest)'],
  [/\b(WebSocket|EventSource|RTCPeerConnection|WebTransport)\b/, 'a network connection'],
  [/\bsendBeacon\b/, 'a network request (sendBeacon)'],
  [/\bimport\s*\(/, 'a dynamic import'],
  [/^\s*import\s[^;]*\bfrom\b/m, 'a module import'],
  [/\bwindow\.open\s*\(/, 'opening another page'],
  [/\b(location\.(href|assign|replace)|document\.location|window\.location)\s*(=|\()/, 'navigating to another page'],
  [/\bnavigator\.serviceWorker\b/, 'a service worker'],
  [/(^|[\s"'(=,])\/\/[a-z0-9-]+\.[a-z0-9.-]+\//i, 'a protocol-relative URL (//host/…)'],
];

export function pageProblems(html: string): string[] {
  const problems = new Set<string>();
  for (const m of html.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>()]*/gi)) {
    if (!NAMESPACE.test(m[0].replace(/[),;]+$/, ''))) problems.add(`a remote URL (${m[0].slice(0, 80)})`);
  }
  for (const [re, what] of RULES) if (re.test(html)) problems.add(what);
  if (!/<(script|canvas|body|div|svg|main|button)\b/i.test(html)) problems.add('no page content (expected HTML with a <script>, <canvas> or <body>)');
  return [...problems];
}

/** The page with Keo's network-blocking policy as the first thing in <head>. */
export function withPolicy(html: string, title: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
  const t = title.replace(/[<>&"]/g, '');
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${meta}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (h) => `${h}\n<head>${meta}<meta charset="utf-8"><title>${t}</title></head>`);
  return `<!doctype html>\n<html><head>${meta}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title></head><body>\n${html}\n</body></html>`;
}
