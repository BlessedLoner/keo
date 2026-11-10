import { afterEach, describe, expect, it } from 'vitest';
import { breaksChain, isTransient, recoverHint } from '../src/main/agent/recovery';
import { CapabilityError } from '../src/main/capabilities/types';
import type { ChatRequest, ChatResult, NeutralMessage } from '../src/main/providers/types';
import { makeHarness, notepad, type Harness } from './helpers';

let h: Harness;
let stopApproving: (() => void) | null = null;
afterEach(async () => {
  stopApproving?.();
  stopApproving = null;
  await h?.close();
});

let seq = 0;
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, model: 'keo-test-1', native: undefined });
const calls = (...cs: Array<[string, unknown]>): ChatResult => ({
  text: '',
  toolCalls: cs.map(([name, input]) => ({ id: `r${++seq}`, name, input })),
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'keo-test-1',
  native: undefined,
});
const results = (req: ChatRequest) =>
  req.messages.flatMap((m) => m.content).filter((b): b is Extract<NeutralMessage['content'][number], { type: 'tool_result' }> => b.type === 'tool_result').map((b) => b.content);

function enableDesktop() {
  h.services.settings.update({
    permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] },
    agent: { approvalWaitSeconds: 10, maxToolIterations: 10 },
  });
}

function approveAll() {
  const timer = setInterval(() => {
    for (const t of h.services.tasks.list(50)) {
      for (const s of t.steps) if (s.state === 'awaiting_authorization') h.services.tasks.approveStep(s.id, s.inputHash);
    }
  }, 5);
  stopApproving = () => clearInterval(timer);
}

describe('several steps in one reply', () => {
  it('runs a predictable chain in order, in a single model round', async () => {
    let rounds = 0;
    h = makeHarness({
      script: (_req, n) => {
        rounds = n + 1;
        if (n === 0) return calls(['desktop__type_text', { target: notepad, text: 'buy milk' }], ['desktop__press_keys', { target: notepad, combo: 'ctrl+s' }]);
        return reply('Typed "buy milk" and saved it.');
      },
    });
    enableDesktop();
    approveAll();
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type buy milk in notepad and save').done;
    expect(h.desktop.inputCalls().map((x) => x.op)).toEqual(['focus', 'paste', 'focus', 'keys']);
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['executed', 'executed']);
    // Two actions, one round of thinking in between instead of two.
    expect(rounds).toBe(2);
  });

  it('stops the rest of the chain once an on-screen step fails', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(structuredClone(req));
        if (n === 0) return calls(['desktop__type_text', { target: notepad, text: 'buy milk' }], ['desktop__press_keys', { target: notepad, combo: 'ctrl+s' }]);
        return reply('Typing did not work, so I did not save. Nothing was changed.');
      },
    });
    enableDesktop();
    approveAll();
    h.desktop.failNext = new CapabilityError('input_failed', 'The keyboard input was not delivered.', { dispatched: 'no' });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type buy milk in notepad and save').done;
    // Save never ran: it would have saved the wrong thing.
    expect(h.desktop.inputCalls().map((x) => x.op)).toEqual(['focus']);
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['failed', 'rejected']);
    expect(msg.meta.tools?.[1]?.summary).toContain('Skipped');
    const r = results(seen[1]!);
    // The failure says what to try instead; the skipped step says why it did not run.
    expect(r[0]).toContain('replace: true');
    expect(r[1]).toContain('skipped');
  });
});

describe('recovering', () => {
  it('a read-only lookup that hits a passing glitch is quietly tried again', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(structuredClone(req));
        if (n === 0) return calls(['desktop__list_windows', {}]);
        return reply('Notepad is open.');
      },
    });
    enableDesktop();
    const real = h.desktop.list.bind(h.desktop);
    let failures = 1;
    h.desktop.list = async () => {
      if (failures-- > 0) throw new Error('The desktop helper timed out.');
      return real();
    };
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'which windows are open?').done;
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['executed']);
    expect(results(seen[1]!)[0]).toContain('succeeded');
  });

  it('a lasting failure is not retried and says what to do next', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(structuredClone(req));
        if (n === 0) return calls(['desktop__list_windows', {}]);
        return reply('I could not list the windows.');
      },
    });
    enableDesktop();
    let tries = 0;
    h.desktop.list = async () => {
      tries++;
      throw new Error('Access to the window list is broken.');
    };
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'which windows are open?').done;
    expect(tries).toBe(1);
    expect(results(seen[1]!)[0]).toContain('If a different way also fails');
  });

  it('gives a concrete second way per kind of step', () => {
    expect(recoverHint('apps.open')).toContain('apps__find');
    expect(recoverHint('computer.type')).toContain('replace: true');
    expect(recoverHint('computer.click')).toContain('desktop__inspect_window');
    expect(recoverHint('web.fetch_page')).toContain('different result');
    expect(recoverHint('something.else')).toContain('Do not repeat this exact call');
    // A setting that blocks it is reported, never worked around.
    expect(recoverHint('desktop.type_text', 'Desktop control is turned off in Settings.')).toContain('which setting');
  });

  it('knows passing glitches from lasting failures', () => {
    expect(isTransient('Request timed out')).toBe(true);
    expect(isTransient('socket hang up')).toBe(true);
    expect(isTransient('HTTP 503 from service')).toBe(true);
    expect(isTransient('No window matches that name')).toBe(false);
    expect(breaksChain('failed')).toBe(true);
    expect(breaksChain('executed')).toBe(false);
  });
});
