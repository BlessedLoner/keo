import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const paint = { hwnd: '3101', pid: 3131, processName: 'mspaint' };

function setup() {
  h = makeHarness();
  h.desktop.windows.push({ ...paint, title: 'Untitled - Paint', className: 'WinUIDesktopWin32WindowClass', minimized: false, x: 100, y: 50, width: 1000, height: 600, foreground: false });
  h.services.settings.update({ permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'mspaint', label: 'Paint' }, { processName: 'notepad', label: 'Notepad' }] }, agent: { approvalWaitSeconds: 10 } });
}

async function run(input: unknown) {
  const a = h.services.registry.admit({ capabilityId: 'desktop.draw', input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const t = h.services.tasks.create({ title: 'draw', rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: 'draw', dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  if (step.state === 'awaiting_authorization') h.services.tasks.approveStep(step.id, step.inputHash);
  await waitFor(() => ['completed', 'failed', 'cancelled', 'outcome_uncertain'].includes(h.services.tasks.get(t.id)!.state), 5000);
  return { step: h.services.tasks.get(t.id)!.steps[0]! } as const;
}

describe('drawing', () => {
  it('maps strokes on the 0–1000 scale into the canvas box, in screen coordinates', async () => {
    setup();
    const r = await run({ target: paint, area: { x: 100, y: 150, w: 801, h: 401 }, strokes: [[0, 0, 1000, 1000], [500, 0, 500, 1000]], what: 'two lines' });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.step.state).toBe('succeeded');
    expect(h.desktop.drawn).toHaveLength(1);
    // window at (100, 50) + area (100, 150) → (200, 200) … (1000, 600)
    expect(h.desktop.drawn[0]!.strokes).toEqual([
      [[200, 200], [1000, 600]],
      [[600, 200], [600, 600]],
    ]);
    expect(r.step.preview.autoTier).toBe('important'); // a drawing app: may run hands-free
  });

  it('refuses an area outside the window, odd point lists and windows that are not allowed', async () => {
    setup();
    const out = await run({ target: paint, area: { x: 900, y: 100, w: 400, h: 100 }, strokes: [[0, 0, 10, 10]] });
    if ('rejected' in out) throw new Error(out.rejected);
    expect(out.step.errorCode).toBe('outside_client_area');
    expect(h.desktop.drawn).toEqual([]);
    expect(await run({ target: paint, area: { x: 0, y: 0, w: 100, h: 100 }, strokes: [[0, 0, 10]] })).toHaveProperty('rejected');
    expect(await run({ target: { hwnd: '1002', pid: 5151, processName: 'chrome' }, area: { x: 0, y: 0, w: 100, h: 100 }, strokes: [[0, 0, 10, 10]] })).toHaveProperty('rejected');
  });

  it('dragging in an app that is not a drawing app always asks', async () => {
    setup();
    const a = h.services.registry.admit({ capabilityId: 'desktop.draw', input: { target: { hwnd: '1001', pid: 4242, processName: 'notepad' }, area: { x: 0, y: 0, w: 100, h: 100 }, strokes: [[0, 0, 10, 10]] }, origin: 'model', correlationId: 'c' });
    expect(a.ok && a.preview.autoTier).toBe('always_ask');
  });
});
