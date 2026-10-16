import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CapabilityError } from '../capabilities/types';
import type { Logger } from '../logging/logger';
import { WIN32_HELPER_SCRIPT } from './win32Script';

export interface RawWindow {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
  className: string;
  minimized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  foreground: boolean;
}

export type UiaAction = 'invoke' | 'toggle' | 'select' | 'expand' | 'collapse' | 'focus' | 'set_value' | 'scroll_down' | 'scroll_up' | 'page_down' | 'page_up';

export interface UiaNodeRaw {
  i?: number;
  rid: string;
  role: string;
  lct?: string;
  name: string;
  aid?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  depth: number;
  parent: number;
  disabled?: boolean;
  offscreen?: boolean;
  focused?: boolean;
  password?: boolean;
  readonly?: boolean;
  patterns?: string[];
  toggle?: string;
  selected?: boolean;
  expanded?: string;
  value?: string;
}

export interface UiaSnapshotRaw {
  nodes: UiaNodeRaw[];
  truncated: boolean;
  ms: number;
  window: { w: number; h: number; x: number; y: number };
}

export interface BrowserContextRaw {
  url: string | null;
  documentName: string;
  textAvailable: boolean;
  selection: string;
  page: string;
  method: string;
}

/** Native desktop operations. Every method acts on exactly one explicit hwnd. */
export interface DesktopBackend {
  support(): { supported: boolean; reason: string | null };
  list(): Promise<RawWindow[]>;
  info(hwnd: string): Promise<RawWindow | null>;
  focus(hwnd: string): Promise<{ foreground: boolean }>;
  move(hwnd: string, b: { x: number; y: number; width: number; height: number }): Promise<RawWindow>;
  typeText(hwnd: string, text: string): Promise<{ chars: number }>;
  /** Sends Ctrl+V to the foreground target. */
  paste(hwnd: string): Promise<void>;
  /** Reads the window's document text via UI Automation; null when unsupported. */
  readText(hwnd: string): Promise<string | null>;
  /** Bounded UI Automation tree of one window. */
  uiaSnapshot(hwnd: string, opts: { maxNodes: number; maxDepth: number; budgetMs: number }): Promise<UiaSnapshotRaw>;
  /** Current properties of one element (null when it no longer exists). */
  uiaDescribe(hwnd: string, rid: string): Promise<UiaNodeRaw | null>;
  uiaAct(hwnd: string, rid: string, action: UiaAction, text?: string): Promise<{ method: string }>;
  /** Screen coordinates of an element's centre (for the pointer fallback). */
  uiaCenter(hwnd: string, rid: string): Promise<{ x: number; y: number }>;
  browserContext(hwnd: string, maxChars: number): Promise<BrowserContextRaw>;
  /** All visible windows of a process, including owned dialogs. */
  processWindows(pid: number): Promise<Array<RawWindow & { owner: string }>>;
  clickScreen(hwnd: string, x: number, y: number): Promise<void>;
  wheel(hwnd: string, x: number, y: number, notches: number): Promise<void>;
  keys(hwnd: string, mods: number[], key: number): Promise<void>;
  click(hwnd: string, x: number, y: number, button: 'left' | 'right', double: boolean): Promise<void>;
  dispose(): void;
}

/** Helper error codes that guarantee nothing was sent to the target. */
const NOT_DISPATCHED = new Set([
  'target_gone',
  'not_foreground',
  'outside_client_area',
  'target_obscured',
  'unknown_command',
  'element_gone',
  'element_disabled',
  'element_offscreen',
  'no_invoke_pattern',
  'no_value_pattern',
  'no_scroll_pattern',
  'unsupported_action',
  'password_field',
  'uia_unavailable',
]);

/**
 * Win32 backend: a single long-lived PowerShell process running the fixed
 * helper script (written fresh from the app bundle at start, so its content
 * is always Keo's own). Requests are serialized one at a time.
 */
export class Win32Backend implements DesktopBackend {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runtimeDir: string,
    private readonly log: Logger,
  ) {}

  support(): { supported: boolean; reason: string | null } {
    if (process.platform !== 'win32') return { supported: false, reason: 'Desktop interaction is implemented for Windows only.' };
    return { supported: true, reason: null };
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const sup = this.support();
      if (!sup.supported) return reject(new CapabilityError('unsupported', sup.reason ?? 'Unsupported'));
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      const scriptPath = path.join(this.runtimeDir, 'keo-win32-helper.ps1');
      fs.writeFileSync(scriptPath, `\ufeff${WIN32_HELPER_SCRIPT}`, 'utf8');
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // -ExecutionPolicy Bypass applies to this child process only; it does not change system policy.
      const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: 'pipe',
      });
      this.proc = proc;
      const startTimer = setTimeout(() => reject(new CapabilityError('helper_start_timeout', 'Desktop helper did not start in time.', { retryable: true })), 45000);
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
        try {
          msg = JSON.parse(line.replace(/^\ufeff/, ''));
        } catch {
          return;
        }
        if (msg.ready) {
          clearTimeout(startTimer);
          resolve();
          return;
        }
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(helperError(msg.error?.message ?? 'helper error'));
      });
      proc.stderr.on('data', (d: Buffer) => this.log.warn('desktop.helper_stderr', { bytes: d.length }));
      proc.on('exit', (code) => {
        clearTimeout(startTimer);
        this.log.warn('desktop.helper_exit', { code });
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new CapabilityError('helper_exited', 'The desktop helper stopped unexpectedly.', { dispatched: 'unknown' }));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(new CapabilityError('helper_exited', 'The desktop helper could not start.', { retryable: true }));
      });
      proc.on('error', (e) => {
        this.log.error('desktop.helper_error', { error: e.message });
      });
    });
    return this.ready;
  }

  private call<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    const run = async (): Promise<T> => {
      await this.start();
      const proc = this.proc;
      if (!proc) throw new CapabilityError('helper_unavailable', 'Desktop helper is not running.', { retryable: true });
      const id = this.nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new CapabilityError('timeout', `Desktop helper timed out on ${cmd}.`, { dispatched: 'unknown' }));
        }, timeoutMs);
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<RawWindow[]> {
    const r = await this.call<RawWindow[] | RawWindow | null>('list');
    return (Array.isArray(r) ? r : r ? [r] : []).map(normalize);
  }

  async info(hwnd: string): Promise<RawWindow | null> {
    const r = await this.call<RawWindow | null>('info', { hwnd });
    return r ? normalize(r) : null;
  }

  focus(hwnd: string): Promise<{ foreground: boolean }> {
    return this.call('focus', { hwnd });
  }

  async move(hwnd: string, b: { x: number; y: number; width: number; height: number }): Promise<RawWindow> {
    return normalize(await this.call<RawWindow>('move', { hwnd, ...b }));
  }

  typeText(hwnd: string, text: string): Promise<{ chars: number }> {
    // ~20 chars per 15 ms chunk plus overhead; allow generously for long text.
    return this.call('type', { hwnd, text }, 15000 + text.length * 5);
  }

  async paste(hwnd: string): Promise<void> {
    await this.call('paste', { hwnd });
  }

  uiaSnapshot(hwnd: string, opts: { maxNodes: number; maxDepth: number; budgetMs: number }): Promise<UiaSnapshotRaw> {
    return this.call('uia_snapshot', { hwnd, ...opts }, opts.budgetMs + 15000);
  }

  uiaDescribe(hwnd: string, rid: string): Promise<UiaNodeRaw | null> {
    return this.call('uia_describe', { hwnd, rid }, 15000);
  }

  uiaAct(hwnd: string, rid: string, action: UiaAction, text = ''): Promise<{ method: string }> {
    return this.call('uia_act', { hwnd, rid, action, text }, 20000);
  }

  uiaCenter(hwnd: string, rid: string): Promise<{ x: number; y: number }> {
    return this.call('uia_center', { hwnd, rid }, 15000);
  }

  browserContext(hwnd: string, maxChars: number): Promise<BrowserContextRaw> {
    return this.call('browser_context', { hwnd, maxChars }, 30000);
  }

  async processWindows(pid: number): Promise<Array<RawWindow & { owner: string }>> {
    const r = await this.call<Array<RawWindow & { owner: string }> | (RawWindow & { owner: string }) | null>('proc_windows', { pid });
    return (Array.isArray(r) ? r : r ? [r] : []).map((w) => ({ ...normalize(w), owner: String(w.owner ?? '0') }));
  }

  async clickScreen(hwnd: string, x: number, y: number): Promise<void> {
    await this.call('click_screen', { hwnd, x, y });
  }

  async wheel(hwnd: string, x: number, y: number, notches: number): Promise<void> {
    await this.call('wheel', { hwnd, x, y, notches });
  }

  async readText(hwnd: string): Promise<string | null> {
    try {
      const r = await this.call<{ available: boolean; text: string }>('readtext', { hwnd }, 15000);
      return r.available ? String(r.text ?? '') : null;
    } catch {
      return null;
    }
  }

  async keys(hwnd: string, mods: number[], key: number): Promise<void> {
    await this.call('keys', { hwnd, mods, key });
  }

  async click(hwnd: string, x: number, y: number, button: 'left' | 'right', double: boolean): Promise<void> {
    await this.call('click', { hwnd, x, y, button, double });
  }

  dispose(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.ready = null;
  }
}

function helperError(message: string): CapabilityError {
  const code = message.split(':')[0] ?? 'helper_error';
  if (NOT_DISPATCHED.has(code)) return new CapabilityError(code, describe(code), { dispatched: 'no' });
  if (code === 'partial_input') return new CapabilityError(code, 'Only part of the input was delivered.', { dispatched: 'yes' });
  if (code === 'foreground_lost') {
    const sent = Number(message.split(':')[1] ?? '0');
    return new CapabilityError(
      code,
      sent > 0 ? `Another window came to the front after ${sent} characters, so typing stopped.` : 'Another window came to the front before typing started, so nothing was typed.',
      { dispatched: sent > 0 ? 'yes' : 'no' },
    );
  }
  return new CapabilityError('helper_error', `Desktop helper error: ${message.slice(0, 200)}`, { dispatched: 'unknown' });
}

function describe(code: string): string {
  switch (code) {
    case 'target_gone':
      return 'The target window no longer exists.';
    case 'not_foreground':
      return 'The target window is not in the foreground, so no input was sent.';
    case 'outside_client_area':
      return 'The click position is outside the target window.';
    case 'target_obscured':
      return 'Another window covers that point, so the click was not sent.';
    case 'element_gone':
      return 'That control no longer exists in the window (the screen changed). Inspect the window again.';
    case 'element_disabled':
      return 'That control is disabled right now.';
    case 'element_offscreen':
      return 'That control is not visible on screen; scroll to it first.';
    case 'no_invoke_pattern':
      return 'That control cannot be activated through accessibility.';
    case 'no_value_pattern':
      return 'That control does not accept text through accessibility.';
    case 'no_scroll_pattern':
      return 'Nothing scrollable was found around that control.';
    case 'unsupported_action':
      return 'That control does not support this action.';
    case 'password_field':
      return 'Keo never types into password fields.';
    case 'uia_unavailable':
      return 'Windows UI Automation is not available in the desktop helper.';
    default:
      return code;
  }
}

function normalize(r: RawWindow): RawWindow {
  return {
    hwnd: String(r.hwnd),
    pid: Number(r.pid),
    processName: String(r.processName ?? ''),
    title: String(r.title ?? ''),
    className: String(r.className ?? ''),
    minimized: Boolean(r.minimized),
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
    foreground: Boolean(r.foreground),
  };
}
