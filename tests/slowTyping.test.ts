import { afterEach, describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/main/providers/types';
import { textArrived } from '../src/main/capabilities/builtins';
import { makeHarness, notepad, type Harness } from './helpers';

let h: Harness;
let stopApproving: (() => void) | null = null;
afterEach(async () => {
  stopApproving?.();
  stopApproving = null;
  await h?.close();
});

let seq = 0;
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined });
const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `s${++seq}`, name, input }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined });

function setUp(script: (n: number) => ChatResult) {
  // focusSettleMs > 0: Keo waits for real apps, as on a real computer.
  h = makeHarness({ script: (_req, n) => script(n), deps: { focusSettleMs: 1 } });
  h.services.settings.update({
    permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] },
    agent: { approvalWaitSeconds: 10, maxToolIterations: 10 },
  });
  const timer = setInterval(() => {
    for (const t of h.services.tasks.list(50)) for (const s of t.steps) if (s.state === 'awaiting_authorization') h.services.tasks.approveStep(s.id, s.inputHash);
  }, 5);
  stopApproving = () => clearInterval(timer);
  // Like the new Windows Notepad: Windows accepts the keys at once, the app shows them one by one.
  const desk = h.desktop;
  desk.typeText = async (_hwnd: string, text: string) => {
    desk.calls.push({ op: 'type', args: [_hwnd, text] });
    [...text].forEach((ch, k) => setTimeout(() => (desk.documentText = (desk.documentText ?? '') + ch), 40 * (k + 1)));
    return { chars: text.length };
  };
}

describe('typing into a slow app', () => {
  it('waits for the letters to arrive instead of calling it a failure', async () => {
    setUp((n) => (n === 0 ? call('desktop__type_text', { target: notepad, text: 'hello Emmanuel', method: 'type' }) : reply('Typed it.')));
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'open notepad and type hello Emmanuel').done;
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['executed']);
    expect(h.desktop.documentText).toBe('hello Emmanuel');
    // Nothing late lands afterwards.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.desktop.documentText).toBe('hello Emmanuel');
  }, 30_000);

  it('adds new text after what is there, on a new line when asked', async () => {
    setUp((n) => (n === 0 ? call('desktop__type_text', { target: notepad, text: 'how are you doing today', newLine: true, method: 'paste' }) : reply('Added it on a new line.')));
    h.desktop.documentText = 'hello Emmanuel';
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'type how are you doing today in a new line').done;
    const ops = h.desktop.inputCalls().map((x) => x.op);
    // Ctrl+End first: whatever was selected is never typed over.
    expect(ops).toEqual(['focus', 'keys', 'paste']);
    expect(h.desktop.inputCalls()[1]?.args).toEqual([notepad.hwnd, [0x11], 0x23]);
    // Pasted with Windows line endings, as Notepad stores them.
    expect(h.desktop.documentText).toBe('hello Emmanuel\r\nhow are you doing today');
  }, 30_000);

  it('pastes ordinary text instead of typing it key by key', async () => {
    setUp((n) => (n === 0 ? call('desktop__type_text', { target: notepad, text: 'hello Emmanuel' }) : reply('Done.')));
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'type hello Emmanuel in notepad').done;
    expect(h.desktop.inputCalls().map((x) => x.op)).toEqual(['focus', 'paste']);
    expect(h.desktop.documentText).toBe('hello Emmanuel');
  }, 30_000);

  it('knows when typed lines have arrived', () => {
    expect(textArrived('hello Emmanuel', 'hello Emmanuel')).toBe(true);
    expect(textArrived('h', 'hello Emmanuel')).toBe(false);
    expect(textArrived('Title\r\n\r\nline two  \r\n', 'Title\nline two')).toBe(true);
  });
});
