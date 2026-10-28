import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/main/providers/types';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

/**
 * Keo inside Studio: the Ask Keo panel's conversation gets Keo's video tools and knows the
 * playhead and the selection; Keo's edits land in the open project. Offline, scripted provider.
 */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const system = (req: ChatRequest | null) => (typeof req?.system === 'string' ? req.system : JSON.stringify(req?.system ?? ''));
const toolNames = (req: ChatRequest | null) => (req?.tools ?? []).map((t) => t.name);

describe('Ask Keo in Studio', () => {
  it('a Studio conversation has the video tools, the playhead and the selection', async () => {
    h = makeHarness({ dir: path.join(tempDir('keo-studio-keo-'), 'profile') });
    const s = h.services;
    const p = s.studio.create('Beach day', 'vertical');
    const withText = s.studio.edit(p.id, [{ op: 'add_text', text: 'Hello', start: 0, duration: 3 }]).project;
    const clip = withText.tracks.find((t) => t.kind === 'text')!.clips[0]!.id;
    const conv = s.studioConversation(p.id, 'Beach day');
    // The same conversation again for the same project.
    expect(s.studioConversation(p.id, 'Beach day')).toBe(conv);
    s.setStudioFocus({ projectId: p.id, time: 1.25, selected: [clip] });
    await s.agent.send(conv, 'make it bigger').done;
    await waitFor(() => !!h!.provider.lastRequest, 5000);
    const req = h.provider.lastRequest;
    // "make it bigger" has no video words: the video tools come because this is Studio.
    expect(toolNames(req)).toContain('studio__edit');
    expect(system(req)).toMatch(/The playhead is at 1\.25 s \(on screen: cl_/);
    expect(system(req)).toContain(`Selected: ${clip}`);
    expect(system(req)).toMatch(/talking to you from inside Keo Studio/);
  });

  it('Keo’s edits from the panel change the open project', async () => {
    h = makeHarness({ dir: path.join(tempDir('keo-studio-keo2-'), 'profile') });
    const s = h.services;
    const p = s.studio.create('Promo', 'vertical');
    const conv = s.studioConversation(p.id, 'Promo');
    await s.agent.send(conv, '/tool studio.preset {"preset":"title","at":0,"text":"Big news"}').done;
    await waitFor(() => s.studio.get(p.id).tracks.some((t) => t.clips.length > 0), 8000);
    const text = s.studio.get(p.id).tracks.flatMap((t) => t.clips).find((c) => c.type === 'text');
    expect(text && text.type === 'text' && text.text).toBe('Big news');
    // An ordinary conversation does not get video tools for a plain message.
    const other = s.conversations.create('other').id;
    h.provider.lastRequest = null;
    await s.agent.send(other, 'hello there').done;
    await waitFor(() => !!h!.provider.lastRequest, 5000);
    expect(toolNames(h.provider.lastRequest)).not.toContain('studio__edit');
  });
});
