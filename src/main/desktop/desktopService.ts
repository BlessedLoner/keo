import type { WindowTarget } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { CapabilityError } from '../capabilities/types';
import type { DesktopBackend, RawWindow } from './backend';

export interface TargetRef {
  hwnd: string;
  pid: number;
  processName: string;
}

/** "Notepad", "notepad" and "notepad.exe" all name the same process. */
export function normalizeProcess(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, '');
}

export function isAllowedProcess(processName: string, s: Settings): boolean {
  const n = normalizeProcess(processName);
  return s.permissions.allowedApps.some((a) => normalizeProcess(a.processName) === n);
}

export function toTarget(w: RawWindow, s: Settings): WindowTarget {
  return {
    hwnd: w.hwnd,
    pid: w.pid,
    processName: w.processName,
    title: w.title,
    className: w.className,
    minimized: w.minimized,
    bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
    allowed: isAllowedProcess(w.processName, s),
  };
}

/**
 * Identity-checked access to desktop windows. Every action re-resolves the
 * target immediately before acting and fails (never substitutes) when the
 * window is gone, belongs to a different process, or is not allow-listed.
 */
export class DesktopService {
  constructor(
    readonly backend: DesktopBackend,
    private readonly ownPid: number = process.pid,
  ) {}

  /**
   * Single owner of the physical keyboard, mouse and foreground window: work
   * that controls the desktop (an approved desktop action, a live chat
   * reply) runs one at a time, in order. Reading/research never waits here.
   */
  private inputTail: Promise<unknown> = Promise.resolve();
  private owner: string | null = null;
  private waiting = 0;

  /**
   * Called when work takes over the desktop: Keo's own floating windows (the research results
   * window) get out of the way so they cannot cover or take focus from the target app. Returns
   * what to call when the work is done.
   */
  stepAside: ((owner: string) => (() => void) | void) | null = null;

  inputOwner(): { owner: string | null; waiting: number } {
    return { owner: this.owner, waiting: this.waiting };
  }

  async exclusive<T>(owner: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prev = this.inputTail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.inputTail = prev.then(() => mine);
    this.waiting++;
    try {
      await Promise.race([
        prev,
        new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new CapabilityError('cancelled', 'Cancelled while waiting for another desktop action to finish.', { dispatched: 'no' }));
          signal?.addEventListener('abort', () => reject(new CapabilityError('cancelled', 'Cancelled while waiting for another desktop action to finish.', { dispatched: 'no' })), { once: true });
        }),
      ]);
    } catch (e) {
      this.waiting--;
      release(); // keep the queue moving for those behind
      throw e;
    }
    this.waiting--;
    this.owner = owner;
    let restore: (() => void) | void;
    try {
      restore = this.stepAside?.(owner);
    } catch {
      restore = undefined;
    }
    try {
      return await fn();
    } finally {
      this.owner = null;
      try {
        restore?.();
      } catch {
        /* a window that is gone needs no restoring */
      }
      release();
    }
  }

  support() {
    return this.backend.support();
  }

  async listWindows(s: Settings, includeAll: boolean): Promise<WindowTarget[]> {
    const all = await this.backend.list();
    return all
      .filter((w) => w.pid !== this.ownPid)
      .map((w) => toTarget(w, s))
      .filter((w) => includeAll || w.allowed);
  }

  /** Re-validates identity right before an action. */
  async resolve(ref: TargetRef, s: Settings): Promise<RawWindow> {
    if (!isAllowedProcess(ref.processName, s)) {
      throw new CapabilityError('target_not_allowed', `${ref.processName} is not in the allowed applications list.`);
    }
    const w = await this.backend.info(ref.hwnd);
    if (!w) throw new CapabilityError('target_gone', 'No window with that handle exists (it was closed, or the handle was not taken from a current window list). Keo will not act on a different window. Use desktop__list_windows for current handles.');
    if (w.pid !== ref.pid || normalizeProcess(w.processName) !== normalizeProcess(ref.processName)) {
      throw new CapabilityError('target_changed', 'That window handle belongs to a different process than requested. Keo will not act on it. Use desktop__list_windows for current handles.');
    }
    if (!isAllowedProcess(w.processName, s)) throw new CapabilityError('target_not_allowed', `${w.processName} is not allow-listed.`);
    return w;
  }
}
