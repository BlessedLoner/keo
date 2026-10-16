import type { UiaNodeRaw } from './backend';

/**
 * Small, pure adapter that recognises WhatsApp (Web in a browser, or the
 * Desktop app) from a UI Automation snapshot using roles, accessible names and
 * layout — no fixed coordinates. It only *reads* structure; all actions go
 * through the generic capability layer with its identity and approval checks.
 */
export interface WaChat {
  index: number;
  title: string;
  node: UiaNodeRaw;
}

export interface WaMessage {
  from: 'me' | 'them' | 'unknown';
  text: string;
  status: string | null;
}

export interface WaView {
  search: UiaNodeRaw | null;
  compose: UiaNodeRaw | null;
  send: UiaNodeRaw | null;
  header: string | null;
  chats: WaChat[];
  messages: WaMessage[];
}

export const normName = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/[^\p{L}\p{N}+ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Exact (normalised) match between the open chat's header and the intended contact. */
export function headerMatches(header: string | null, contact: string): boolean {
  if (!header) return false;
  return normName(header) === normName(contact);
}

const GENERIC_HEADER = /^(search|menu|more options|new chat|video call|voice call|call|chats|status|channels|communities|settings|profile|get the app|attach|emoji|archived|filter|unread|all|groups|favourites|favorites|whatsapp|back|close|search\.\.\.|search messages?)$/i;
const TIME = /^\s*(\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;
const STATUS = /\b(pending|sent|delivered|read)\b/i;

const TRAILING_TIME = /\s*(\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;

/** Item names that concatenate their text (“Daniel Okafor10:40”) lose the trailing time stamp. */
function stripTrailingTime(name: string): string {
  const t = name.replace(TRAILING_TIME, '').trim();
  return t || name.trim();
}

function children(nodes: UiaNodeRaw[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = m.get(n.parent) ?? [];
    list.push(i);
    m.set(n.parent, list);
  });
  return m;
}

function descendants(i: number, kids: Map<number, number[]>, limit = 60): number[] {
  const out: number[] = [];
  const stack = [...(kids.get(i) ?? [])].reverse();
  while (stack.length && out.length < limit) {
    const j = stack.pop() as number;
    out.push(j);
    stack.push(...[...(kids.get(j) ?? [])].reverse());
  }
  return out;
}

const cx = (n: UiaNodeRaw) => (n.x ?? 0) + (n.w ?? 0) / 2;
const cy = (n: UiaNodeRaw) => (n.y ?? 0) + (n.h ?? 0) / 2;

export function analyzeWhatsApp(nodes: UiaNodeRaw[], win: { w: number; h: number }): WaView {
  const kids = children(nodes);
  const W = Math.max(1, win.w);
  const H = Math.max(1, win.h);
  const editable = (n: UiaNodeRaw) => (n.role === 'edit' || n.role === 'combobox' || n.role === 'document') && !n.password && !n.offscreen;

  const searchCandidates = nodes.filter((n) => editable(n) && /search/i.test(`${n.name} ${n.aid ?? ''}`) && cx(n) < W * 0.5);
  const search = searchCandidates.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))[0] ?? null;

  const composeCandidates = nodes.filter(
    (n) => editable(n) && n !== search && /(type a message|message|compose|write)/i.test(`${n.name} ${n.aid ?? ''}`) && !/search/i.test(n.name) && cx(n) > W * 0.3,
  );
  const compose = composeCandidates.sort((a, b) => (b.y ?? 0) - (a.y ?? 0))[0] ?? null;

  const send = nodes.find((n) => n.role === 'button' && /^send\b/i.test(n.name.trim()) && !n.offscreen) ?? null;

  // Header: first named control in the top band of the right-hand pane.
  const paneLeft = W * 0.3;
  const headerNode = nodes.find(
    (n) =>
      !!n.name &&
      ['button', 'text', 'hyperlink', 'header', 'headeritem', 'group'].includes(n.role) &&
      cx(n) > paneLeft &&
      cy(n) < H * 0.18 &&
      (n.y ?? 0) >= 0 &&
      !GENERIC_HEADER.test(n.name.trim()) &&
      !TIME.test(n.name) &&
      n.name.trim().length <= 80,
  );
  const header = headerNode ? headerNode.name.split(/\s{2,}|\n/)[0]!.trim() : null;

  // Chat list: list items in the left pane; title = first named text child.
  const chats: WaChat[] = [];
  nodes.forEach((n, i) => {
    if (!['listitem', 'dataitem', 'treeitem'].includes(n.role) || cx(n) > W * 0.45 || n.offscreen) return;
    const texts = descendants(i, kids)
      .map((j) => nodes[j] as UiaNodeRaw)
      .filter((d) => d.role === 'text' && d.name && !TIME.test(d.name));
    const title = (texts[0]?.name ?? stripTrailingTime(n.name.split(/\s{2,}|\n/)[0] ?? '')).trim();
    if (title) chats.push({ index: i, title, node: n });
  });

  // Messages: rows between the header and the compose box in the right pane.
  const top = headerNode ? (headerNode.y ?? 0) + (headerNode.h ?? 0) : H * 0.1;
  const bottom = compose ? (compose.y ?? H) : H * 0.9;
  const rowIdx = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => ['listitem', 'dataitem', 'row', 'group'].includes(n.role) && cx(n) > paneLeft && cy(n) > top && cy(n) < bottom && !n.offscreen);
  const rows = rowIdx.filter(({ i }) => !rowIdx.some((o) => o.i !== i && descendants(o.i, kids, 400).includes(i))); // outermost only
  const paneMid = paneLeft + (W - paneLeft) / 2;
  const messages: WaMessage[] = rows.map(({ n, i }) => {
    const ds = descendants(i, kids, 120).map((j) => nodes[j] as UiaNodeRaw);
    const textParts = ds.filter((d) => d.role === 'text' && d.name && !TIME.test(d.name) && !STATUS.test(d.name.trim())).map((d) => d.name.trim());
    const text = (textParts.length ? textParts.join(' ') : n.name).replace(/\s+/g, ' ').trim().slice(0, 1000);
    const statusNode = ds.find((d) => STATUS.test(d.name ?? '') && (d.name ?? '').trim().length < 20);
    const youPrefix = /^you:/i.test(n.name);
    // Rows are often full-width; the bubble's content tells which side it sits on.
    const boxed = ds.filter((d) => (d.w ?? 0) > 0 && (d.h ?? 0) > 0 && !d.offscreen);
    const left = boxed.length ? Math.min(...boxed.map((d) => d.x ?? 0)) : (n.x ?? 0);
    const right = boxed.length ? Math.max(...boxed.map((d) => (d.x ?? 0) + (d.w ?? 0))) : (n.x ?? 0) + (n.w ?? 0);
    const mid = (left + right) / 2;
    const from: WaMessage['from'] = youPrefix ? 'me' : mid > paneMid + 4 ? 'me' : mid < paneMid - 4 ? 'them' : 'unknown';
    return { from, text, status: statusNode ? (STATUS.exec(statusNode.name)?.[1] ?? null)?.toLowerCase() ?? null : null };
  });

  return { search, compose, send, header, chats, messages: messages.filter((m) => m.text) };
}

/** The most recent message sent by the user, if visible. */
export function lastOutgoing(view: WaView): WaMessage | null {
  for (let i = view.messages.length - 1; i >= 0; i--) if (view.messages[i]!.from === 'me') return view.messages[i]!;
  return null;
}

export function textMatches(haystack: string, needle: string): boolean {
  const a = normName(haystack);
  const b = normName(needle);
  return b.length > 0 && a.includes(b);
}
