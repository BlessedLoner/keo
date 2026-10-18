import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type BrowserId = 'chrome' | 'edge' | 'brave';

export interface BrowserProfile {
  /** Profile folder ("Default", "Profile 1"), used to open it. */
  dir: string;
  /** Name shown in the browser's profile menu ("Personal", "Work"). */
  name: string;
}

export interface InstalledBrowser {
  id: BrowserId;
  label: string;
  exe: string;
  profiles: BrowserProfile[];
}

interface BrowserDef {
  id: BrowserId;
  label: string;
  exes: string[];
  userData: string;
}

function defs(env: NodeJS.ProcessEnv): BrowserDef[] {
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA ?? '';
  return [
    {
      id: 'chrome',
      label: 'Google Chrome',
      exes: [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      userData: path.join(local, 'Google', 'Chrome', 'User Data'),
    },
    {
      id: 'edge',
      label: 'Microsoft Edge',
      exes: [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      userData: path.join(local, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      id: 'brave',
      label: 'Brave',
      exes: [path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
      userData: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    },
  ];
}

export const PROFILE_DIR = /^(Default|Profile \d{1,3}|Guest Profile)$/;

/**
 * Profile names from a Chromium "Local State" file. Only each profile's
 * folder and display name are taken — never e-mail addresses, the stored
 * encryption key, cookies or anything else in the file.
 */
export function profilesFromLocalState(json: string): BrowserProfile[] {
  let j: unknown;
  try {
    j = JSON.parse(json);
  } catch {
    return [];
  }
  const cache = (j as { profile?: { info_cache?: Record<string, { name?: unknown; is_ephemeral?: unknown }> } })?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  const out: BrowserProfile[] = [];
  for (const [dir, v] of Object.entries(cache)) {
    if (!PROFILE_DIR.test(dir) || dir === 'Guest Profile' || v?.is_ephemeral === true) continue;
    const name = typeof v?.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 60) : dir;
    out.push({ dir, name });
  }
  return out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })));
}

export interface BrowserFs {
  exists(p: string): boolean;
  read(p: string): string | null;
}

const realFs: BrowserFs = {
  exists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  read: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
};

/** Installed Chromium browsers and their profiles (Chrome first). */
export function installedBrowsers(env: NodeJS.ProcessEnv = process.env, f: BrowserFs = realFs): InstalledBrowser[] {
  const out: InstalledBrowser[] = [];
  for (const d of defs(env)) {
    const exe = d.exes.find((e) => f.exists(e));
    if (!exe) continue;
    const ls = f.read(path.join(d.userData, 'Local State'));
    out.push({ id: d.id, label: d.label, exe, profiles: ls ? profilesFromLocalState(ls) : [] });
  }
  return out;
}

/**
 * Profiles matching a display name or folder. Several profiles can share a
 * display name ("Blessed2" twice), so more than one result means: ask.
 */
export function matchProfiles(profiles: BrowserProfile[], wanted: string): BrowserProfile[] {
  const w = wanted.trim().toLowerCase();
  const byDir = profiles.filter((p) => p.dir.toLowerCase() === w);
  if (byDir.length) return byDir;
  const exact = profiles.filter((p) => p.name.toLowerCase() === w);
  if (exact.length) return exact;
  return profiles.filter((p) => p.name.toLowerCase().startsWith(w) || w.split(/\s+/).every((x) => p.name.toLowerCase().includes(x)));
}

/** "Blessed2 (Profile 1)" when the name alone is not unique. */
export function profileLabel(p: BrowserProfile, all: BrowserProfile[]): string {
  return all.filter((x) => x.name === p.name).length > 1 ? `${p.name} (${p.dir})` : p.name;
}

/** Only web addresses are opened (no file:, javascript:, chrome:, or command-line flags). */
export function safeWebUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

/**
 * Opens a URL in a NEW tab of the given profile (the browser adds a tab to
 * that profile's window, or opens one); existing tabs are left alone. No
 * shell; the profile folder and URL are validated, each one argument.
 */
export function openInProfile(exe: string, profileDir: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const safe = safeWebUrl(url);
    if (!safe || !PROFILE_DIR.test(profileDir)) return reject(new Error('invalid profile or address'));
    const p = spawn(exe, [`--profile-directory=${profileDir}`, safe], { detached: true, stdio: 'ignore', shell: false });
    p.once('error', reject);
    p.once('spawn', () => {
      p.unref();
      resolve();
    });
  });
}
