import { afterEach, describe, expect, it } from 'vitest';
import { channelAllowed } from '../src/main/ipc/roles';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

function setup() {
  let calls = 0;
  h = makeHarness({
    script: () => {
      calls++;
      return reply('ok');
    },
    voiceIo: { listen: async () => ({ text: null, reason: 'silence' }), speak: async () => undefined },
  });
  const ui = { shown: 0, hidden: 0 };
  h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showKeoMode: () => void ui.shown++, hideKeoMode: () => void ui.hidden++ };
  return { ui, modelCalls: () => calls };
}

describe('Keo mode', () => {
  it('“open Keo mode” (typed or spoken) opens it without asking the model, and starts listening', async () => {
    const { ui, modelCalls } = setup();
    const conv = h.services.conversations.create('k');
    const m = await h.services.agent.send(conv.id, 'Hey Keo, open Keo mode please').done;
    expect(m.content).toMatch(/Keo mode is on/);
    expect(ui.shown).toBe(1);
    expect(modelCalls()).toBe(0);
    await waitFor(() => h.services.voiceMode.isActive() || ui.shown > 0, 2000);
    const c = await h.services.agent.send(conv.id, 'close keo mode').done;
    expect(c.content).toMatch(/Keo mode is off/);
    expect(ui.hidden).toBe(1);
  });

  it('other sentences that mention Keo mode go to the model as usual', async () => {
    const { ui, modelCalls } = setup();
    const conv = h.services.conversations.create('k');
    await h.services.agent.send(conv.id, 'what is keo mode?').done;
    expect(ui.shown).toBe(0);
    expect(modelCalls()).toBe(1);
  });

  it('the Keo mode window can only reach its own channels', () => {
    for (const c of ['presence:get', 'voice:modeStart', 'voice:modeStop', 'keomode:close'] as const) expect(channelAllowed('keomode', c)).toBe(true);
    for (const c of ['chat:send', 'settings:update', 'tasks:approveStep', 'pencil:submit'] as const) expect(channelAllowed('keomode', c as never)).toBe(false);
    expect(channelAllowed('companion', 'keomode:open')).toBe(true);
  });
});
