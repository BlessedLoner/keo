import { describe, expect, it } from 'vitest';
import type { UiaNodeRaw } from '../src/main/desktop/backend';
import { analyzeChatArea, analyzeWhatsApp, chatAreaOf } from '../src/main/desktop/whatsapp';
import { FakeWhatsApp } from './fakeApps';

/** What the helper returns when asked to read one element and what is inside it. */
function subtree(nodes: UiaNodeRaw[], rid: string, skip: string[] = []): UiaNodeRaw[] {
  const root = nodes.findIndex((n) => n.rid === rid);
  const keep = new Map<number, number>([[root, 0]]);
  const out: UiaNodeRaw[] = [{ ...nodes[root]!, i: 0, parent: -1 }];
  nodes.forEach((n, i) => {
    if (i <= root || !keep.has(n.parent) || (n.parent === root && skip.includes(n.rid))) return;
    keep.set(i, out.length);
    out.push({ ...n, i: out.length, parent: keep.get(n.parent)! });
  });
  return out;
}

describe('reading only the open WhatsApp chat', () => {
  for (const inBrowser of [false, true]) {
    it(`finds the same chat, messages and message box as a full read (${inBrowser ? 'WhatsApp Web' : 'the app'})`, () => {
      const wa = new FakeWhatsApp();
      wa.inBrowser = inBrowser;
      wa.open = 'Daniel Okafor';
      const nodes = wa.nodes();
      const full = analyzeWhatsApp(nodes, wa.window);
      const area = chatAreaOf(nodes, wa.window, full);
      expect(area).not.toBeNull();
      // The chat list and the search box are not read again.
      const part = subtree(nodes, area!.root, area!.skip);
      expect(part.some((n) => /^rid\.(chat|search|list)/.test(n.rid))).toBe(false);
      const quick = analyzeChatArea(part, area!).view;
      expect(quick.header).toBe(full.header);
      expect(quick.compose?.rid).toBe(full.compose?.rid);
      expect(quick.messages.map((m) => [m.from, m.text])).toEqual(full.messages.map((m) => [m.from, m.text]));
      expect(quick.chats).toEqual([]);
      // Elements that appear later in the conversation (the Send button once there is text) are read too.
      wa.compose = 'Hi';
      const later = analyzeChatArea(subtree(wa.nodes(), area!.root, area!.skip), area!).view;
      expect(later.send?.rid).toBe(analyzeWhatsApp(wa.nodes(), wa.window).send?.rid);
      expect(later.send).not.toBeNull();
    });
  }

  it('gives no area when the open chat cannot be told apart', () => {
    const wa = new FakeWhatsApp();
    const nodes = wa.nodes(); // no chat open: no header, no message box
    expect(chatAreaOf(nodes, wa.window, analyzeWhatsApp(nodes, wa.window))).toBeNull();
  });
});
