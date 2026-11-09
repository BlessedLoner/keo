import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorError, DriveClient, notionBlocks, NotionClient, SlackClient, TelegramBot } from '../src/main/connected/connectors';
import { tempDir } from './helpers';

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };
/** A fake service: answers by URL; nothing leaves the PC. */
function fake(answer: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | FormData } = {}) => {
    const c: Call = { url, ...(init.method ? { method: init.method } : {}), ...(init.headers ? { headers: init.headers } : {}), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(c);
    const a = answer(c);
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.json };
  };
  return { calls, f };
}

describe('Connected apps (fake services: nothing is sent)', () => {
  it('Telegram: checks the bot, lists chats that wrote to it, sends a message; a bad token is said plainly', async () => {
    const { calls, f } = fake((c) => (c.url.endsWith('/getMe') ? { json: { ok: true, result: { username: 'keo_bot', first_name: 'Keo' } } } : c.url.endsWith('/getUpdates') ? { json: { ok: true, result: [{ message: { chat: { id: 42, first_name: 'Ana' }, from: { first_name: 'Ana' }, text: 'hi', date: 1_700_000_000 } }] } } : { json: { ok: true, result: { message_id: 7 } } }));
    const bot = new TelegramBot(() => '123:abc', f);
    expect(await bot.me()).toEqual({ username: 'keo_bot', name: 'Keo' });
    expect((await bot.recent())[0]).toMatchObject({ chatId: 42, chat: 'Ana', text: 'hi' });
    expect(await bot.send(42, 'Your video is ready')).toEqual({ messageId: 7 });
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.telegram.org/bot123:abc/sendMessage', body: { chat_id: 42, text: 'Your video is ready' } });
    const bad = new TelegramBot(() => 'x', fake(() => ({ status: 401, json: { ok: false, description: 'Unauthorized' } })).f);
    await expect(bad.me()).rejects.toThrow(/did not accept the bot token/);
    await expect(new TelegramBot(() => null, f).me()).rejects.toBeInstanceOf(ConnectorError);
  });

  it('Notion: searches shared pages, reads one as text, adds lines as blocks; an unshared page says how to share it', async () => {
    const { calls, f } = fake((c) => {
      if (c.url.endsWith('/search')) return { json: { results: [{ id: 'p1', object: 'page', url: 'https://notion.so/p1', properties: { Name: { type: 'title', title: [{ plain_text: 'Video ideas' }] } } }] } };
      if (c.url.includes('/blocks/missing')) return { status: 404, json: { code: 'object_not_found' } };
      if (c.method === 'GET') return { json: { results: [{ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Ideas' }] } }, { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Wan 2.2' }] } }] } };
      return { json: {} };
    });
    const n = new NotionClient(() => 'secret_x', f);
    expect((await n.search('video'))[0]).toMatchObject({ id: 'p1', title: 'Video ideas' });
    expect(await n.read('p1')).toBe('# Ideas\n- Wan 2.2');
    expect(await n.append('p1', '# New\n- one\nplain')).toEqual({ blocks: 3 });
    expect(calls.at(-1)!.headers!['notion-version']).toBe('2022-06-28');
    await expect(n.read('missing')).rejects.toThrow(/Connections/);
    expect(notionBlocks('- a\n\n# b\nc').map((b) => b.type)).toEqual(['bulleted_list_item', 'heading_3', 'paragraph']);
  });

  it('Slack: posts a message; not in the channel says to invite the app', async () => {
    const { calls, f } = fake((c) => (String((c.body as { channel?: string })?.channel) === 'C-out' ? { json: { ok: false, error: 'not_in_channel' } } : { json: { ok: true, ts: '1.2', team: 'Keo team' } }));
    const sl = new SlackClient(() => 'xoxb-1', f);
    expect(await sl.me()).toMatchObject({ team: 'Keo team' });
    expect(await sl.send('C1', 'Shipped!')).toEqual({ ts: '1.2' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', body: { channel: 'C1', text: 'Shipped!' } });
    await expect(sl.send('C-out', 'x')).rejects.toThrow(/\/invite/);
  });

  it('Drive: uploads a file as one multipart request and gives its link', async () => {
    const dir = tempDir('keo-drive-');
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'bytes');
    const { calls, f } = fake(() => ({ json: { id: 'd1', name: 'video.mp4', webViewLink: 'https://drive.google.com/file/d/d1/view' } }));
    const d = new DriveClient(async () => 'g-token', f);
    expect(await d.upload(file)).toEqual({ id: 'd1', name: 'video.mp4', link: 'https://drive.google.com/file/d/d1/view' });
    expect(calls[0]!.url).toContain('uploadType=multipart');
    expect(calls[0]!.headers!.authorization).toBe('Bearer g-token');
  });
});
