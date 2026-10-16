import type { WindowTarget } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { CapabilityError } from '../capabilities/types';
import type { DesktopBackend, RawWindow } from './backend';

export interface TargetRef {
  hwnd: string;
  pid: number;
  processName: string;
}

export function isAllowedProcess(processName: string, s: Settings): boolean {
  const n = processName.toLowerCase().replace(/\.exe$/, '');
  return s.permissions.allowedApps.some((a) => a.processName.toLowerCase().replace(/\.exe$/, '') === n);
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
    if (!w) throw new CapabilityError('target_gone', 'The target window no longer exists. Keo will not act on a different window.');
    if (w.pid !== ref.pid || w.processName.toLowerCase() !== ref.processName.toLowerCase()) {
      throw new CapabilityError('target_changed', 'The window handle now belongs to a different process. Keo will not act on it.');
    }
    if (!isAllowedProcess(w.processName, s)) throw new CapabilityError('target_not_allowed', `${w.processName} is not allow-listed.`);
    return w;
  }
}
