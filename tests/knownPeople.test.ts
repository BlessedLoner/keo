import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnownPeople } from '../src/main/memory/knownPeople';
import type { ChatRequest } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keo-people-')), 'known-people.json');

describe('people Keo knows', () => {
  it('learns who a name means from an approved send, and keeps it', () => {
    const file = tmp();
    const p = new KnownPeople(file);
    p.learnWhatsApp('Tunde', 'Tunde Adeyemi (Work)');
    p.learnWhatsApp('tunde', 'Tunde Adeyemi (Work)');
    expect(p.list()).toEqual([expect.objectContaining({ name: 'Tunde', whatsapp: 'Tunde Adeyemi (Work)', sends: 2 })]);
    // Stays after a restart.
    expect(new KnownPeople(file).list()[0]?.whatsapp).toBe('Tunde Adeyemi (Work)');
    // The same name now going to another chat: the newest wins.
    p.learnWhatsApp('Tunde', 'Tunde Bakare');
    expect(p.list()[0]).toMatchObject({ whatsapp: 'Tunde Bakare', sends: 1 });
    expect(p.forget('TUNDE')).toBe(true);
    expect(p.list()).toEqual([]);
  });

  it('finds the people a message mentions, by whole or first name', () => {
    const p = new KnownPeople(tmp());
    p.learnWhatsApp('Ada Obi', 'Ada 💛');
    p.learnWhatsApp('Mum', 'Mummy');
    p.learnWhatsApp('Jo', 'Jo Smith');
    expect(p.mentionedIn('send ada a message saying I am on my way').map((x) => x.name)).toEqual(['Ada Obi']);
    expect(p.mentionedIn('tell Mum, thanks!').map((x) => x.name)).toEqual(['Mum']);
    // Too short to match inside ordinary words safely.
    expect(p.mentionedIn('jo')).toEqual([]);
    expect(p.mentionedIn('send a message to Paul')).toEqual([]);
    expect(p.context('message ada')).toContain('WhatsApp chat "Ada 💛"');
    expect(p.context('what time is it')).toBeNull();
  });

  it('Keo is told who a name means when the user mentions them', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req) => {
        seen.push(structuredClone(req));
        return { text: 'Opening the chat.', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined };
      },
    });
    // What Keo learns after a WhatsApp send the user approved and Keo verified.
    h.services.agent.learned?.('whatsapp.send_message', { contact: 'Tunde', text: 'hi' }, { sent: true, recipient: 'Tunde Adeyemi', appearsInChat: true });
    // A send that did not go through teaches nothing.
    h.services.agent.learned?.('whatsapp.send_message', { contact: 'Kemi', text: 'hi' }, { sent: false, recipient: 'Kemi A' });
    expect(h.services.people.list().map((p) => p.name)).toEqual(['Tunde']);
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'tell tunde I will be late').done;
    const said = JSON.stringify(seen[0]!.messages);
    expect(said).toContain('Tunde Adeyemi');
  });
});
