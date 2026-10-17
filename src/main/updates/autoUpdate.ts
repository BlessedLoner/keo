import type { UpdateDownload } from '../../shared/domain';
import type { Logger } from '../logging/logger';

/** The part of electron-updater's AppUpdater Keo uses (a fake in tests). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-available', fn: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', fn: () => void): unknown;
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', fn: (info: { version: string }) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Downloads new Keo versions from Keo's own GitHub Releases in the background
 * (installed builds, when update checks are on) and installs them when Keo
 * closes — or right away when the user clicks "Restart to update". The
 * installer keeps settings and data, like a manual install over the old one.
 */
export class AutoUpdate {
  private state: UpdateDownload = { state: 'none', version: null, percent: null, error: null };
  private lastCheck: number | null = null;
  private wired = false;

  constructor(
    private readonly updater: Updater | null,
    private readonly enabled: () => boolean,
    private readonly log: Logger,
    private readonly changed: (s: UpdateDownload) => void,
    private readonly notifyReady: (version: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  status(): UpdateDownload {
    return { ...this.state };
  }

  private set(p: Partial<UpdateDownload>): void {
    this.state = { ...this.state, ...p };
    this.changed(this.status());
  }

  private wire(u: Updater): void {
    if (this.wired) return;
    this.wired = true;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, percent: 0, error: null }));
    u.on('update-not-available', () => {
      if (this.state.state !== 'ready') this.set({ state: 'none', percent: null, error: null });
    });
    u.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent))) }));
    u.on('update-downloaded', (i) => {
      this.set({ state: 'ready', version: i.version, percent: 100, error: null });
      this.log.info('update.downloaded', { version: i.version });
      this.notifyReady(i.version);
    });
    u.on('error', (e) => {
      this.log.info('update.failed', { error: e.name });
      if (this.state.state !== 'ready') this.set({ state: 'failed', percent: null, error: 'The update could not be downloaded. Keo will try again later.' });
    });
  }

  /** Checks (at most daily unless forced) and downloads in the background. */
  async check(force = false): Promise<UpdateDownload> {
    const u = this.updater;
    if (!u || !this.enabled()) return this.status();
    if (this.state.state === 'ready' || this.state.state === 'downloading') return this.status();
    if (!force && this.lastCheck !== null && this.now() - this.lastCheck < DAY) return this.status();
    this.lastCheck = this.now();
    this.wire(u);
    try {
      await u.checkForUpdates();
    } catch (e) {
      this.log.info('update.check_failed', { error: (e as Error).name });
    }
    return this.status();
  }

  /** Restarts into the downloaded version. */
  install(): boolean {
    if (!this.updater || this.state.state !== 'ready') return false;
    this.log.info('update.install', { version: this.state.version });
    // Not silent: the installer window shows progress; Keo starts again afterwards.
    this.updater.quitAndInstall(false, true);
    return true;
  }
}
