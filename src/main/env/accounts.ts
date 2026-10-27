import fs from 'node:fs';
import path from 'node:path';
import type { ProfileInfo } from './profile';

/**
 * Each Keo account has its own data on this PC: conversations, memory, projects, tasks, settings,
 * connected email and calendar, Keo's browser profile, and so on. Signing in to another account
 * starts Keo again on that account's own folder, so one account never sees another's data.
 *
 *   <profile>\                       logs, runtime helpers and Electron's session (shared)
 *   <profile>\keo-session\           who is signed in (the encrypted Keo sign-in) and the mode
 *   <profile>\accounts\<user id>\    one Keo account's data
 *   <profile>\accounts\local\        Keo without a Keo account (the user's own API keys)
 *   <profile>\accounts\signed-out\   while nobody is signed in (the sign-in screen)
 *
 * Data from before accounts existed is kept aside ("unclaimed") and goes to the first account
 * that signs in on this PC — or to "local" if the user chooses their own API key instead.
 */

export type Mode = 'account' | 'local' | 'signed-out';

export interface AccountState {
  mode: Mode;
  /** The signed-in Keo account (mode 'account'). */
  userId: string | null;
}

/** Keo's own files and folders in a data folder (everything else there belongs to Electron). */
export const DATA_ITEMS = [
  'keo.db',
  'keo.db-shm',
  'keo.db-wal',
  'keo.db-journal',
  'secrets.json',
  'settings.json',
  'observations',
  'backups',
  'attachments',
  'background-jobs.json',
  'briefing-state.json',
  'created',
  'created-backups',
  'created-files.json',
  'pending-questions.json',
  'pictures-work',
  'research',
  'saved-research',
  'tools',
  'video',
  'videos',
  'web-browser',
  'workflows.json',
] as const;

const UNCLAIMED = 'unclaimed';

export function sessionDir(root: string): string {
  return path.join(root, 'keo-session');
}

const stateFile = (root: string) => path.join(sessionDir(root), 'state.json');

export function readState(root: string): AccountState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Partial<AccountState>;
    const mode: Mode = s.mode === 'account' || s.mode === 'local' ? s.mode : 'signed-out';
    const userId = typeof s.userId === 'string' && /^[0-9a-f-]{8,64}$/i.test(s.userId) ? s.userId : null;
    return mode === 'account' && !userId ? { mode: 'signed-out', userId: null } : { mode, userId: mode === 'account' ? userId : null };
  } catch {
    return { mode: 'signed-out', userId: null };
  }
}

export function writeState(root: string, s: AccountState): void {
  fs.mkdirSync(sessionDir(root), { recursive: true });
  const tmp = `${stateFile(root)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mode: s.mode, userId: s.mode === 'account' ? s.userId : null }));
  fs.renameSync(tmp, stateFile(root));
}

/** The folder name for a state. */
export function folderFor(s: AccountState): string {
  return s.mode === 'account' && s.userId ? s.userId.toLowerCase() : s.mode === 'local' ? 'local' : 'signed-out';
}

function hasData(dir: string): boolean {
  return DATA_ITEMS.some((n) => fs.existsSync(path.join(dir, n)));
}

function moveData(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const n of DATA_ITEMS) {
    const src = path.join(from, n);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(to, n));
  }
}

/**
 * One-time: Keo's data from before accounts (in the profile folder itself) is set aside as
 * "unclaimed". A Keo sign-in that was in it is not carried over (whoever signs in first after
 * the update gets the data), so a test account that happened to be signed in cannot take it.
 */
export function setAsideLegacy(root: string): boolean {
  if (!hasData(root)) return false;
  moveData(root, path.join(root, 'accounts', UNCLAIMED));
  return true;
}

/**
 * The data folder to start Keo on for this state. The first account (or local use) to start on
 * this PC takes the unclaimed data from before accounts, if there is any and its own folder is
 * still empty. Returns the folder and whether it just took that data.
 */
export function openFolder(root: string, s: AccountState): { dir: string; claimed: boolean } {
  const accounts = path.join(root, 'accounts');
  const dir = path.join(accounts, folderFor(s));
  const unclaimed = path.join(accounts, UNCLAIMED);
  let claimed = false;
  if (s.mode !== 'signed-out' && fs.existsSync(unclaimed) && !hasData(dir)) {
    moveData(unclaimed, dir);
    fs.rmSync(unclaimed, { recursive: true, force: true });
    claimed = true;
  }
  fs.mkdirSync(dir, { recursive: true });
  return { dir, claimed };
}

/** Keo's paths for one account's folder; logs, helpers and Electron's own files stay shared. */
export function accountProfile(base: ProfileInfo, dir: string, s: AccountState): ProfileInfo {
  return {
    ...base,
    profile: `${base.profile}/${s.mode === 'account' ? 'account' : s.mode}`,
    userData: dir,
    dbFile: path.join(dir, 'keo.db'),
    secretsDir: dir,
    observationsDir: path.join(dir, 'observations'),
    backupsDir: path.join(dir, 'backups'),
  };
}

/** The Keo account id inside a Supabase access token (its "sub"), without checking the signature. */
export function userIdOfToken(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { sub?: unknown };
    return typeof json.sub === 'string' && /^[0-9a-f-]{8,64}$/i.test(json.sub) ? json.sub : null;
  } catch {
    return null;
  }
}
