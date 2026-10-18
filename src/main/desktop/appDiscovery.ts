import { spawn } from 'node:child_process';
import path from 'node:path';

/** One entry of Windows' own list of startable apps (Start menu, incl. Microsoft Store apps). */
export interface StartApp {
  name: string;
  /** Windows app id: an AUMID for packaged/Store apps ("Pkg_hash!App"), a path-like id for desktop apps. */
  appId: string;
  /** Publisher shown by Windows for Store apps (from the package manifest), when known. */
  publisher?: string | null;
}

export interface DiscoveredApp extends StartApp {
  kind: 'store' | 'desktop';
}

export interface AppMatch {
  app: DiscoveredApp;
  exact: boolean;
}

/** App ids are passed to explorer.exe as one argument; anything outside this shape is never launched. */
const APP_ID = /^[\w.{}\\:~ !-]{1,300}$/u;
export const validAppId = (id: string) => APP_ID.test(id) && !id.includes('..') && !/["'`&|<>^%]/.test(id);

export const normApp = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Discovers startable Windows apps from Windows itself (Get-StartApps: Start
 * menu shortcuts and registered/packaged apps, each with its app id) instead
 * of a hand-kept list of executable paths. Discovery only lists candidates:
 * launching is a separate, approved capability, and acting inside an app
 * still needs that app in the allowed list.
 */
export class AppDiscovery {
  private cache: { at: number; apps: DiscoveredApp[] } | null = null;

  constructor(
    private readonly source: () => Promise<StartApp[]> = listStartApps,
    private readonly now: () => number = Date.now,
  ) {}

  async list(force = false): Promise<DiscoveredApp[]> {
    if (!force && this.cache && this.now() - this.cache.at < 10 * 60_000) return this.cache.apps;
    const raw = await this.source();
    const seen = new Set<string>();
    const apps: DiscoveredApp[] = [];
    for (const a of raw) {
      const name = String(a.name ?? '').trim().slice(0, 120);
      const appId = String(a.appId ?? '').trim();
      if (!name || !validAppId(appId) || seen.has(appId.toLowerCase())) continue;
      // Uninstallers, help files and web links are not apps to open.
      if (/^(uninstall|remove)\b|\buninstall(er)?\b/i.test(name) || /^https?:/i.test(appId) || /\.(chm|txt|pdf|url|html?)$/i.test(appId)) continue;
      seen.add(appId.toLowerCase());
      const publisher = typeof a.publisher === 'string' && a.publisher.trim() && !/^ms-resource:/i.test(a.publisher) ? a.publisher.trim().slice(0, 80) : null;
      apps.push({ name, appId, kind: appId.includes('!') ? 'store' : 'desktop', publisher });
    }
    apps.sort((x, y) => x.name.localeCompare(y.name));
    this.cache = { at: this.now(), apps };
    return apps;
  }

  /** Apps whose name matches the request; exact names first. */
  async find(query: string, limit = 8): Promise<AppMatch[]> {
    const q = normApp(query);
    if (!q) return [];
    const words = q.split(' ');
    const apps = await this.list();
    const scored = apps
      .map((app) => {
        const n = normApp(app.name);
        const exact = n === q;
        const score = exact ? 100 : n.startsWith(q) ? 80 : words.every((w) => n.split(' ').some((x) => x.startsWith(w))) ? 60 : n.includes(q) ? 40 : 0;
        return { app, exact, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
    return scored.slice(0, limit).map(({ app, exact }) => ({ app, exact }));
  }

  async get(appId: string): Promise<DiscoveredApp | null> {
    return (await this.list()).find((a) => a.appId.toLowerCase() === appId.toLowerCase()) ?? null;
  }
}

/** Windows' list of startable apps, read with the built-in Get-StartApps cmdlet (names and app ids only). */
export function listStartApps(): Promise<StartApp[]> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve([]);
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Publisher for Store apps: the package manifest's display name, else the O= part of the package identity.
    const script = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$pub = @{}',
      "Get-AppxPackage | ForEach-Object { $d = $null; try { $m = [xml](Get-Content -LiteralPath (Join-Path $_.InstallLocation 'AppxManifest.xml') -ErrorAction Stop); $d = [string]$m.Package.Properties.PublisherDisplayName } catch {}; if ((-not $d -or $d -like 'ms-resource:*') -and $_.Publisher -match 'O=([^,]+)') { $d = $Matches[1] }; $pub[$_.PackageFamilyName] = $d }",
      "Get-StartApps | ForEach-Object { $pfn = ($_.AppID -split '!')[0]; [pscustomobject]@{ Name = $_.Name; AppID = $_.AppID; Publisher = $pub[$pfn] } } | ConvertTo-Json -Compress",
    ].join('; ');
    const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => p.kill(), 45_000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      if (out.length < 4_000_000) out += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        type Row = { Name?: string; AppID?: string; Publisher?: string | null };
        const j = JSON.parse(out.replace(/^\ufeff/, '') || '[]') as Row[] | Row;
        resolve((Array.isArray(j) ? j : [j]).map((x) => ({ name: x.Name ?? '', appId: x.AppID ?? '', publisher: x.Publisher ?? null })));
      } catch {
        reject(new Error('Windows did not return the list of apps.'));
      }
    });
  });
}

/** Starts an app by its Windows app id (works for Store and desktop apps alike); no shell, one validated argument. */
export function launchByAppId(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!validAppId(appId)) return reject(new Error('invalid app id'));
    const explorer = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    const p = spawn(explorer, [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    p.once('error', reject);
    p.once('spawn', () => {
      p.unref();
      resolve();
    });
  });
}
