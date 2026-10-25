import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, Notification, screen, ipcMain, nativeImage, nativeTheme, type OpenDialogOptions, protocol, safeStorage, session, shell } from 'electron';
import { UpdateService } from './updates/updateService';
import { AutoUpdate } from './updates/autoUpdate';
import { realPorcupine } from './voice/porcupineEngine';
import { autoUpdater } from 'electron-updater';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pushChannels } from '../shared/ipc';
import { Win32Backend } from './desktop/backend';
import { APP_ID, resolveProfile } from './env/profile';
import { createHandlers } from './ipc/handlers';
import { originOf, registerIpc } from './ipc/router';
import { Logger } from './logging/logger';
import { TestProvider } from './providers/testProvider';
import type { SecretCipher } from './secrets/secretStore';
import { Services } from './services';
import { errorMessage } from './util/errors';
import { electronImageTools, ElectronWindowCapture } from './vision/electronCapture';
import { buildCsp } from './window/csp';
import { PresenceWindows } from './window/presenceWindows';
import { reportHtml } from './research/results';

// ---------------------------------------------------------------------------
// Identity & isolated profile (must happen before "ready")
// ---------------------------------------------------------------------------
app.setName('Keo');
app.setAppUserModelId(APP_ID);
const profile = resolveProfile(app.getPath('appData'), process.env, app.isPackaged);
fs.mkdirSync(profile.userData, { recursive: true });
app.setPath('userData', profile.userData);
app.setPath('sessionData', path.join(profile.userData, 'session'));
app.setAppLogsPath(profile.logsDir);

const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const TRUSTED_ORIGIN = (DEV_URL ? originOf(DEV_URL) : null) ?? 'app://keo';
const RENDERER_DIR = path.join(__dirname, '../renderer');
const TEST_PROVIDER = process.env.KEO_ENABLE_TEST_PROVIDER === '1';
const SMOKE = process.env.KEO_SMOKE === '1';

const E2E_DESKTOP = process.env.KEO_E2E_DESKTOP === '1';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const log = new Logger(profile.logsDir, !app.isPackaged && !SMOKE);
const updates = new UpdateService(app.getVersion(), log);
log.info('app.starting', { version: app.getVersion(), profile: profile.profile, packaged: app.isPackaged, electron: process.versions.electron });

if (!app.requestSingleInstanceLock()) {
  log.info('app.second_instance_exit', {});
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;

const cipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

process.on('uncaughtException', (e) => log.error('process.uncaught_exception', { error: errorMessage(e) }));
process.on('unhandledRejection', (e) => log.error('process.unhandled_rejection', { error: errorMessage(e) }));

// ---------------------------------------------------------------------------
// Renderer protocol: app://keo/* served from the bundled renderer only
// ---------------------------------------------------------------------------
function registerAppProtocol(): void {
  const csp = buildCsp(false);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'keo') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body, {
        headers: { 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cross-origin-opener-policy': 'same-origin' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

// ---------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------
function hardenSession(): void {
  const ses = session.defaultSession;
  const fromTrusted = (url: string | undefined) => !!url && originOf(url) === TRUSTED_ORIGIN;
  // Only microphone audio, only for Keo's own page; everything else denied.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    const ok = permission === 'media' && fromTrusted(details.requestingUrl) && (media.mediaTypes ?? []).every((t) => t === 'audio') && wc === mainWindow?.webContents;
    log.info('permission.request', { permission, granted: ok });
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && fromTrusted(origin));
  ses.setDevicePermissionHandler(() => false);
  // The renderer never talks to the network directly; all provider traffic goes through main.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const allowed = u.startsWith('app://keo/') || u.startsWith('data:') || u.startsWith('devtools://') || (DEV_URL && (u.startsWith(TRUSTED_ORIGIN) || u.startsWith(TRUSTED_ORIGIN.replace('http', 'ws'))));
    if (!allowed) log.warn('network.blocked_renderer_request', { scheme: u.split(':')[0] });
    cb({ cancel: !allowed });
  });
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(true, TRUSTED_ORIGIN)] } });
    });
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.on('will-navigate', (ev, url) => {
    if (originOf(url) !== TRUSTED_ORIGIN) {
      ev.preventDefault();
      log.warn('navigation.blocked', { scheme: url.split(':')[0] });
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(show = true): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'Keo',
    backgroundColor: '#0a0c11',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0c11', symbolColor: '#aeb8cc', height: 38 },
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged,
      // Hands-free voice records and speaks in this window; keep its timers and
      // audio running at full speed while it is minimized or in the background.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => {
    if (show && !SMOKE && !E2E_DESKTOP) win.show();
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  void win.loadURL(DEV_URL ?? 'app://keo/index.html');
  return win;
}

function push(channel: string, payload: unknown): void {
  if (!(pushChannels as readonly string[]).includes(channel)) return;
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  presenceWindows?.broadcast(channel, payload);
}

let presenceWindows: PresenceWindows | null = null;
let autoUpdate: AutoUpdate | null = null;

/**
 * Voice mode records and speaks through the main window. If the user closed it
 * (Keo keeps running with the companion), a hidden one is loaded for that.
 */
function ensureVoiceWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) return Promise.resolve();
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(false);
  const wc = mainWindow.webContents;
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, 1200); // let the app subscribe to voice commands
    if (!wc.isLoading()) return done();
    wc.once('did-finish-load', done);
    setTimeout(resolve, 15000);
  });
}

/** Report files being rendered right now: the only file:// addresses the report session may load. */
const renderingReports = new Set<string>();
let reportSessionReady = false;

/**
 * A separate in-memory session for rendering reports. Keo's own session refuses everything but
 * app://keo (renderer hardening); this one refuses everything but the report file being rendered
 * and the data: pictures inside it — no network, no permissions, nothing kept.
 */
function reportSession(): Electron.Session {
  const ses = session.fromPartition('keo-report-render');
  if (!reportSessionReady) {
    reportSessionReady = true;
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onBeforeRequest((details, cb) => {
      const u = details.url;
      const allowed = u.startsWith('data:') || renderingReports.has(normalizeFileUrl(u));
      if (!allowed) log.warn('report.blocked_request', { scheme: u.split(':')[0] });
      cb({ cancel: !allowed });
    });
  }
  return ses;
}

const normalizeFileUrl = (u: string) => {
  try {
    return decodeURIComponent(new URL(u).href).toLowerCase();
  } catch {
    return '';
  }
};

/**
 * Turns a research report (self-contained HTML: inline styles, data: images, no scripts) into a
 * PDF or a PNG in a hidden, sandboxed window with JavaScript off, in its own locked-down session;
 * the file is loaded from Keo's temp folder and the window is destroyed afterwards.
 */
async function renderReport(html: string, kind: 'pdf' | 'png'): Promise<Buffer> {
  const file = path.join(app.getPath('temp'), `keo-report-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const key = normalizeFileUrl(pathToFileURL(file).href);
  renderingReports.add(key);
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: reportSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(file);
    if (kind === 'pdf') return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    // JavaScript is off, so the page height comes from the picture: capture tall, then cut the empty background off the bottom.
    win.setContentSize(1280, 4000);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    if (bmp.length < width * height * 4) return img.toPNG();
    const bg = bmp.readUInt32LE((height - 1) * width * 4);
    let last = height - 1;
    rows: for (; last > 0; last--) {
      const row = last * width * 4;
      for (let x = 0; x < width; x += 2) if (bmp.readUInt32LE(row + x * 4) !== bg) break rows;
    }
    return img.crop({ x: 0, y: 0, width, height: Math.min(height, last + 32) }).toPNG();
  } finally {
    renderingReports.delete(key);
    win.destroy();
    fs.rm(file, { force: true }, () => undefined);
  }
}

/**
 * Says text with Windows' own voice (System.Speech) in a short-lived PowerShell process — the
 * fallback when the app's voice does not start. The text arrives on stdin, never on the command line.
 */
function windowsSpeak(text: string): Promise<void> {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$t = [Console]::In.ReadToEnd()',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$en = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "en-*" } | Select-Object -First 1',
    'if ($en) { $s.SelectVoice($en.VoiceInfo.Name) }',
    '$s.SetOutputToDefaultAudioDevice()',
    '$s.Speak($t)',
    '$s.Dispose()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const t = setTimeout(() => p.kill(), 15_000 + text.length * 120);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.stdin.end(text, 'utf8');
  });
}

/**
 * A picture of the display under the mouse, for Keo's pencil (taken before the drawing layer opens,
 * so it shows exactly what the user sees). Positions are in screen DIPs; `toScreen` turns one into
 * physical desktop pixels (what window positions use).
 */
async function captureScreen(): Promise<{ png: Buffer; width: number; height: number; bounds: { x: number; y: number; width: number; height: number }; toScreen(x: number, y: number): { x: number; y: number } }> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false });
  const src = sources.find((x) => x.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
  if (!src || src.thumbnail.isEmpty()) throw new Error('the screen could not be captured');
  const img = src.thumbnail;
  const { width, height } = img.getSize();
  return { png: img.toPNG(), width, height, bounds: display.bounds, toScreen: (x, y) => screen.dipToScreenPoint({ x, y }) };
}

/**
 * A picture in a format Keo's image tools cannot open (WebP, AVIF, GIF) as a PNG of side×side,
 * letterboxed on white: shown by Chromium in a hidden window of the locked-down report session
 * (JavaScript off, no network) and captured.
 */
async function convertImage(bytes: Buffer, mime: string, side: number): Promise<Buffer> {
  if (!/^image\/(webp|avif|gif)$/.test(mime)) throw new Error('unsupported picture type');
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${side}px;height:${side}px;overflow:hidden;background:#fff}img{width:${side}px;height:${side}px;object-fit:contain;display:block}</style><img src="data:${mime};base64,${bytes.toString('base64')}">`;
  const file = path.join(app.getPath('temp'), `keo-picture-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const key = normalizeFileUrl(pathToFileURL(file).href);
  renderingReports.add(key);
  const win = new BrowserWindow({ show: false, width: side, height: side, useContentSize: true, webPreferences: { session: reportSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 150));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: side, height: side });
    const png = img.resize({ width: side, height: side }).toPNG();
    if (!png.length) throw new Error('empty picture');
    return png;
  } finally {
    renderingReports.delete(key);
    win.destroy();
    fs.rm(file, { force: true }, () => undefined);
  }
}

function showMain(view?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!view) return;
  // A window that is still loading would miss the message: send it once the page is there.
  const wc = mainWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => !wc.isDestroyed() && wc.send('presence:command', { type: 'navigate', view }));
  else wc.send('presence:command', { type: 'navigate', view });
}

const rendererUrl = (hash: string) => `${DEV_URL ?? 'app://keo/index.html'}${hash}`;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  showMain();
});

app.whenReady().then(() => {
  try {
    registerAppProtocol();
    hardenSession();
    services = new Services({
      profile,
      cipher,
      desktopBackend: new Win32Backend(profile.runtimeDir, log),
      captureSource: new ElectronWindowCapture(),
      imageTools: electronImageTools,
      clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
      documentsDir: app.getPath('documents'),
      videosDir: app.getPath('videos'),
      homeDir: app.getPath('home'),
      openPath: async (p) => (await shell.openPath(p)) === '',
      showInFolder: (p) => shell.showItemInFolder(p),
      pickVideo: async (what) => {
        const opts: OpenDialogOptions =
          what === 'clips_folder'
            ? { title: 'Choose the folder with your clips', properties: ['openDirectory'] }
            : what === 'music'
              ? { title: 'Choose a music file (your own or licensed)', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'] }] }
              : { title: 'Choose the template video', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', '3gp'] }] };
        const r = await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      renderReport: (html, kind) => renderReport(html, kind),
      convertImage: (bytes, mime, side) => convertImage(bytes, mime, side),
      windowsSpeak: (text) => windowsSpeak(text),
      captureScreen: () => captureScreen(),
      attachmentImages: {
        // Any picture as a JPEG the model can see (at most maxSide) and a small thumbnail.
        prepare: async (bytes, mime, maxSide) => {
          let img = /^image\/(webp|avif|gif)$/.test(mime) ? nativeImage.createFromBuffer(await convertImage(bytes, mime, maxSide)) : nativeImage.createFromBuffer(bytes);
          if (img.isEmpty()) throw new Error('unreadable picture');
          const { width, height } = img.getSize();
          const k = Math.min(1, maxSide / Math.max(width, height));
          if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' });
          const t = Math.min(1, 240 / Math.max(width, height));
          const thumb = img.resize({ width: Math.max(1, Math.round(width * t)), height: Math.max(1, Math.round(height * t)), quality: 'good' });
          return { jpeg: img.toJPEG(86), thumb: thumb.toJPEG(76) };
        },
      },
      testProvider: TEST_PROVIDER ? new TestProvider() : null,
      logger: log,
      // "Sign in with Google" opens Google's own page in the user's browser (https only).
      openBrowser: async (url) => {
        if (!url.startsWith('https://accounts.google.com/')) throw new Error('Not a Google sign-in page.');
        await shell.openExternal(url);
      },
    });
    services.setPush(push);
    const svcForUpdates = services;
    // Installed builds only: a development run has no installer to update.
    autoUpdate = new AutoUpdate(
      app.isPackaged ? autoUpdater : null,
      () => svcForUpdates.settings.get().updates.check,
      log,
      (st) => push('update:changed', st),
      (version) => svcForUpdates.ui.notify('Keo update ready', `Keo ${version} is downloaded. It installs when you close Keo, or choose “Restart to update”.`),
    );
    // Keo often runs for days in the background: look again every few hours (the check itself is at most daily).
    setInterval(() => void autoUpdate?.check(), 6 * 60 * 60 * 1000).unref();
    const handlers = createHandlers(services, {
      appInfo: () => ({
        name: 'Keo',
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        packaged: app.isPackaged,
        testProviderEnabled: TEST_PROVIDER,
      }),
      openPath: async (p) => (await shell.openPath(p)) === '',
      displays: () => {
        const main = screen.getPrimaryDisplay().id;
        return screen.getAllDisplays().map((d) => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor, primary: d.id === main }));
      },
      openExternal: (url) => shell.openExternal(url),
      copyText: (text) => clipboard.writeText(text),
      // Installed builds only (a development run would always look outdated).
      checkUpdate: async (force) => {
        if (!app.isPackaged && !force) return null;
        const [info, download] = await Promise.all([updates.check(force), autoUpdate!.check(force)]);
        return { ...info, download };
      },
      installUpdate: () => autoUpdate?.install() ?? false,
      pickSaveFile: async (defaultName) => {
        const r = await dialog.showSaveDialog(mainWindow ?? undefined!, { title: 'Export projects and workflows', defaultPath: defaultName, filters: [{ name: 'Keo export', extensions: ['json'] }] });
        return r.canceled ? null : (r.filePath ?? null);
      },
      pickOpenFile: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title: 'Import projects and workflows', properties: ['openFile'], filters: [{ name: 'Keo export', extensions: ['json'] }] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      hideResults: () => presenceWindows?.hideResults(),
      hideVideo: () => presenceWindows?.hideVideo(),
      pickFfmpeg: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title: 'Choose ffmpeg.exe (ffprobe.exe must be in the same folder)', properties: ['openFile'], filters: [{ name: 'ffmpeg', extensions: ['exe'] }] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      currentMarks: () => presenceWindows?.currentMarks() ?? null,
      pickWakeModel: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title: 'Choose your trained wake word (.ppn for Windows)', properties: ['openFile'], filters: [{ name: 'Porcupine wake word', extensions: ['ppn'] }] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      pickFolder: async (title) => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title, properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      pickFiles: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
          title: 'Attach photos or files',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Photos and documents', extensions: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'pdf', 'docx', 'pptx', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'log', 'js', 'ts', 'tsx', 'py', 'java', 'cs', 'cpp', 'c', 'go', 'rs', 'sql', 'css', 'yaml', 'yml'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        return r.canceled ? [] : r.filePaths;
      },
      // The screen as the user sees it, with Keo's main window out of the way for a moment.
      screenshotBehindKeo: async () => {
        const w = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
        w?.setOpacity(0);
        try {
          await new Promise((res) => setTimeout(res, 260));
          return (await captureScreen()).png;
        } finally {
          w?.setOpacity(1);
        }
      },
      pickExecutable: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title: 'Choose an application', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['exe'] }] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
      openMain: (view) => showMain(view),
      showCommandBar: () => presenceWindows?.showCommandBar(),
      hideCommandBar: () => presenceWindows?.hideCommandBar(),
      hideCompanion: () => presenceWindows?.syncCompanion(),
      broadcastPresence: (channel, payload) => presenceWindows?.broadcast(channel, payload),
      setCompanionInteractive: (b) => presenceWindows?.setCompanionInteractive(b),
      companionDrag: (phase) => presenceWindows?.companionDrag(phase),
      shortcutStatus: () => presenceWindows?.shortcutStatus() ?? { accelerator: '', enabled: false, registered: false, error: 'Not started.' },
      voiceShortcutStatus: () => presenceWindows?.voiceShortcutStatus() ?? { accelerator: '', enabled: false, registered: false, error: 'Not started.' },
      pencilShortcutStatus: () => presenceWindows?.pencilShortcutStatus() ?? { accelerator: '', enabled: false, registered: false, error: 'Not started.' },
      quit: () => app.quit(),
    });
    const svc = services;
    presenceWindows = new PresenceWindows(svc, log, rendererUrl, path.join(__dirname, '../preload/index.js'), showMain);
    svc.desktop.stepAside = () => presenceWindows?.stepAsideResults();
    svc.ui = {
      showCommandBar: () => presenceWindows?.showCommandBar(),
      showMain: (view) => showMain(view),
      // Windows notification (no focus change); clicking it opens Keo on the Tasks view.
      ensureVoiceWindow: () => ensureVoiceWindow(),
      showResults: () => presenceWindows?.showResults(),
      showVideo: () => presenceWindows?.showVideo(),
      showPencil: (bounds) => presenceWindows?.showPencil(bounds),
      hidePencil: () => presenceWindows?.hidePencil(),
      showKeoMode: () => presenceWindows?.showKeoMode(),
      showMarks: (bounds, marks, seconds) => presenceWindows?.showMarks(bounds, marks, seconds),
      hideKeoMode: () => presenceWindows?.hideKeoMode(),
      keoModeOpen: () => !!presenceWindows?.keoMode,
      mainFocused: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
      notify: (title, body, view = 'tasks') => {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body: body.slice(0, 240), silent: false });
        n.on('click', () => showMain(view));
        n.show();
      },
    };
    registerIpc(
      ipcMain,
      handlers,
      {
        trustedOrigin: TRUSTED_ORIGIN,
        roleOf: (id) => (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === id ? 'main' : (presenceWindows?.roleOf(id) ?? null)),
      },
      log,
    );
    const recovered = services.start();
    log.info('app.ready', { profile: profile.profile, ...recovered.recovery, interruptedMessages: recovered.interruptedMessages, secretStorage: cipher.isAvailable() });
    mainWindow = createWindow();
    if (E2E_DESKTOP && !app.isPackaged) {
      const out = process.env.KEO_E2E_OUT ?? path.join(profile.userData, 'e2e-desktop.json');
      void import('./devtools/e2eDesktop').then(({ runDesktopE2E }) =>
        runDesktopE2E(svc, { electronPath: process.execPath, fixtureDir: path.join(__dirname, '../../tests/fixtures/fake-whatsapp'), outFile: out, workDir: profile.userData }).finally(() => app.quit()),
      );
    } else if (SMOKE) {
      runSmoke(mainWindow);
    } else {
      // Desktop presence: companion, global shortcut and (if enabled) wake word.
      presenceWindows.syncCompanion();
      presenceWindows.syncShortcut();
      void svc.wake.apply();
      let lastShortcut = JSON.stringify(svc.settings.get().shortcuts);
      let lastCompanion = JSON.stringify({ e: svc.settings.get().companion.enabled, t: svc.settings.get().companion.alwaysOnTop });
      let lastDock = svc.settings.get().companion.dock;
      svc.settings.onChange((st) => {
        const sc = JSON.stringify(st.shortcuts);
        if (sc !== lastShortcut) {
          lastShortcut = sc;
          presenceWindows?.syncShortcut();
        }
        const cp = JSON.stringify({ e: st.companion.enabled, t: st.companion.alwaysOnTop });
        if (cp !== lastCompanion) {
          lastCompanion = cp;
          presenceWindows?.syncCompanion();
        }
        // A new edge chosen in Settings (a drag places the bar itself).
        if (st.companion.dock !== lastDock) {
          lastDock = st.companion.dock;
          presenceWindows?.onDisplaysChanged();
        }
      });
      screen.on('display-removed', () => presenceWindows?.onDisplaysChanged());
      screen.on('display-metrics-changed', () => presenceWindows?.onDisplaysChanged());
    }
  } catch (err) {
    log.error('app.startup_failed', { error: errorMessage(err) });
    dialog.showErrorBox('Keo could not start', errorMessage(err));
    app.exit(1);
  }
});

// Closing the main window keeps Keo running in the companion (if enabled);
// with no companion, closing the last window quits.
app.on('window-all-closed', () => {
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (e) => {
  if (shuttingDown || !services) return;
  e.preventDefault();
  shuttingDown = true;
  presenceWindows?.shutdown();
  presenceWindows = null;
  services
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      services = null;
      app.quit();
    });
});

/**
 * Development-only visual review (KEO_SMOKE_SHOTS=<dir>, never in packaged
 * builds): seeds synthetic data through the normal IPC bridge in the
 * disposable smoke profile and screenshots each view. The approval request it
 * creates targets a fake window handle and is never approved.
 */
async function captureViews(win: BrowserWindow, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  win.setSize(1360, 860);
  // Hidden windows are not repainted reliably; show it (without stealing focus) while capturing.
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
  const js = (code: string) => win.webContents.executeJavaScript(`(async () => { const call = async (ch, input) => { const r = await window.keo.invoke(ch, input); if (!r.ok) throw new Error(r.error.message); return r.value; }; ${code} })()`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The first-run welcome, as a brand-new user sees it (no provider yet).
  await js(`await call('settings:update', { patch: { activeProvider: null, ui: { onboarded: false } } });`);
  await wait(1200);
  fs.writeFileSync(path.join(dir, 'welcome.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('.onboarding button')].find(b => b.textContent.trim() === 'Next')?.click();`);
  await wait(700);
  fs.writeFileSync(path.join(dir, 'welcome-provider.png'), (await win.webContents.capturePage()).toPNG());
  await js(`await call('settings:update', { patch: { activeProvider: 'test', ui: { onboarded: true } } });`);
  await wait(500);
  await js(`
    await call('settings:update', { patch: { permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] } } });
    await call('memory:create', { kind: 'preference', subject: 'style.answers', content: 'Prefers short, direct answers with concrete next steps.' });
    await call('memory:create', { kind: 'fact', subject: 'user.timezone', content: 'Works in Central European Time.' });
    const p = await call('projects:create', { name: 'Website relaunch', description: 'Rebuild the marketing site before the spring campaign.' });
    await call('projects:addItem', { projectId: p.id, type: 'objective', content: 'Ship the new landing page by March 31' });
    await call('projects:addItem', { projectId: p.id, type: 'blocker', content: 'Waiting on final brand colours from design' });
    await call('projects:addItem', { projectId: p.id, type: 'question', content: 'Do we keep the existing blog URLs?' });
    const c = await call('conversations:create', { title: 'Plan the week', projectId: p.id });
    await call('chat:send', { conversationId: c.id, text: '/tool memory.propose {"kind":"preference","content":"Likes weekly plans on Monday mornings","evidence":"plan my week every Monday","subject":"planning.cadence"}' });
    await new Promise(r => setTimeout(r, 800));
    await call('chat:send', { conversationId: c.id, text: '/tool desktop.focus_window {"target":{"hwnd":"1","pid":1,"processName":"notepad"}}' });
  `);
  await wait(1500);
  const views: Array<[string, string]> = [
    ['chat', 'Chat'],
    ['call', 'Call'],
    ['tasks', 'Tasks'],
    ['memory', 'Memory'],
    ['projects', 'Projects'],
    ['access', 'Access'],
    ['settings', 'Settings'],
    ['diagnostics', 'Diagnose'],
  ];
  for (const [name, label] of views) {
    await js(`document.querySelector('nav.rail button[title^="${label}"]')?.click();`);
    await wait(400);
    if (name === 'chat') await js(`[...document.querySelectorAll('.conv-item')].find(b => b.textContent.includes('Plan the week'))?.click();`);
    await wait(900);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    if (name === 'settings') {
      await js(`document.querySelector('section[aria-label="OpenRouter"]')?.scrollIntoView({ block: 'start' });`);
      await wait(500);
      fs.writeFileSync(path.join(dir, 'settings-openrouter.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  await js(`document.querySelector('nav.rail button[title^="Settings"]')?.click();`);
  await wait(400);
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Web search'))?.click();`);
  await wait(700);
  fs.writeFileSync(path.join(dir, 'settings-web.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Voice'))?.click();`);
  await wait(1500);
  fs.writeFileSync(path.join(dir, 'settings-voice.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Approvals'))?.click();`);
  await wait(1200);
  fs.writeFileSync(path.join(dir, 'settings-approvals.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Appearance'))?.click();`);
  await wait(900);
  fs.writeFileSync(path.join(dir, 'appearance.png'), (await win.webContents.capturePage()).toPNG());
  // Leave the pending approval unanswered; cancel the turn so nothing lingers.
  await js(`for (const id of await call('chat:active')) await call('chat:cancel', { conversationId: id });`);
}

/**
 * Smoke part 2: the desktop presence windows in the real app. Uses a shortcut
 * nobody else is likely to hold (not Ctrl+K) so the check never collides with
 * the user's other applications, and tears everything down again.
 */
async function presenceSmoke(shots: string | undefined): Promise<Record<string, unknown>> {
  const svc = services;
  const pw = presenceWindows;
  if (!svc || !pw) throw new Error('presence not initialised');
  const r: Record<string, unknown> = {};
  const loaded = (w: BrowserWindow) => (w.webContents.isLoading() ? new Promise<void>((res) => w.webContents.once('did-finish-load', () => res())) : Promise.resolve());
  const tryCall = (w: BrowserWindow, ch: string, input: unknown = {}) =>
    w.webContents.executeJavaScript(`window.keo.invoke(${JSON.stringify(ch)}, ${JSON.stringify(input)}).then(r => r.ok ? 'ok' : r.error.code)`) as Promise<string>;
  const before = BrowserWindow.getAllWindows().length;
  pw.syncCompanion();
  const first = pw.companion;
  pw.syncCompanion();
  r.companionSingle = !!first && pw.companion === first && BrowserWindow.getAllWindows().length === before + 1;
  const comp = pw.companion!;
  await loaded(comp);
  await new Promise((res) => setTimeout(res, 600));
  r.companionFocusable = comp.isFocusable();
  r.companionAlwaysOnTop = comp.isAlwaysOnTop();
  r.companionOnScreen = screen.getAllDisplays().some((d) => {
    const b = comp.getBounds();
    return b.x >= d.bounds.x && b.y >= d.bounds.y && b.x + b.width <= d.bounds.x + d.bounds.width && b.y + b.height <= d.bounds.y + d.bounds.height;
  });
  r.companionRendered = await comp.webContents.executeJavaScript(`!!document.querySelector('.island')`);
  r.companionPresenceGet = await tryCall(comp, 'presence:get');
  r.companionMemoryList = await tryCall(comp, 'memory:list', {});
  r.companionChatSend = await tryCall(comp, 'chat:send', { conversationId: 'x', text: 'x' });
  pw.showCommandBar();
  // The bar appears after Keo notes the active window (bounded to well under a second).
  for (let i = 0; i < 40 && !pw.command; i++) await new Promise((res) => setTimeout(res, 50));
  const cmd = pw.command!;
  await loaded(cmd);
  await new Promise((res) => setTimeout(res, 600));
  r.commandRendered = await cmd.webContents.executeJavaScript(`!!document.querySelector('.command-shell')`);
  r.commandChatActive = await tryCall(cmd, 'chat:active');
  r.commandSettingsUpdate = await tryCall(cmd, 'settings:update', { patch: {} });
  r.commandDesktopList = await tryCall(cmd, 'desktop:listWindows', {});
  if (shots && !app.isPackaged) {
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'companion.png'), (await comp.webContents.capturePage()).toPNG());
    // The bar opened, as on hover (React listens for pointerover).
    await comp.webContents.executeJavaScript(`document.querySelector('.island')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await new Promise((res) => setTimeout(res, 700));
    fs.writeFileSync(path.join(shots, 'companion-open.png'), (await comp.webContents.capturePage()).toPNG());
    // Visual review only: how three running tasks look as dots (sample markup, closed bar).
    await comp.webContents.executeJavaScript(`(() => { const i = document.querySelector('.island'); i.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); })()`);
    await new Promise((res) => setTimeout(res, 500));
    await comp.webContents.executeJavaScript(`(() => { const i = document.querySelector('.island'); const d = document.createElement('span'); d.className = 'island-dots'; d.innerHTML = ['#5aa9ff','#a98bff','#38e0c2'].map((c, k) => '<span class="idot s-running" style="--c:' + c + ';animation-delay:' + (k * 0.35) + 's"></span>').join(''); i.appendChild(d); i.querySelector('.island-label').textContent = 'Researching laptops'; i.classList.remove('state-idle'); i.classList.add('state-acting'); })()`);
    await new Promise((res) => setTimeout(res, 400));
    fs.writeFileSync(path.join(shots, 'companion-tasks.png'), (await comp.webContents.capturePage()).toPNG());
    // Docked to the left edge.
    r.dotColors = await comp.webContents.executeJavaScript(`[...document.querySelectorAll('.island .idot')].map((d) => getComputedStyle(d).backgroundColor)`);
    svc.settings.update({ companion: { dock: 'left' } });
    pw.onDisplaysChanged();
    await new Promise((res) => setTimeout(res, 900));
    await comp.webContents.executeJavaScript(`document.querySelector('.island')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await new Promise((res) => setTimeout(res, 700));
    fs.writeFileSync(path.join(shots, 'companion-left.png'), (await comp.webContents.capturePage()).toPNG());
    svc.settings.update({ companion: { dock: 'top' } });
    pw.onDisplaysChanged();
    fs.writeFileSync(path.join(shots, 'command-bar.png'), (await cmd.webContents.capturePage()).toPNG());
  }
  pw.hideCommandBar();
  // Research results window: a synthetic result (no network), its own channels only.
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const card = (name: string, price: string) => ({ name, url: `https://shop.example.com/${name.length}`, pageTitle: name, merchant: 'Example Shop', price, currency: 'USD', priceFrom: 'page data' as const, availability: 'InStock', image: px, imageUrl: null, fit: null, pros: ['Fast'], cons: ['Heavier'], specs: ['32 GB RAM', '512 GB SSD'], fetchedAt: new Date().toISOString() });
  svc.results.add({ title: 'MacBook Pro M4 vs MacBook Air M4 (32 GB, 512 GB)', summary: 'Synthetic smoke result.', criteria: ['price', '32 GB RAM'], cards: [card('MacBook Air 13 M4', '1799'), card('MacBook Pro 14 M4', '2199')], dropped: [], conversationId: null });
  pw.showResults();
  const res = pw.results!;
  await loaded(res);
  await new Promise((resolve) => setTimeout(resolve, 900));
  r.resultsRendered = await res.webContents.executeJavaScript(`document.querySelectorAll('.results-card').length`);
  r.resultsGet = await tryCall(res, 'results:get', {});
  r.resultsMemoryList = await tryCall(res, 'memory:list', {});
  r.resultsSettingsUpdate = await tryCall(res, 'settings:update', { patch: {} });
  r.resultsTasksApprove = await tryCall(res, 'tasks:approveStep', { stepId: 'x', inputHash: 'x' });
  r.resultsTitle = await res.webContents.executeJavaScript(`document.querySelector('.results-heading h1')?.textContent ?? ''`);
  if (shots && !app.isPackaged) {
    res.webContents.setBackgroundThrottling(false);
    res.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    fs.writeFileSync(path.join(shots, 'results.png'), (await res.webContents.capturePage()).toPNG());
  }
  // It steps aside while Keo controls the desktop, then comes back without taking focus.
  svc.desktop.stepAside = () => pw.stepAsideResults();
  const visibleBefore = res.isVisible();
  let hiddenDuring = false;
  await svc.desktop.exclusive('smoke', async () => {
    hiddenDuring = !res.isVisible();
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  r.resultsStepsAside = visibleBefore && hiddenDuring && res.isVisible();
  pw.hideResults();
  await svc.desktop.exclusive('smoke', async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 900));
  r.resultsStaysClosed = !res.isVisible();
  // Video preview window: no project and no ffmpeg needed; its own channels only.
  pw.showVideo();
  const vid = pw.video!;
  await loaded(vid);
  await new Promise((resolve) => setTimeout(resolve, 700));
  r.videoRendered = await vid.webContents.executeJavaScript(`!!document.querySelector('.video-panel')`);
  r.videoFocused = vid.isFocused();
  r.videoGet = await tryCall(vid, 'video:get', {});
  r.videoMemoryList = await tryCall(vid, 'memory:list', {});
  r.videoChatSend = await tryCall(vid, 'chat:send', { conversationId: 'xxxxxxxx', text: 'x' });
  r.videoSettingsUpdate = await tryCall(vid, 'settings:update', { patch: {} });
  r.videoPickFfmpeg = await tryCall(vid, 'video:pickFfmpeg', {});
  r.videoSetupStart = await tryCall(vid, 'video:setupStart', {});
  if (shots && !app.isPackaged) fs.writeFileSync(path.join(shots, 'video.png'), (await vid.webContents.capturePage()).toPNG());
  await vid.webContents.executeJavaScript(`window.keo.invoke('video:close', {})`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  r.videoClosed = !vid.isVisible();
  // Manual live check (development only, KEO_LIVE_RESULTS_SEND=<contact>): the real Send of the results
  // window — focused as after the user's click — into the real WhatsApp app. Sends one real message.
  const liveContact = process.env.KEO_LIVE_RESULTS_SEND;
  if (liveContact && !app.isPackaged) {
    fs.writeFileSync(path.join(app.getPath('temp'), 'keo-live-results-send.json'), JSON.stringify({ started: new Date().toISOString() }));
    svc.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'WhatsApp', label: 'WhatsApp' }] } });
    pw.showResults();
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const t0 = Date.now();
    const sent = await svc.runUserAction('research.send_whatsapp', { contact: liveContact, which: 'app', note: 'Keo test: research results window' });
    r.liveSend = { ok: sent.ok, error: sent.error, detail: sent.detail, ms: Date.now() - t0 };
    await new Promise((resolve) => setTimeout(resolve, 900));
    r.liveResultsBack = res.isVisible();
    fs.writeFileSync(path.join(app.getPath('temp'), 'keo-live-results-send.json'), JSON.stringify({ liveSend: r.liveSend, back: r.liveResultsBack }, null, 1));
    pw.hideResults();
  }
  // Keo's pencil: the drawing layer over the screen, its own channels only, closed again.
  try {
    const started = await svc.startPencil();
    r.pencilStarted = started.ok ? true : started.error;
    for (let i = 0; i < 60 && !(pw.pencil && !pw.pencil.webContents.isLoading()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const pen = pw.pencil;
    if (pen) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      r.pencilRendered = await pen.webContents.executeJavaScript(`!!document.querySelector('.pencil-bar')`);
      r.pencilContext = await tryCall(pen, 'pencil:context', {});
      r.pencilChatSend = await tryCall(pen, 'chat:send', { conversationId: 'x', text: 'x' });
      if (shots && !app.isPackaged) fs.writeFileSync(path.join(shots, 'pencil.png'), (await pen.webContents.capturePage()).toPNG());
      // Draw a mark, type the request and press Send, as a user would.
      await pen.webContents.executeJavaScript(`(() => {
        const st = document.querySelector('.pencil-stage');
        const ev = (t, x, y) => st.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerId: 7, pressure: 0.5 }));
        ev('pointerdown', 400, 300);
        for (let i = 1; i <= 24; i++) ev('pointermove', 400 + Math.cos(i / 24 * 6.283) * 80, 300 + Math.sin(i / 24 * 6.283) * 50);
        ev('pointerup', 480, 300);
        const input = document.querySelector('.pencil-input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'what is in this circle');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let i = 0; i < 50; i++) {
        if (await pen.webContents.executeJavaScript(`!document.querySelector('.pencil-send').disabled`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await pen.webContents.executeJavaScript(`document.querySelector('.pencil-send').click()`);
      for (let i = 0; i < 150 && pw.pencil; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const conv = svc.settings.get().commandBar.conversationId;
      const msgs = conv ? svc.conversations.messages(conv) : [];
      r.pencilSent = msgs.some((m) => m.role === 'user' && m.content.startsWith('what is in this circle') && m.content.includes('Keo’s pencil'));
    }
    svc.pencilCancel();
    await new Promise((resolve) => setTimeout(resolve, 300));
    r.pencilClosed = pw.pencil === null;
  } catch (e) {
    r.pencilError = errorMessage(e);
  }
  // Keo's marks on the screen: a click-through window over the marked area only, then gone.
  try {
    pw.showMarks(null, [{ shape: 'circle', x: 300, y: 300, w: 80, label: 'Play button' }, { shape: 'arrow', x: 420, y: 360, fromX: 520, fromY: 460, label: 'Then here' }], 6);
    for (let i = 0; i < 60 && !(pw.marksWin && !pw.marksWin.webContents.isLoading()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const mw = pw.marksWin;
    if (mw) {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      r.marksRendered = await mw.webContents.executeJavaScript(`document.querySelectorAll('.mk-line').length`);
      r.marksClickThrough = !mw.isFocusable();
      const db = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
      const b = mw.getBounds();
      r.marksPartial = b.width < db.width && b.height < db.height;
      r.marksChatSend = await tryCall(mw, 'chat:send', { conversationId: 'x', text: 'x' });
      if (shots && !app.isPackaged) fs.writeFileSync(path.join(shots, 'marks.png'), (await mw.webContents.capturePage()).toPNG());
    }
    pw.hideMarks();
    r.marksClosed = pw.marksWin === null;
  } catch (e) {
    r.marksError = errorMessage(e);
  }
  // Keo mode: the full-screen Keo, its own channels only, closed again (no voice conversation in the smoke run).
  try {
    pw.showKeoMode();
    for (let i = 0; i < 60 && !(pw.keoMode && !pw.keoMode.webContents.isLoading()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const km = pw.keoMode;
    if (km) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      r.keoModeRendered = await km.webContents.executeJavaScript(`(() => { const c = document.querySelector('canvas.km-sphere'); return !!c && c.width > 100 && c.height > 100; })()`);
      r.keoModePresence = await tryCall(km, 'presence:get');
      r.keoModeChatSend = await tryCall(km, 'chat:send', { conversationId: 'x', text: 'x' });
      if (shots && !app.isPackaged) {
        km.webContents.setBackgroundThrottling(false);
        km.webContents.invalidate();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        fs.writeFileSync(path.join(shots, 'keomode.png'), (await km.webContents.capturePage()).toPNG());
      }
    }
    pw.hideKeoMode();
    r.keoModeClosed = pw.keoMode === null;
  } catch (e) {
    r.keoModeError = errorMessage(e);
  }
  // A WebP picture (made by Chromium itself) becomes a PNG through the converter research cards use.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const b64 = String(await mainWindow.webContents.executeJavaScript(`(() => { const c = document.createElement('canvas'); c.width = 60; c.height = 40; const g = c.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 60, 40); return c.toDataURL('image/webp').split(',')[1]; })()`));
      const png = await convertImage(Buffer.from(b64, 'base64'), 'image/webp', 120);
      r.webpConverted = png.subarray(1, 4).toString('latin1') === 'PNG' && png.length > 100;
    } catch (e) {
      r.webpConverted = errorMessage(e);
    }
  }
  // Copy from Keo's window goes through the main process (the page's own clipboard access is not granted).
  if (mainWindow && !mainWindow.isDestroyed()) {
    const before = await clipboard.readText();
    const ok = await mainWindow.webContents.executeJavaScript(`window.keo.invoke('app:copyText', { text: 'keo smoke copy' }).then((x) => x.ok && x.value.copied)`);
    r.copyText = ok === true && (await clipboard.readText()) === 'keo smoke copy';
    await clipboard.writeText(before);
  }
  // Optional (KEO_SMOKE_VOICE=1, makes a sound): a voice-mode reply is spoken by the hidden main window.
  if (process.env.KEO_SMOKE_VOICE === '1') {
    const t0 = Date.now();
    await (svc as unknown as { voiceSpeak(t: string): Promise<void> }).voiceSpeak('Keo voice check.');
    r.voiceSpeak = { how: svc.lastVoiceSpeak, ms: Date.now() - t0 };
  }
  // The real report renderer, under Keo's real session hardening (Save / Send use it).
  try {
    const sample = reportHtml(svc.results.get(undefined)!, { forImage: true });
    const pdf = await renderReport(sample, 'pdf');
    const png = await renderReport(sample, 'png');
    r.reportPdf = pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.length > 1000;
    r.reportPng = png.subarray(1, 4).toString('latin1') === 'PNG' && png.length > 1000;
    r.reportAgain = (await renderReport(sample, 'pdf')).length > 1000;
  } catch (e) {
    r.reportError = errorMessage(e);
  }
  svc.settings.update({ shortcuts: { commandBarEnabled: true, commandBar: 'Control+Alt+Shift+F11' } });
  const st = pw.syncShortcut();
  r.shortcutRegistered = st.registered && globalShortcut.isRegistered('Control+Alt+Shift+F11');
  svc.settings.update({ shortcuts: { commandBarEnabled: false } });
  pw.syncShortcut();
  r.shortcutReleasedWhenDisabled = !globalShortcut.isRegistered('Control+Alt+Shift+F11');
  svc.settings.update({ companion: { enabled: false } });
  pw.syncCompanion();
  r.companionClosedWhenDisabled = pw.companion === null && comp.isDestroyed();
  pw.shutdown();
  r.noPresenceWindowsAfterShutdown = BrowserWindow.getAllWindows().length === before;
  // The command bar keeps its own "Quick commands" conversation; count after it exists.
  r.conversationsAfter = svc.conversations.list({}).length;
  return r;
}

// ---------------------------------------------------------------------------
// Smoke check (KEO_SMOKE=1): verifies the real renderer boundary, then exits.
// ---------------------------------------------------------------------------
function runSmoke(win: BrowserWindow): void {
  const out = process.env.KEO_SMOKE_OUT;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      let result: Record<string, unknown>;
      try {
        result = (await win.webContents.executeJavaScript(
          `(async () => {
            const r = {};
            r.title = document.title;
            r.hasRequire = typeof window.require !== 'undefined';
            r.hasProcess = typeof window.process !== 'undefined';
            r.hasModule = typeof window.module !== 'undefined';
            r.bridgeKeys = Object.keys(window.keo || {}).sort();
            r.bridgeFrozen = Object.isFrozen(window.keo);
            const call = async (ch, input) => { const res = await window.keo.invoke(ch, input); if (!res.ok) throw new Error(res.error.code + ': ' + res.error.message); return res.value; };
            const u = await window.keo.invoke('fs:readFile', {}); r.unknownChannel = u.ok ? 'allowed' : 'rejected';
            const bad = await window.keo.invoke('conversations:rename', { id: 'x', title: 5 }); r.invalidInput = bad.ok ? 'accepted' : bad.error.code;
            const info = await call('app:info');
            r.profile = info.profile; r.schemaVersion = info.schemaVersion; r.secretStorage = info.secretStorage;
            const c = await call('conversations:create', { title: 'smoke' });
            await call('chat:send', { conversationId: c.id, text: 'hello from smoke test' });
            for (let i = 0; i < 50; i++) {
              const msgs = await call('conversations:messages', { id: c.id });
              const a = msgs.find(m => m.role === 'assistant' && m.status !== 'streaming');
              if (a) { r.assistantStatus = a.status; r.assistantText = a.content.slice(0, 80); break; }
              await new Promise(res => setTimeout(res, 100));
            }
            r.conversationCount = (await call('conversations:list', {})).length;
            r.capabilities = (await call('capabilities:list')).length;
            // Optional (KEO_SMOKE_DESKTOP=1): the real desktop helper on Keo's own throw-away test window.
            if (${process.env.KEO_SMOKE_DESKTOP === '1' ? 'true' : 'false'}) { try { r.selfTest = await call('diag:checkComputer', {}); } catch (e) { r.selfTest = { ok: false, error: String(e) }; } }
            try { const x = await fetch('https://example.com'); r.rendererNetwork = 'allowed:' + x.status; } catch (e) { r.rendererNetwork = 'blocked'; }
            r.rootRendered = !!document.querySelector('#root')?.children.length;
            return r;
          })()`,
        )) as Record<string, unknown>;
      } catch (e) {
        result = { error: errorMessage(e) };
      }
      try {
        result.presence = await presenceSmoke(process.env.KEO_SMOKE_SHOTS);
      } catch (e) {
        result.presence = { error: errorMessage(e) };
      }
      // The trained wake word's native modules load in this build (packaged: from app.asar.unpacked).
      try {
        realPorcupine();
        result.porcupineLoads = true;
      } catch (e) {
        result.porcupineLoads = errorMessage(e).slice(0, 200);
      }
      log.info('smoke.result', { keys: Object.keys(result).length });
      if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
      const shots = process.env.KEO_SMOKE_SHOTS;
      if (shots && !app.isPackaged) await captureViews(win, shots).catch((e) => log.error('smoke.shots_failed', { error: errorMessage(e) }));
      app.quit();
    }, 1500);
  });
}
