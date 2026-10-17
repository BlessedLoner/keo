import { z } from 'zod';
import type { Settings } from '../../shared/settings';
import { Target, targetLabel, type CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

type ExportId = keyof Settings['permissions']['visionExport'];
const EXPORT_IDS: ExportId[] = ['anthropic', 'openai', 'openrouter', 'local'];

/**
 * Lets Keo ask — in chat or by voice — for access to the window the user is
 * talking about ("look at my screen"), instead of telling them to go to
 * Settings. It only ever adds that one app to the allowed list (plus
 * observation, and screenshots for the current provider when asked), it
 * always needs the user's explicit yes, and it never runs hands-free.
 */
export function accessCapabilities(d: CapabilityDeps & { updateSettings: (patch: Partial<Settings['permissions']>) => void; currentSettings: () => Settings }): AnyCapability[] {
  const allow = defineCapability({
    id: 'access.allow_app',
    version: '1.0.0',
    title: 'Allow Keo to read an app',
    description:
      'Ask the user for permission to read one app\'s window (adds it to the allowed apps and turns on window observation). Use when the user asks about a window that is NOT allowed yet ("look at my screen", "what is this error", "explain this page"). Use the target exactly as given under "Where the user is" or by desktop__list_windows. screenshots=true also lets Keo send pictures of that window to the current AI provider (only when text reading is not enough, e.g. images, charts, games). After it succeeds, read the window with desktop__inspect_window / browser__read_page (or vision__observe_window when screenshots were allowed).',
    input: z
      .object({
        target: Target,
        purpose: z.string().trim().min(1).max(300).describe('Why, in the user\'s terms, e.g. "to explain what is on your screen"'),
        screenshots: z.boolean().default(false),
      })
      .strict(),
    output: z.object({ processName: z.string(), observation: z.boolean(), screenshots: z.boolean() }),
    risk: 'medium',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: true,
    timeoutMs: 15000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Settings are read back after the change.',
    // Can be approved by voice ("yes"), but policyMatcher never runs it without asking.
    autonomy: () => ({ tier: 'important' }),
    preview: (i, s) => {
      const pid = d.activeProviderId();
      const already = s.permissions.allowedApps.some((a) => a.processName.toLowerCase() === i.target.processName.toLowerCase());
      return {
        summary: `Let Keo read ${i.target.processName}${i.screenshots ? ' and take pictures of it' : ''}`,
        target: targetLabel(i.target),
        consequences: [
          `Purpose: ${i.purpose}`,
          already ? `${i.target.processName} is already allowed.` : `Adds ${i.target.processName} to your allowed apps (remove it any time in Settings → Access).`,
          ...(s.permissions.observationEnabled ? [] : ['Turns on window observation (reading text in allowed apps).']),
          'Keo still needs your approval for every action in that app, such as clicking or typing.',
        ],
        dataExport: i.screenshots && pid && pid !== 'test' ? `Pictures of this window will be sent to ${d.activeProviderDestination()}.` : `Text read from this window is sent to ${d.activeProviderDestination()} to answer you.`,
      };
    },
    auditView: (i) => ({ processName: i.target.processName, screenshots: i.screenshots }),
    async execute(i, ctx) {
      const all = await d.desktop.listWindows(ctx.settings, true);
      const w = all.find((x) => x.hwnd === i.target.hwnd && x.pid === i.target.pid && x.processName.toLowerCase() === i.target.processName.toLowerCase());
      if (!w) throw new CapabilityError('window_gone', 'That window is no longer open. Ask the user to bring it up and try again.', { dispatched: 'no' });
      const p = ctx.settings.permissions;
      const processName = w.processName;
      if (!/^[A-Za-z0-9 ._-]{1,120}$/.test(processName)) throw new CapabilityError('unsupported_name', `Keo can't allow “${processName.slice(0, 60)}” automatically; add it in Settings → Access.`, { dispatched: 'no' });
      const allowedApps = p.allowedApps.some((a) => a.processName.toLowerCase() === processName.toLowerCase())
        ? p.allowedApps
        : [...p.allowedApps, { processName, label: labelFor(processName, w.title) }].slice(-100);
      const pid = d.activeProviderId();
      const exportId = EXPORT_IDS.find((x) => x === pid);
      d.updateSettings({
        observationEnabled: true,
        allowedApps,
        ...(i.screenshots && exportId ? { visionExport: { ...p.visionExport, [exportId]: true } } : {}),
      });
      return { processName, observation: true, screenshots: !!(i.screenshots && exportId) };
    },
    async verify(_i, o) {
      const p = d.currentSettings().permissions;
      const ok = p.observationEnabled && p.allowedApps.some((a) => a.processName.toLowerCase() === o.processName.toLowerCase());
      return ok ? { verified: true, detail: `${o.processName} is allowed; Keo can read it now.` } : { verified: false, detail: 'The setting did not stick.' };
    },
  });
  return [allow];
}

/** A readable label: the part of the title after the last dash ("… - Google Chrome"), else the process name. */
function labelFor(processName: string, title: string): string {
  const tail = title.split(/\s[-–—]\s/).at(-1)?.trim();
  return (tail && tail.length <= 60 ? tail : processName).slice(0, 120);
}
