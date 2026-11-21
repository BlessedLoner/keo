import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import type { LiveChatSession } from '../src/shared/domain';
import { HelperBoard } from '../src/main/agent/board';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const isBrain = (req: ChatRequest) => req.system.includes('chat on behalf of the user');

/** A Telegram bot that never reaches Telegram: messages are added by the test, sends are recorded. */
class FakeBot {
  msgs: Array<{ id: number; chatId: number; chat: string; from: string; text: string; at: string }> = [];
  sent: Array<{ chatId: string; text: string }> = [];
  failSends = false;
  private n = 0;
  say(chatId: number, chat: string, text: string) {
    this.msgs.push({ id: ++this.n, chatId, chat, from: chat, text, at: new Date().toISOString() });
  }
  async recent() {
    return [...this.msgs].reverse();
  }
  async send(chatId: number | string, text: string) {
    if (this.failSends) throw new Error('Telegram said: Forbidden');
    this.sent.push({ chatId: String(chatId), text });
    return { messageId: ++this.n };
  }
}

let brain: Array<string | ((req: ChatRequest) => string)> = [];
let brainCalls: ChatRequest[] = [];

function setup() {
  brain = [];
  brainCalls = [];
  h = makeHarness({
    script: (req) => {
      if (!isBrain(req)) return reply('ok');
      brainCalls.push(req);
      const next = brain.shift();
      return reply(typeof next === 'function' ? next(req) : (next ?? JSON.stringify({ action: 'wait' })));
    },
    liveChatTiming: { pollMs: 15, debounceMs: 0, minGapMs: 0, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) },
  });
  const bot = new FakeBot();
  const deps = (h.services.live as unknown as { d: { telegram?: unknown } }).d;
  deps.telegram = bot;
  const conv = h.services.conversations.create('Helpers test');
  return { bot, conv };
}

const session = (): LiveChatSession => h.services.live.list()[0]!;

describe('live chat on Telegram', () => {
  it('replies to new messages through the bot (old ones are not answered), with no screen', async () => {
    const { bot, conv } = setup();
    bot.say(77, 'Ada', 'old message from yesterday');
    bot.say(99, 'Someone else', 'not this chat');
    const s = await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Keep Ada company', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id });
    expect(s.channel).toBe('telegram');
    await new Promise((r) => setTimeout(r, 80));
    expect(bot.sent).toEqual([]);

    brain.push(JSON.stringify({ action: 'reply', message: 'Hey Ada! All good here.' }));
    bot.say(77, 'Ada', 'Hi, how are you?');
    await waitFor(() => bot.sent.length === 1, 5000);
    expect(bot.sent[0]).toEqual({ chatId: '77', text: 'Hey Ada! All good here.' });
    await waitFor(() => session().replies === 1, 5000);
    expect(brainCalls[0]!.system).toContain('replying in a Telegram chat');
    // Telegram needs no window: nothing touched the desktop.
    expect(h.desktop.inputCalls()).toEqual([]);
    h.services.live.stop(session().id);
  });

  it('refuses a chat that is not the person named (the bot only sees chats that messaged the bot)', async () => {
    const { bot, conv } = setup();
    bot.say(77, 'Ada', '/start');
    const base = { goal: 'Chat', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id };
    await expect(h.services.live.startTelegram({ ...base, chatId: '77', contact: 'Kidbro 2' })).rejects.toThrow(/not “Kidbro 2”.*press Start/);
    await expect(h.services.live.startTelegram({ ...base, chatId: '55', contact: 'Kidbro 2' })).rejects.toThrow(/no chat 55.*Chats the bot has: Ada/);
    expect(h.services.live.list()).toEqual([]);
    await h.services.live.startTelegram({ ...base, chatId: '77', contact: 'ada' }); // the same person, any case
    expect(h.services.live.list()).toHaveLength(1);
    h.services.live.stop(session().id);
  });

  it('a failed send pauses and asks the user (never retried by itself)', async () => {
    const { bot, conv } = setup();
    bot.say(77, 'Ada', 'hi'); // a person writes to the bot first
    await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Chat', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id });
    bot.failSends = true;
    brain.push(JSON.stringify({ action: 'reply', message: 'Hello!' }));
    bot.say(77, 'Ada', 'Hello?');
    await waitFor(() => session().status === 'paused', 5000);
    expect(session().question).toMatch(/could not send to Ada on Telegram/);
    h.services.live.stop(session().id);
  });
});

describe('answer everyone on the Telegram bot', () => {
  it('starts a live chat for each new person who writes (not old messages, not groups), until turned off', async () => {
    const { bot, conv } = setup();
    bot.say(11, 'Old Friend', 'message from before');
    brain.push((req) => JSON.stringify({ action: 'reply', message: JSON.stringify(req.messages).includes('Do you deliver?') ? 'Yes, we deliver!' : 'Hi there!' }));
    brain.push((req) => JSON.stringify({ action: 'reply', message: JSON.stringify(req.messages).includes('Do you deliver?') ? 'Yes, we deliver!' : 'Hi there!' }));
    const a = await h.services.live.startAuto({ goal: 'Answer customers about my shop', instructions: [], maxMinutes: 60, maxReplies: 5, conversationId: conv.id });
    expect(a.started).toBe(0);
    bot.say(21, 'Kidbro 2', 'Hello');
    bot.say(31, 'Bola', 'Do you deliver?');
    bot.say(-500, 'Shop Group', 'anyone here?'); // a group: left alone
    await waitFor(() => bot.sent.length === 2, 8000);
    expect(bot.sent.map((m) => m.chatId).sort()).toEqual(['21', '31']);
    expect(bot.sent.find((m) => m.chatId === '31')!.text).toBe('Yes, we deliver!');
    expect(h.services.live.autoStatus()!.started).toBe(2);
    expect(h.services.live.list().map((x) => x.contact).sort()).toEqual(['Bola', 'Kidbro 2']);
    // Off: no new chats, running ones keep their own Stop.
    expect(h.services.live.stopAuto()).toBe(true);
    bot.say(41, 'Newcomer', 'hi?');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.services.live.list().map((x) => x.contact)).not.toContain('Newcomer');
    expect(bot.sent.some((m) => m.chatId === '11')).toBe(false);
    h.services.live.stopAll();
  });
});

/** WhatsApp Web in the background, faked: chats in memory; sends are recorded. */
class FakeWaWeb {
  readonly appName = 'WhatsApp';
  chats: Record<string, Array<{ from: 'me' | 'them'; text: string; status: string | null }>> = { Mum: [{ from: 'them', text: 'Call me later', status: null }], 'Ma Glo': [] };
  open: string | null = null;
  sent: Array<{ to: string; text: string }> = [];
  dropSends = false;
  async status() {
    return 'ready' as const;
  }
  async link() {
    return 'linking' as const;
  }
  async openChat(contact: string) {
    const hit = Object.keys(this.chats).filter((c) => c.toLowerCase().includes(contact.toLowerCase()));
    const exact = hit.find((c) => c.toLowerCase() === contact.toLowerCase());
    if (!exact) return { opened: false, header: null, candidates: hit };
    this.open = exact;
    return { opened: true, header: exact, candidates: hit };
  }
  async read() {
    return { header: this.open, messages: this.open ? this.chats[this.open]!.map((m) => ({ ...m })) : [] };
  }
  async send(contact: string, text: string) {
    if (this.open !== contact) throw new Error('wrong chat');
    if (!this.dropSends) {
      this.chats[contact]!.push({ from: 'me', text, status: 'sent' });
      this.sent.push({ to: contact, text });
    }
    return { appears: !this.dropSends };
  }
  async unread() {
    return Object.entries(this.unreadCounts).filter(([, n]) => n > 0).map(([title, count]) => ({ title, count }));
  }
  unreadCounts: Record<string, number> = {};
  account() {
    return { phone: '+2348000000000', name: null, linkedAt: '' };
  }
  async unlink() {}
  async close() {}
}

describe('WhatsApp in the background', () => {
  function withWa() {
    const ctx = setup();
    const wa = new FakeWaWeb();
    (h.services.live as unknown as { d: { backgrounds?: unknown } }).d.backgrounds = { whatsapp_bg: wa, telegram_bg: wa };
    return { ...ctx, wa };
  }

  it('keeps a live chat through Keo’s own WhatsApp Web: replies to new messages, never touches the screen', async () => {
    const { wa, conv } = withWa();
    brainCalls = [];
    brain.push(JSON.stringify({ action: 'reply', message: "I'm fine Mum, talk soon!" }));
    const s = await h.services.live.startBackground({ channel: 'whatsapp_bg', contact: 'Mum', goal: 'Keep Mum company', instructions: [], opening: null, maxMinutes: 30, maxReplies: 5, conversationId: conv.id });
    expect(s.channel).toBe('whatsapp_bg');
    await new Promise((r) => setTimeout(r, 80));
    expect(wa.sent).toEqual([]); // old messages are not answered
    wa.chats.Mum!.push({ from: 'them', text: 'How are you?', status: null });
    await waitFor(() => wa.sent.length === 1, 5000);
    expect(wa.sent[0]).toEqual({ to: 'Mum', text: "I'm fine Mum, talk soon!" });
    await waitFor(() => session().replies === 1, 5000);
    expect(h.desktop.inputCalls()).toEqual([]);
    h.services.live.stop(session().id);
  });

  it('answers everyone on the user’s own account: chats already unread are left, new ones get a live chat', async () => {
    const { wa, conv } = withWa();
    wa.unreadCounts = { Mum: 2 }; // waiting before it was turned on: left for the user
    brain.push(JSON.stringify({ action: 'reply', message: 'Hi! I will get back to you soon.' }));
    await h.services.live.startAuto({ channel: 'whatsapp_bg', goal: 'Let people know I am busy', instructions: [], maxMinutes: 60, maxReplies: 5, conversationId: conv.id });
    wa.chats['Ma Glo']!.push({ from: 'them', text: 'Are you free today?', status: null });
    wa.unreadCounts['Ma Glo'] = 1;
    await waitFor(() => wa.sent.length === 1, 8000);
    expect(wa.sent[0]).toEqual({ to: 'Ma Glo', text: 'Hi! I will get back to you soon.' });
    expect(h.services.live.list().map((x) => [x.contact, x.channel])).toEqual([['Ma Glo', 'whatsapp_bg']]);
    expect(h.services.live.autoStatus()).toMatchObject({ channel: 'whatsapp_bg', started: 1 });
    h.services.live.stopAll();
    expect(h.services.live.autoStatus()).toBeNull();
  });

  it('a reply that does not show pauses (never sent twice); an unknown or unclear chat is refused', async () => {
    const { wa, conv } = withWa();
    const base = { channel: 'whatsapp_bg' as const, goal: 'Chat', instructions: [], opening: null, maxMinutes: 30, maxReplies: 5, conversationId: conv.id };
    await expect(h.services.live.startBackground({ ...base, contact: 'M' })).rejects.toThrow(/Chats found: Mum, Ma Glo\. Ask the user which one/);
    await h.services.live.startBackground({ ...base, contact: 'Mum' });
    wa.dropSends = true;
    brain.push(JSON.stringify({ action: 'reply', message: 'Hello!' }));
    wa.chats.Mum!.push({ from: 'them', text: 'Hello?', status: null });
    await waitFor(() => session().status === 'paused', 5000);
    expect(session().question).toMatch(/could not confirm/);
    h.services.live.stop(session().id);
  });
});

describe('live chats after a restart', () => {
  it('a Telegram live chat carries on after Keo restarts and answers what came in meanwhile', async () => {
    const { bot, conv } = setup();
    bot.say(77, 'Ada', 'hi'); // a person writes to the bot first
    await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Chat with Ada', instructions: [], opening: null, maxMinutes: 60, maxReplies: 10, conversationId: conv.id });
    const dir = h.dir;
    await h.close();
    // Keo is closed: Ada writes.
    await new Promise((r) => setTimeout(r, 20));
    bot.say(77, 'Ada', 'Are you still there?');
    brain = [JSON.stringify({ action: 'reply', message: 'Yes, still here!' })];
    brainCalls = [];
    h = makeHarness({
      dir,
      script: (req) => (isBrain(req) ? reply(typeof brain[0] === 'string' ? (brain.shift() as string) : JSON.stringify({ action: 'wait' })) : reply('ok')),
      liveChatTiming: { pollMs: 15, debounceMs: 0, minGapMs: 0, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) },
    });
    (h.services.live as unknown as { d: { telegram?: unknown } }).d.telegram = bot;
    h.services.resumeDelayMs = 0;
    h.services.start();
    await waitFor(() => bot.sent.length === 1, 5000);
    expect(bot.sent[0]!.text).toBe('Yes, still here!');
    expect(session().transcript.map((l) => l.text)).toContain('Keo restarted — carrying on with this chat.');
    h.services.live.stop(session().id);
  });
});

describe('the helpers’ board', () => {
  it('a live chat leaves a note and reads what other helpers posted (as data)', async () => {
    const { bot, conv } = setup();
    h.services.board.post('Job: Find a venue', 'The hall on 5th Street is free on Saturday.');
    bot.say(77, 'Ada', 'hi'); // a person writes to the bot first
    await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Plan the party with Ada', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id });
    brain.push(JSON.stringify({ action: 'reply', message: 'Great, see you then!', board_note: 'Ada will bring 20 chairs on Saturday.' }));
    bot.say(77, 'Ada', 'I can bring 20 chairs on Saturday');
    await waitFor(() => bot.sent.length === 1, 5000);
    const prompt = JSON.stringify(brainCalls[0]!.messages);
    expect(prompt).toContain('helper_board');
    expect(prompt).toContain('The hall on 5th Street is free on Saturday.');
    const notes = h.services.board.recent(null, 10);
    expect(notes.map((n) => [n.from, n.text])).toContainEqual(['Live chat with Ada (Telegram bot)', 'Ada will bring 20 chairs on Saturday.']);
    // The user's own chat sees the helpers' notes too.
    expect(h.services.board.context('Keo (your chat)', true)).toContain('Ada will bring 20 chairs');
    h.services.live.stop(session().id);
  });

  it('keeps notes across restarts, drops exact repeats and trims old ones', () => {
    let saved: unknown = null;
    const store = { load: () => saved as never, save: (n: unknown) => (saved = JSON.parse(JSON.stringify(n))) };
    const a = new HelperBoard({ store });
    a.post('Job: A', 'first');
    a.post('Job: A', 'first');
    for (let k = 0; k < 250; k++) a.post('Job: B', `note ${k}`);
    const b = new HelperBoard({ store });
    const all = b.recent(null, 500);
    expect(all).toHaveLength(200);
    expect(all.at(-1)!.text).toBe('note 249');
    expect(b.recent('Job: B', 5)).toEqual([]);
    expect(new HelperBoard().context(null, false)).toBe('');
  });
});
