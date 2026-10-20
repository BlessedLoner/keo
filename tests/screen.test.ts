import { afterEach, describe, expect, it } from 'vitest';
import { channelAllowed } from '../src/main/ipc/roles';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function setup() {
  h = makeHarness({
    script: () => reply('The play button is at [500, 820].'),
    deps: { captureScreen: async () => ({ png: PNG, width: 1920, height: 1080, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, toScreen: (x, y) => ({ x, y }) }) },
  });
  const shown: Array<{ bounds: unknown; marks: unknown[]; seconds: number }> = [];
  h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMarks: (bounds, marks, seconds) => void shown.push({ bounds, marks, seconds }) };
  return { shown };
}

async function run(capabilityId: string, input: unknown) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  if (step.state === 'awaiting_authorization') h.services.tasks.approveStep(step.id, step.inputHash);
  else h.services.tasks.pump();
  for (let i = 0; i < 100 && !['completed', 'failed', 'cancelled'].includes(h.services.tasks.get(t.id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
  return { step: h.services.tasks.get(t.id)!.steps[0]!, needed: step.state === 'awaiting_authorization' } as const;
}

describe('Keo on the whole screen', () => {
  it('looks at the screen with the active model, then points things out on that same display', async () => {
    const { shown } = setup();
    const look = await run('screen.look', { question: 'Where is the play button?' });
    if ('rejected' in look) throw new Error(look.rejected);
    expect(look.step.state).toBe('succeeded');
    expect((look.step.result as { answer: string }).answer).toContain('[500, 820]');
    const mark = await run('screen.point_out', { marks: [{ shape: 'circle', x: 500, y: 820, w: 60, label: 'Play' }], seconds: 8 });
    if ('rejected' in mark) throw new Error(mark.rejected);
    expect(mark.needed).toBe(false); // display-only: no approval
    expect(mark.step.state).toBe('succeeded');
    expect(shown).toEqual([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, marks: [{ shape: 'circle', x: 500, y: 820, w: 60, label: 'Play' }], seconds: 8 }]);
  });

  it('refuses to send the screen to a real provider without screen-content consent', async () => {
    setup();
    (h.services.providers as unknown as { active: () => unknown }).active = () => ({ id: 'openai', label: 'OpenAI', destination: () => 'api.openai.com', selectedModel: () => 'm', models: () => [{ id: 'm', capabilities: { vision: true } }] });
    const r = await run('screen.look', { question: 'What is on screen?' });
    expect('rejected' in r ? r.rejected : '').toMatch(/not allowed yet/);
  });

  it('the marks window can only read its marks', () => {
    expect(channelAllowed('marks', 'marks:get')).toBe(true);
    for (const c of ['chat:send', 'settings:update', 'presence:get', 'pencil:submit'] as const) expect(channelAllowed('marks', c as never)).toBe(false);
  });
});
