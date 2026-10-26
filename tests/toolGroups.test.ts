import { afterEach, describe, expect, it } from 'vitest';
import { chooseGroups, groupOf } from '../src/main/agent/toolGroups';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

const reply = (text: string, toolCalls: ChatResult['toolCalls'] = []): ChatResult => ({ text, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined });
const names = (r: ChatRequest) => (r.tools ?? []).map((t) => t.name);
const base = { pictures: false, documents: false, pencil: false, recent: [] as never[] };

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('tool groups', () => {
  it('maps tools to groups (searching and reading pages, finding files are everyday tools)', () => {
    expect(groupOf('desktop__click')).toBe('desktop');
    expect(groupOf('apps__open')).toBe('desktop');
    expect(groupOf('web__search')).toBe('core');
    expect(groupOf('web__fill')).toBe('webapps');
    expect(groupOf('files__search')).toBe('core');
    expect(groupOf('files__peek')).toBe('files');
    expect(groupOf('research__send_whatsapp')).toBe('whatsapp');
    expect(groupOf('memory__propose')).toBe('core');
    expect(groupOf('something_new__x')).toBe('core');
  });

  it('brings in groups from the words of the request, attachments and the pencil', () => {
    const g = (text: string, more = {}) => [...chooseGroups({ ...base, texts: [text], ...more })].sort();
    expect(g('hi there')).toEqual(['core']);
    expect(g('check my email')).toContain('email');
    expect(g('book a meeting with Ana tomorrow at 3')).toContain('calendar');
    expect(g('open notepad and type hello')).toContain('desktop');
    expect(g('send Ana a WhatsApp message')).toContain('whatsapp');
    expect(g('make a presentation about our launch')).toEqual(expect.arrayContaining(['create', 'files']));
    expect(g('compare the best laptops under 1000')).toContain('research');
    expect(g('what is this?', { pictures: true })).toContain('pictures');
    expect(g('explain this', { pencil: true })).toEqual(expect.arrayContaining(['screen', 'desktop']));
    expect(g('yes, do it', { recent: ['email'] })).toContain('email');
  });
});

describe('focused tools in a conversation', () => {
  it('a simple message gets only the core tools and tools__load; asking for a group loads it for the next step', async () => {
    const seen: string[][] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(names(req));
        if (n === 0) return reply('', [{ id: 'l1', name: 'tools__load', input: { groups: ['create'] } }]);
        return reply('ok');
      },
    });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'hi').done;
    expect(seen[0]).toContain('tools__load');
    expect(seen[0]).not.toContain('create__presentation');
    expect(seen[0]).not.toContain('desktop__click');
    expect(seen[0]).toContain('memory__propose');
    expect(seen[1]).toContain('create__presentation');
    // The model's call to load tools is free (not counted as a step) and never shown as an action.
    const msg = h.services.conversations.recentMessages(c.id, 5).find((m) => m.role === 'assistant')!;
    expect(msg.content).toBe('ok');
  });

  it('a follow-up keeps the group whose tools were just used', async () => {
    let req: ChatRequest | null = null;
    h = makeHarness({
      script: (r, n) => {
        req = r;
        return n === 0 ? reply('', [{ id: 'p1', name: 'project__list', input: {} }]) : reply('ok');
      },
    });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'show me my projects').done;
    await h.services.agent.send(c.id, 'thanks, now the other one').done;
    expect(names(req!)).toContain('project__list');
  });

  it('“all” sends every tool, as before', async () => {
    let req: ChatRequest | null = null;
    h = makeHarness({ script: (r) => ((req = r), reply('ok')) });
    h.services.settings.update({ agent: { toolSelection: 'all' } });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'hi').done;
    expect(names(req!)).toContain('project__list');
    expect(names(req!)).toContain('create__presentation');
    expect(names(req!)).not.toContain('tools__load');
    // The group instructions come with their tools.
    expect(req!.system).toContain('WhatsApp and messages');
  });
});
