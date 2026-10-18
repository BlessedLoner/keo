import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CapabilityError } from '../capabilities/types';

/**
 * A project's workspace: one folder the user chose with the folder picker.
 * Every path is resolved inside it (no "..", no absolute paths, no links that
 * lead outside); writes are atomic and keep a backup; commands are only the
 * project's own package.json scripts, with a time limit.
 */

const MAX_READ = 200_000;
const MAX_WRITE = 1_000_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'release', '.next', '.keo-backups', '__pycache__', '.venv', 'venv']);
/** Files whose content is usually secret; Keo reads or writes them only if the user asks by name. */
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials\.json|secrets?\.(json|ya?ml))$/i;

export const hashText = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

/** Resolves a relative path inside the workspace, refusing anything that would leave it. */
export function inside(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw new CapabilityError('outside_workspace', 'Use a path relative to the project folder (no "..", no drive letters).', { dispatched: 'no' });
  }
  const realRoot = fs.realpathSync(root);
  const full = path.resolve(realRoot, rel);
  if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw new CapabilityError('outside_workspace', 'That path is outside the project folder.', { dispatched: 'no' });
  // Existing parts must not be links that lead outside.
  let probe = full;
  while (probe.startsWith(realRoot) && probe !== realRoot && !fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new CapabilityError('outside_workspace', 'That path leads outside the project folder through a link.', { dispatched: 'no' });
  return full;
}

export const isSecretFile = (rel: string) => SECRET_FILE.test(rel);

export function listFiles(root: string, rel = '', limit = 400): Array<{ path: string; type: 'file' | 'dir'; size: number }> {
  const start = rel ? inside(root, rel) : fs.realpathSync(root);
  const realRoot = fs.realpathSync(root);
  const out: Array<{ path: string; type: 'file' | 'dir'; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      const relPath = path.relative(realRoot, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push({ path: relPath, type: 'dir', size: 0 });
        walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push({ path: relPath, type: 'file', size: fs.statSync(full).size });
      }
    }
  };
  walk(start, 0);
  return out;
}

export function readText(root: string, rel: string): { text: string; hash: string; truncated: boolean } {
  const full = inside(root, rel);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new CapabilityError('not_a_file', 'That is not a file.', { dispatched: 'no' });
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) throw new CapabilityError('binary_file', 'That file is not text.', { dispatched: 'no' });
  const text = buf.toString('utf8');
  return { text: text.slice(0, MAX_READ), hash: hashText(text), truncated: text.length > MAX_READ };
}

/** A short unified-style diff (changed lines with a little context) for the approval preview. */
export function diffSummary(before: string, after: string, maxLines = 40): string[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  if (start > 0) out.push(`  ${a[start - 1]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  if (endA + 1 < a.length) out.push(`  ${a[endA + 1]}`);
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… ${out.length - maxLines} more line(s)`];
  return out.length ? [`@@ line ${start + 1}`, ...out] : ['(no change)'];
}

/**
 * Writes atomically (temporary file, then rename) and keeps the previous
 * version in .keo-backups/<time>/. Refuses when the file changed since it was
 * read (expectedHash), so an edit never overwrites newer work.
 */
export function writeText(root: string, rel: string, content: string, expectedHash: string | null): { created: boolean; backup: string | null; hash: string } {
  if (content.length > MAX_WRITE) throw new CapabilityError('too_large', 'That content is larger than 1 MB.', { dispatched: 'no' });
  const full = inside(root, rel);
  const exists = fs.existsSync(full);
  if (exists && !fs.statSync(full).isFile()) throw new CapabilityError('not_a_file', 'That path is a folder.', { dispatched: 'no' });
  const current = exists ? fs.readFileSync(full, 'utf8') : null;
  if (current !== null && expectedHash && hashText(current) !== expectedHash) {
    throw new CapabilityError('file_changed', 'The file changed since Keo read it. Read it again and redo the edit.', { dispatched: 'no' });
  }
  if (current !== null && !expectedHash) throw new CapabilityError('read_first', 'Read the file first (files__read) and pass its hash, so newer changes are never overwritten.', { dispatched: 'no' });
  let backup: string | null = null;
  if (current !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const realRoot = fs.realpathSync(root);
    backup = path.join(realRoot, '.keo-backups', stamp, path.relative(realRoot, full));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(full, backup);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.keo-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, full);
  return { created: current === null, backup: backup ? path.relative(fs.realpathSync(root), backup).replace(/\\/g, '/') : null, hash: hashText(content) };
}

export function packageScripts(root: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(inside(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(j.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && /^[\w:.-]{1,40}$/.test(e[0])));
  } catch {
    return {};
  }
}

const SECRETISH = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g;
export const redactSecrets = (t: string) => t.replace(SECRETISH, '[redacted]');

/**
 * Runs one of the project's package.json scripts ("npm run <name>"), in the
 * project folder, with a time limit; the output tail is returned with
 * anything that looks like a key redacted. The script name is checked
 * against package.json, so no other command can run.
 */
export function runScript(root: string, name: string, timeoutMs: number, signal: AbortSignal, spawnImpl: typeof spawn = spawn): Promise<{ exitCode: number | null; timedOut: boolean; output: string; ms: number }> {
  const scripts = packageScripts(root);
  if (!scripts[name]) throw new CapabilityError('no_such_script', `package.json has no "${name}" script. Available: ${Object.keys(scripts).join(', ') || 'none'}.`, { dispatched: 'no' });
  const cwd = fs.realpathSync(root);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    // cmd.exe is needed to start npm.cmd; the script name was matched against package.json above.
    const p = spawnImpl(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm run ${name}`], { cwd, shell: false, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '';
    const add = (d: Buffer) => {
      out = (out + d.toString('utf8')).slice(-40_000);
    };
    p.stdout?.on('data', add);
    p.stderr?.on('data', add);
    let timedOut = false;
    const kill = () => {
      if (p.pid) spawnImpl('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, shell: false });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new CapabilityError('run_failed', `Could not start npm: ${e.message}`, { dispatched: 'no' }));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: redactSecrets(out.slice(-8000)), ms: Date.now() - t0 });
    });
  });
}
