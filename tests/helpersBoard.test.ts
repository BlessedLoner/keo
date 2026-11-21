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

  it('a failed send pauses and asks the user (never retried by itself)', async () => {
    const { bot, conv } = setup();
    await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Chat', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id });
    bot.failSends = true;
    brain.push(JSON.stringify({ action: 'reply', message: 'Hello!' }));
    bot.say(77, 'Ada', 'Hello?');
    await waitFor(() => session().status === 'paused', 5000);
    expect(session().question).toMatch(/could not send to Ada on Telegram/);
    h.services.live.stop(session().id);
  });
});

describe('live chats after a restart', () => {
  it('a Telegram live chat carries on after Keo restarts and answers what came in meanwhile', async () => {
    const { bot, conv } = setup();
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
    await h.services.live.startTelegram({ chatId: '77', contact: 'Ada', goal: 'Plan the party with Ada', instructions: [], opening: null, maxMinutes: 30, maxReplies: 10, conversationId: conv.id });
    brain.push(JSON.stringify({ action: 'reply', message: 'Great, see you then!', board_note: 'Ada will bring 20 chairs on Saturday.' }));
    bot.say(77, 'Ada', 'I can bring 20 chairs on Saturday');
    await waitFor(() => bot.sent.length === 1, 5000);
    const prompt = JSON.stringify(brainCalls[0]!.messages);
    expect(prompt).toContain('helper_board');
    expect(prompt).toContain('The hall on 5th Street is free on Saturday.');
    const notes = h.services.board.recent(null, 10);
    expect(notes.map((n) => [n.from, n.text])).toContainEqual(['Live chat with Ada (Telegram)', 'Ada will bring 20 chairs on Saturday.']);
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
