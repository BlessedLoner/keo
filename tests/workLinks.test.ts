import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

describe('builds and Studio videos stay linked to the chat and Keo project they were made in', () => {
  it('Studio remembers its panel chat and the chat Keo worked from; the Keo project lists both kinds of work', async () => {
    h = makeHarness({ script: (_req: ChatRequest) => reply('ok') });
    const s = h.services;
    const kp = s.projects.create('Launch campaign');
    const chat = s.conversations.create('Promo work', kp.id);
    const video = s.studio.create('Launch promo', 'vertical');
    // The panel chat is made once and remembered with the project, so a restart finds the same one.
    const panel = s.studioConversation(video.id, video.name);
    expect(s.studio.get(video.id).panelConversationId).toBe(panel);
    s.studio.link(video.id, { conversationId: chat.id });
    expect(s.studio.get(video.id).conversationId).toBe(chat.id);
    expect(s.studioConversation(video.id, 'Renamed later')).toBe(panel);
    // A build made in a chat of the project.
    const build = s.builds.create({ title: 'Launch page', kind: 'website', conversationId: chat.id });
    s.builds.create({ title: 'Elsewhere', kind: 'website', conversationId: s.conversations.create('other').id });
    const work = s.projectWork(kp.id);
    expect(work.builds.map((b) => b.id)).toEqual([build.id]);
    expect(work.videos.map((v) => v.id)).toEqual([video.id]);
    expect(s.projectWork(s.projects.create('Empty').id)).toEqual({ builds: [], videos: [] });
  });
});
