import { afterEach, describe, expect, it } from 'vitest';
import { channelAllowed } from '../src/main/ipc/roles';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

function setup(o: { main?: boolean } = {}) {
  let calls = 0;
  h = makeHarness({
    script: () => {
      calls++;
      return reply('ok');
    },
    voiceIo: { listen: async () => ({ text: null, reason: 'silence' }), speak: async () => undefined },
  });
  const ui = { shown: 0, hidden: 0, views: [] as string[], calls: 0 };
  // The fake microphone hears silence at once, so the call itself ends quickly: count the starts.
  const start = h.services.voiceMode.start.bind(h.services.voiceMode);
  h.services.voiceMode.start = (...a: Parameters<typeof start>) => {
    ui.calls++;
    return start(...a);
  };
  h.services.ui = {
    showCommandBar: () => undefined,
    notify: () => undefined,
    showKeoMode: () => void ui.shown++,
    hideKeoMode: () => void ui.hidden++,
    ...(o.main === false ? {} : { showMain: (v: string) => void ui.views.push(v) }),
  };
  return { ui, modelCalls: () => calls };
}

describe('Keo mode (a call with Keo)', () => {
  it('“open Keo mode” (typed or spoken) opens the Call view without asking the model, and the call starts', async () => {
    const { ui, modelCalls } = setup();
    const conv = h.services.conversations.create('k');
    const m = await h.services.agent.send(conv.id, 'Hey Keo, open Keo mode please').done;
    expect(m.content).toMatch(/on the call/);
    expect(ui.views).toEqual(['call']);
    expect(ui.shown).toBe(0);
    expect(modelCalls()).toBe(0);
    await waitFor(() => ui.calls === 1, 2000);
    const c = await h.services.agent.send(conv.id, 'close keo mode').done;
    expect(c.content).toMatch(/Call ended/);
    expect(ui.hidden).toBe(1);
    expect(h.services.voiceMode.isActive()).toBe(false);
  });

  it('“call Keo”, “start a call” and “hang up” work on their own; “start a call with Mom” goes to the model', async () => {
    const { ui, modelCalls } = setup();
    const conv = h.services.conversations.create('k');
    await h.services.agent.send(conv.id, 'Call Keo').done;
    expect(ui.views).toEqual(['call']);
    await waitFor(() => ui.calls === 1, 2000);
    expect((await h.services.agent.send(conv.id, 'hang up').done).content).toMatch(/Call ended/);
    await h.services.agent.send(conv.id, 'start a call').done;
    expect(ui.views).toEqual(['call', 'call']);
    await h.services.agent.send(conv.id, 'end call').done;
    await h.services.agent.send(conv.id, 'start a call with Mom on WhatsApp').done;
    expect(modelCalls()).toBe(1);
  });

  it('without a main window, the full-screen view is used', async () => {
    const { ui } = setup({ main: false });
    const conv = h.services.conversations.create('k');
    await h.services.agent.send(conv.id, 'open keo mode').done;
    expect(ui.shown).toBe(1);
  });

  it('other sentences that mention Keo mode go to the model as usual', async () => {
    const { ui, modelCalls } = setup();
    const conv = h.services.conversations.create('k');
    await h.services.agent.send(conv.id, 'what is keo mode?').done;
    expect(ui.shown).toBe(0);
    expect(modelCalls()).toBe(1);
  });

  it('one window reporting silence does not hide another window that is speaking', () => {
    setup();
    h.services.reportVoice({ speaking: true, recording: false, transcribing: false }, 'main');
    h.services.reportVoice({ speaking: false, recording: false, transcribing: false }, 'command');
    expect(h.services.presence.speaking).toBe(true);
    h.services.reportVoice({ speaking: false, recording: false, transcribing: false }, 'main');
    expect(h.services.presence.speaking).toBe(false);
  });

  it('the Keo mode window can only reach its own channels', () => {
    for (const c of ['presence:get', 'voice:modeStart', 'voice:modeStop', 'keomode:close'] as const) expect(channelAllowed('keomode', c)).toBe(true);
    for (const c of ['chat:send', 'settings:update', 'tasks:approveStep', 'pencil:submit'] as const) expect(channelAllowed('keomode', c as never)).toBe(false);
    expect(channelAllowed('companion', 'keomode:open')).toBe(true);
  });
});
