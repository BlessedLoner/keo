import { afterEach, describe, expect, it } from 'vitest';
import { AppDiscovery, validAppId, type StartApp } from '../src/main/desktop/appDiscovery';
import { installedBrowsers, matchProfiles, profilesFromLocalState, safeWebUrl } from '../src/main/desktop/browserProfiles';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
let seq = 0;
const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `a${++seq}`, name, input }], stopReason: 'tool_use', usage: null, model: 'keo-test-1', native: undefined });

/** Shaped like Get-StartApps on a real PC (names and app ids). */
const START_APPS: StartApp[] = [
  { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
  { name: 'WhatsApp Web', appId: 'Chrome._crx_hnpfjngllnfapefoaidbinmjnm' },
  { name: 'Uninstall Foo', appId: '{7C5A40EF}\\Foo\\uninstall.exe' },
  { name: 'Documentation', appId: '{7C5A40EF}\\Kits\\Docs.url' },
  { name: 'Evil', appId: 'x" & calc.exe & "' },
];

describe('Windows app discovery', () => {
  it('lists Start-menu and Microsoft Store apps, skipping uninstallers, links and unsafe ids', async () => {
    const d = new AppDiscovery(async () => START_APPS);
    const apps = await d.list();
    expect(apps.map((a) => a.name)).toEqual(['Calculator', 'Google Chrome', 'Notepad', 'Visual Studio Code', 'WhatsApp', 'WhatsApp Web']);
    expect(apps.find((a) => a.name === 'Calculator')?.kind).toBe('store');
    expect(apps.find((a) => a.name === 'Google Chrome')?.kind).toBe('desktop');
    expect(validAppId('x" & calc.exe & "')).toBe(false);
    expect(validAppId('..\\..\\Windows\\System32\\cmd.exe')).toBe(false);
  });

  it('matches by name: exact first, then words', async () => {
    const d = new AppDiscovery(async () => START_APPS);
    expect((await d.find('calculator'))[0]).toMatchObject({ exact: true, app: { name: 'Calculator' } });
    expect((await d.find('code')).map((m) => m.app.name)).toContain('Visual Studio Code');
    expect((await d.find('whatsapp')).map((m) => m.app.name)).toEqual(['WhatsApp', 'WhatsApp Web']);
  });
});

function appsHarness(opts: { launched?: string[]; windowsAfterLaunch?: () => void } = {}) {
  h = makeHarness({
    script: () => reply('ok'),
    deps: {
      startApps: async () => START_APPS,
      launchApp: async (id) => {
        opts.launched?.push(id);
        opts.windowsAfterLaunch?.();
      },
      appLaunchWaitMs: 300,
    },
  });
  h.services.settings.update({ permissions: { launchEnabled: true }, agent: { approvalWaitSeconds: 10 } });
}

async function run(capabilityId: string, input: unknown) {
  const a = h.services.registry.admit({ capabilityId, input, origin: 'model', correlationId: 'c' });
  if (!a.ok) return { rejected: a.reason };
  const t = h.services.tasks.create({ title: capabilityId, rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
  h.services.tasks.submit(t.id);
  const step = h.services.tasks.get(t.id)!.steps[0]!;
  if (step.state === 'awaiting_authorization') h.services.tasks.approveStep(step.id, step.inputHash);
  await waitFor(() => ['succeeded', 'failed', 'outcome_uncertain'].includes(h.services.tasks.get(t.id)!.steps[0]!.state), 5000);
  return { step: h.services.tasks.get(t.id)!.steps[0]! };
}

describe('opening apps', () => {
  it('needs the launch permission', async () => {
    h = makeHarness({ script: () => reply('ok'), deps: { startApps: async () => START_APPS } });
    const r = await run('apps.open', { query: 'calculator' });
    expect(r.rejected).toMatch(/launch/i);
  });

  it('always asks before opening, then launches a Microsoft Store app by its app id and finds its window', async () => {
    const launched: string[] = [];
    appsHarness({
      launched,
      windowsAfterLaunch: () => h.desktop.windows.push({ hwnd: '3001', pid: 777, processName: 'CalculatorApp', title: 'Calculator', className: 'ApplicationFrameWindow', minimized: false, x: 0, y: 0, width: 400, height: 600, foreground: true }),
    });
    const a = h.services.registry.admit({ capabilityId: 'apps.open', input: { query: 'calculator' }, origin: 'model', correlationId: 'c' });
    expect(a.ok && a.requiresApproval).toBe(true);
    const r = await run('apps.open', { query: 'calculator' });
    expect(launched).toEqual(['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']);
    expect(r.step?.state).toBe('succeeded');
    expect((r.step?.result as { action: string }).action).toBe('launched');
  });

  it('never guesses between several matching apps: fails with the candidates for the user to choose', async () => {
    const launched: string[] = [];
    appsHarness({ launched });
    const r = await run('apps.open', { query: 'whats' });
    expect(r.step?.state).toBe('failed');
    expect(r.step?.errorCode).toBe('ambiguous_app');
    expect(r.step?.error).toMatch(/WhatsApp.*WhatsApp Web/);
    expect(launched).toEqual([]);
  });

  it('an exact name wins; the chosen app id opens exactly that app', async () => {
    const launched: string[] = [];
    appsHarness({ launched });
    await run('apps.open', { query: 'WhatsApp' });
    await run('apps.open', { appId: 'Chrome._crx_hnpfjngllnfapefoaidbinmjnm' });
    expect(launched).toEqual(['5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', 'Chrome._crx_hnpfjngllnfapefoaidbinmjnm']);
  });

  it('switches to an already open window instead of starting another copy', async () => {
    const launched: string[] = [];
    appsHarness({ launched });
    const r = await run('apps.open', { query: 'notepad' }); // the fake desktop has notes.txt - Notepad open
    expect(launched).toEqual([]);
    expect((r.step?.result as { action: string }).action).toBe('switched');
  });

  it('refuses an app id that is not installed (no arbitrary launch)', async () => {
    const launched: string[] = [];
    appsHarness({ launched });
    const r = await run('apps.open', { appId: 'C:\\Windows\\System32\\cmd.exe' });
    expect(r.step?.state).toBe('failed');
    expect(launched).toEqual([]);
  });
});

const LOCAL_STATE = JSON.stringify({
  os_crypt: { encrypted_key: 'SECRET-KEY-MUST-NOT-LEAK' },
  profile: {
    info_cache: {
      Default: { name: 'Person 1', user_name: 'someone@example.com', gaia_name: 'Some One' },
      'Profile 1': { name: 'Blessed2', user_name: 'a@example.com' },
      'Profile 2': { name: 'Blessed2' },
      'Profile 3': { name: 'Work' },
      'Guest Profile': { name: 'Guest' },
      '../../evil': { name: 'Evil' },
    },
  },
});

describe('browser profiles', () => {
  it('reads only profile folders and display names — no e-mails, keys or odd folders', () => {
    const p = profilesFromLocalState(LOCAL_STATE);
    expect(p).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Blessed2' },
      { dir: 'Profile 2', name: 'Blessed2' },
      { dir: 'Profile 3', name: 'Work' },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/example\.com|SECRET|Some One|Guest|evil/);
  });

  it('matching: by name, by folder; a shared name gives several results (ask)', () => {
    const p = profilesFromLocalState(LOCAL_STATE);
    expect(matchProfiles(p, 'work').map((x) => x.dir)).toEqual(['Profile 3']);
    expect(matchProfiles(p, 'Profile 2').map((x) => x.dir)).toEqual(['Profile 2']);
    expect(matchProfiles(p, 'blessed2')).toHaveLength(2);
  });

  it('finds installed browsers from their usual install folders', () => {
    const files = new Map([
      ['C:\\PF\\Google\\Chrome\\Application\\chrome.exe', ''],
      ['C:\\Local\\Google\\Chrome\\User Data\\Local State', LOCAL_STATE],
    ]);
    const b = installedBrowsers({ ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' }, { exists: (p) => files.has(p), read: (p) => files.get(p) ?? null });
    expect(b.map((x) => x.id)).toEqual(['chrome']);
    expect(b[0]!.profiles).toHaveLength(4);
  });

  it('opens only web addresses', () => {
    expect(safeWebUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const u of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://settings', '--disable-web-security', 'https://user:pw@example.com']) expect(safeWebUrl(u)).toBeNull();
  });
});

function browserHarness(opened: Array<{ dir: string; url: string }>, profiles = profilesFromLocalState(LOCAL_STATE)) {
  h = makeHarness({
    script: () => reply('ok'),
    deps: {
      browsers: () => [{ id: 'chrome', label: 'Google Chrome', exe: 'C:\\PF\\chrome.exe', profiles }],
      openTab: async (_exe, dir, url) => void opened.push({ dir, url }),
    },
  });
  h.services.settings.update({ permissions: { launchEnabled: true }, agent: { approvalWaitSeconds: 10 } });
}

describe('research in a new browser tab', () => {
  it('asks which profile when there are several, and opens nothing', async () => {
    const opened: Array<{ dir: string; url: string }> = [];
    browserHarness(opened);
    const r = await run('browser.open_tab', { browser: 'chrome', search: 'best microphone for streaming' });
    expect(r.step?.errorCode).toBe('ambiguous_profile');
    expect(r.step?.error).toMatch(/“Person 1”.*“Blessed2 \(Profile 1\)”.*“Blessed2 \(Profile 2\)”.*“Work”/);
    expect(opened).toEqual([]);
  });

  it('a shared profile name is ambiguous too; the folder resolves it', async () => {
    const opened: Array<{ dir: string; url: string }> = [];
    browserHarness(opened);
    expect((await run('browser.open_tab', { browser: 'chrome', profile: 'Blessed2', search: 'x' })).step?.errorCode).toBe('ambiguous_profile');
    await run('browser.open_tab', { browser: 'chrome', profile: 'Profile 2', search: 'best microphone' });
    expect(opened).toEqual([{ dir: 'Profile 2', url: 'https://www.google.com/search?q=best%20microphone' }]);
  });

  it('a single profile needs no question; only http(s) addresses are accepted', async () => {
    const opened: Array<{ dir: string; url: string }> = [];
    browserHarness(opened, [{ dir: 'Default', name: 'Me' }]);
    await run('browser.open_tab', { browser: 'chrome', url: 'https://example.com/review' });
    expect(opened).toEqual([{ dir: 'Default', url: 'https://example.com/review' }]);
    const bad = await run('browser.open_tab', { browser: 'chrome', url: 'file:///C:/secret.txt' });
    expect(bad.rejected).toMatch(/http/);
  });
});

describe('clarification continuity', () => {
  it('keeps the original request open after “which profile?”, scoped to its conversation, and clears it once done', async () => {
    const opened: Array<{ dir: string; url: string }> = [];
    let systemOnAnswer = '';
    h = makeHarness({
      script: (req: ChatRequest) => {
        const last = req.messages.at(-1);
        const text = JSON.stringify(last?.content ?? '');
        if (last?.role === 'user' && text.includes('research the best microphone')) return call('browser__open_tab', { browser: 'chrome', search: 'best microphone' });
        if (last?.role === 'user' && text.includes('Work') && !text.includes('tool_result')) {
          systemOnAnswer = req.system;
          return call('browser__open_tab', { browser: 'chrome', profile: 'Work', search: 'best microphone' });
        }
        return reply(text.includes('ambiguous_profile') ? 'Which Chrome profile: Person 1, Blessed2 (Profile 1), Blessed2 (Profile 2) or Work?' : 'Opened.');
      },
      deps: { browsers: () => [{ id: 'chrome', label: 'Google Chrome', exe: 'C:\\PF\\chrome.exe', profiles: profilesFromLocalState(LOCAL_STATE) }], openTab: async (_e, dir, url) => void opened.push({ dir, url }) },
    });
    h.services.settings.update({ permissions: { launchEnabled: true }, autonomy: { level: 'hands_free' }, agent: { approvalWaitSeconds: 10 } });
    const conv = h.services.conversations.create('a');
    const other = h.services.conversations.create('b');
    // Hands-free approves opening a tab, so the flow runs without approval clicks here.
    await h.services.agent.send(conv.id, 'Open Chrome and research the best microphone').done;
    expect(h.services.agent.pendingQuestion(conv.id)?.capabilityId).toBe('browser.open_tab');
    expect(h.services.agent.pendingQuestion(other.id)).toBeNull();
    await h.services.agent.send(conv.id, 'Work').done;
    expect(systemOnAnswer).toMatch(/Open question in this conversation[\s\S]*browser__open_tab[\s\S]*best microphone/);
    expect(systemOnAnswer).toMatch(/not an approval/);
    expect(opened).toEqual([{ dir: 'Profile 3', url: 'https://www.google.com/search?q=best%20microphone' }]);
    expect(h.services.agent.pendingQuestion(conv.id)).toBeNull();
  });
});

describe('open questions survive a restart', () => {
  it('keeps the question after restarting with the same profile, within its expiry', async () => {
    const { tempDir } = await import('./helpers');
    const dir = tempDir();
    const deps = { browsers: () => [{ id: 'chrome' as const, label: 'Google Chrome', exe: 'C:/PF/chrome.exe', profiles: profilesFromLocalState(LOCAL_STATE) }] };
    h = makeHarness({ dir, deps, script: (req: ChatRequest) => (JSON.stringify(req.messages.at(-1)?.content ?? '').includes('research') && req.tools.length ? call('browser__open_tab', { browser: 'chrome', search: 'mics' }) : reply('Which profile?')) });
    h.services.settings.update({ permissions: { launchEnabled: true }, autonomy: { level: 'hands_free' } });
    const conv = h.services.conversations.create('a');
    await h.services.agent.send(conv.id, 'research mics in Chrome').done;
    expect(h.services.agent.pendingQuestion(conv.id)?.capabilityId).toBe('browser.open_tab');
    await h.close();
    h = makeHarness({ dir, deps, script: () => reply('ok') });
    expect(h.services.agent.pendingQuestion(conv.id)?.question).toMatch(/several profiles/);
  });
});

describe('choice buttons', () => {
  it('offers the profile names as buttons when Keo must ask', async () => {
    h = makeHarness({
      script: (req: ChatRequest) => (JSON.stringify(req.messages.at(-1)?.content ?? '').includes('research') && req.tools.length ? call('browser__open_tab', { browser: 'chrome', search: 'mics' }) : reply('Which profile?')),
      deps: { browsers: () => [{ id: 'chrome', label: 'Google Chrome', exe: 'C:/PF/chrome.exe', profiles: profilesFromLocalState(LOCAL_STATE) }] },
    });
    h.services.settings.update({ permissions: { launchEnabled: true }, autonomy: { level: 'hands_free' } });
    const conv = h.services.conversations.create('a');
    const m = await h.services.agent.send(conv.id, 'research mics in Chrome').done;
    const t = m.meta.tools?.find((x) => x.capabilityId === 'browser.open_tab');
    expect(t?.choices).toEqual(['Person 1', 'Blessed2 (Profile 1)', 'Blessed2 (Profile 2)', 'Work']);
    expect(matchProfiles(profilesFromLocalState(LOCAL_STATE), 'Blessed2 (Profile 2)').map((p) => p.dir)).toEqual(['Profile 2']);
  });
});

describe('installed apps picker', () => {
  it('lists installed apps with process names and icons; Store apps become launchable by app id', async () => {
    const d = new AppDiscovery(async () => START_APPS);
    const rows = [
      { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', exe: 'C:/Program Files/WindowsApps/5319275A.WhatsAppDesktop/WhatsApp.Root.exe', icon: 'iVBORw0KGgo=' },
      { name: 'Google Chrome', appId: 'Chrome', exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe', icon: null },
    ];
    const apps = await d.installed(async () => rows);
    expect(apps.find((a) => a.name === 'WhatsApp')).toMatchObject({ kind: 'store', processName: 'WhatsApp.Root', exePath: null, icon: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(apps.find((a) => a.name === 'Google Chrome')).toMatchObject({ kind: 'desktop', processName: 'chrome', exePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    expect(apps.find((a) => a.name === 'Notepad')).toMatchObject({ processName: null, icon: null });
  });

  it('a Store app in the launch list starts by its app id (through Windows, no path)', async () => {
    const launched: string[] = [];
    h = makeHarness({ script: () => reply('ok'), deps: { launchApp: async (id) => void launched.push(id) } });
    h.services.settings.update({ permissions: { launchEnabled: true, launchableApps: [{ id: 'whatsapp', label: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' }] }, agent: { approvalWaitSeconds: 10 } });
    const r = await run('desktop.launch_app', { appId: 'whatsapp' });
    expect(r.step?.state).toBe('succeeded');
    expect(launched).toEqual(['5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App']);
    const { SettingsSchema } = await import('../src/shared/settings');
    expect(() => SettingsSchema.parse({ permissions: { launchableApps: [{ id: 'x', label: 'X' }] } })).toThrow();
  });
});
