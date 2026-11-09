import fs from 'node:fs';
import path from 'node:path';

/**
 * Keo's connected apps, each connected the way that service expects personal tools to be:
 * Telegram (the user's own bot), Notion (an internal integration that sees only the pages the
 * user shares with it), Slack (the user's own Slack app's bot) and Google Drive (only files Keo
 * itself saves there). Tokens come from Keo's encrypted secret store and only go to their service.
 */

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | FormData; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const defaultFetch: Fetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetch>;

export class ConnectorError extends Error {}

const timeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000));

// ---------------------------------------------------------------- Telegram

export class TelegramBot {
  constructor(private readonly token: () => string | null, private readonly f: Fetch = defaultFetch) {}
  private async call<T>(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    const t = this.token();
    if (!t) throw new ConnectorError('Telegram is not connected: add your bot’s token in Settings → Connected apps.');
    const form = body instanceof FormData;
    const r = await this.f(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', ...(form ? {} : { headers: { 'content-type': 'application/json' } }), body: form ? body : JSON.stringify(body ?? {}), signal: timeout(signal) }).catch(() => {
      throw new ConnectorError('Keo could not reach Telegram. Check your internet connection.');
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!j.ok) throw new ConnectorError(r.status === 401 ? 'Telegram did not accept the bot token: check it in Settings → Connected apps.' : `Telegram said: ${String(j.description ?? r.status).slice(0, 200)}`);
    return j.result as T;
  }
  async me(signal?: AbortSignal): Promise<{ username: string; name: string }> {
    const r = await this.call<{ username?: string; first_name?: string }>('getMe', undefined, signal);
    return { username: r.username ?? '', name: r.first_name ?? '' };
  }
  /** The chats that messaged the bot lately (people must message it first: bots cannot start chats), with their last messages. */
  async recent(signal?: AbortSignal): Promise<Array<{ chatId: number; chat: string; from: string; text: string; at: string }>> {
    const updates = await this.call<Array<{ message?: { chat: { id: number; title?: string; first_name?: string; username?: string }; from?: { first_name?: string; username?: string }; text?: string; caption?: string; date: number } }>>('getUpdates', { limit: 50, allowed_updates: ['message'] }, signal);
    return updates
      .flatMap((u) => (u.message ? [u.message] : []))
      .map((m) => ({ chatId: m.chat.id, chat: m.chat.title ?? m.chat.first_name ?? m.chat.username ?? String(m.chat.id), from: m.from?.first_name ?? m.from?.username ?? '', text: (m.text ?? m.caption ?? '').slice(0, 1000), at: new Date(m.date * 1000).toISOString() }))
      .reverse();
  }
  async send(chatId: number | string, text: string, signal?: AbortSignal): Promise<{ messageId: number }> {
    const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, 4096) }, signal);
    return { messageId: r.message_id };
  }
  /** A file (up to 50 MB, Telegram's limit for bots) with an optional caption. */
  async sendFile(chatId: number | string, file: string, caption: string, signal?: AbortSignal): Promise<{ messageId: number }> {
    const size = fs.statSync(file).size;
    if (size > 50 * 1024 * 1024) throw new ConnectorError('Telegram bots can send files up to 50 MB: export a smaller version first.');
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1024));
    form.set('document', new Blob([new Uint8Array(fs.readFileSync(file))]), path.basename(file));
    const r = await this.call<{ message_id: number }>('sendDocument', form, signal);
    return { messageId: r.message_id };
  }
}

// ---------------------------------------------------------------- Notion

const NOTION = 'https://api.notion.com/v1';
type NotionBlock = { type: string; [k: string]: unknown };
const richText = (b: NotionBlock): string => {
  const v = b[b.type] as { rich_text?: Array<{ plain_text?: string }>; title?: string } | undefined;
  return (v?.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
};

export class NotionClient {
  constructor(private readonly token: () => string | null, private readonly f: Fetch = defaultFetch) {}
  private async call<T>(pathName: string, init: { method?: string; body?: unknown } = {}, signal?: AbortSignal): Promise<T> {
    const t = this.token();
    if (!t) throw new ConnectorError('Notion is not connected: add your integration’s token in Settings → Connected apps.');
    const r = await this.f(`${NOTION}${pathName}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${t}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' }, ...(init.body ? { body: JSON.stringify(init.body) } : {}), signal: timeout(signal) }).catch(() => {
      throw new ConnectorError('Keo could not reach Notion. Check your internet connection.');
    });
    const j = (await r.json().catch(() => ({}))) as T & { message?: string; code?: string };
    if (!r.ok) {
      if (r.status === 401) throw new ConnectorError('Notion did not accept the token: check it in Settings → Connected apps.');
      if (r.status === 404 || j.code === 'object_not_found') throw new ConnectorError('Notion cannot find that page, or it is not shared with Keo’s integration (in Notion: the page’s ••• menu → Connections → add it).');
      throw new ConnectorError(`Notion said: ${String(j.message ?? r.status).slice(0, 200)}`);
    }
    return j;
  }
  async me(signal?: AbortSignal): Promise<{ name: string }> {
    const r = await this.call<{ name?: string; bot?: { workspace_name?: string } }>('/users/me', {}, signal);
    return { name: r.bot?.workspace_name ?? r.name ?? 'Notion' };
  }
  /** Pages shared with the integration that match the words. */
  async search(query: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string; url: string; edited: string }>> {
    const r = await this.call<{ results: Array<{ id: string; object: string; url?: string; last_edited_time?: string; properties?: Record<string, { type: string; title?: Array<{ plain_text?: string }> }> }> }>('/search', { method: 'POST', body: { query: query.slice(0, 200), page_size: 20, filter: { property: 'object', value: 'page' } } }, signal);
    return r.results.map((p) => {
      const t = Object.values(p.properties ?? {}).find((x) => x.type === 'title');
      return { id: p.id, title: (t?.title ?? []).map((x) => x.plain_text ?? '').join('') || 'Untitled', url: p.url ?? '', edited: p.last_edited_time ?? '' };
    });
  }
  /** A page's text (its blocks as lines, up to 200 blocks). */
  async read(pageId: string, signal?: AbortSignal): Promise<string> {
    const r = await this.call<{ results: NotionBlock[] }>(`/blocks/${encodeURIComponent(pageId)}/children?page_size=100`, {}, signal);
    return r.results
      .map((b) => {
        const t = richText(b);
        if (b.type.startsWith('heading')) return `# ${t}`;
        if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') return `- ${t}`;
        if (b.type === 'to_do') return `[${(b.to_do as { checked?: boolean })?.checked ? 'x' : ' '}] ${t}`;
        return t;
      })
      .filter((l) => l.trim())
      .join('\n')
      .slice(0, 20000);
  }
  /** Lines added at the end of a page (each a paragraph; "- " lines as bullets). */
  async append(pageId: string, text: string, signal?: AbortSignal): Promise<{ blocks: number }> {
    const children = notionBlocks(text);
    await this.call(`/blocks/${encodeURIComponent(pageId)}/children`, { method: 'PATCH', body: { children } }, signal);
    return { blocks: children.length };
  }
  /** A new page inside a page the integration can see. */
  async create(parentId: string, title: string, text: string, signal?: AbortSignal): Promise<{ id: string; url: string }> {
    const r = await this.call<{ id: string; url?: string }>('/pages', { method: 'POST', body: { parent: { page_id: parentId }, properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 200) } }] } }, children: notionBlocks(text) } }, signal);
    return { id: r.id, url: r.url ?? '' };
  }
}

/** Plain text as Notion blocks: "- " bullets, "# " headings, the rest paragraphs (Notion's 2,000-character limit per block). */
export function notionBlocks(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, 100)
    .map((l) => {
      const heading = /^#{1,3}\s+/.exec(l);
      const bullet = /^\s*[-*•]\s+/.exec(l);
      const type = heading ? 'heading_3' : bullet ? 'bulleted_list_item' : 'paragraph';
      const content = l.replace(heading?.[0] ?? bullet?.[0] ?? '', '').slice(0, 2000);
      return { object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content } }] } };
    });
}

// ---------------------------------------------------------------- Slack

export class SlackClient {
  constructor(private readonly token: () => string | null, private readonly f: Fetch = defaultFetch) {}
  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const t = this.token();
    if (!t) throw new ConnectorError('Slack is not connected: add your Slack app’s bot token in Settings → Connected apps.');
    const r = await this.f(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: timeout(signal) }).catch(() => {
      throw new ConnectorError('Keo could not reach Slack. Check your internet connection.');
    });
    const j = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!j.ok) {
      const e = String(j.error ?? r.status);
      if (e === 'invalid_auth' || e === 'not_authed') throw new ConnectorError('Slack did not accept the token: check it in Settings → Connected apps.');
      if (e === 'not_in_channel' || e === 'channel_not_found') throw new ConnectorError('Keo’s Slack app is not in that channel: in Slack, open the channel and add the app (type /invite @your-app).');
      if (e === 'missing_scope') throw new ConnectorError('Keo’s Slack app is missing a permission: add chat:write, channels:read and channels:history to its bot scopes, then reinstall it.');
      throw new ConnectorError(`Slack said: ${e.slice(0, 120)}`);
    }
    return j;
  }
  async me(signal?: AbortSignal): Promise<{ team: string; user: string }> {
    const r = await this.call<{ team?: string; user?: string }>('auth.test', {}, signal);
    return { team: r.team ?? '', user: r.user ?? '' };
  }
  async channels(signal?: AbortSignal): Promise<Array<{ id: string; name: string; member: boolean }>> {
    const r = await this.call<{ channels: Array<{ id: string; name: string; is_member?: boolean }> }>('conversations.list', { limit: 200, exclude_archived: true, types: 'public_channel,private_channel' }, signal);
    return r.channels.map((c) => ({ id: c.id, name: c.name, member: !!c.is_member }));
  }
  async history(channel: string, signal?: AbortSignal): Promise<Array<{ user: string; text: string; at: string }>> {
    const r = await this.call<{ messages: Array<{ user?: string; bot_id?: string; text?: string; ts: string }> }>('conversations.history', { channel, limit: 30 }, signal);
    return r.messages.map((m) => ({ user: m.user ?? m.bot_id ?? '', text: (m.text ?? '').slice(0, 1000), at: new Date(Number(m.ts) * 1000).toISOString() })).reverse();
  }
  async send(channel: string, text: string, signal?: AbortSignal): Promise<{ ts: string }> {
    const r = await this.call<{ ts: string }>('chat.postMessage', { channel, text: text.slice(0, 4000) }, signal);
    return { ts: r.ts };
  }
}

// ---------------------------------------------------------------- Google Drive (files Keo saves)

export class DriveClient {
  constructor(private readonly token: () => Promise<string>, private readonly f: Fetch = defaultFetch) {}
  /** Saves a file in the user's Drive (Keo can only see the files it saved itself). */
  async upload(file: string, o: { name?: string; signal?: AbortSignal } = {}): Promise<{ id: string; name: string; link: string }> {
    const size = fs.statSync(file).size;
    if (size > 200 * 1024 * 1024) throw new ConnectorError('That file is over 200 MB: Keo saves files up to 200 MB to Drive.');
    const name = (o.name ?? path.basename(file)).slice(0, 200);
    const boundary = `keo${Date.now().toString(36)}`;
    const head = Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([head, fs.readFileSync(file), tail]);
    const t = await this.token();
    const r = await this.f('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body), signal: timeout(o.signal) }).catch(() => {
      throw new ConnectorError('Keo could not reach Google Drive. Check your internet connection.');
    });
    const j = (await r.json().catch(() => ({}))) as { id?: string; name?: string; webViewLink?: string; error?: { message?: string } };
    if (!r.ok || !j.id) throw new ConnectorError(r.status === 401 || r.status === 403 ? 'Google Drive did not allow it: connect Drive again in Settings → Connected apps.' : `Google Drive said: ${String(j.error?.message ?? r.status).slice(0, 200)}`);
    return { id: j.id, name: j.name ?? name, link: j.webViewLink ?? `https://drive.google.com/file/d/${j.id}/view` };
  }
  /** The files Keo saved in Drive, newest first. */
  async list(signal?: AbortSignal): Promise<Array<{ id: string; name: string; link: string; modified: string }>> {
    const t = await this.token();
    const q = new URLSearchParams({ q: 'trashed=false', orderBy: 'modifiedTime desc', pageSize: '50', fields: 'files(id,name,webViewLink,modifiedTime)' });
    const r = await this.f(`https://www.googleapis.com/drive/v3/files?${q.toString()}`, { headers: { authorization: `Bearer ${t}` }, signal: timeout(signal) }).catch(() => {
      throw new ConnectorError('Keo could not reach Google Drive. Check your internet connection.');
    });
    const j = (await r.json().catch(() => ({}))) as { files?: Array<{ id: string; name: string; webViewLink?: string; modifiedTime?: string }> };
    if (!r.ok) throw new ConnectorError('Google Drive did not answer: connect Drive again in Settings → Connected apps.');
    return (j.files ?? []).map((x) => ({ id: x.id, name: x.name, link: x.webViewLink ?? '', modified: x.modifiedTime ?? '' }));
  }
}
