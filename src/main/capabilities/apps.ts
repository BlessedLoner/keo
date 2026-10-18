import { z } from 'zod';
import type { AppDiscovery, DiscoveredApp } from '../desktop/appDiscovery';
import { normApp } from '../desktop/appDiscovery';
import { matchProfiles, profileLabel, safeWebUrl, searchUrl, type InstalledBrowser } from '../desktop/browserProfiles';
import type { CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

const AppOut = z.object({ name: z.string(), appId: z.string(), kind: z.enum(['store', 'desktop']), publisher: z.string().nullable(), openWindow: z.boolean() });

export interface AppsDeps extends CapabilityDeps {
  apps: AppDiscovery;
  /** Starts an app by its Windows app id (tests inject a fake). */
  launchApp: (appId: string) => Promise<void>;
  /** Wait for a launched app's window (tests shorten it). */
  launchWaitMs?: number;
  /** Installed Chromium browsers with their profile names (no other profile data). */
  browsers: () => InstalledBrowser[];
  openTab: (exe: string, profileDir: string, url: string) => Promise<void>;
}

const kindLabel = (a: DiscoveredApp) => `${a.kind === 'store' ? 'Microsoft Store app' : 'desktop app'}${a.publisher ? ` by ${a.publisher}` : ''}`;

/**
 * Finding and opening Windows apps by name (Start menu and Microsoft Store
 * apps, discovered from Windows). Finding only lists candidates; opening
 * always needs the user's OK; several matches are never guessed between —
 * the user is asked. Acting inside an app still needs it in the allowed list.
 */
export function appCapabilities(d: AppsDeps): AnyCapability[] {
  const openWindows = async (app: DiscoveredApp, settings: Parameters<CapabilityDeps['desktop']['listWindows']>[0]) => {
    const n = normApp(app.name).split(' ')[0] ?? '';
    const all = await d.desktop.listWindows(settings, true).catch(() => []);
    return all.filter((w) => n.length >= 3 && (normApp(w.title).includes(normApp(app.name)) || normApp(w.processName).startsWith(n)));
  };

  const find = defineCapability({
    id: 'apps.find',
    version: '1.0.0',
    title: 'Find installed apps',
    description:
      'Search the Windows apps installed on this computer (Start menu and Microsoft Store apps) by name, e.g. "whatsapp", "calculator", "code". Returns names, kinds and app ids, and whether a window of it is already open. Use before apps__open when unsure which app the user means; if several match, ask the user which one.',
    input: z.object({ query: z.string().trim().min(1).max(80) }).strict(),
    output: z.object({ matches: z.array(AppOut), total: z.number() }),
    risk: 'low',
    approval: 'never',
    permissions: ['desktop.launch'],
    consequential: false,
    idempotent: true,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only listing from Windows.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Look for installed apps named “${i.query}”`, target: null, consequences: [], dataExport: `App names are sent to ${d.activeProviderDestination()}.` }),
    auditView: (i) => ({ queryLength: i.query.length }),
    async execute(i, ctx) {
      const all = await d.apps.list().catch((e: Error) => {
        throw new CapabilityError('discovery_failed', `Windows did not return its list of apps (${e.message.slice(0, 80)}).`, { dispatched: 'no' });
      });
      const matches = await d.apps.find(i.query);
      const out = [];
      for (const m of matches) out.push({ name: m.app.name, appId: m.app.appId, kind: m.app.kind, publisher: m.app.publisher ?? null, openWindow: (await openWindows(m.app, ctx.settings)).length > 0 });
      return { matches: out, total: all.length };
    },
  });

  const open = defineCapability({
    id: 'apps.open',
    version: '1.0.0',
    title: 'Open an app',
    description:
      'Open (or switch to) an installed Windows app, including Microsoft Store apps, by name or by an app id from apps__find. If several apps match the name, this fails with the candidates: ask the user which one (they may say "the one already open"), then call again with its appId. Typing or clicking inside the app needs it in the allowed apps.',
    input: z
      .object({
        query: z.string().trim().min(1).max(80).optional(),
        appId: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .refine((x) => !!x.query || !!x.appId, 'Give query or appId.'),
    output: z.object({ name: z.string(), appId: z.string(), kind: z.enum(['store', 'desktop']), action: z.enum(['launched', 'switched']), window: z.object({ hwnd: z.string(), pid: z.number(), processName: z.string(), allowed: z.boolean() }).nullable() }),
    risk: 'medium',
    approval: 'always',
    permissions: ['desktop.launch'],
    consequential: true,
    idempotent: false,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The app’s window must appear (or an open one must come to the front).',
    // Voice-approvable ("yes"); hands-free may open an app the user named.
    autonomy: (i) => ({ tier: 'important', mustBeNamed: i.query }),
    preview: (i) => ({
      summary: `Open ${i.query ? `“${i.query}”` : 'the selected app'}`,
      target: i.appId ?? null,
      consequences: ['Starts the app, or brings its open window to the front.', 'Keo does not type or click in it without a separate approval.'],
      dataExport: null,
    }),
    auditView: (i) => ({ byId: !!i.appId, queryLength: i.query?.length ?? 0 }),
    async execute(i, ctx) {
      let app: DiscoveredApp | null;
      if (i.appId) {
        app = await d.apps.get(i.appId);
        if (!app) throw new CapabilityError('not_found', 'That app id is not among the apps installed on this computer. Call apps__find again.', { dispatched: 'no' });
      } else {
        const ms = await d.apps.find(i.query!);
        const exact = ms.filter((m) => m.exact);
        const pick = exact.length === 1 ? exact : exact.length > 1 ? exact : ms;
        if (!pick.length) throw new CapabilityError('not_found', `No installed app matches “${i.query}”.`, { dispatched: 'no' });
        if (pick.length > 1) {
          const list = pick.slice(0, 6).map((m) => `“${m.app.name}” (${kindLabel(m.app)}, appId ${m.app.appId})`).join('; ');
          throw new CapabilityError('ambiguous_app', `Several apps match “${i.query}”: ${list}. Ask the user which one they mean, then call apps__open with its appId.`, { dispatched: 'no' });
        }
        app = pick[0]!.app;
      }
      // Already open: bring it to the front instead of starting another copy.
      const before = await openWindows(app, ctx.settings);
      if (before.length) {
        const w = before[0]!;
        const r = await d.desktop.backend.focus(w.hwnd).catch(() => ({ foreground: false }));
        if (r.foreground) return { name: app.name, appId: app.appId, kind: app.kind, action: 'switched' as const, window: { hwnd: w.hwnd, pid: w.pid, processName: w.processName, allowed: w.allowed } };
      }
      try {
        await d.launchApp(app.appId);
      } catch (e) {
        throw new CapabilityError('launch_failed', `Windows could not start ${app.name}: ${(e as Error).message.slice(0, 120)}`, { dispatched: 'no' });
      }
      const until = Date.now() + (d.launchWaitMs ?? 15000);
      const known = new Set(before.map((w) => w.hwnd));
      while (Date.now() < until) {
        if (ctx.signal.aborted) break;
        const w = (await openWindows(app, ctx.settings)).find((x) => !known.has(x.hwnd));
        if (w) return { name: app.name, appId: app.appId, kind: app.kind, action: 'launched' as const, window: { hwnd: w.hwnd, pid: w.pid, processName: w.processName, allowed: w.allowed } };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { name: app.name, appId: app.appId, kind: app.kind, action: 'launched' as const, window: null };
    },
    async verify(_i, o) {
      if (o.window) return { verified: true, detail: `${o.name} is open (${o.window.processName}${o.window.allowed ? '' : ', not in the allowed apps yet'}).` };
      return { verified: false, detail: `${o.name} was started, but its window did not appear within the wait. It may still be loading — check desktop__list_windows.` };
    },
  });

  const Browser = z.enum(['chrome', 'edge', 'brave']);

  const profiles = defineCapability({
    id: 'browser.list_profiles',
    version: '1.0.0',
    title: 'List browser profiles',
    description: 'List the installed browsers (Chrome, Edge, Brave) and their profile names, e.g. "Personal", "Work". Use when the user names a browser but not a profile; if there are several, ask which one.',
    input: z.object({ browser: Browser.optional() }).strict(),
    output: z.object({ browsers: z.array(z.object({ id: Browser, label: z.string(), profiles: z.array(z.object({ name: z.string(), dir: z.string() })) })) }),
    risk: 'low',
    approval: 'never',
    permissions: ['desktop.launch'],
    consequential: false,
    idempotent: true,
    timeoutMs: 10000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only: profile names from the browser’s own profile list.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Look up browser profile names', target: null, consequences: [], dataExport: `Profile names are sent to ${d.activeProviderDestination()}.` }),
    auditView: (i) => ({ browser: i.browser ?? null }),
    async execute(i) {
      const list = d.browsers().filter((b) => !i.browser || b.id === i.browser);
      return { browsers: list.map((b) => ({ id: b.id, label: b.label, profiles: b.profiles.map((p) => ({ name: profileLabel(p, b.profiles), dir: p.dir })) })) };
    },
  });

  const openTab = defineCapability({
    id: 'browser.open_tab',
    version: '1.0.0',
    title: 'Open a new browser tab',
    description:
      'Open a web address or a web search in a NEW tab of the chosen browser and profile (existing tabs are left alone). If the browser has several profiles and the user did not say which, this fails with the profile names: ask the user, then call again with profile. For research, open the search here if the user wants to see it, and use web__search / web__fetch_page (or browser__read_page on the new tab) to read results.',
    input: z
      .object({
        browser: Browser.default('chrome'),
        profile: z.string().trim().min(1).max(60).optional(),
        url: z.string().trim().max(2000).optional(),
        search: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .refine((x) => !!x.url !== !!x.search, 'Give either url or search.'),
    output: z.object({ browser: z.string(), profile: z.string(), url: z.string() }),
    risk: 'medium',
    approval: 'always',
    permissions: ['desktop.launch'],
    consequential: true,
    idempotent: false,
    timeoutMs: 20000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The browser accepts the request; the new tab is not read back.',
    autonomy: () => ({ tier: 'important' }),
    precheck: (i) => (i.url && !safeWebUrl(i.url) ? 'Only http(s) web addresses can be opened.' : null),
    preview: (i) => ({
      summary: `Open ${i.search ? `a search for “${i.search}”` : i.url} in a new ${i.browser} tab${i.profile ? ` (profile “${i.profile}”)` : ''}`,
      target: i.profile ?? null,
      consequences: ['Adds a new tab; your open tabs are not changed.'],
      dataExport: null,
    }),
    auditView: (i) => ({ browser: i.browser, profile: !!i.profile, search: !!i.search }),
    async execute(i) {
      const b = d.browsers().find((x) => x.id === i.browser);
      if (!b) throw new CapabilityError('browser_not_found', `${i.browser} is not installed on this computer.`, { dispatched: 'no' });
      let dir = 'Default';
      let name = 'Default';
      if (b.profiles.length) {
        const found = i.profile ? matchProfiles(b.profiles, i.profile) : b.profiles.length === 1 ? b.profiles : [];
        const chosen = found.length === 1 ? found[0]! : null;
        if (!chosen) {
          const pool = found.length > 1 ? found : b.profiles;
          const names = pool.map((p) => `“${profileLabel(p, b.profiles)}”`).join(', ');
          const code = i.profile && !found.length ? 'profile_not_found' : 'ambiguous_profile';
          const msg =
            code === 'profile_not_found'
              ? `${b.label} has no profile called “${i.profile}”. Its profiles: ${names}. Ask the user which one.`
              : `${b.label} has ${found.length > 1 ? `more than one profile called “${i.profile}”` : 'several profiles'}: ${names}. Ask the user which one, then call again with profile set to the name (or the folder in brackets, such as Profile 1).`;
          throw new CapabilityError(code, msg, { dispatched: 'no' });
        }
        dir = chosen.dir;
        name = profileLabel(chosen, b.profiles);
      }
      const url = i.search ? searchUrl(i.search) : safeWebUrl(i.url!)!;
      try {
        await d.openTab(b.exe, dir, url);
      } catch (e) {
        throw new CapabilityError('launch_failed', `${b.label} could not be started: ${(e as Error).message.slice(0, 100)}`, { dispatched: 'no' });
      }
      return { browser: b.label, profile: name, url };
    },
  });

  return [find, open, profiles, openTab];
}
