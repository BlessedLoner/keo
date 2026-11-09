import { CapabilityError } from '../capabilities/types';

/** What the Electron shell provides for Full control (no-ops in tests). */
export interface ControlUi {
  /** The “Keo is using your computer” banner with Stop (content-protected: not in screen pictures). */
  showBanner(): void;
  hideBanner(): void;
  /** The banner's place in physical screen pixels, or null. */
  bannerBounds(): { x: number; y: number; width: number; height: number } | null;
  /** Hides the banner for one action whose point is under it (so the click reaches the app). */
  bannerAside(aside: boolean): void;
  /** Keo's own windows get out of the way (minimised) so they cover nothing; restored at the end. */
  stepKeoAside(): void;
  restoreKeo(): void;
  /** Esc as a global Stop key while Keo is in control (released for Keo's own Esc presses). */
  stopKey(on: boolean): void;
}

export interface ControlSessionDeps {
  ui: () => ControlUi | null;
  /** Time since the last keyboard/mouse input (Keo's own included). */
  idleMs(): Promise<number>;
  /** Stops everything (turns, tasks, jobs). */
  stopAll(): void;
  log: { info(event: string, data?: Record<string, unknown>): void };
  /** Seconds without a Keo action before control is handed back. */
  idleEndMs?: number;
  /** Pause after Keo steps aside, before the first look or action (tests use 0). */
  settleMs?: number;
}

/**
 * One stretch of Keo using the computer: it begins with the first look or action (the banner
 * shows, Keo's window steps aside, Esc becomes Stop) and ends when Keo has been quiet for a while,
 * when the user presses Stop or Esc, or when the user moves the mouse or types (Keo hands the
 * computer back the moment the user touches it).
 */
export class ControlSession {
  private active = false;
  private lastActionEnd = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: ControlSessionDeps) {}

  isActive(): boolean {
    return this.active;
  }

  /** Starts (or keeps) control without an action: before Keo looks at the screen. */
  async enter(): Promise<void> {
    if (this.active) {
      this.armIdle();
      return;
    }
    this.active = true;
    this.lastActionEnd = 0;
    this.d.ui()?.showBanner();
    this.d.ui()?.stepKeoAside();
    this.d.ui()?.stopKey(true);
    this.d.log.info('fullcontrol.begin');
    const settle = this.d.settleMs ?? 350;
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    this.armIdle();
  }

  /**
   * Right before an action. `userApproved` = the user just approved this action by hand (their
   * click on Approve is not “taking over”). Returns what to call when the action is done.
   */
  async begin(signal: AbortSignal, opts: { point?: { x: number; y: number }; pressesEscape?: boolean; userApproved?: boolean }): Promise<() => void> {
    if (signal.aborted) throw new CapabilityError('cancelled', 'Stopped.', { dispatched: 'no' });
    const wasActive = this.active;
    await this.enter();
    if (wasActive && this.lastActionEnd && !opts.userApproved) {
      const idle = await this.d.idleMs().catch(() => Number.POSITIVE_INFINITY);
      const sinceKeo = Date.now() - this.lastActionEnd;
      // Input newer than Keo's own last action came from the user.
      if (idle + 400 < sinceKeo) {
        this.end('user_took_over');
        // Everything else stops right after this action is recorded as not done (nothing was sent).
        setTimeout(() => {
          try {
            this.d.stopAll();
          } catch {
            /* Keo is shutting down */
          }
        }, 50).unref?.();
        throw new CapabilityError('cancelled', 'The user moved the mouse or typed, so Keo stopped and handed the computer back. Ask before continuing.', { dispatched: 'no' });
      }
    }
    if (this.timer) clearTimeout(this.timer);
    const b = opts.point ? this.d.ui()?.bannerBounds() : null;
    const under = !!(b && opts.point && opts.point.x >= b.x - 8 && opts.point.x <= b.x + b.width + 8 && opts.point.y >= b.y - 8 && opts.point.y <= b.y + b.height + 8);
    if (under) this.d.ui()?.bannerAside(true);
    if (opts.pressesEscape) this.d.ui()?.stopKey(false);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (under) this.d.ui()?.bannerAside(false);
      if (opts.pressesEscape && this.active) this.d.ui()?.stopKey(true);
      this.lastActionEnd = Date.now();
      this.armIdle();
    };
  }

  /** A new request from the user (typed or said): their typing in Keo is not taking over. */
  userSpoke(): void {
    this.lastActionEnd = 0;
  }

  /** Hands the computer back: banner gone, Esc released, Keo's window back. */
  end(reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active) return;
    this.active = false;
    this.lastActionEnd = 0;
    this.d.ui()?.stopKey(false);
    this.d.ui()?.hideBanner();
    this.d.ui()?.restoreKeo();
    this.d.log.info('fullcontrol.end', { reason });
  }

  private armIdle(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end('idle'), this.d.idleEndMs ?? 25_000);
    this.timer.unref?.();
  }
}
