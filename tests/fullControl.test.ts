import { afterEach, describe, expect, it } from 'vitest';
import { bestElement, looksLikeCardNumber, parseComputerCombo } from '../src/main/capabilities/computer';
import { ControlSession, type ControlUi } from '../src/main/desktop/fullControl';
import { isAllowedProcess } from '../src/main/desktop/desktopService';
import { channelAllowed } from '../src/main/ipc/roles';
import { chooseGroups } from '../src/main/agent/toolGroups';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';
import type { FakeUiaApp } from './fakeApps';
import type { UiaNodeRaw } from '../src/main/desktop/backend';

/**
 * Full control: Keo uses any app like a person — always against the fake desktop (no real input).
 * Fake screen: 1000×1000 pixels at 0,0, so a 0–1000 position is the same pixel.
 */
let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function setup(fullControl = true) {
  h = makeHarness({
    script: () => reply('The text area is at [300, 300].'),
    deps: { captureScreen: async () => ({ png: PNG, width: 1000, height: 1000, bounds: { x: 0, y: 0, width: 1000, height: 1000 }, toScreen: (x, y) => ({ x, y }) }) },
  });
  h.services.settings.update({ permissions: { fullControl } });
  const events: string[] = [];
  const control: ControlUi = {
    showBanner: () => void events.push('banner'),
    hideBanner: () => void events.push('banner_off'),
    bannerBounds: () => ({ x: 400, y: 0, width: 200, height: 40 }),
    bannerAside: (a) => void events.push(a ? 'aside' : 'back'),
    stepKeoAside: () => void events.push('keo_aside'),
    restoreKeo: () => void events.push('keo_back'),
    stopKey: (on) => void events.push(on ? 'esc_on' : 'esc_off'),
  };
  h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMarks: () => undefined, control };
  return { events };
}

/** Runs one capability as a task in a conversation with the user; approves only if asked to. */
async function run(capabilityId: string, input: unknown, approve = false) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason } as const;
  const conv = h.services.conversations.create();
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: conv.id, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  const needed = step.state === 'awaiting_authorization';
  if (needed && !approve) return { needed, step, tier: step.preview.autoTier } as const;
  if (needed) h.services.tasks.approveStep(step.id, step.inputHash);
  else h.services.tasks.pump();
  for (let i = 0; i < 100 && !['completed', 'failed', 'cancelled'].includes(h.services.tasks.get(t.id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
  return { needed, step: h.services.tasks.get(t.id)!.steps[0]!, tier: step.preview.autoTier } as const;
}

const look = () => run('screen.look', { question: 'Where is the text area?' });

describe('Full control', () => {
  it('is off by default: the computer tools are not offered and any app still needs allowing', () => {
    setup(false);
    expect(h.services.settings.get().permissions.fullControl).toBe(false);
    const a = h.services.registry.admit({ capabilityId: 'computer.click', input: { x: 1, y: 1, what: 'xx' }, origin: 'model', correlationId: 'c' });
    expect(a.ok).toBe(false);
    expect(isAllowedProcess('notepad', h.services.settings.get())).toBe(false);
  });

  it('allows every app except password managers and Windows security prompts', () => {
    setup();
    const s = h.services.settings.get();
    for (const p of ['notepad', 'chrome', 'spotify', 'EXCEL.EXE']) expect(isAllowedProcess(p, s)).toBe(true);
    for (const p of ['1Password', 'KeePassXC', 'Bitwarden', 'consent', 'CredentialUIBroker', 'LogonUI']) expect(isAllowedProcess(p, s)).toBe(false);
  });

  it('looks, then clicks on any app without asking; the banner shows and Keo steps aside', async () => {
    const { events } = setup();
    const l = await look();
    if ('rejected' in l) throw new Error(l.rejected);
    expect(events.slice(0, 3)).toEqual(['banner', 'keo_aside', 'esc_on']);
    const r = await run('computer.click', { x: 300, y: 300, what: 'the text area' });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.needed).toBe(false); // ordinary steps run on their own
    expect(r.step.state).toBe('succeeded');
    expect(r.step.result).toMatchObject({ clicked: true, app: 'notepad' });
    expect(h.desktop.calls.some((c) => c.op === 'click_at' && c.args[0] === '1001' && c.args[1] === 300 && c.args[2] === 300)).toBe(true);
    // Like a person: the taskbar or Start menu cannot be brought to the front first, and need not be.
    h.desktop.focusAllowed = false;
    const shell = await run('computer.click', { x: 300, y: 300, what: 'the taskbar search box' });
    if ('rejected' in shell) throw new Error(shell.rejected);
    expect(shell.step.state).toBe('succeeded');
  });

  it('needs a fresh look before clicking', async () => {
    setup();
    const r = await run('computer.click', { x: 300, y: 300, what: 'the text area' });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.step.state).toBe('failed');
    expect(JSON.stringify(r.step.error)).toMatch(/Look at the screen first/);
    expect(h.desktop.calls.some((c) => c.op === 'click_at')).toBe(false);
  });

  it('refuses an undeclared click on a Send/Buy/Delete button, and asks the user when it is declared', async () => {
    setup();
    await look();
    h.desktop.pointElement = { type: 'Button', name: 'Send' };
    const sneaky = await run('computer.click', { x: 300, y: 300, what: 'the arrow' });
    if ('rejected' in sneaky) throw new Error(sneaky.rejected);
    expect(sneaky.step.state).toBe('failed');
    expect(JSON.stringify(sneaky.step.error)).toMatch(/sends, pays, deletes/);
    expect(h.desktop.calls.some((c) => c.op === 'click_at')).toBe(false);
    const honest = await run('computer.click', { x: 300, y: 300, what: 'the Send button', effect: 'sends' });
    if ('rejected' in honest) throw new Error(honest.rejected);
    expect(honest.needed).toBe(true); // the user approves sending
    expect(honest.tier).toBe('critical');
  });

  it('never clicks or types in Keo itself or a password manager, and never types into a password box', async () => {
    setup();
    await look();
    h.desktop.windows.unshift({ hwnd: '3001', pid: process.pid, processName: 'keo', title: 'Keo', className: 'Chrome_WidgetWin_1', minimized: false, x: 0, y: 0, width: 200, height: 200, foreground: false });
    const self = await run('computer.click', { x: 50, y: 50, what: 'Approve' });
    if ('rejected' in self) throw new Error(self.rejected);
    expect(self.step.state).toBe('failed');
    expect(JSON.stringify(self.step.error)).toMatch(/Keo’s own window/);
    h.desktop.windows.shift();
    h.desktop.windows.unshift({ hwnd: '3002', pid: 777, processName: 'Bitwarden', title: 'Vault', className: 'x', minimized: false, x: 0, y: 0, width: 200, height: 200, foreground: false });
    const vault = await run('computer.click', { x: 50, y: 50, what: 'Copy password' });
    if ('rejected' in vault) throw new Error(vault.rejected);
    expect(JSON.stringify(vault.step.error)).toMatch(/password manager/);
    h.desktop.windows.shift();
    h.desktop.foreground = '1001';
    h.desktop.focused = { type: 'Edit', name: 'Password', password: true };
    const pw = await run('computer.type', { text: 'hunter2' });
    if ('rejected' in pw) throw new Error(pw.rejected);
    expect(JSON.stringify(pw.step.error)).toMatch(/password box/);
    expect(h.desktop.calls.some((c) => c.op === 'type' || c.op === 'click_at')).toBe(false);
  });

  it('types into the app in front and refuses card numbers before anything runs', async () => {
    setup();
    h.desktop.foreground = '1001';
    const r = await run('computer.type', { text: 'Hello from Keo' });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.needed).toBe(false);
    expect(r.step.state).toBe('succeeded');
    // All at once (pasted), then read back from the app so Keo never types it twice.
    expect(h.desktop.documentText).toBe('Hello from Keo');
    expect(r.step.result).toMatchObject({ confirmed: true });
    expect(h.desktop.calls.some((c) => c.op === 'type')).toBe(false);
    expect(await h.clipboard.readText()).toBe('user clipboard before'); // the user's clipboard comes back
    const one = await run('computer.type', { text: '!', method: 'keys' });
    if ('rejected' in one) throw new Error(one.rejected);
    expect(h.desktop.documentText).toBe('Hello from Keo!');
    const card = await run('computer.type', { text: 'my card 4111 1111 1111 1111' });
    expect('rejected' in card ? card.rejected : '').toMatch(/card number/);
  });

  it('replaces what is already there cleanly, and the clipboard comes back only after the paste landed', async () => {
    setup();
    h.desktop.foreground = '1001';
    h.desktop.documentText = 'are you doing today?';
    // A slow app: Ctrl+A selects everything; the paste shows up a moment later, from whatever the clipboard holds then.
    const origKeys = h.desktop.keys.bind(h.desktop);
    let selected = false;
    h.desktop.keys = async (hwnd, mods, key) => {
      await origKeys(hwnd, mods, key);
      if (mods.includes(0x11) && key === 0x41) selected = true;
    };
    h.desktop.paste = async (hwnd) => {
      h.desktop.calls.push({ op: 'paste', args: [hwnd] });
      setTimeout(() => {
        void h.clipboard.readText().then((t) => {
          h.desktop.documentText = selected ? t : `${h.desktop.documentText}${t}`;
        });
      }, 100);
    };
    const r = await run('computer.type', { text: 'how are you doing today?', replace: true });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.step.state).toBe('succeeded');
    expect(h.desktop.documentText).toBe('how are you doing today?');
    expect(r.step.result).toMatchObject({ confirmed: true, replaced: true, nowInApp: 'how are you doing today?' });
    expect(await h.clipboard.readText()).toBe('user clipboard before');
  });

  it('fills an email in one step: each text in its own box, read back, nothing sent', async () => {
    setup();
    const v: Record<string, string> = { search: '', to: '', subject: 'Old subject', body: '' };
    const node = (key: string, role: string, name: string, y: number, extra: Partial<UiaNodeRaw> = {}): UiaNodeRaw => ({ rid: `rid.${key}`, role, name, x: 20, y, w: 600, h: 30, depth: 1, parent: 0, patterns: ['value'], value: v[key], ...extra });
    const mail: FakeUiaApp = {
      window: { w: 1200, h: 800, x: 0, y: 0 },
      extraWindows: [],
      nodes: () => [
        { rid: 'rid.root', role: 'window', name: 'New Message - Gmail - Google Chrome', x: 0, y: 0, w: 1200, h: 800, depth: 0, parent: -1 },
        node('search', 'edit', 'Search mail', 20),
        node('to', 'combobox', 'To recipients', 100),
        node('subject', 'edit', 'Subject', 140),
        node('body', 'document', 'Message Body', 180, { h: 400 }),
        { rid: 'rid.send', role: 'button', name: 'Send', x: 20, y: 600, w: 80, h: 30, depth: 1, parent: 0, patterns: ['invoke'] },
      ],
      act: (rid, action, text) => {
        if (action === 'set_value') v[rid.replace('rid.', '')] = text ?? '';
        return action;
      },
    };
    h.desktop.addApp({ hwnd: '7001', pid: 7070, processName: 'chrome', title: 'New Message - Gmail - Google Chrome', className: 'Chrome_WidgetWin_1', minimized: false, x: 0, y: 0, width: 1200, height: 800, foreground: false }, mail);
    h.desktop.foreground = '7001';
    const r = await run('computer.fill_form', { fields: [{ field: 'To', text: 'ann@example.com' }, { field: 'Subject', text: 'Monday' }, { field: 'Message', text: 'Hi Ann,\n\nSee you Monday.' }] });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.needed).toBe(false);
    expect(r.step.state).toBe('succeeded');
    expect(v).toEqual({ search: '', to: 'ann@example.com', subject: 'Monday', body: 'Hi Ann,\n\nSee you Monday.' });
    expect((r.step.result as { filled: Array<{ confirmed: boolean }> }).filled.every((f) => f.confirmed)).toBe(true);
    expect(h.desktop.calls.some((c) => c.op === 'uia_act' && c.args[1] === 'rid.send')).toBe(false); // never sends
    // A box that is not there: nothing is filled, and the real box names come back.
    const bad = await run('computer.fill_form', { fields: [{ field: 'Subject', text: 'x' }, { field: 'Phone number', text: '123' }] });
    if ('rejected' in bad) throw new Error(bad.rejected);
    expect(bad.step.state).toBe('failed');
    expect(JSON.stringify(bad.step.error)).toMatch(/To recipients/);
    expect(v.subject).toBe('Monday');
  });

  it('computer__do: several steps in one call — clicks by name, types, presses keys — then shows the window', async () => {
    setup();
    const clicked: string[] = [];
    const v: Record<string, string> = { search: '' };
    const n = (key: string, role: string, name: string, y: number, extra: Partial<UiaNodeRaw> = {}): UiaNodeRaw => ({ rid: `rid.${key}`, role, name, x: 20, y, w: 300, h: 30, depth: 1, parent: 0, patterns: ['invoke'], ...extra });
    let page: 'home' | 'results' = 'home';
    const app: FakeUiaApp = {
      window: { w: 1000, h: 800, x: 0, y: 0 },
      extraWindows: [],
      nodes: () => [
        { rid: 'rid.root', role: 'window', name: 'Music', x: 0, y: 0, w: 1000, h: 800, depth: 0, parent: -1 },
        n('search', 'edit', 'Search', 20, { patterns: ['value'], value: v.search }),
        n('home', 'tabitem', 'Home', 60),
        n('delete', 'button', 'Delete playlist', 100),
        n('hidden', 'button', 'Search help', 140, { offscreen: true }),
        ...(page === 'results' ? [n('song', 'listitem', 'Blue in Green — Miles Davis', 200)] : []),
      ],
      act: (rid, action, text) => {
        if (action === 'set_value') v[rid.replace('rid.', '')] = text ?? '';
        return action;
      },
    };
    h.desktop.addApp({ hwnd: '7101', pid: 7171, processName: 'music', title: 'Music', className: 'x', minimized: false, x: 0, y: 0, width: 1000, height: 800, foreground: true }, app);
    h.desktop.foreground = '7101';
    const original = h.desktop.clickAt.bind(h.desktop);
    h.desktop.clickAt = (hwnd, x, y, button, double) => {
      clicked.push(`${x},${y}`);
      return original(hwnd, x, y, button, double);
    };
    const origKeys = h.desktop.keys.bind(h.desktop);
    h.desktop.keys = async (hwnd, mods, key) => {
      if (key === 0x0d) page = 'results';
      return origKeys(hwnd, mods, key);
    };
    const r = await run('computer.do', { steps: [{ do: 'click', name: 'Search' }, { do: 'keys', combo: 'enter' }, { do: 'wait_for', name: 'Blue in Green' }, { do: 'click', name: 'Blue in Green', role: 'listitem' }] });
    if ('rejected' in r) throw new Error(r.rejected);
    expect(r.needed).toBe(false);
    expect(r.step.state).toBe('succeeded');
    const out = r.step.result as { done: number; stopped: string | null; steps: string[]; after: { elements: string[] } };
    expect(out.done).toBe(4);
    expect(out.stopped).toBeNull();
    expect(out.steps[0]).toMatch(/edit “Search”/); // the box, not the hidden “Search help” button
    expect(clicked).toHaveLength(2);
    expect(out.after.elements).toContain('listitem “Blue in Green — Miles Davis”');
    expect(out.after.elements.join(' ')).not.toContain('Search help'); // only what a person can see
  });

  it('computer__do: a step that sends or deletes must say so (then the user approves); a failed step stops the run', async () => {
    setup();
    const n = (key: string, role: string, name: string, y: number): UiaNodeRaw => ({ rid: `rid.${key}`, role, name, x: 20, y, w: 300, h: 30, depth: 1, parent: 0, patterns: ['invoke'] });
    const app: FakeUiaApp = { window: { w: 1000, h: 800, x: 0, y: 0 }, extraWindows: [], nodes: () => [{ rid: 'rid.root', role: 'window', name: 'Music', x: 0, y: 0, w: 1000, h: 800, depth: 0, parent: -1 }, n('home', 'tabitem', 'Home', 60), n('delete', 'button', 'Delete playlist', 100)], act: (_r, a) => a };
    h.desktop.addApp({ hwnd: '7101', pid: 7171, processName: 'music', title: 'Music', className: 'x', minimized: false, x: 0, y: 0, width: 1000, height: 800, foreground: true }, app);
    h.desktop.foreground = '7101';
    const before = h.desktop.calls.filter((c) => c.op === 'click_at').length;
    const sneaky = await run('computer.do', { steps: [{ do: 'click', name: 'Delete playlist' }] });
    if ('rejected' in sneaky) throw new Error(sneaky.rejected);
    expect(sneaky.step.state).toBe('failed');
    expect(JSON.stringify(sneaky.step.error)).toMatch(/sends, pays, deletes/);
    expect(h.desktop.calls.filter((c) => c.op === 'click_at').length).toBe(before);
    const declared = await run('computer.do', { steps: [{ do: 'click', name: 'Delete playlist', effect: 'deletes' }] });
    if ('rejected' in declared) throw new Error(declared.rejected);
    expect(declared.needed).toBe(true);
    expect(declared.tier).toBe('critical');
    // Step 2 is not there: step 1 ran, the run stops and says why, and the window is shown.
    const partial = await run('computer.do', { steps: [{ do: 'click', name: 'Home' }, { do: 'click', name: 'Settings' }, { do: 'keys', combo: 'ctrl+s' }] });
    if ('rejected' in partial) throw new Error(partial.rejected);
    const out = partial.step.result as { done: number; stopped: string; after: { elements: string[] } };
    expect(out.done).toBe(1);
    expect(out.stopped).toMatch(/Step 2 .*No “Settings”/);
    expect(out.after.elements).toContain('tabitem “Home”');
  });

  it('finds the element a person means by its name', () => {
    const n = (name: string, role: string, extra: Partial<UiaNodeRaw> = {}): UiaNodeRaw => ({ rid: name, role, name, x: 0, y: 0, w: 10, h: 10, depth: 1, parent: 0, ...extra });
    const nodes = [n('Save as', 'menuitem'), n('Save', 'button'), n('Autosave settings', 'button'), n('Search', 'button', { offscreen: true }), n('Search', 'edit')];
    expect(bestElement(nodes, 'save')?.rid).toBe('Save');
    expect(bestElement(nodes, 'Search')?.role).toBe('edit');
    expect(bestElement(nodes, 'search', 'button')?.role).toBe('button');
    expect(bestElement(nodes, 'Print')).toBeNull();
  });

  it('Enter in a chat app must be declared as sending; shortcuts with the Win key work', async () => {
    setup();
    h.desktop.windows.push({ hwnd: '2001', pid: 888, processName: 'WhatsApp.Root', title: 'WhatsApp', className: 'x', minimized: false, x: 0, y: 0, width: 10, height: 10, foreground: false });
    h.desktop.foreground = '2001';
    const enter = await run('computer.keys', { combo: 'enter' });
    if ('rejected' in enter) throw new Error(enter.rejected);
    expect(enter.step.state).toBe('failed');
    expect(JSON.stringify(enter.step.error)).toMatch(/may send a message/);
    h.desktop.foreground = '1001';
    const win = await run('computer.keys', { combo: 'win+r' });
    if ('rejected' in win) throw new Error(win.rejected);
    expect(win.needed).toBe(false);
    expect(h.desktop.calls.some((c) => c.op === 'keys' && (c.args[1] as number[]).includes(0x5b) && c.args[2] === 0x52)).toBe(true);
    expect(parseComputerCombo('ctrl+shift+t')).toMatchObject({ mods: [0x11, 0x10], key: 0x54 });
    expect(parseComputerCombo('ctrl+nope')).toBeNull();
    expect(looksLikeCardNumber('order 12345 on 2026-11-08')).toBe(false);
  });

  it('hands the computer back when the user touches the mouse, and on Stop', async () => {
    const { events } = setup();
    await look();
    h.desktop.foreground = '1001';
    const first = await run('computer.keys', { combo: 'ctrl+a' });
    if ('rejected' in first) throw new Error(first.rejected);
    expect(first.step.state).toBe('succeeded');
    await new Promise((r) => setTimeout(r, 700));
    h.desktop.idleMs = 50; // the user just moved the mouse
    const second = await run('computer.keys', { combo: 'ctrl+c' });
    if ('rejected' in second) throw new Error(second.rejected);
    expect(second.step.state).toBe('failed');
    expect(JSON.stringify(second.step.error)).toMatch(/handed the computer back/);
    expect(events).toContain('banner_off');
    expect(events).toContain('keo_back');
    expect(h.services.control.isActive()).toBe(false);
    await new Promise((r) => setTimeout(r, 120)); // the rest of Keo stops too
  });

  it('turning it off ends control at once; the banner window can only press Stop', () => {
    const s = new ControlSession({ ui: () => null, idleMs: async () => 0, stopAll: () => undefined, log: { info: () => undefined }, settleMs: 0 });
    void s.enter();
    expect(s.isActive()).toBe(true);
    s.end('turned_off');
    expect(s.isActive()).toBe(false);
    expect(channelAllowed('control', 'presence:stopAll')).toBe(true);
    for (const c of ['chat:send', 'settings:update', 'tasks:approveStep'] as const) expect(channelAllowed('control', c as never)).toBe(false);
  });

  it('working on the computer brings the screen tools along', () => {
    const g = chooseGroups({ texts: ['open spotify and play my liked songs'], pictures: false, documents: false, pencil: false, recent: [] });
    expect(g.has('desktop')).toBe(true);
    expect(g.has('screen')).toBe(true);
  });
});
