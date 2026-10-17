import { BrowserWindow, globalShortcut, screen, type Rectangle } from 'electron';
import path from 'node:path';
import type { Logger } from '../logging/logger';
import type { Services } from '../services';

const COMPANION_W = 300;
const COMPANION_H = 120;
const COMMAND_W = 680;
const COMMAND_H = 500;

export interface ShortcutStatus {
  accelerator: string;
  enabled: boolean;
  registered: boolean;
  error: string | null;
}

const webPreferences = (preload: string) => ({
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: true,
  devTools: false,
});

/**
 * Owns the floating companion and the command bar. One instance of each,
 * created on demand and destroyed on shutdown (no orphans across restarts —
 * the app is single-instance).
 */
export class PresenceWindows {
  companion: BrowserWindow | null = null;
  command: BrowserWindow | null = null;
  private dragTimer: NodeJS.Timeout | null = null;
  private dragOffset = { x: 0, y: 0 };
  private shortcut: ShortcutStatus = { accelerator: '', enabled: false, registered: false, error: null };
  private quitting = false;

  constructor(
    private readonly services: Services,
    private readonly log: Logger,
    private readonly url: (hash: string) => string,
    private readonly preload: string,
    private readonly showMain: (view?: string) => void,
  ) {}

  // ---------------------------------------------------------------- companion
  syncCompanion(): void {
    const s = this.services.settings.get().companion;
    if (!s.enabled) {
      this.companion?.destroy();
      this.companion = null;
      return;
    }
    if (!this.companion || this.companion.isDestroyed()) this.createCompanion();
    this.companion?.setAlwaysOnTop(s.alwaysOnTop, 'floating');
  }

  private defaultPosition(): { x: number; y: number } {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - COMPANION_W - 16, y: wa.y + wa.height - COMPANION_H - 16 };
  }

  /** Keeps the companion fully visible on some display (monitors change, DPI changes). */
  private clamp(p: { x: number; y: number }): { x: number; y: number } {
    const rect: Rectangle = { x: p.x, y: p.y, width: COMPANION_W, height: COMPANION_H };
    const wa = screen.getDisplayMatching(rect).workArea;
    return {
      x: Math.min(Math.max(p.x, wa.x), wa.x + wa.width - COMPANION_W),
      y: Math.min(Math.max(p.y, wa.y), wa.y + wa.height - COMPANION_H),
    };
  }

  private createCompanion(): void {
    const s = this.services.settings.get().companion;
    const pos = this.clamp(s.x !== null && s.y !== null ? { x: s.x, y: s.y } : this.defaultPosition());
    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: COMPANION_W,
      height: COMPANION_H,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // never steal focus from the app Keo is working in
      show: false,
      hasShadow: false,
      alwaysOnTop: s.alwaysOnTop,
      title: 'Keo companion',
      backgroundColor: '#00000000',
      webPreferences: webPreferences(this.preload),
    });
    win.setAlwaysOnTop(s.alwaysOnTop, 'floating');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      if (this.companion === win) this.companion = null;
    });
    void win.loadURL(this.url('#companion'));
    this.companion = win;
  }

  setCompanionInteractive(interactive: boolean): void {
    this.companion?.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  /** Manual drag (non-focusable windows cannot use native drag regions). */
  companionDrag(phase: 'start' | 'end'): void {
    const win = this.companion;
    if (!win) return;
    if (phase === 'start') {
      const c = screen.getCursorScreenPoint();
      const [x, y] = win.getPosition() as [number, number];
      this.dragOffset = { x: c.x - x, y: c.y - y };
      if (this.dragTimer) clearInterval(this.dragTimer);
      this.dragTimer = setInterval(() => {
        if (win.isDestroyed()) return;
        const p = screen.getCursorScreenPoint();
        const next = this.clamp({ x: p.x - this.dragOffset.x, y: p.y - this.dragOffset.y });
        win.setPosition(next.x, next.y);
      }, 16);
    } else {
      if (this.dragTimer) clearInterval(this.dragTimer);
      this.dragTimer = null;
      const [x, y] = win.getPosition() as [number, number];
      this.services.settings.update({ companion: { x, y } });
    }
  }

  onDisplaysChanged(): void {
    const win = this.companion;
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition() as [number, number];
    const next = this.clamp({ x, y });
    if (next.x !== x || next.y !== y) win.setPosition(next.x, next.y);
  }

  // ---------------------------------------------------------------- command bar
  private createCommand(): BrowserWindow {
    const win = new BrowserWindow({
      width: COMMAND_W,
      height: COMMAND_H,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      title: 'Keo command bar',
      backgroundColor: '#00000000',
      webPreferences: webPreferences(this.preload),
    });
    win.setAlwaysOnTop(true, 'floating');
    win.on('blur', () => {
      // Keep it open while Keo is working or waiting on the user; otherwise hide on blur.
      const p = this.services.presence.get();
      if (!this.quitting && p.state === 'idle' && !win.isDestroyed()) win.hide();
    });
    win.on('closed', () => {
      if (this.command === win) this.command = null;
    });
    void win.loadURL(this.url('#command'));
    this.command = win;
    return win;
  }

  showCommandBar(): void {
    // Remember what the user was looking at before the bar takes focus ("explain this error").
    void this.services
      .noteActiveWindow()
      .catch(() => undefined)
      .finally(() => this.revealCommandBar());
  }

  private revealCommandBar(): void {
    const win = this.command && !this.command.isDestroyed() ? this.command : this.createCommand();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({ x: Math.round(d.x + (d.width - COMMAND_W) / 2), y: Math.round(d.y + d.height * 0.18), width: COMMAND_W, height: COMMAND_H });
    const show = () => {
      win.show();
      win.focus();
      win.webContents.send('presence:command', { type: 'focus_input' });
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show);
    else show();
  }

  hideCommandBar(): void {
    if (this.command && !this.command.isDestroyed()) this.command.hide();
  }

  toggleCommandBar(): void {
    if (this.command && !this.command.isDestroyed() && this.command.isVisible() && this.command.isFocused()) this.hideCommandBar();
    else this.showCommandBar();
  }

  // ---------------------------------------------------------------- shortcut
  /** (Re-)registers the global command-bar shortcut from settings and records the outcome. */
  syncShortcut(): ShortcutStatus {
    const s = this.services.settings.get().shortcuts;
    if (this.shortcut.registered && this.shortcut.accelerator) globalShortcut.unregister(this.shortcut.accelerator);
    this.shortcut = { accelerator: s.commandBar, enabled: s.commandBarEnabled, registered: false, error: null };
    if (!s.commandBarEnabled) return this.shortcut;
    try {
      const ok = globalShortcut.register(s.commandBar, () => this.toggleCommandBar());
      this.shortcut.registered = ok && globalShortcut.isRegistered(s.commandBar);
      if (!this.shortcut.registered) this.shortcut.error = `${s.commandBar} is already used by another application. Choose a different shortcut in Settings → Voice & shortcuts.`;
    } catch (e) {
      this.shortcut.error = `Invalid shortcut: ${(e as Error).message}`;
    }
    this.log.info('shortcut.register', { accelerator: s.commandBar, registered: this.shortcut.registered });
    return this.shortcut;
  }

  shortcutStatus(): ShortcutStatus {
    return { ...this.shortcut };
  }

  roleOf(id: number): 'companion' | 'command' | null {
    if (this.companion && !this.companion.isDestroyed() && this.companion.webContents.id === id) return 'companion';
    if (this.command && !this.command.isDestroyed() && this.command.webContents.id === id) return 'command';
    return null;
  }

  broadcast(channel: string, payload: unknown): void {
    for (const w of [this.companion, this.command]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  openMain(view?: string): void {
    this.showMain(view);
  }

  shutdown(): void {
    this.quitting = true;
    if (this.dragTimer) clearInterval(this.dragTimer);
    globalShortcut.unregisterAll();
    this.companion?.destroy();
    this.command?.destroy();
    this.companion = null;
    this.command = null;
  }
}

export const presenceWindowPaths = { preload: (dir: string) => path.join(dir, '../preload/index.js') };
