import fs from 'node:fs';
import os from 'node:os';
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

  private details: { at: number; apps: InstalledApp[] } | null = null;

  /** All startable apps with process name, executable and icon (for the app pickers). */
  async installed(source: () => Promise<Array<{ name: string; appId: string; exe: string | null; icon: string | null }>> = listInstalledDetails): Promise<InstalledApp[]> {
    if (this.details && this.now() - this.details.at < 30 * 60_000) return this.details.apps;
    const [apps, rows] = await Promise.all([this.list(), source()]);
    const byId = new Map(rows.map((r) => [r.appId.toLowerCase(), r]));
    const out = apps.map((a): InstalledApp => {
      const r = byId.get(a.appId.toLowerCase());
      const exe = r?.exe && /\.exe$/i.test(r.exe) ? r.exe : null;
      const proc = exe ? path.basename(exe).replace(/\.exe$/i, '') : null;
      return {
        name: a.name,
        appId: a.appId,
        kind: a.kind,
        publisher: a.publisher ?? null,
        processName: proc && /^[A-Za-z0-9 ._-]{1,120}$/.test(proc) ? proc : null,
        exePath: a.kind === 'desktop' ? exe : null,
        icon: r?.icon && r.icon.length < 120_000 ? `data:image/png;base64,${r.icon}` : null,
      };
    });
    this.details = { at: this.now(), apps: out };
    return out;
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

/** One installed app with what Keo needs to allow/launch it, and its icon (data: URL). */
export interface InstalledApp {
  name: string;
  appId: string;
  kind: 'store' | 'desktop';
  publisher: string | null;
  /** Process name of its main window (e.g. "WhatsApp.Root"), when Windows tells. */
  processName: string | null;
  /** Executable path for desktop apps (launching by path); Store apps launch by app id. */
  exePath: string | null;
  icon: string | null;
}

/**
 * PowerShell that lists Start-menu and Store apps with their executable and
 * icon: Store apps from their package manifest (Application/@Executable and
 * the 44 px logo), desktop apps from their Start-menu shortcut (icon of the
 * target .exe). Read-only; nothing is started.
 */
const INSTALLED_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
function IconOf($path) {
  try {
    $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($path); if (-not $ic) { return $null }
    $bmp = $ic.ToBitmap(); $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); return [Convert]::ToBase64String($ms.ToArray())
  } catch { return $null }
}
$known = @{ '{6D809377-6AF0-444B-8957-A3773F02200E}' = $env:ProgramW6432; '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}' = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); '{F38BF404-1D43-42F2-9305-67DE0B28FC23}' = $env:windir; '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}' = "$env:windir\System32" }
$pk = @{}; Get-AppxPackage | ForEach-Object { $pk[$_.PackageFamilyName] = $_ }
$sh = New-Object -ComObject WScript.Shell
$lnk = @{}
foreach ($dir in @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")) {
  Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk | ForEach-Object { try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t -and $t.ToLower().EndsWith('.exe')) { $lnk[$_.BaseName.ToLower()] = $t } } catch {} }
}
Get-StartApps | ForEach-Object {
  $name = $_.Name; $id = $_.AppID; $exe = $null; $icon = $null
  if ($id -like '*!*') {
    $parts = $id -split '!', 2; $p = $pk[$parts[0]]
    if ($p) {
      try {
        $m = [xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml'))
        $app = @($m.Package.Applications.Application) | Where-Object { $_.Id -eq $parts[1] } | Select-Object -First 1
        if ($app.Executable) { $exe = Join-Path $p.InstallLocation $app.Executable }
        $logo = $app.VisualElements.Square44x44Logo
        if ($logo) {
          $lp = Join-Path $p.InstallLocation $logo; $base = [IO.Path]::GetFileNameWithoutExtension($lp)
          $cand = Get-ChildItem -LiteralPath (Split-Path $lp) -Filter "$base*.png" | Where-Object { $_.Length -lt 40000 } | Sort-Object { if ($_.Name -match 'targetsize-32') { 0 } elseif ($_.Name -match 'targetsize-48') { 1 } elseif ($_.Name -match 'scale-100') { 2 } else { 3 } } | Select-Object -First 1
          if ($cand) { $icon = [Convert]::ToBase64String([IO.File]::ReadAllBytes($cand.FullName)) }
        }
      } catch {}
    }
  } else {
    $cand = $id
    foreach ($k in $known.Keys) { if ($cand.StartsWith($k)) { $cand = $known[$k] + $cand.Substring($k.Length) } }
    if ($cand -match '\.exe$' -and (Test-Path -LiteralPath $cand)) { $exe = $cand } elseif ($lnk[$name.ToLower()]) { $exe = $lnk[$name.ToLower()] }
    if ($exe) { $icon = IconOf $exe }
  }
  [pscustomobject]@{ Name = $name; AppID = $id; Exe = $exe; Icon = $icon }
} | ConvertTo-Json -Compress
`;

/** Runs INSTALLED_SCRIPT (a few seconds; cached by the caller). */
export function listInstalledDetails(): Promise<Array<{ name: string; appId: string; exe: string | null; icon: string | null }>> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve([]);
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Written fresh from Keo's own copy each time (like the desktop helper), run with -File.
    const file = path.join(os.tmpdir(), `keo-installed-apps-${process.pid}.ps1`);
    fs.writeFileSync(file, `\ufeff${INSTALLED_SCRIPT}`, 'utf8');
    const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => p.kill(), 90_000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      if (out.length < 12_000_000) out += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', () => {
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => undefined);
      try {
        type Row = { Name?: string; AppID?: string; Exe?: string | null; Icon?: string | null };
        const j = JSON.parse(out.replace(/^\ufeff/, '') || '[]') as Row[] | Row;
        resolve((Array.isArray(j) ? j : [j]).map((x) => ({ name: x.Name ?? '', appId: x.AppID ?? '', exe: x.Exe ?? null, icon: x.Icon ?? null })));
      } catch {
        reject(new Error('Windows did not return the list of apps.'));
      }
    });
  });
}
