import { afterEach, describe, expect, it } from 'vitest';
import { channelAllowed } from '../src/main/ipc/roles';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function setup(opts: { heard?: string | null } = {}) {
  const requests: ChatRequest[] = [];
  const spoken: string[] = [];
  let listens = 0;
  h = makeHarness({
    script: (req) => {
      requests.push(req);
      return reply('That is the Save button. It stores your file. Press it to keep your changes.');
    },
    voiceIo: {
      listen: async () => {
        listens++;
        await new Promise((r) => setTimeout(r, 5));
        return listens === 1 && opts.heard ? { text: opts.heard, reason: 'ok' } : { text: null, reason: 'silence' };
      },
      speak: async (t) => void spoken.push(t),
    },
    deps: {
      // Notepad's window (FakeDesktop) is at (10, 10) 800×600 on a 1:1 display.
      captureScreen: async () => ({ png: PNG, width: 1920, height: 1080, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, toScreen: (x, y) => ({ x, y }) }),
    },
  });
  const ui = { shown: 0, hidden: 0, commandBar: 0 };
  h.services.ui = { showCommandBar: () => void ui.commandBar++, notify: () => undefined, showPencil: () => void ui.shown++, hidePencil: () => void ui.hidden++ };
  return { requests, spoken, ui };
}

const submit = (text = '') => h.services.pencilSubmit({ text, crop: PNG.toString('base64'), full: PNG.toString('base64'), box: { x: 100, y: 100, w: 200, h: 150 } });

describe('Keo’s pencil', () => {
  it('opens over the screen, listens, and sends the marked area with what was said; the answer is spoken and Keo keeps listening', async () => {
    const { requests, spoken, ui } = setup({ heard: 'what does this button do' });
    expect((await h.services.startPencil()).ok).toBe(true);
    expect(ui.shown).toBe(1);
    await waitFor(() => h.services.pencilContext()?.heard === 'what does this button do', 3000);
    const ctx = h.services.pencilContext()!;
    expect(ctx.image).toMatch(/^data:image\/png;base64,/);
    expect(ctx.consentNeeded).toBe(false); // the offline test provider
    expect((await submit()).ok).toBe(true);
    expect(ui.hidden).toBe(1);
    await waitFor(() => spoken.some((t) => t.includes('Save button')), 5000);
    // The model saw both pictures next to the request, and where the marks are.
    const user = requests[0]!.messages.at(-1)!;
    expect(user.content.filter((b) => b.type === 'image')).toHaveLength(2);
    const text = user.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ');
    expect(text).toContain('what does this button do');
    expect(text).toContain('notes.txt - Notepad');
    // A voice conversation continues (it listened again after answering).
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    // Pictures are for that turn only: the stored message is text.
    const stored = h.services.conversations.messages(h.services.conversations.list({}).find((c) => c.title.length > 0)!.id);
    expect(stored.every((m) => typeof m.content === 'string')).toBe(true);
  });

  it('typed requests open the mini-chat instead of speaking', async () => {
    const { requests, spoken, ui } = setup({ heard: null });
    await h.services.startPencil();
    expect((await submit('make this text bold')).ok).toBe(true);
    await waitFor(() => requests.length > 0, 3000);
    expect(ui.commandBar).toBe(1);
    expect(spoken).toEqual([]);
    expect(JSON.stringify(requests[0]!.messages.at(-1)!.content)).toContain('make this text bold');
  });

  it('asks before sending a screen picture to a real provider, and cancel sends nothing', async () => {
    const { requests } = setup();
    await h.services.startPencil();
    // Pretend the active provider is a real one without consent.
    (h.services.providers as unknown as { active: () => unknown }).active = () => ({ id: 'openai', label: 'OpenAI', selectedModel: () => 'm', models: () => [{ id: 'm', capabilities: { vision: true } }] });
    expect(h.services.pencilContext()!.consentNeeded).toBe(true);
    expect((await submit('what is this')).ok).toBe(false);
    h.services.pencilAllowExport();
    expect(h.services.settings.get().permissions.visionExport.openai).toBe(true);
    h.services.pencilCancel();
    expect(h.services.pencilContext()).toBeNull();
    expect(requests).toEqual([]);
  });

  it('the pencil window can only reach its own channels', () => {
    for (const c of ['pencil:context', 'pencil:submit', 'pencil:cancel', 'pencil:allowExport', 'pencil:listen'] as const) expect(channelAllowed('pencil', c)).toBe(true);
    for (const c of ['chat:send', 'settings:update', 'tasks:approveStep', 'vision:capture', 'app:copyText'] as const) expect(channelAllowed('pencil', c as never)).toBe(false);
    expect(channelAllowed('companion', 'pencil:start')).toBe(true);
    expect(channelAllowed('companion', 'pencil:submit')).toBe(false);
  });
});
