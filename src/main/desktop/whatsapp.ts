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
  /** The visible name text inside the entry, when exposed (best place to click). */
  titleNode: UiaNodeRaw | null;
  /** Unread messages WhatsApp reports for this chat (0 when none or unknown). */
  unread: number;
}

export interface WaMessage {
  from: 'me' | 'them' | 'unknown';
  text: string;
  status: string | null;
  /** The message row (used to read text a web page hides from the control view). */
  row?: UiaNodeRaw;
}

export interface WaView {
  search: UiaNodeRaw | null;
  compose: UiaNodeRaw | null;
  send: UiaNodeRaw | null;
  header: string | null;
  /**
   * Other places that name the open chat: header-area buttons and the selected chat in the list.
   * Used only to confirm a chat the user named (never to pick a recipient).
   */
  headerAlternatives?: string[];
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

/**
 * The contact/group name from a header label: WhatsApp appends screen-reader
 * hints, presence and labels (“click here for contact info”, “Business
 * Account”, “online”, “typing…”, “last seen today at 10:02”) to the same element.
 */
export function cleanHeader(name: string): string {
  let t = name.replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 3; k++) {
    t = t
      .replace(/[\s,.]*(click|tap) here for (contact|group) info\s*$/i, '')
      .replace(/[\s,.·-]*(official\s+)?business\s+account\s*$/i, '')
      .replace(/[\s,.]*(online|typing(…|\.\.\.)?|recording audio(…|\.\.\.)?|last seen\b.*)\s*$/i, '')
      // WhatsApp app: your own chat reads "Name (You) Message yourself".
      .replace(/[\s,.]*message yourself\s*$/i, '')
      .trim();
  }
  return t;
}

/**
 * Whether the open chat is the one the user named: the header, or — when the app lays the header
 * out differently (smaller window, banners, other versions) — a header-area button or the chat
 * selected in the list carries exactly that name.
 */
export function openChatIs(view: Pick<WaView, 'header' | 'headerAlternatives'>, contact: string): boolean {
  if (headerMatches(view.header, contact)) return true;
  return (view.headerAlternatives ?? []).some((a) => headerMatches(a, contact));
}

/** Exact (normalised) match between the open chat's header and the intended contact. */
export function headerMatches(header: string | null, contact: string): boolean {
  if (!header) return false;
  return sameChat(cleanHeader(header), contact);
}

/** Same chat name, normalised; "Name (You)" — your own chat — also matches "Name". */
export function sameChat(a: string, b: string): boolean {
  const bare = (s: string) => normName(s.replace(/\s*\(you\)\s*$/i, ''));
  return normName(a) === normName(b) || bare(a) === bare(b);
}

const GENERIC_HEADER = /^(search|menu|more options|new chat|profile details|contact info|end icon button|start icon button|read more|voice message|emojis, gifs, stickers|disappearing messages|encrypted|click here for contact info|video call|voice call|call|chats|status|channels|communities|settings|profile|get the app|attach|emoji|archived|filter|unread|all|groups|favourites|favorites|whatsapp|back|close|search\.\.\.|search messages?)$/i;
/** "Search" in WhatsApp's common interface languages. */
const SEARCH = /search|pesquis|buscar|busca|rechercher|recherche|suchen|suche|cerca|zoek|szukaj|\bara\b|arama|поиск|пошук|بحث|搜索|検索|검색|tìm|cari|ค้นหา|חיפוש|αναζήτηση|hľadať|hledat|keresés|sök|søg|søk|haku|caută/i;
const COMPOSE = /type a message|message|compose|write|mensagem|mensaje|nachricht|messaggio|bericht|сообщение/i;
const TIME = /^\s*(\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;
const STATUS = /\b(pending|sent|delivered|read)\b/i;
/** A delivery status on its own ("Delivered") is never a chat name. */
const STATUS_ONLY = /^(pending|sent|delivered|read|seen|failed)$/i;

const TRAILING_TIME = /\s*(\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i;

/** Item names that concatenate their text (“Daniel Okafor10:40”) lose the trailing time stamp. */
function stripTrailingTime(name: string): string {
  const t = name.replace(TRAILING_TIME, '').trim();
  return t || name.trim();
}

/** Removes WhatsApp's screen-reader prefixes (“1 unread message”, “View status”) from a chat name. */
function cleanTitle(name: string): string {
  return name.replace(/^\s*(\d+\s+unread\s+messages?|view\s+status|muted|pinned)[\s,:.]*/gi, '').trim();
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

const hasBox = (n: UiaNodeRaw) => n.x !== undefined && n.y !== undefined && (n.w ?? 0) > 0 && (n.h ?? 0) > 0;

/**
 * Recognises WhatsApp's controls. In a browser (WhatsApp Web) only the web
 * page counts: the browser's own address bar, tabs and window buttons are
 * never mistaken for WhatsApp's search box or chat header.
 */
export function analyzeWhatsApp(nodes: UiaNodeRaw[], win: { w: number; h: number }): WaView {
  const docs = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.role === 'document' && hasBox(n));
  const doc = docs.sort((a, b) => (b.n.w ?? 0) * (b.n.h ?? 0) - (a.n.w ?? 0) * (a.n.h ?? 0))[0];
  if (!doc) return analyzeScoped(nodes, win);
  const inPage = descendants(doc.i, children(nodes), 100_000);
  const remap = new Map<number, number>(inPage.map((orig, k) => [orig, k]));
  const ox = doc.n.x ?? 0;
  const oy = doc.n.y ?? 0;
  const scoped = inPage.map((orig, k) => {
    const n = nodes[orig]!;
    return { ...n, i: k, parent: remap.get(n.parent) ?? -1, x: n.x === undefined ? undefined : n.x - ox, y: n.y === undefined ? undefined : n.y - oy };
  });
  const back = (n: UiaNodeRaw | null): UiaNodeRaw | null => (n ? (nodes[inPage[n.i ?? -1] ?? -1] ?? null) : null);
  const v = analyzeScoped(scoped, { w: doc.n.w ?? win.w, h: doc.n.h ?? win.h });
  return {
    ...v,
    search: back(v.search),
    compose: back(v.compose),
    send: back(v.send),
    chats: v.chats.map((c) => ({ ...c, index: inPage[c.index]!, node: back(c.node)!, titleNode: back(c.titleNode) })),
  };
}

function analyzeScoped(nodes: UiaNodeRaw[], win: { w: number; h: number }): WaView {
  const kids = children(nodes);
  const W = Math.max(1, win.w);
  const H = Math.max(1, win.h);
  const editable = (n: UiaNodeRaw) => (n.role === 'edit' || n.role === 'combobox' || n.role === 'document') && !n.password && !n.offscreen && hasBox(n);

  const searchCandidates = nodes.filter((n) => editable(n) && SEARCH.test(`${n.name} ${n.aid ?? ''}`) && cx(n) < W * 0.5);
  // Other languages or unnamed fields: the top-most single-line field at the top of the chat list.
  const byPlace = nodes.filter(
    (n) => (n.role === 'edit' || n.role === 'combobox') && editable(n) && cx(n) < W * 0.45 && cy(n) < H * 0.3 && !COMPOSE.test(`${n.name} ${n.aid ?? ''}`),
  );
  const search = searchCandidates.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))[0] ?? byPlace.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))[0] ?? null;

  const composeCandidates = nodes.filter(
    (n) => editable(n) && n !== search && COMPOSE.test(`${n.name} ${n.aid ?? ''}`) && !SEARCH.test(n.name) && cx(n) > W * 0.3,
  );
  // Other languages: the bottom-most field in the lower part of the conversation pane.
  const composeByPlace = nodes.filter((n) => editable(n) && n !== search && !SEARCH.test(`${n.name} ${n.aid ?? ''}`) && cx(n) > W * 0.35 && cy(n) > H * 0.7);
  const compose = composeCandidates.sort((a, b) => (b.y ?? 0) - (a.y ?? 0))[0] ?? composeByPlace.sort((a, b) => (b.y ?? 0) - (a.y ?? 0))[0] ?? null;

  const send = nodes.find((n) => n.role === 'button' && /^send\b/i.test(n.name.trim()) && !n.offscreen) ?? null;

  // Chat list: list items in the left pane; title = first named text child.
  const chats: WaChat[] = [];
  nodes.forEach((n, i) => {
    if (!['listitem', 'dataitem', 'treeitem'].includes(n.role) || cx(n) > W * 0.45 || n.offscreen) return;
    const texts = descendants(i, kids)
      .map((j) => nodes[j] as UiaNodeRaw)
      .filter((d) => d.role === 'text' && d.name && !TIME.test(d.name));
    const title = cleanTitle(texts[0]?.name ?? stripTrailingTime(n.name.split(/\s{2,}|\n/)[0] ?? ''));
    const unread = Number(/(\d+)\s+unread\s+messages?/i.exec(`${texts[0]?.name ?? ''} ${n.name}`)?.[1] ?? 0);
    if (title) chats.push({ index: i, title, node: n, titleNode: texts[0] && !texts[0].offscreen ? texts[0] : null, unread });
  });
  // WhatsApp Web nests entries (row › cell › name); keep only the innermost one of each.
  const nested = new Set(chats.filter((c) => chats.some((o) => o !== c && descendants(c.index, kids, 400).includes(o.index))).map((c) => c.index));
  const innermost = chats.filter((c) => !nested.has(c.index));

  // The conversation pane starts where the chat list ends. The list is narrower than 30% of a wide
  // (maximised) window, so 30% is only the fallback when no list is visible.
  const leftEdges = [search, ...chats.map((c) => c.node)].filter((n): n is UiaNodeRaw => !!n && hasBox(n)).map((n) => (n.x ?? 0) + (n.w ?? 0));
  const paneLeft = leftEdges.length ? Math.max(...leftEdges) : W * 0.3;

  // Header: the contact/group name in the top band of the conversation pane. Several controls live
  // there (profile, call, search, menu); the name is the widest one that is not a known action.
  const headerNode =
    nodes
      .filter(
        (n) =>
          !!n.name &&
          hasBox(n) &&
          !n.offscreen &&
          ['button', 'text', 'hyperlink', 'header', 'headeritem', 'group'].includes(n.role) &&
          (n.x ?? 0) >= paneLeft - 2 &&
          cy(n) < H * 0.12 &&
          (n.y ?? 0) >= 0 &&
          !GENERIC_HEADER.test(n.name.trim()) &&
          !STATUS_ONLY.test(n.name.trim()) &&
          !TIME.test(n.name) &&
          n.name.trim().length <= 80,
      )
      .sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0] ?? null;
  const header = headerNode ? cleanHeader(headerNode.name.split(/\s{2,}|\n/)[0]!) || null : null;
  // Confirmations of the open chat: buttons in a slightly taller header band (a banner or a small
  // window moves the header down) and the selected chat in the list. Message text never counts.
  const band = Math.max(H * 0.18, 130);
  const headerAlternatives = [
    ...nodes
      .filter((n) => !!n.name && hasBox(n) && !n.offscreen && ['button', 'header', 'headeritem'].includes(n.role) && (n.x ?? 0) >= paneLeft - 2 && cy(n) < band && (n.y ?? 0) >= 0 && !GENERIC_HEADER.test(n.name.trim()) && !STATUS_ONLY.test(n.name.trim()) && n.name.trim().length <= 80)
      .map((n) => cleanHeader(n.name.split(/\s{2,}|\n/)[0]!)),
    ...innermost.filter((c) => c.node.selected).map((c) => c.title),
  ].filter(Boolean);

  // Messages: rows between the header and the compose box in the right pane.
  const top = headerNode ? (headerNode.y ?? 0) + (headerNode.h ?? 0) : H * 0.1;
  const bottom = compose ? (compose.y ?? H) : H * 0.9;
  const rowIdx = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => ['listitem', 'dataitem', 'row', 'group'].includes(n.role) && cx(n) > paneLeft && cy(n) > top && cy(n) < bottom && !n.offscreen);
  // Real rows (list/data items) win over generic groups, which often just wrap the whole list.
  const items = rowIdx.filter(({ n }) => n.role !== 'group' && (n.h ?? 0) < (bottom - top) * 0.8);
  const base = items.length ? items : rowIdx.filter(({ n }) => (n.h ?? 0) < (bottom - top) * 0.8);
  const rows = base.filter(({ i }) => !base.some((o) => o.i !== i && descendants(o.i, kids, 400).includes(i))); // outermost only
  const paneMid = paneLeft + (W - paneLeft) / 2;
  const messages: WaMessage[] = rows.map(({ n, i }) => {
    const ds = descendants(i, kids, 120).map((j) => nodes[j] as UiaNodeRaw);
    const textParts = ds.filter((d) => d.role === 'text' && d.name && !TIME.test(d.name) && !STATUS.test(d.name.trim()) && !/^[^:]{1,60}:$/.test(d.name.trim())).map((d) => d.name.trim());
    const text = (textParts.length ? textParts.join(' ') : n.name).replace(/\s+/g, ' ').trim().slice(0, 1000);
    const statusNode = ds.find((d) => STATUS.test(d.name ?? '') && (d.name ?? '').trim().length < 20);
    // WhatsApp Web labels each message with its sender (“Ma Glo:”, “You:”).
    const sender = [n, ...ds].map((d) => (d.name ?? '').trim()).find((t) => /^[^:]{1,60}:$/.test(t)) ?? null;
    const youPrefix = /^you:/i.test(n.name) || (sender !== null && /^you:$/i.test(sender));
    // Rows are often full-width; the bubble's content tells which side it sits on.
    const boxed = ds.filter((d) => (d.w ?? 0) > 0 && (d.h ?? 0) > 0 && !d.offscreen);
    const left = boxed.length ? Math.min(...boxed.map((d) => d.x ?? 0)) : (n.x ?? 0);
    const right = boxed.length ? Math.max(...boxed.map((d) => (d.x ?? 0) + (d.w ?? 0))) : (n.x ?? 0) + (n.w ?? 0);
    const mid = (left + right) / 2;
    const from: WaMessage['from'] = youPrefix ? 'me' : sender ? 'them' : mid > paneMid + 4 ? 'me' : mid < paneMid - 4 ? 'them' : 'unknown';
    return { from, text, status: statusNode ? (STATUS.exec(statusNode.name)?.[1] ?? null)?.toLowerCase() ?? null : null, row: n };
  });

  // Rows without readable text are kept so the caller can read them through the raw view (see completeMessages).
  return { search, compose, send, header, headerAlternatives, chats: innermost, messages };
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

/**
 * Completes messages whose text is hidden from the control view with the
 * names read inside each row (sender label, text, time, delivery status),
 * then drops rows that still have no text (date separators, empty rows).
 */
export function completeMessages(messages: WaMessage[], namesByRow: Map<WaMessage, string[]>, contact: string | null = null): WaMessage[] {
  return messages
    .map((m) => {
      const names = namesByRow.get(m);
      if (m.text || !names) return m;
      const clean = names.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const sender = clean.find((t) => /^[^:]{1,60}:$/.test(t)) ?? null;
      const status = clean.map((t) => (t.length <= 24 ? STATUS.exec(t)?.[1] : undefined)).find(Boolean)?.toLowerCase() ?? m.status;
      const text = clean
        .filter((t) => t !== sender && !TIME.test(t) && !(t.length <= 24 && STATUS.test(t)) && !/^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i.test(t))
        .join(' ')
        .slice(0, 1000);
      // A sender label decides only when it is unambiguous; otherwise the bubble's side (from layout) stands.
      const label = sender ? normName(sender.slice(0, -1)) : null;
      const from: WaMessage['from'] = label === 'you' ? 'me' : label && contact && label === normName(contact) ? 'them' : m.from;
      return { ...m, text, status, from };
    })
    .filter((m) => m.text);
}

export type WaReadiness = 'ready' | 'signed_out' | 'loading' | 'no_content' | 'unrecognized';

/**
 * Whether the WhatsApp window shows a usable chat screen, judged only from the
 * names of interface elements (never message text): the QR / "link a device"
 * screen means signed out; the start-up screen or an empty page means loading.
 */
export function waReadiness(nodes: UiaNodeRaw[], v: WaView): WaReadiness {
  if (v.search || v.chats.length > 0) return 'ready';
  const names = nodes.map((n) => n.name).filter(Boolean).join(' \n ');
  if (/scan (the )?qr|qr code|link with phone|log in with phone|link a device|use whatsapp on your computer|steps to log in/i.test(names)) return 'signed_out';
  if (/loading (your )?(chats|messages)|syncing|end-to-end encrypted\s*$|starting whatsapp/i.test(names)) return 'loading';
  const meaningful = nodes.filter((n) => n.role !== 'window' && n.role !== 'titlebar' && n.role !== 'menubar' && n.role !== 'menuitem' && !(n.role === 'button' && /^(minimi[sz]e|maximi[sz]e|restore|close)$/i.test(n.name)));
  if (meaningful.length < 8) return 'no_content';
  return 'unrecognized';
}
