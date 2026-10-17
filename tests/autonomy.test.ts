import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityError } from '../src/main/capabilities/types';
import type { RawWindow } from '../src/main/desktop/backend';
import { SnapshotStore } from '../src/main/desktop/uia';
import { analyzeWhatsApp, headerMatches } from '../src/main/desktop/whatsapp';
import { createHandlers } from '../src/main/ipc/handlers';
import { dispatch, type SenderPolicy } from '../src/main/ipc/router';
import { channelAllowed } from '../src/main/ipc/roles';
import { Logger } from '../src/main/logging/logger';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { validateWakePhrase } from '../src/main/voice/wakeService';
import { SettingsSchema } from '../src/shared/settings';
import { FakeBrowser, FakeSettingsApp, FakeWhatsApp } from './fakeApps';
import { FakeSpeech, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

let seq = 0;
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `t${++seq}`, name, input }], stopReason: 'tool_use', usage: null, model: 'keo-test-1', native: undefined });
const lastResult = (req: ChatRequest) => (req.messages.at(-1)?.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)?.content ?? '';
const win = (hwnd: string, pid: number, processName: string, title: string): RawWindow => ({ hwnd, pid, processName, title, className: 'X', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false });

const SETTINGS = { hwnd: '3001', pid: 777, processName: 'fakeapp' };
const WA = { hwnd: '4001', pid: 888, processName: 'chrome' };

function setup(opts: { script?: (req: ChatRequest, n: number) => ChatResult; speech?: FakeSpeech } = {}) {
  h = makeHarness({ script: opts.script ?? (() => reply('ok')), speech: opts.speech });
  h.services.settings.update({
    permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'fakeapp', label: 'Fake' }, { processName: 'chrome', label: 'Chrome' }] },
    agent: { approvalWaitSeconds: 10, maxToolIterations: 12 },
  });
  const app = new FakeSettingsApp();
  const wa = new FakeWhatsApp();
  h.desktop.addApp(win(SETTINGS.hwnd, SETTINGS.pid, 'fakeapp', 'Fake Settings App'), app);
  h.desktop.addApp(win(WA.hwnd, WA.pid, 'chrome', 'WhatsApp - Google Chrome'), wa);
  return { app, wa };
}

/** Runs one capability through the real registry → orchestrator path, approving if needed. */
async function runCap(capabilityId: string, input: unknown, approve: boolean | 'grant' = true) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  let task = h.services.tasks.get(t.id)!;
  const step = task.steps[0]!;
  if (step.state === 'awaiting_authorization') {
    if (approve === false) return { task, step } as const;
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    if (approve === 'grant') await handlers['grants:approveAndGrant']({ stepId: step.id, inputHash: step.inputHash, minutes: 10 });
    else h.services.tasks.approveStep(step.id, step.inputHash);
  } else h.services.tasks.pump();
  await waitFor(() => ['completed', 'failed', 'cancelled', 'outcome_uncertain'].includes(h.services.tasks.get(t.id)!.state), 5000);
  task = h.services.tasks.get(t.id)!;
  return { task, step: task.steps[0]! } as const;
}

async function inspect(target: typeof SETTINGS) {
  const r = await runCap('desktop.inspect_window', { target });
  if ('rejected' in r) throw new Error(r.rejected);
  return r.step.result as { snapshotId: string; elements: Array<{ id: string; name: string; role: string; actions?: string[] }>; dialogs: string[] };
}
const el = (snap: { elements: Array<{ id: string; name: string }> }, name: string) => snap.elements.find((e) => e.name === name)!.id;

describe('universal desktop interaction', () => {
  it('observes, navigates to a section and verifies the change', async () => {
    const { app } = setup();
    const s1 = await inspect(SETTINGS);
    expect(s1.elements.map((e) => e.name)).toEqual(expect.arrayContaining(['Home', 'Settings']));
    const r = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: s1.snapshotId, elementId: el(s1, 'Settings'), action: 'select' });
    expect(r.task?.state).toBe('completed');
    expect(r.step?.verification).toBe('verified');
    expect(app.tab).toBe('settings');
    const s2 = await inspect(SETTINGS);
    expect(s2.elements.map((e) => e.name)).toContain('Dark mode');
  });

  it('toggles, fills fields with read-back, and refuses password fields', async () => {
    const { app } = setup();
    app.tab = 'settings';
    const s = await inspect(SETTINGS);
    const t = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: s.snapshotId, elementId: el(s, 'Dark mode'), action: 'toggle' });
    expect(t.step?.verification).toBe('verified');
    expect(app.dark).toBe(true);
    const f = await runCap('desktop.set_text', { target: SETTINGS, snapshotId: s.snapshotId, elementId: el(s, 'Display name'), text: 'Blessed' });
    expect(f.step?.verification).toBe('verified');
    expect(app.name).toBe('Blessed');
    const pw = await runCap('desktop.set_text', { target: SETTINGS, snapshotId: s.snapshotId, elementId: el(s, 'Password'), text: 'x' });
    expect('rejected' in pw && pw.rejected).toMatch(/password/i);
  });

  it('refuses to act when the control changed since it was observed', async () => {
    const { app } = setup();
    app.tab = 'settings';
    const s = await inspect(SETTINGS);
    app.renameButton = 'Reset everything';
    const r = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: s.snapshotId, elementId: el(s, 'Open advanced') });
    expect(r.task?.state).toBe('failed');
    expect(r.step?.errorCode).toBe('element_changed');
    expect(app.invoked).toEqual([]);
  });

  it('reports a new dialog as a decision point', async () => {
    const { app } = setup();
    app.tab = 'settings';
    const s = await inspect(SETTINGS);
    const r = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: s.snapshotId, elementId: el(s, 'Open advanced') });
    expect((r.step?.result as { newWindows: string[] }).newWindows).toEqual(['Confirm advanced settings']);
    expect(r.step?.verificationDetail).toMatch(/decision point/);
    expect(r.step?.verification).toBe('unverified');
  });

  it('rejects stale observations and observations of another window', () => {
    let now = 1_000_000;
    const store = new SnapshotStore(() => now);
    const snap = store.put(SETTINGS, { nodes: [{ rid: '1', role: 'button', name: 'OK', depth: 0, parent: -1 }], truncated: false, ms: 1, window: { w: 1, h: 1, x: 0, y: 0 } });
    expect(store.resolve(snap.id, 'e0', SETTINGS).node.name).toBe('OK');
    expect(() => store.resolve(snap.id, 'e0', WA)).toThrow(/different window/);
    expect(() => store.resolve(snap.id, 'e9', SETTINGS)).toThrow(/No element/);
    now += 121_000;
    expect(() => store.resolve(snap.id, 'e0', SETTINGS)).toThrow(/older than 2 minutes/);
  });

  it('scrolls through the accessibility tree or the wheel fallback', async () => {
    setup();
    const r = await runCap('desktop.scroll', { target: SETTINGS, direction: 'down' });
    expect(r.task?.state).toBe('completed');
    expect(h.desktop.calls.some((c) => c.op === 'wheel')).toBe(true);
  });
});

describe('navigation grants', () => {
  it('cover low-risk steps in that window only, never sensitive controls', async () => {
    const { app } = setup();
    app.tab = 'settings';
    // First inspection approved with "allow navigation" → creates the grant.
    await runCap('desktop.inspect_window', { target: SETTINGS }, 'grant');
    expect(h.services.grants.list()).toHaveLength(1);
    // A later inspection and a harmless click run without asking.
    const again = await runCap('desktop.inspect_window', { target: SETTINGS }, false);
    expect(again.step?.approval?.grantId).toBeTruthy();
    const darkSnap = again.step!.result as { snapshotId: string; elements: Array<{ id: string; name: string }> };
    const toggle = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: darkSnap.snapshotId, elementId: el(darkSnap, 'Dark mode'), action: 'toggle' }, false);
    expect(toggle.task?.state).toBe('completed');
    // "Delete account" is sensitive: still needs its own approval.
    const del = await runCap('desktop.invoke_element', { target: SETTINGS, snapshotId: darkSnap.snapshotId, elementId: el(darkSnap, 'Delete account') }, false);
    expect(del.step?.state).toBe('awaiting_authorization');
    expect(app.invoked).not.toContain('delete');
    // Another window is not covered.
    const other = await runCap('desktop.inspect_window', { target: WA }, false);
    expect(other.step?.state).toBe('awaiting_authorization');
    // Revoke → asks again.
    h.services.grants.revokeAll();
    const after = await runCap('desktop.inspect_window', { target: SETTINGS }, false);
    expect(after.step?.state).toBe('awaiting_authorization');
  });

  it('expire after their time limit', () => {
    setup();
    let now = Date.now();
    const g = new (h.services.grants.constructor as new (a: unknown, n: () => number) => typeof h.services.grants)(h.services.audit, () => now);
    g.create(SETTINGS, 'x', 1);
    expect(g.list()).toHaveLength(1);
    now += 61_000;
    expect(g.list()).toHaveLength(0);
  });
});

describe('WhatsApp workflows', () => {
  it('asks when the contact name is ambiguous and opens only on an exact match', async () => {
    const { wa } = setup();
    const amb = await runCap('whatsapp.open_chat', { target: WA, contact: 'Daniel' });
    expect(amb.step?.result).toMatchObject({ opened: false, candidates: ['Daniel Okafor', 'Daniel Smith'] });
    expect(wa.open).toBeNull();
    const ok = await runCap('whatsapp.open_chat', { target: WA, contact: 'daniel okafor' });
    expect(ok.step?.result).toMatchObject({ opened: true, header: 'Daniel Okafor' });
    expect(ok.step?.verification).toBe('verified');
  });

  it('works with WhatsApp Web in Chrome: refused accessibility focus/value fall back to real clicks and paste', async () => {
    const { wa } = setup();
    const desktop = h.desktop;
    wa.webLike = true;
    const open = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(open.step?.state).toBe('succeeded');
    expect(open.step?.verification).toBe('verified');
    expect(wa.open).toBe('Mum');
    expect(desktop.calls.filter((c) => c.op === 'click_screen').length).toBe(2); // search box, then the chat entry
    const send = await runCap('whatsapp.send_message', { target: WA, contact: 'Mum', text: 'On my way' });
    expect(send.step?.verification).toBe('verified');
    expect(wa.sent).toEqual([{ to: 'Mum', text: 'On my way' }]);
  });

  it('waits for a just-restored browser to report WhatsApp visible instead of failing “not visible”', async () => {
    const { wa } = setup();
    wa.webLike = true;
    const w = h.desktop.windows.find((x) => x.hwnd === WA.hwnd)!;
    w.minimized = true;
    wa.hiddenReads = 3;
    const open = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(open.step?.state).toBe('succeeded');
    expect(open.step?.verification).toBe('verified');
    expect(wa.open).toBe('Mum');
  });

  it('opens and sends in WhatsApp Web inside Chrome (browser controls around the page)', async () => {
    const { wa } = setup();
    wa.inBrowser = true;
    wa.webLike = true;
    const open = await runCap('whatsapp.open_chat', { target: WA, contact: 'Daniel Smith' });
    expect(open.step?.verification).toBe('verified');
    expect(wa.open).toBe('Daniel Smith');
    const send = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Smith', text: 'See you at 3' });
    expect(send.step?.verification).toBe('verified');
    expect(wa.sent).toEqual([{ to: 'Daniel Smith', text: 'See you at 3' }]);
  });

  it('reads WhatsApp Web messages whose text is hidden from the control view', async () => {
    const { wa } = setup();
    wa.inBrowser = true;
    wa.open = 'Daniel Okafor';
    const r = await runCap('whatsapp.read_chat', { target: WA, contact: 'Daniel Okafor' });
    expect((r.step?.result as { messages: unknown[] }).messages).toEqual([
      { from: 'them', text: 'Hey! Did you find a good microphone?', status: null },
      { from: 'me', text: 'Still looking', status: 'read' },
    ]);
  });

  it('types for real when the page silently ignores an accessibility value write', async () => {
    const { wa } = setup();
    wa.inBrowser = true;
    wa.ignoreValueWrites = true;
    const open = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(open.step?.verification).toBe('verified');
    const send = await runCap('whatsapp.send_message', { target: WA, contact: 'Mum', text: 'Calling you at 6' });
    expect(send.step?.verification).toBe('verified');
    expect(wa.sent).toEqual([{ to: 'Mum', text: 'Calling you at 6' }]);
  });

  it('reports a refused focus as “nothing entered”, never as an uncertain outcome', async () => {
    const { wa } = setup();
    const desktop = h.desktop;
    wa.webLike = true;
    desktop.clickScreen = async () => {
      throw new CapabilityError('target_obscured', 'covered', { dispatched: 'no' });
    };
    const r = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(r.step?.state).toBe('failed');
    expect(r.step?.errorCode).toBe('target_obscured');
    expect(wa.open).toBeNull();
  });

  it('opens the top match when search lists the same person under Chats and Contacts', async () => {
    const { wa } = setup();
    wa.searchListsContacts = true;
    const r = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(r.step?.result).toMatchObject({ opened: true, header: 'Mum' });
    expect(r.step?.verification).toBe('verified');
    expect(wa.open).toBe('Mum');
  });

  it('reads the open chat only after verifying the recipient', async () => {
    const { wa } = setup();
    wa.open = 'Mum';
    const wrong = await runCap('whatsapp.read_chat', { target: WA, contact: 'Daniel Okafor' });
    expect(wrong.step?.errorCode).toBe('chat_mismatch');
    wa.open = 'Daniel Okafor';
    const r = await runCap('whatsapp.read_chat', { target: WA, contact: 'Daniel Okafor' });
    expect((r.step?.result as { messages: unknown[] }).messages).toEqual([
      { from: 'them', text: 'Hey! Did you find a good microphone?', status: null },
      { from: 'me', text: 'Still looking', status: 'read' },
    ]);
  });

  it('never sends without approval, after denial, or after cancellation', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    const pending = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'The AudioPro X1 is the best value.' }, false);
    expect(pending.step?.state).toBe('awaiting_authorization');
    expect(pending.step?.preview.target).toContain('Daniel Okafor');
    expect(pending.step?.preview.consequences.join(' ')).toContain('The AudioPro X1 is the best value.');
    expect(pending.step?.preview.grantable).toBe(false);
    h.services.tasks.denyStep(pending.step!.id);
    const p2 = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'second' }, false);
    h.services.tasks.cancel(p2.task!.id);
    h.services.tasks.pump();
    await new Promise((r) => setTimeout(r, 30));
    expect(wa.sent).toEqual([]);
    expect(h.desktop.calls.filter((c) => c.op === 'uia_act' && String(c.args[1]).includes('send'))).toHaveLength(0);
  });

  it('a navigation grant can never authorise sending', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    await runCap('whatsapp.read_chat', { target: WA, contact: 'Daniel Okafor' }, 'grant');
    expect(h.services.grants.list()).toHaveLength(1);
    const send = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'hi' }, false);
    expect(send.step?.state).toBe('awaiting_authorization');
    expect(wa.sent).toEqual([]);
  });

  it('sends after approval, verifies it in the chat, and does not duplicate on retry', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    const r = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'Got it, thanks!' });
    expect(r.task?.state).toBe('completed');
    expect(r.step?.verification).toBe('verified');
    expect(r.step?.verificationDetail).toMatch(/WhatsApp shows: sent/i);
    expect(wa.sent).toEqual([{ to: 'Daniel Okafor', text: 'Got it, thanks!' }]);
    const again = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'Got it, thanks!' });
    expect(again.step?.result).toMatchObject({ sent: false, alreadyPresent: true });
    expect(wa.sent).toHaveLength(1);
  });

  it('stops if the open chat changes before sending', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    wa.switchChatAfterCompose = 'Mum';
    const r = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'for Daniel only' });
    expect(r.task?.state).toBe('failed');
    expect(r.step?.errorCode).toBe('chat_mismatch');
    expect(wa.sent).toEqual([]);
  });

  it('marks an unconfirmed send as uncertain instead of success, and never retries it blindly', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    wa.dropSends = true;
    const r = await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'Did this arrive?' });
    expect(r.task?.state).toBe('outcome_uncertain');
    expect(r.step?.error).toMatch(/may or may not have been sent/);
    await new Promise((res) => setTimeout(res, 50));
    expect(h.desktop.calls.filter((c) => c.op === 'uia_act' && c.args[1] === 'rid.send')).toHaveLength(1);
  });

  it('recognises WhatsApp structure from roles, names and layout', () => {
    const wa = new FakeWhatsApp();
    wa.open = 'Daniel Okafor';
    const v = analyzeWhatsApp(wa.nodes(), wa.window);
    expect(v.search?.name).toBe('Search input textbox');
    expect(v.compose?.name).toBe('Type a message');
    expect(v.send?.name).toBe('Send');
    expect(v.header).toBe('Daniel Okafor');
    expect(v.chats.map((c) => c.title)).toEqual(['Daniel Okafor', 'Daniel Smith', 'Mum']);
  });
  it('tells incoming from outgoing messages when rows span the whole pane', () => {
    const wa = new FakeWhatsApp();
    wa.open = 'Daniel Okafor';
    const nodes = wa.nodes().map((n) => (/^rid\.msg\.\d+$/.test(n.rid) ? { ...n, x: 400, w: 800 } : n));
    const v = analyzeWhatsApp(nodes, wa.window);
    expect(v.messages.map((m) => m.from)).toEqual(['them', 'me']);
  });

  it('in a browser, uses only the WhatsApp page — never the address bar or window buttons', () => {
    const wa = new FakeWhatsApp();
    wa.inBrowser = true;
    let v = analyzeWhatsApp(wa.nodes(), wa.window);
    expect(v.search?.name).toBe('Search input textbox');
    expect(v.header).toBeNull(); // not “Minimize”
    expect(v.chats.map((c) => c.title)).toEqual(['Daniel Okafor', 'Daniel Smith', 'Mum']); // innermost entries, prefixes removed
    wa.open = 'Mum';
    v = analyzeWhatsApp(wa.nodes(), wa.window);
    expect(v.header).toBe('Mum');
    expect(v.compose?.name).toBe('Type a message');
  });

  it('matches the header despite WhatsApp’s “click here for contact info” and presence suffixes', () => {
    expect(headerMatches('Ma Glo click here for contact info', 'Ma Glo')).toBe(true);
    expect(headerMatches('Ma Glo, online', 'ma glo')).toBe(true);
    expect(headerMatches('Ma Glo last seen today at 10:02', 'Ma Glo')).toBe(true);
    expect(headerMatches('Ma Glory click here for contact info', 'Ma Glo')).toBe(false);
    expect(headerMatches('Ma Glo Business Account', 'Ma Glo')).toBe(true);
    expect(headerMatches('Ma Glo, Business Account, online', 'Ma Glo')).toBe(true);
    const wa = new FakeWhatsApp();
    wa.open = 'Mum';
    const nodes = wa.nodes().map((n) => (n.rid === 'rid.header' ? { ...n, name: 'Mum click here for contact info' } : n));
    expect(analyzeWhatsApp(nodes, wa.window).header).toBe('Mum');
  });

  it('tells the model how to recover from an invented or incomplete window target', () => {
    setup();
    const a = h.services.registry.admit({ capabilityId: 'whatsapp.send_message', input: { target: { hwnd: '4001', pid: 0, processName: 'chrome' }, contact: 'Mum', text: 'hi' }, origin: 'model', correlationId: 'c' });
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toContain('desktop__list_windows');
  });

  it('drops a time stamp glued onto concatenated list-item names (Chromium)', () => {
    const wa = new FakeWhatsApp();
    const nodes = wa.nodes().filter((n) => !(n.role === 'text' && /Daniel|Mum/.test(n.name)));
    nodes.forEach((n) => {
      if (n.role === 'listitem' && n.name.startsWith('Mum')) n.name = 'Mum10:42';
    });
    const v = analyzeWhatsApp(nodes, wa.window);
    expect(v.chats.map((c) => c.title)).toContain('Mum');
  });
});

describe('browser context', () => {
  it('reads the active tab and marks page text as untrusted; injected instructions authorise nothing', async () => {
    const BR = { hwnd: '5001', pid: 999, processName: 'chrome' };
    setup({
      script: (req, n) => (n === 0 ? call('browser__read_page', { target: BR }) : n === 1 ? reply(lastResult(req)) : reply('done')),
    });
    h.desktop.addApp(win(BR.hwnd, BR.pid, 'chrome', 'AudioPro X1 – Shop - Google Chrome'), new FakeBrowser());
    const c = h.services.conversations.create();
    const run = h.services.agent.send(c.id, 'research this microphone and find the best quality for the price');
    await waitFor(() => h.services.tasks.list(5).some((t) => t.state === 'awaiting_authorization'));
    const st = h.services.tasks.list(5)[0]!.steps[0]!;
    expect(st.preview.dataExport).toMatch(/Page text is sent to/);
    h.services.tasks.approveStep(st.id, st.inputHash);
    const msg = await run.done;
    expect(msg.content).toContain('untrusted');
    expect(msg.content).toContain('https://shop.example/audiopro-x1');
    expect(msg.content).toContain('Cardioid condenser');
    expect(h.services.tasks.list(10)).toHaveLength(1); // the page's "approve all actions" created nothing
    expect(h.services.grants.list()).toHaveLength(0);
  });

  it('only reads browsers', () => {
    setup();
    const a = h.services.registry.admit({ capabilityId: 'browser.read_page', input: { target: SETTINGS }, origin: 'model', correlationId: 'c' });
    expect(a.ok === false && a.reason).toMatch(/not a supported browser/);
  });
});

describe('cancellation across multi-step work', () => {
  it('cancelling a plan prevents all later steps', async () => {
    const { app } = setup();
    app.tab = 'settings';
    const s = await inspect(SETTINGS);
    const mk = (elementId: string) => {
      const a = h.services.registry.admit({ capabilityId: 'desktop.invoke_element', input: { target: SETTINGS, snapshotId: s.snapshotId, elementId, action: 'toggle' }, origin: 'plan', correlationId: 'c' });
      if (!a.ok) throw new Error(a.reason);
      return a;
    };
    h.desktop.hang = true;
    const t = h.services.tasks.create({
      title: 'two toggles',
      rationale: '',
      origin: 'plan',
      conversationId: null,
      correlationId: 'c',
      steps: [
        { admission: mk(el(s, 'Dark mode')), title: 'a', dependsOnIndexes: [] },
        { admission: mk(el(s, 'Dark mode')), title: 'b', dependsOnIndexes: [0] },
      ],
    });
    h.services.tasks.approvePlan(t.id, Object.fromEntries(t.steps.map((x) => [x.id, x.inputHash])));
    await waitFor(() => h.services.tasks.get(t.id)!.state === 'running');
    h.services.stopAll();
    await waitFor(() => !['running', 'cancelling'].includes(h.services.tasks.get(t.id)!.state));
    const final = h.services.tasks.get(t.id)!;
    expect(final.steps[1]!.state).toBe('cancelled');
    expect(['outcome_uncertain', 'cancelled']).toContain(final.state);
    // The first step was stuck bringing the window forward; nothing further was sent.
    expect(h.desktop.calls.filter((c) => c.op === 'uia_act')).toHaveLength(0);
    h.desktop.hang = false;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.desktop.calls.filter((c) => c.op === 'uia_act')).toHaveLength(0);
  });
});

describe('presence', () => {
  it('derives each state from the corresponding real signal', () => {
    setup();
    const p = h.services.presence;
    p.agentEvent({ type: 'turn_started', conversationId: 'c1', messageId: 'm1', correlationId: 'x' });
    expect(p.get()).toMatchObject({ state: 'understanding', activity: 'Understanding your request' });
    p.agentEvent({ type: 'phase', conversationId: 'c1', messageId: 'm1', phase: 'gathering_context' });
    expect(p.get()).toMatchObject({ state: 'understanding', activity: 'Gathering context' });
    p.agentEvent({ type: 'phase', conversationId: 'c1', messageId: 'm1', phase: 'planning' });
    expect(p.get().state).toBe('planning');
    p.stepActivity({ taskId: 't', stepId: 's', capabilityId: 'desktop.type_text', phase: 'executing' }, 'Notepad');
    expect(p.get()).toMatchObject({ state: 'acting', activity: 'Type text · Notepad' });
    p.stepActivity({ taskId: 't', stepId: 's', capabilityId: 'desktop.type_text', phase: 'verifying' }, 'Notepad');
    expect(p.get()).toMatchObject({ state: 'verifying', activity: 'Verifying: Type text · Notepad' });
    p.stepActivity({ taskId: 't', stepId: 's', capabilityId: 'desktop.type_text', phase: 'done' }, 'Notepad');
    p.setApprovals(1, { capabilityId: 'whatsapp.send_message', app: 'chrome' });
    expect(p.get().state).toBe('awaiting_approval');
    p.setApprovals(0, null);
    p.agentEvent({ type: 'turn_finished', conversationId: 'c1', message: { id: 'm1', conversationId: 'c1', role: 'assistant', content: '', status: 'error', createdAt: '', meta: {} } });
    expect(p.get().state).toBe('error');
  });

  it('follows a real turn through to the approval it leaves behind', async () => {
    const seen: string[] = [];
    setup({
      script: (req, n) => (n === 0 ? call('task__propose_plan', { title: 'x', rationale: 'y', steps: [{ capability: 'system.datetime', title: 't', input: {} }] }) : reply('planned')),
    });
    h.services.presence.onChange((p) => seen.push(p.state));
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'plan something').done;
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.at(-1)).toBe('awaiting_approval'); // the proposed plan waits for the user
    const [task] = h.services.tasks.list(5);
    h.services.tasks.approvePlan(task!.id, Object.fromEntries(task!.steps.map((s) => [s.id, s.inputHash])));
    await waitFor(() => h.services.tasks.get(task!.id)!.state === 'completed');
    await new Promise((r) => setTimeout(r, 120));
    expect(h.services.presence.get().state).toBe('idle');
  });

  it('reports speaking only while audio actually plays and flashes "cancelled" on stop', async () => {
    setup();
    h.services.reportVoice({ speaking: true, recording: false, transcribing: false });
    expect(h.services.presence.get().state).toBe('speaking');
    h.services.reportVoice({ speaking: false, recording: false, transcribing: false });
    expect(h.services.presence.get().state).toBe('idle');
    h.services.stopAll();
    expect(h.services.presence.get().state).toBe('cancelled');
  });

  it('activity text never contains message or page content', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    await runCap('whatsapp.send_message', { target: WA, contact: 'Daniel Okafor', text: 'SECRET PLAN' }, false);
    await new Promise((r) => setTimeout(r, 80));
    const p = h.services.presence.get();
    expect(p.state).toBe('awaiting_approval');
    expect(p.activity).toBe('Needs your approval: Send a WhatsApp message · chrome');
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });
});

describe('wake word and voice commands', () => {
  it('listens only when enabled and unmuted, pauses while Keo speaks, and resumes after', async () => {
    const speech = new FakeSpeech();
    setup({ speech });
    await h.services.wake.apply();
    expect(speech.cmds()).not.toContain('wake'); // off by default
    h.services.settings.update({ wake: { enabled: true, phrases: ['hey keo', 'okay kio'] } });
    await waitFor(() => speech.cmds().includes('wake'));
    expect(speech.sent.find((c) => c.cmd === 'wake')).toMatchObject({ phrases: ['hey keo', 'okay kio'], culture: 'en-US' });
    expect(h.services.presence.get().wake.status).toBe('listening');
    h.services.reportVoice({ speaking: true, recording: false, transcribing: false });
    expect(speech.cmds().at(-1)).toBe('pause');
    h.services.reportVoice({ speaking: false, recording: false, transcribing: false });
    await waitFor(() => speech.cmds().at(-1) === 'wake', 3000);
    await h.services.wake.setMuted(true);
    expect(speech.cmds().at(-1)).toBe('pause');
    expect(h.services.presence.get().wake.muted).toBe(true);
  });

  it('a detected wake phrase starts a voice conversation and sends the spoken command', async () => {
    const speech = new FakeSpeech();
    setup({ speech, script: () => reply('Here is your summary.') });
    let shown = 0;
    h.services.ui = { showCommandBar: () => shown++, notify: () => undefined };
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    speech.fire({ event: 'wake', phrase: 'hey keo', confidence: 0.93 });
    await waitFor(() => speech.cmds().includes('capture'));
    expect(shown).toBe(0); // voice mode: no command bar pops up
    expect(h.services.presence.get().voiceMode.active).toBe(true);
    expect(h.services.presence.get().state).toBe('listening');
    speech.fire({ event: 'command', text: 'summarize this page', confidence: 0.8 });
    const convId = () => h.services.settings.get().commandBar.conversationId;
    await waitFor(() => !!convId() && h.services.conversations.messages(convId()!).some((m) => m.role === 'assistant' && m.status === 'complete'));
    expect(h.services.conversations.messages(convId()!)[0]?.content).toBe('summarize this page');
  });

  it('reports microphone and recognizer problems honestly', async () => {
    const speech = new FakeSpeech();
    setup({ speech });
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    speech.fire({ event: 'error', code: 'no_microphone' });
    expect(h.services.presence.get().wake).toMatchObject({ status: 'error', message: expect.stringMatching(/No microphone/) });
    speech.fire({ event: 'silent_input' });
    expect(h.services.presence.get().wake.message).toMatch(/Privacy → Microphone/);
    const pending = h.services.wake.capture();
    await waitFor(() => speech.cmds().includes('capture'));
    speech.fire({ event: 'error', code: 'no_microphone' });
    expect(await pending).toMatchObject({ text: null, reason: 'no_microphone' });
  });

  it('validates custom wake phrases', () => {
    expect(validateWakePhrase('hey keo')).toBeNull();
    expect(validateWakePhrase('okay jarvis')).toBeNull();
    expect(validateWakePhrase('keo')).toMatch(/2–4 words/);
    expect(validateWakePhrase('hey k3o')).toMatch(/letters/);
    expect(validateWakePhrase('ok yes')).toMatch(/too common/);
    expect(() => SettingsSchema.parse({ wake: { phrases: ['hey 123'] } })).toThrow();
    expect(SettingsSchema.parse({}).wake.enabled).toBe(false);
  });

  it('validates shortcut accelerators', () => {
    expect(SettingsSchema.parse({}).shortcuts.commandBar).toBe('Control+K');
    expect(() => SettingsSchema.parse({ shortcuts: { commandBar: 'K' } })).toThrow();
    expect(() => SettingsSchema.parse({ shortcuts: { commandBar: 'Control+Alt+Delete!' } })).toThrow();
    expect(SettingsSchema.parse({ shortcuts: { commandBar: 'Control+Shift+Space' } }).shortcuts.commandBar).toBe('Control+Shift+Space');
  });
});

describe('window roles', () => {
  const policy: SenderPolicy = { trustedOrigin: 'app://keo', roleOf: (id) => (id === 1 ? 'main' : id === 2 ? 'command' : id === 3 ? 'companion' : null) };
  const frame = (id: number) => ({ senderId: id, frameUrl: 'app://keo/index.html#x', isMainFrame: true });

  it('limits what the companion and command bar can do', async () => {
    setup();
    const handlers = createHandlers(h.services, { appInfo: () => ({}) as never, openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const log = new Logger(null);
    const c = h.services.conversations.create();
    expect((await dispatch('chat:send', { conversationId: c.id, text: 'hi' }, frame(3), handlers, policy, log)).ok).toBe(false);
    expect((await dispatch('providers:setKey', { providerId: 'openai', apiKey: 'sk-test-0000000000' }, frame(2), handlers, policy, log)).ok).toBe(false);
    expect((await dispatch('data:deleteAll', { confirm: 'DELETE' }, frame(2), handlers, policy, log)).ok).toBe(false);
    expect((await dispatch('presence:get', {}, frame(3), handlers, policy, log)).ok).toBe(true);
    expect(channelAllowed('command', 'chat:send')).toBe(true);
    expect(channelAllowed('command', 'settings:update')).toBe(false);
    expect(channelAllowed('companion', 'tasks:approveStep')).toBe(false);
  });
});

describe('WhatsApp in other languages and layouts', () => {
  it('finds the search and message boxes when they are named in another language or not at all', async () => {
    const { analyzeWhatsApp } = await import('../src/main/desktop/whatsapp');
    for (const [searchName, composeName] of [
      ['Rechercher ou démarrer une discussion', 'Écrivez un message'],
      ['Pesquisar ou começar uma nova conversa', 'Digite uma mensagem'],
      ['', ''],
    ]) {
      const wa = new FakeWhatsApp();
      wa.searchName = searchName!;
      wa.composeName = composeName!;
      wa.open = 'Mum';
      const v = analyzeWhatsApp(wa.nodes(), wa.window);
      expect(v.search?.rid).toBe('rid.search');
      expect(v.compose?.rid).toBe('rid.compose');
    }
  });

  it('opens a chat in a French WhatsApp', async () => {
    const { wa } = setup();
    wa.searchName = 'Rechercher ou démarrer une discussion';
    const r = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
    expect(r.task?.steps[0]?.state).toBe('succeeded');
    expect(wa.open).toBe('Mum');
  });

  it('“Check WhatsApp” reports layout facts only — no chat names', async () => {
    const { wa } = setup();
    wa.open = 'Daniel Okafor';
    const r = await h.services.checkWhatsApp();
    expect(r.ok).toBe(true);
    const text = r.lines.join('\n');
    expect(text).toMatch(/Search box: found \(left-top\)/);
    expect(text).toMatch(/chat list entries: 3/);
    expect(text).not.toMatch(/Daniel|Mum|microphone|Okafor/);
    expect(h.desktop.inputCalls()).toEqual([]);
  });
});

describe('WhatsApp not ready', () => {
  for (const [screen, code, words] of [
    ['signed_out', 'wa_signed_out', /not signed in/],
    ['loading', 'wa_not_ready', /still loading/],
    ['empty', 'wa_not_accessible', /not its contents/],
  ] as const) {
    it(`explains a ${screen} WhatsApp window instead of a generic failure, and types nothing`, async () => {
      const { wa } = setup();
      wa.screen = screen;
      const r = await runCap('whatsapp.open_chat', { target: WA, contact: 'Mum' });
      const step = r.task?.steps[0];
      expect(step?.state).toBe('failed');
      expect(step?.errorCode).toBe(code);
      expect(step?.error).toMatch(words);
      expect(h.desktop.inputCalls().filter((c) => c.op === 'type' || c.op === 'paste' || c.op === 'uia_act')).toEqual([]);
      const check = await h.services.checkWhatsApp();
      expect(check.ok).toBe(false);
      expect(check.lines.join('\n')).toMatch(/state: /);
    });
  }
});
