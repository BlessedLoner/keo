import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CapabilityError } from '../capabilities/types';
import type { Logger } from '../logging/logger';
import { MODERN_UIA_SCRIPT, WIN32_HELPER_SCRIPT } from './win32Script';

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
  /** Embedded web-content windows read directly because the frame did not lead into them. */
  contentRoots?: number;
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
  /** Helper diagnostics (e.g. its DPI awareness mode). */
  helperInfo?(): Promise<{ pong: boolean; dpi?: string }>;
  /** Time since the user's last keyboard/mouse input, and the current foreground window. */
  userActivity(): Promise<{ idleMs: number; foreground: string | null }>;
  /** Share (0..1) of the window hidden behind other windows (1 when minimised). */
  coveredShare(hwnd: string): Promise<number>;
  list(): Promise<RawWindow[]>;
  info(hwnd: string): Promise<RawWindow | null>;
  focus(hwnd: string): Promise<{ foreground: boolean }>;
  move(hwnd: string, b: { x: number; y: number; width: number; height: number }): Promise<RawWindow>;
  /** method "direct": Windows refused simulated keys, so characters were posted to the focused field. */
  typeText(hwnd: string, text: string): Promise<{ chars: number; method?: 'keys' | 'direct' }>;
  /** Sends Ctrl+V to the foreground target. */
  paste(hwnd: string): Promise<void>;
  /** Puts one file on the clipboard as a file (like Copy in Explorer), for attaching it by pasting. */
  /** Puts one file on the clipboard for pasting; a picture (`asImage`) goes on as the image itself. */
  setClipboardFiles?(path: string, asImage?: boolean): Promise<void>;
  /** Visible standard file dialogs (with their owner window and process). */
  fileDialogs?(): Promise<Array<{ hwnd: string; pid: number; owner: string; title: string }>>;
  /** Puts a path in a file dialog's "File name" box and presses Open (no keyboard input). */
  fileDialogOpen?(dialog: string, path: string): Promise<void>;
  fileDialogCancel?(dialog: string): Promise<void>;
  /** Left-button strokes in screen coordinates, inside the target window only. */
  draw?(hwnd: string, strokes: Array<Array<[number, number]>>): Promise<{ points: number; method: 'mouse' | 'direct' }>;
  /** Reads the window's document text via UI Automation; null when unsupported. */
  readText(hwnd: string): Promise<string | null>;
  /** Bounded UI Automation tree of one window. */
  uiaSnapshot(hwnd: string, opts: { maxNodes: number; maxDepth: number; budgetMs: number }): Promise<UiaSnapshotRaw>;
  /** Current properties of one element (null when it no longer exists). */
  uiaDescribe(hwnd: string, rid: string): Promise<UiaNodeRaw | null>;
  uiaAct(hwnd: string, rid: string, action: UiaAction, text?: string): Promise<{ method: string }>;
  /** Screen coordinates of an element's centre (for the pointer fallback). */
  uiaCenter(hwnd: string, rid: string): Promise<{ x: number; y: number }>;
  /** For each element, the names found inside it through the raw accessibility view (text a web page hides from the control view). */
  uiaTexts(hwnd: string, rids: string[]): Promise<string[][]>;
  browserContext(hwnd: string, maxChars: number): Promise<BrowserContextRaw>;
  /** All visible windows of a process, including owned dialogs. */
  processWindows(pid: number): Promise<Array<RawWindow & { owner: string }>>;
  clickScreen(hwnd: string, x: number, y: number): Promise<void>;
  wheel(hwnd: string, x: number, y: number, notches: number): Promise<void>;
  keys(hwnd: string, mods: number[], key: number): Promise<void>;
  click(hwnd: string, x: number, y: number, button: 'left' | 'right', double: boolean): Promise<void>;
  /** Class names of the window's child windows with counts (diagnostics; no titles or content). */
  childClasses?(hwnd: string): Promise<Record<string, number>>;
  /** Which accessibility reader a window uses (diagnostics). */
  uiaEngine?(hwnd: string): 'classic' | 'modern';
  dispose(): void;
}

/** Helper error codes that guarantee nothing was sent to the target. */
const NOT_DISPATCHED = new Set([
  'input_blocked',
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
  'value_rejected',
  'not_focusable',
  'pointer_mismatch',
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
    /** Which helper this process runs (the main one, or the modern UI Automation reader). */
    private readonly helper: { script: string; file: string } = { script: WIN32_HELPER_SCRIPT, file: 'keo-win32-helper.ps1' },
  ) {}

  /** Separate process for the modern UI Automation reader (see MODERN_UIA_SCRIPT), started on first need. */
  private modernProc: Win32Backend | null = null;
  private modern(): Win32Backend {
    return (this.modernProc ??= new Win32Backend(this.runtimeDir, this.log, { script: MODERN_UIA_SCRIPT, file: 'keo-uia-modern.ps1' }));
  }

  /** Routes modern-reader commands to its own process. */
  private uiCall<T>(cmd: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return cmd.startsWith('uia3_') ? this.modern().call<T>(cmd, args, timeoutMs) : this.call<T>(cmd, args, timeoutMs);
  }

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
      const scriptPath = path.join(this.runtimeDir, this.helper.file);
      fs.writeFileSync(scriptPath, `\ufeff${this.helper.script}`, 'utf8');
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

  helperInfo(): Promise<{ pong: boolean; dpi?: string }> {
    return this.call('ping', {});
  }

  async coveredShare(hwnd: string): Promise<number> {
    const r = await this.call<{ share: number }>('covered', { hwnd });
    return Number(r.share);
  }

  async userActivity(): Promise<{ idleMs: number; foreground: string | null }> {
    const r = await this.call<{ idleMs: number; foreground: string }>('idle', {});
    return { idleMs: Number(r.idleMs), foreground: r.foreground ? String(r.foreground) : null };
  }

  focus(hwnd: string): Promise<{ foreground: boolean }> {
    return this.call('focus', { hwnd });
  }

  async move(hwnd: string, b: { x: number; y: number; width: number; height: number }): Promise<RawWindow> {
    return normalize(await this.call<RawWindow>('move', { hwnd, ...b }));
  }

  /**
   * Some PCs refuse simulated input from Keo entirely (security software, input
   * policies). Then the same text, key or click is posted directly to the
   * focused control of the same verified foreground window.
   */
  private directMode = false;

  private async orDirect<T>(simulated: () => Promise<T>, direct: () => Promise<T>): Promise<T> {
    if (!this.directMode) {
      try {
        return await simulated();
      } catch (e) {
        if (!(e instanceof CapabilityError) || e.code !== 'input_blocked') throw e;
        this.directMode = true;
        this.log.warn('desktop.input_blocked_direct', { detail: e.message.slice(0, 120) });
      }
    }
    return direct();
  }

  async typeText(hwnd: string, text: string): Promise<{ chars: number; method?: 'keys' | 'direct' }> {
    // ~20 chars per 15 ms chunk plus overhead; allow generously for long text.
    const t = 15000 + text.length * 5;
    return this.orDirect<{ chars: number; method: 'keys' | 'direct' }>(
      async () => ({ ...(await this.call<{ chars: number }>('type', { hwnd, text }, t)), method: 'keys' as const }),
      async () => ({ ...(await this.call<{ chars: number }>('post_text', { hwnd, text }, t)), method: 'direct' as const }),
    );
  }

  async paste(hwnd: string): Promise<void> {
    await this.orDirect(
      () => this.call('paste', { hwnd }),
      () => this.call('post_paste', { hwnd }, 30000),
    );
  }

  async setClipboardFiles(path: string, asImage = false): Promise<void> {
    await this.call('clipboard_files', { path, image: asImage }, 15000);
  }

  childClasses(hwnd: string): Promise<Record<string, number>> {
    return this.call('child_classes', { hwnd });
  }

  /**
   * Windows read with the modern UI Automation client: the classic .NET client
   * returns WinUI 3 apps that host web content without a child window (the
   * WhatsApp app) as an empty frame. Decided per window from what each sees.
   */
  private readonly uia3Windows = new Set<string>();

  async uiaSnapshot(hwnd: string, opts: { maxNodes: number; maxDepth: number; budgetMs: number }): Promise<UiaSnapshotRaw> {
    if (this.uia3Windows.has(hwnd)) {
      try {
        return await this.uiCall<UiaSnapshotRaw>('uia3_snapshot', { hwnd, ...opts }, opts.budgetMs + 15000);
      } catch (e) {
        if (!(e instanceof CapabilityError) || e.code !== 'uia_unavailable') throw e;
        this.uia3Windows.delete(hwnd);
      }
    }
    const classic = await this.call<UiaSnapshotRaw>('uia_snapshot', { hwnd, ...opts }, opts.budgetMs + 15000);
    if (meaningfulNodes(classic.nodes) >= 8) return classic;
    try {
      const modern = await this.uiCall<UiaSnapshotRaw>('uia3_snapshot', { hwnd, ...opts }, opts.budgetMs + 15000);
      if (meaningfulNodes(modern.nodes) > meaningfulNodes(classic.nodes) + 3) {
        this.uia3Windows.add(hwnd);
        this.log.info('desktop.uia3_window', { classic: classic.nodes.length, modern: modern.nodes.length });
        return modern;
      }
    } catch {
      /* modern client unavailable: keep the classic result */
    }
    return classic;
  }

  /** Which reader a window uses (diagnostics). */
  uiaEngine(hwnd: string): 'classic' | 'modern' {
    return this.uia3Windows.has(hwnd) ? 'modern' : 'classic';
  }

  private ui(hwnd: string, cmd: string): string {
    return this.uia3Windows.has(hwnd) ? `uia3_${cmd}` : `uia_${cmd}`;
  }

  uiaDescribe(hwnd: string, rid: string): Promise<UiaNodeRaw | null> {
    return this.uiCall(this.ui(hwnd, 'describe'), { hwnd, rid }, 15000);
  }

  async uiaTexts(hwnd: string, rids: string[]): Promise<string[][]> {
    if (!rids.length) return [];
    const r = await this.uiCall<string[][] | null>(this.ui(hwnd, 'texts'), { hwnd, rids: rids.join('|'), budgetMs: 6000 }, 20000);
    return Array.isArray(r) ? r.map((x) => (Array.isArray(x) ? x.map(String) : [])) : [];
  }

  uiaAct(hwnd: string, rid: string, action: UiaAction, text = ''): Promise<{ method: string }> {
    return this.uiCall(this.ui(hwnd, 'act'), { hwnd, rid, action, text }, 20000);
  }

  uiaCenter(hwnd: string, rid: string): Promise<{ x: number; y: number }> {
    return this.uiCall(this.ui(hwnd, 'center'), { hwnd, rid }, 15000);
  }

  browserContext(hwnd: string, maxChars: number): Promise<BrowserContextRaw> {
    return this.call('browser_context', { hwnd, maxChars }, 30000);
  }

  async processWindows(pid: number): Promise<Array<RawWindow & { owner: string }>> {
    const r = await this.call<Array<RawWindow & { owner: string }> | (RawWindow & { owner: string }) | null>('proc_windows', { pid });
    return (Array.isArray(r) ? r : r ? [r] : []).map((w) => ({ ...normalize(w), owner: String(w.owner ?? '0') }));
  }

  /**
   * Drags with the left button along strokes (screen coordinates), in the target window only.
   * Falls back to posted mouse messages when Windows refuses simulated input.
   */
  async draw(hwnd: string, strokes: Array<Array<[number, number]>>): Promise<{ points: number; method: 'mouse' | 'direct' }> {
    const PEN_UP = 2147483647;
    const points = strokes.flatMap((s) => [...s.flatMap(([x, y]) => [Math.round(x), Math.round(y)]), PEN_UP, PEN_UP]);
    const t = 20000 + points.length * 20;
    return this.orDirect<{ points: number; method: 'mouse' | 'direct' }>(
      async () => ({ points: Number((await this.call<{ points: number }>('draw', { hwnd, points }, t)).points), method: 'mouse' as const }),
      async () => ({ points: Number((await this.call<{ points: number }>('post_draw', { hwnd, points }, t)).points), method: 'direct' as const }),
    );
  }

  async fileDialogs(): Promise<Array<{ hwnd: string; pid: number; owner: string; title: string }>> {
    const r = await this.call<Array<{ hwnd: string; pid: number; owner: string; title: string }> | null>('file_dialogs', {}, 15000);
    return (r ?? []).map((x) => ({ hwnd: String(x.hwnd), pid: Number(x.pid), owner: String(x.owner), title: String(x.title ?? '') }));
  }

  async fileDialogOpen(dialog: string, path: string): Promise<void> {
    await this.call('file_dialog_open', { hwnd: dialog, path }, 15000);
  }

  async fileDialogCancel(dialog: string): Promise<void> {
    await this.call('file_dialog_cancel', { hwnd: dialog }, 15000);
  }

  async clickScreen(hwnd: string, x: number, y: number): Promise<void> {
    await this.orDirect(
      () => this.call('click_screen', { hwnd, x, y }),
      () => this.call('post_click_screen', { hwnd, x, y }),
    );
  }

  async wheel(hwnd: string, x: number, y: number, notches: number): Promise<void> {
    await this.call('wheel', { hwnd, x, y, notches });
  }

  async readText(hwnd: string): Promise<string | null> {
    try {
      const r = await this.uiCall<{ available: boolean; text: string }>(this.uia3Windows.has(hwnd) ? 'uia3_readtext' : 'readtext', { hwnd }, 15000);
      return r.available ? String(r.text ?? '') : null;
    } catch {
      return null;
    }
  }

  async keys(hwnd: string, mods: number[], key: number): Promise<void> {
    await this.orDirect(
      () => this.call('keys', { hwnd, mods, key }),
      async () => {
        // Shortcuts need real modifier state, which direct delivery cannot give.
        if (mods.length) throw new CapabilityError('input_blocked', describe('input_blocked'), { dispatched: 'no' });
        await this.call('post_key', { hwnd, key });
      },
    );
  }

  async click(hwnd: string, x: number, y: number, button: 'left' | 'right', double: boolean): Promise<void> {
    await this.call('click', { hwnd, x, y, button, double });
  }

  dispose(): void {
    this.modernProc?.dispose();
    this.modernProc = null;
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

/** Elements beyond the window frame (title bar, system menu, caption buttons). */
export function meaningfulNodes(nodes: UiaNodeRaw[]): number {
  return nodes.filter((n) => !['window', 'titlebar', 'menubar', 'menuitem'].includes(n.role) && !(n.role === 'button' && /^(minimi[sz]e|maximi[sz]e|restore|close)$/i.test(n.name))).length;
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
    case 'input_blocked':
      return 'Windows blocked Keo’s simulated keyboard/mouse input, so nothing was sent. This happens when the app runs as administrator (run Keo the same way) or when security software blocks simulated input. Keo types text directly where it can, but keyboard shortcuts need simulated input.';
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
    case 'value_rejected':
      return 'The control refused text set through accessibility; nothing was entered.';
    case 'pointer_mismatch':
      return 'The mouse pointer did not arrive where Keo aimed, so nothing was clicked.';
    case 'not_focusable':
      return 'The control refused keyboard focus through accessibility; nothing was entered.';
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
