import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { installedBrowsers } from '../src/main/desktop/browserProfiles';
import { makeHarness } from './helpers';

/**
 * Manual check: Keo's real browser window (with a window, a throw-away profile) on a local
 * test page served from this process — no website is opened, nothing is submitted.
 * KEO_LIVE_WEB=1 npx vitest run tests/live-web.test.ts
 */
it.runIf(process.env.KEO_LIVE_WEB === '1')('Keo’s browser window works on a local page', async () => {
  const b = installedBrowsers().find((x) => x.id === 'chrome') ?? installedBrowsers().find((x) => x.id === 'edge');
  if (!b) throw new Error('Neither Chrome nor Edge is installed.');
  const server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Keo live web test</title><h1>Live test</h1><label>Name <input></label><textarea aria-label="Notes"></textarea><select aria-label="Size"><option>S</option><option>M</option></select>'),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const h = makeHarness({ deps: { webBrowser: { pick: () => ({ exe: b.exe, label: b.label }) } } });
  const run = async (capabilityId: string, input: unknown) => {
    const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
    if (!a.ok) throw new Error(a.reason);
    const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
    h.services.tasks.submit(t.id);
    const step = h.services.tasks.get(t.id)!.steps[0]!;
    if (step.state === 'awaiting_authorization') h.services.tasks.approveStep(step.id, step.inputHash);
    else h.services.tasks.pump();
    for (let i = 0; i < 1500 && !['completed', 'failed', 'cancelled'].includes(h.services.tasks.get(t.id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
    const s = h.services.tasks.get(t.id)!.steps[0]!;
    if (s.error) throw new Error(s.error);
    return s.result as Record<string, unknown>;
  };
  const out: Record<string, unknown> = {};
  try {
    out.open = await run('web.open', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
    const page = (await run('web.read', {})) as { text: string };
    out.read = page.text;
    const ref = (n: string) => /^\[(p\d+e\d+)\]/.exec(page.text.split('\n').find((l) => l.includes(n))!)![1]!;
    out.fill = await run('web.fill', { ref: ref('"Name"'), value: 'Kid bro' });
    out.notes = await run('web.fill', { ref: ref('"Notes"'), value: 'Line one\nLine two' });
    out.select = await run('web.select', { ref: ref('"Size"'), option: 'M' });
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    console.log(JSON.stringify(out, null, 2));
    await h.close();
    server.close();
  }
  expect(out.fill).toMatchObject({ verified: true });
  expect(out.notes).toMatchObject({ verified: true });
  expect(out.select).toMatchObject({ verified: true });
}, 120000);
