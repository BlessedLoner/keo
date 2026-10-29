import { Mp4Reader } from './studio/mp4';
import { voicedSpans, wavOf } from './studio/captions';
import { LOOKS, projectDuration, type EditOp } from '../shared/studio';
import { presetOps, type PresetId, type PresetOptions } from '../shared/studioPresets';
import { scenesFromScript, Storyboard } from '../shared/studioFaceless';
import os from 'node:os';
import type { RenderJob } from './studio/studioService';
import { Readable } from 'node:stream';
import { accountProfile, folderFor, openFolder, readState, sessionDir, setAsideLegacy, userIdOfToken, writeState, type AccountState } from './env/accounts';
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
import { APP_ID, resolveProfile, type ProfileInfo } from './env/profile';
import { createHandlers } from './ipc/handlers';
import { originOf, registerIpc } from './ipc/router';
import { Logger } from './logging/logger';
import { TestProvider } from './providers/testProvider';
import { SecretStore, type SecretCipher } from './secrets/secretStore';
import { Services, type ServiceDeps } from './services';
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

// stream: Keo's own videos (the sign-in intro) play from app://keo like any other bundled file.
// corsEnabled: Studio's media is read by Keo's own pages, which in development come from the dev server's origin.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

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
    // Keo Studio's media: only files that are in a project (or being measured), with seeking.
    const media = /^\/media\/(pr_[A-Za-z0-9]{4,24})\/(as_[A-Za-z0-9]{4,24})$/.exec(url.pathname);
    const probing = /^\/probe\/([0-9a-f]{24})$/.exec(url.pathname);
    if (media || probing) {
      const file = media ? (services?.studio.assetFile(media[1]!, media[2]!) ?? null) : (services?.studio.probeTarget(probing![1]!) ?? null);
      if (!file) return new Response('Not found', { status: 404 });
      return serveFile(file, request.headers.get('range'));
    }
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

/** A file with HTTP range support (video elements seek with ranges). */
async function serveFile(file: string, range: string | null): Promise<Response> {
  const size = (await fs.promises.stat(file)).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    start = Math.max(0, start);
    const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(size) } });
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
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
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
    // The hidden render window must never keep Keo running on its own.
    if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy();
  });
  void win.loadURL(DEV_URL ?? 'app://keo/index.html');
  return win;
}

/**
 * Keo Studio's render window: hidden, made on first use; it exports videos and draws frames with
 * the PC's video codecs. Jobs wait until it has loaded.
 */
let renderWindow: BrowserWindow | null = null;
let renderReady: Promise<void> | null = null;
let markRenderReady: (() => void) | null = null;
function sendRenderJob(jobId: string, job: RenderJob): void {
  if (!renderWindow || renderWindow.isDestroyed()) {
    renderReady = new Promise<void>((res) => (markRenderReady = res));
    renderWindow = new BrowserWindow({
      show: false,
      width: 480,
      height: 360,
      title: 'Keo renderer',
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, devTools: false, spellcheck: false },
    });
    renderWindow.on('closed', () => {
      renderWindow = null;
      renderReady = null;
    });
    // Development builds: the render window's own messages (it has no visible console).
    if (!app.isPackaged) renderWindow.webContents.on('console-message', (e) => log.info('studio.render_console', { level: e.level, message: String(e.message).slice(0, 300) }));
    renderWindow.webContents.on('render-process-gone', (_e, d) => log.warn('studio.render_gone', { reason: d.reason }));
    void renderWindow.loadURL(rendererUrl('#render'));
  }
  const win = renderWindow;
  void renderReady!.then(() => {
    if (!win.isDestroyed()) win.webContents.send('studio:job', { jobId, job });
  });
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

/** Windows' file picker for Keo Studio: videos, pictures and sound (several files). */
async function pickStudioMedia(): Promise<string[]> {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    title: 'Add videos, pictures or sound',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos, pictures and sound', extensions: ['mp4', 'm4v', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
}

const rendererUrl = (hash: string) => `${DEV_URL ?? 'app://keo/index.html'}${hash}`;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  showMain();
});

/** Which account folder this run of Keo uses (see env/accounts.ts). */
let accountState: AccountState = { mode: 'signed-out', userId: null };

/**
 * Picks the data folder for whoever is signed in: each Keo account has its own. Data from before
 * accounts is set aside once and goes to the first account (or local use) that opens.
 */
function openAccountFolder(): { profile: ProfileInfo; sessionSecrets: SecretStore } {
  const root = profile.userData;
  const sessionSecrets = new SecretStore(sessionDir(root), cipher);
  if (setAsideLegacy(root)) log.info('app.data_set_aside', {});
  // The stored sign-in decides; the saved mode only matters without one.
  let signedInAs: string | null = null;
  try {
    const raw = sessionSecrets.get('keo_account');
    const s = raw ? (JSON.parse(raw) as { access?: string; userId?: string }) : null;
    signedInAs = s?.access ? (s.userId ?? userIdOfToken(s.access)) : null;
  } catch {
    signedInAs = null;
  }
  const saved = readState(root);
  accountState = signedInAs ? { mode: 'account', userId: signedInAs } : saved.mode === 'local' ? saved : { mode: 'signed-out', userId: null };
  writeState(root, accountState);
  const folder = openFolder(root, accountState);
  // A Keo sign-in that came along with old data belongs to the shared store, not to the folder.
  if (folder.claimed) new SecretStore(folder.dir, cipher).delete('keo_account');
  log.info('app.account_folder', { mode: accountState.mode, claimedOldData: folder.claimed });
  return { profile: accountProfile(profile, folder.dir, accountState), sessionSecrets };
}

/** The current account's IPC handlers; calls are routed through liveHandlers so they can change. */
let currentHandlers: ReturnType<typeof createHandlers> | null = null;
const liveHandlers = new Proxy({} as ReturnType<typeof createHandlers>, {
  get: (_t, k) => (currentHandlers as Record<string | symbol, unknown> | null)?.[k],
  has: (_t, k) => !!currentHandlers && k in currentHandlers,
});
/** Start the services (and the companion, shortcuts, wake word) on the current account's folder. */
let startServices: () => void = () => undefined;
let startPresence: () => void = () => undefined;
let switching = false;

/** Saves the new mode and, if its folder is another one, opens it in place. */
function switchAccountFolder(next: AccountState): void {
  const same = folderFor(next) === folderFor(accountState);
  writeState(profile.userData, next);
  accountState = next;
  if (same) return;
  log.info('app.switch_account_folder', { mode: next.mode });
  // After the current call has answered the window.
  setTimeout(() => void switchInPlace(), 120);
}

/**
 * Opens another account's data without restarting Keo, like any signed-in desktop app: the
 * window shows "Opening…", this account's services and extra windows close (saving everything),
 * the new account's start, and the window reloads on them.
 */
async function switchInPlace(): Promise<void> {
  if (switching) return;
  switching = true;
  push('app:switching', { mode: accountState.mode });
  try {
    presenceWindows?.shutdown();
    presenceWindows = null;
    const old = services;
    currentHandlers = null;
    services = null;
    await old?.shutdown().catch((e: unknown) => log.warn('app.switch_shutdown', { error: errorMessage(e) }));
    startServices();
    if (!SMOKE && !E2E_DESKTOP) startPresence();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    else mainWindow = createWindow();
    log.info('app.account_opened', { mode: accountState.mode });
  } catch (e) {
    // Never leave Keo half-switched: start again on the new folder.
    log.error('app.switch_failed', { error: errorMessage(e) });
    restartKeo();
  } finally {
    switching = false;
  }
}

/** Set while this (development) Keo hands over to a new one and waits for it. */
let devHandover = false;

/**
 * Starts Keo again. In development (electron-vite) the dev server stops as soon as this process
 * ends, which left the new window blank: there, the new Keo starts first and this one — windows
 * closed, data saved and closed — waits in the background until it ends.
 */
function restartKeo(): void {
  if (!DEV_URL) {
    app.relaunch();
    app.exit(0);
    return;
  }
  devHandover = true;
  presenceWindows?.shutdown();
  presenceWindows = null;
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  const saved = services ? services.shutdown().catch(() => undefined) : Promise.resolve();
  void saved.then(() => {
    services = null;
    app.releaseSingleInstanceLock();
    const next = spawn(process.execPath, process.argv.slice(1), { env: process.env, stdio: 'inherit' });
    next.on('exit', (code) => app.exit(code ?? 0));
    next.on('error', () => app.exit(1));
  });
}

app.whenReady().then(() => {
  try {
    registerAppProtocol();
    hardenSession();
    registerIpc(
      ipcMain,
      liveHandlers,
      {
        trustedOrigin: TRUSTED_ORIGIN,
        roleOf: (id) =>
          mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === id ? 'main' : renderWindow && !renderWindow.isDestroyed() && renderWindow.webContents.id === id ? 'render' : (presenceWindows?.roleOf(id) ?? null),
      },
      log,
    );
    // Everything that belongs to one account's data: made again when another account opens.
    startServices = () => {
      const opened = openAccountFolder();
      services = new Services({
        profile: opened.profile,
        cipher,
        sessionSecrets: opened.sessionSecrets,
        // Another account signed in, or signed out: start again on that account's own data.
        onAccountChange: (userId) => switchAccountFolder(userId ? { mode: 'account', userId } : { mode: 'signed-out', userId: null }),
      studioJob: (jobId, job) => sendRenderJob(jobId, job),
        desktopBackend: new Win32Backend(profile.runtimeDir, log),
        captureSource: new ElectronWindowCapture(),
        imageTools: electronImageTools,
        clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
        documentsDir: app.getPath('documents'),
        videosDir: app.getPath('videos'),
        homeDir: app.getPath('home'),
        openPath: async (p) => (await shell.openPath(p)) === '',
        showInFolder: (p) => shell.showItemInFolder(p),
        pickMedia: pickStudioMedia,
        // Smoke checks only: a stand-in voice (a tone) and pictures (a gradient), never in the real app.
        ...(SMOKE ? smokeFacelessDeps() : {}),
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
        pictureNormalize: async (file) => {
          const img = nativeImage.createFromPath(file);
          return img.isEmpty() ? null : img.toPNG();
        },
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
      // Installed builds only: a development run has no installer to update (made once; it reads the current account's settings).
      if (!autoUpdate) {
        autoUpdate = new AutoUpdate(
          app.isPackaged ? autoUpdater : null,
          () => services?.settings.get().updates.check ?? false,
          log,
          (st) => push('update:changed', st),
          (version) => services?.ui.notify('Keo update ready', `Keo ${version} is downloaded. It installs when you close Keo, or choose “Restart to update”.`),
        );
        // Keo often runs for days in the background: look again every few hours (the check itself is at most daily).
        setInterval(() => void autoUpdate?.check(), 6 * 60 * 60 * 1000).unref();
      }
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
        showInFolder: (p) => shell.showItemInFolder(p),
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
        pickMedia: pickStudioMedia,
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
        relaunch: () => restartKeo(),
        useLocal: () => switchAccountFolder({ mode: 'local', userId: null }),
      renderReady: () => markRenderReady?.(),
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
      currentHandlers = handlers;
      // Keo without a Keo account (own API keys): no sign-in screen in this folder.
      if (accountState.mode === 'local' && !services.settings.get().ui.ownKeys) services.settings.update({ ui: { ownKeys: true } });
      const recovered = services.start();
      log.info('app.ready', { profile: profile.profile, ...recovered.recovery, interruptedMessages: recovered.interruptedMessages, secretStorage: cipher.isAvailable() });
    };
    // Companion, shortcuts and wake word for the current account's settings.
    startPresence = () => {
      // Desktop presence: companion, global shortcut and (if enabled) wake word.
      presenceWindows?.syncCompanion();
      presenceWindows?.syncShortcut();
      const svc = services!;
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
    };
    startServices();
    mainWindow = createWindow();
    if (E2E_DESKTOP && !app.isPackaged) {
      const out = process.env.KEO_E2E_OUT ?? path.join(profile.userData, 'e2e-desktop.json');
      void import('./devtools/e2eDesktop').then(({ runDesktopE2E }) =>
        runDesktopE2E(services!, { electronPath: process.execPath, fixtureDir: path.join(__dirname, '../../tests/fixtures/fake-whatsapp'), outFile: out, workDir: profile.userData }).finally(() => app.quit()),
      );
    } else if (SMOKE) {
      runSmoke(mainWindow);
    } else {
      startPresence();
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
  if (devHandover) return; // the new Keo is starting; this one waits for it
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
 * Smoke: Keo Studio end to end with real codecs. A picture, a tone and animated text are exported
 * to MP4; that MP4 is imported into a second project, edited (split, text, music) and exported
 * again (exact decoding of real H.264); frames are rendered for Keo to look at.
 */
/**
 * Smoke: Studio media loads in a page from another origin (as in development, where Keo's pages
 * come from the dev server): a picture, a sound and fetch() from a blank page (its origin is not app://keo).
 */
async function studioMediaFromOtherOrigin(projectId: string, picId: string, soundId: string): Promise<Record<string, unknown>> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html,<!doctype html><title>origin</title>');
    return (await win.webContents.executeJavaScript(`(async () => {
      const pic = 'app://keo/media/${projectId}/${picId}';
      const sound = 'app://keo/media/${projectId}/${soundId}';
      const img = await new Promise((res) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = pic; });
      const audio = await new Promise((res) => { const a = document.createElement('audio'); a.crossOrigin = 'anonymous'; a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(0); a.src = sound; });
      let bytes = 0;
      try { bytes = (await (await fetch(sound)).arrayBuffer()).byteLength; } catch {}
      return { img, audio, bytes };
    })()`)) as Record<string, unknown>;
  } finally {
    win.destroy();
  }
}

/** Smoke checks of the faceless creator: a voice that is a tone as long as the text, and gradient pictures. */
function smokeFacelessDeps(): Pick<ServiceDeps, 'studioNarrate' | 'pictureAi'> {
  const picture = (): Buffer => {
    const W = 256;
    const H = 384;
    const px = Buffer.alloc(W * H * 4);
    const hue = Math.floor(Math.random() * 200);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i] = (hue + x) % 256;
        px[i + 1] = Math.round((y / H) * 200);
        px[i + 2] = 180;
        px[i + 3] = 255;
      }
    return nativeImage.createFromBitmap(px, { width: W, height: H }).toPNG();
  };
  return {
    studioNarrate: async (text) => {
      const rate = 16000;
      const secs = Math.max(1, Math.min(8, text.length / 15));
      const pcm = new Int16Array(Math.round(secs * rate));
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000);
      return { audio: wavOf(pcm, rate), mimeType: 'audio/wav' };
    },
    pictureAi: { generate: async () => picture(), edit: async () => picture() },
  };
}

/** Test media for Studio checks: a colourful picture and a 2-second 440 Hz tone, in dir. */
function studioSampleMedia(dir: string): { pic: string; tone: string } {
  const W = 640;
  const H = 360;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = Math.round((x / W) * 255);
      px[i + 1] = Math.round((y / H) * 255);
      px[i + 2] = 200;
      px[i + 3] = 255;
    }
  const pic = path.join(dir, 'picture.png');
  fs.writeFileSync(pic, nativeImage.createFromBitmap(px, { width: W, height: H }).toPNG());
  const rate = 48000;
  const samples = rate * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 9000), 44 + i * 2);
  const tone = path.join(dir, 'tone.wav');
  fs.writeFileSync(tone, wav);
  return { pic, tone };
}

async function studioSmoke(): Promise<Record<string, unknown>> {
  const s = services!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-studio-smoke-'));
  const out: Record<string, unknown> = {};
  const { pic, tone } = studioSampleMedia(dir);

  const a = s.studio.create('Studio smoke one', 'landscape');
  const imported = await s.studio.importFiles(a.id, [pic, tone]);
  out.imported = imported.added.map((x) => `${x.kind}:${x.width}x${x.height}:${x.duration}`);
  const picAsset = imported.added.find((x) => x.kind === 'image');
  const toneAsset = imported.added.find((x) => x.kind === 'audio');
  if (!picAsset || !toneAsset) throw new Error(`import failed: ${JSON.stringify(imported.skipped)}`);
  out.crossOrigin = await studioMediaFromOtherOrigin(a.id, picAsset.id, toneAsset.id);
  s.studio.edit(a.id, [
    { op: 'set_project', width: 640, height: 360 },
    { op: 'add_media', assetId: picAsset.id, duration: 2 },
    { op: 'add_text', text: 'Keo Studio works', start: 0, duration: 2, animIn: 'words' },
    { op: 'add_audio', assetId: toneAsset.id },
  ]);
  const first = await s.studio.exportVideo(a.id);
  out.first = { frames: first.frames, durationSec: first.durationSec, bytes: first.bytes };
  const firstAudio = Mp4Reader.open(first.file);
  out.firstHasSound = !!firstAudio?.audio();
  firstAudio?.close();
  // The timeline's sound for captions: 16 kHz mono, the 2-second tone found as one stretch of sound.
  const speech = await s.studio.speech(a.id);
  out.speech = speech ? { rate: speech.rate, seconds: speech.samples.length / speech.rate, spans: voicedSpans(speech.samples, speech.rate) } : null;

  const b = s.studio.create('Studio smoke two', 'vertical');
  const again = await s.studio.importFiles(b.id, [first.file]);
  const vid = again.added[0];
  out.reimported = vid ? `${vid.kind}:${vid.width}x${vid.height}:${vid.duration}:${vid.hasAudio}` : null;
  if (!vid) throw new Error('re-import failed');
  const added = s.studio.edit(b.id, [
    { op: 'set_project', width: 360, height: 640 },
    { op: 'add_media', assetId: vid.id },
    { op: 'add_text', text: 'Second pass', start: 0.2, duration: 1.4, animIn: 'pop', style: { glow: 20, color: '#FFD400' } },
  ]);
  const clip = added.project.tracks[0]!.clips[0]!;
  s.studio.edit(b.id, [{ op: 'split', clip: clip.id, at: 1 }]);
  const second = await s.studio.exportVideo(b.id);
  out.second = { frames: second.frames, durationSec: second.durationSec };
  const frames = await s.studio.frames(b.id, [0.5, 1.5], 180);
  out.frames = frames.map((f) => {
    const img = nativeImage.createFromBuffer(f.png);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    return { width, height, centre: (bmp[at]! + bmp[at + 1]! + bmp[at + 2]!) / 3 };
  });
  // Phase 2 in the real render window: the video's own sound analysed, then voice clean-up,
  // social loudness, a colour look, a slow push, a sound effect and pauses cut, exported again.
  const analysed = await s.studio.analyzeSpeech(b.id);
  const speechSpans = analysed.project.assets.find((x) => x.id === vid.id)?.speech ?? null;
  const fx = s.studio.soundEffect(b.id, 'whoosh');
  const now = s.studio.get(b.id);
  const ops: EditOp[] = [{ op: 'set_project', loudness: 'social' }];
  for (const c of now.tracks.flatMap((t) => t.clips))
    if (c.type === 'media') ops.push({ op: 'set', clip: c.id, voice: true, color: { ...LOOKS.warm }, zooms: [{ at: 0, scale: 1, x: 0.5, y: 0.5, ease: 'cut' }, { at: c.duration, scale: 1.15, x: 0.5, y: 0.5, ease: 'ramp' }] });
  ops.push({ op: 'add_audio', assetId: fx.asset.id, trackName: 'Effects', start: 0.3, volume: 0.6 });
  // A crossfade between the two halves of the split video, and the first half cropped.
  const halves = now.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media');
  if (halves[1]) ops.push({ op: 'set', clip: halves[1].id, transition: { kind: 'crossfade', seconds: 0.5 } });
  if (halves[0]) ops.push({ op: 'set', clip: halves[0].id, crop: { left: 0.1, right: 0.1 }, effects: { grain: 0.5, vhs: 0.5, glow: 0.4, rgbSplit: 0.3, lightLeak: 0.4 } });
  if (halves[1]) ops.push({ op: 'set', clip: halves[1].id, fit: 'contain', backdrop: 'blur' });
  // Mirrored, blended and a voice changer on each half (the pitch shifter and the big hall).
  if (halves[0]) ops.push({ op: 'set', clip: halves[0].id, flipX: true, blend: 'screen', voiceFx: 'chipmunk' });
  if (halves[1]) ops.push({ op: 'set', clip: halves[1].id, flipY: true, voiceFx: 'hall', volumeKeys: [{ at: 0, value: 1, ease: 'in-out' }, { at: 0.5, value: 0.2, ease: 'in-out' }] });
  s.studio.edit(b.id, ops);
  const cleaned = await s.studio.cleanup(b.id, { silences: true });
  const third = await s.studio.exportVideo(b.id);
  const thirdReader = Mp4Reader.open(third.file);
  out.third = { speech: speechSpans, cuts: cleaned.plan.cuts.length, frames: third.frames, durationSec: third.durationSec, sound: !!thirdReader?.audio() };
  thirdReader?.close();
  // Phase 3: motion design drawn and exported by the real render window — kinetic text, a counter,
  // a lower third, an avatar in a circle, a phone mock-up, a glowing outline and keyframes.
  const mo = s.studio.create('Studio smoke motion', 'vertical');
  const moPic = (await s.studio.importFiles(mo.id, [pic])).added[0]!;
  const moP = () => s.studio.get(mo.id);
  s.studio.edit(mo.id, [{ op: 'set_project', width: 360, height: 640, background: '#0A0A12' }]);
  const motionPresets: Array<[PresetId, PresetOptions]> = [
    ['title', { at: 0, text: 'Big idea' }],
    ['counter', { at: 0.4, text: '10,000 fans', y: 0.62 }],
    ['lower-third', { at: 0.2, text: 'Keo Studio', subtext: 'Motion test' }],
    ['avatar', { at: 0, assetId: moPic.id, y: 0.22 }],
    ['neon-frame', { at: 0 }],
    ['phone', { at: 1.2, duration: 0.8, assetId: moPic.id }],
  ];
  for (const [id, o] of motionPresets) s.studio.edit(mo.id, presetOps(moP(), id, { duration: 2, ...o }));
  s.studio.edit(mo.id, [{ op: 'add_shape', shape: 'star', start: 0, duration: 2, style: { width: 0.2, height: 0.11, fill: '#FFD400', glow: 20, glowColor: '#FFD400' }, transform: { x: 0.85, y: 0.1 }, keys: { rotation: [{ at: 0, value: 0, ease: 'linear' }, { at: 2, value: 180, ease: 'linear' }] }, loop: { kind: 'pulse', amount: 0.5, period: 1 } }]);
  const moFrames = await s.studio.frames(mo.id, [0.15, 1, 1.6], 180);
  // Frames change over time (things move), and the middle of the frame is not empty.
  const stats = moFrames.map((f) => {
    const img = nativeImage.createFromBuffer(f.png);
    const bmp = img.toBitmap();
    let sum = 0;
    for (let i = 0; i < bmp.length; i += 4) sum += bmp[i]! + bmp[i + 1]! + bmp[i + 2]!;
    return Math.round(sum / (bmp.length / 4) / 3);
  });
  const moOut = await s.studio.exportVideo(mo.id);
  out.motion = { frames: moOut.frames, brightness: stats, layers: moP().tracks.reduce((n, t) => n + t.clips.length, 0) };
  // Shot changes: a video made of two shots (the picture, then a red frame from 1.5 s), decoded
  // in the render window, split where the red starts.
  const sh = s.studio.create('Studio smoke shots', 'square');
  const [shPic, shTone] = (await s.studio.importFiles(sh.id, [pic, tone])).added;
  s.studio.edit(sh.id, [
    { op: 'set_project', width: 320, height: 320 },
    { op: 'add_media', assetId: shPic!.id, start: 0, duration: 3 },
    { op: 'add_audio', assetId: shTone!.id, start: 0, duration: 2 },
    { op: 'add_shape', shape: 'rect', start: 1.5, duration: 1.5, style: { width: 1.2, height: 1.2, radius: 0, fill: '#FF0000' } },
  ]);
  const shFile = (await s.studio.exportVideo(sh.id)).file;
  const scP = s.studio.create('Studio smoke split', 'square');
  const scVid = (await s.studio.importFiles(scP.id, [shFile])).added[0]!;
  s.studio.edit(scP.id, [{ op: 'add_media', assetId: scVid.id, start: 0 }]);
  const scSplit = await s.studio.splitScenes(scP.id);
  // Reverse: the same two-shot video played backwards (picture and sound) — red first, then the picture.
  const rv = s.studio.create('Studio smoke reverse', 'square');
  const rvVid = (await s.studio.importFiles(rv.id, [shFile])).added[0]!;
  s.studio.edit(rv.id, [{ op: 'add_media', assetId: rvVid.id, start: 0 }]);
  const rvClip = s.studio.get(rv.id).tracks[0]!.clips[0]!;
  await s.studio.reverseClip(rv.id, rvClip.id);
  const rvNow = s.studio.get(rv.id);
  const rvCopy = rvNow.assets.find((x) => x.id === (rvNow.tracks[0]!.clips[0] as { assetId: string }).assetId)!;
  const rvFrames = await s.studio.assetFrames(rv.id, rvCopy.id, [0.3, 2.7], 64);
  const centre = (png: Buffer) => {
    const img = nativeImage.createFromBuffer(png);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    return { r: bmp[at + 2]!, g: bmp[at + 1]!, b: bmp[at]! };
  };
  out.reverse = { copy: rvCopy.name, duration: rvCopy.duration, sound: rvCopy.hasAudio, first: centre(rvFrames[0]!.png), last: centre(rvFrames[1]!.png) };
  s.studio.delete(rv.id);
  out.shots = { scenes: s.studio.get(scP.id).assets[0]?.scenes ?? null, splits: scSplit.splits, starts: s.studio.get(scP.id).tracks[0]!.clips.map((c) => c.start) };
  // Cut to the beat: a drum track (a click every half second) decoded in the render window.
  const drumRate = 16000;
  const drumPcm = new Int16Array(drumRate * 8);
  for (let beat = 0; beat < 16; beat++) {
    const at = Math.round((0.25 + beat * 0.5) * drumRate);
    for (let i = 0; i < 800; i++) drumPcm[at + i] = Math.round(Math.sin(i * 0.9) * 26000 * Math.exp(-i / 200));
  }
  const drumFile = path.join(dir, 'drums.wav');
  fs.writeFileSync(drumFile, wavOf(drumPcm, drumRate));
  const bt = s.studio.create('Studio smoke beat', 'square');
  const btMedia = (await s.studio.importFiles(bt.id, [drumFile, pic])).added;
  const btSong = btMedia.find((x) => x.kind === 'audio')!;
  const btPic = btMedia.find((x) => x.kind === 'image')!;
  s.studio.edit(bt.id, [{ op: 'add_audio', assetId: btSong.id, trackName: 'Music', start: 0 }, ...[0, 1, 2].map(() => ({ op: 'add_media' as const, assetId: btPic.id, start: 'end' as const, duration: 3 }))]);
  const btCut = await s.studio.beatCut(bt.id, { every: 2 });
  const btClips = s.studio.get(bt.id).tracks[0]!.clips;
  out.beat = { placed: btCut.placed, bpm: btCut.bpm, lengths: btClips.map((c) => Math.round(c.duration * 100) / 100) };
  s.studio.delete(bt.id);
  // Phase 4: a faceless video from a three-scene script, built and exported for real.
  const fl = await s.facelessCreate(Storyboard.parse({ title: 'Studio smoke faceless', format: 'square', look: 'warm', scenes: scenesFromScript('Did you know the sea makes air?\n[title: Sea air]\n\nTiny plants do it.\n\nSay thanks.') }));
  s.studio.edit(fl.projectId, [{ op: 'set_project', width: 320, height: 320 }]);
  // Export choices: 240p at 24 fps, named; and an export the user stops.
  const flOut = await s.studio.exportVideo(fl.projectId, { resolution: '720', fps: 24, quality: 'standard', name: 'Smoke faceless 720' });
  const flSize = Mp4Reader.open(flOut.file);
  out.exportChoices = { width: flSize?.video()?.width, height: flSize?.video()?.height, frames: flOut.frames, seconds: flOut.durationSec, named: path.basename(flOut.file) };
  flSize?.close();
  const stopping = s.studio.exportVideo(fl.projectId).then(
    () => 'finished',
    (e: unknown) => errorMessage(e),
  );
  await new Promise((r) => setTimeout(r, 400));
  out.stopped = { asked: s.studio.cancelExport(fl.projectId), result: await stopping };
  const flReader = Mp4Reader.open(flOut.file);
  const flP = s.studio.get(fl.projectId);
  out.faceless = { scenes: fl.scenes, durationSec: flOut.durationSec, frames: flOut.frames, sound: !!flReader?.audio(), captions: flP.tracks.find((t) => t.name === 'Captions')?.clips.length ?? 0, voice: flP.tracks.find((t) => t.name === 'Voice')?.clips.length ?? 0 };
  flReader?.close();
  fs.rmSync(flOut.file, { force: true });
  // Read aloud: a text clip voiced (the smoke voice) and placed under it.
  const ra = s.studio.edit(fl.projectId, [{ op: 'add_text', text: 'Read me aloud', start: 0.5, duration: 2 }]).project;
  const raText = ra.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text' && c.text === 'Read me aloud')!;
  const raOut = await s.studioReadAloud(fl.projectId, raText.id, 'female');
  out.readAloud = { seconds: raOut.seconds, start: s.studio.get(fl.projectId).tracks.flatMap((t) => t.clips).find((c) => c.id === raOut.clip)?.start };
  s.studio.delete(fl.projectId);
  // Green screen: a pure green picture over a red background is keyed away (the frame shows red).
  const greenPx = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < greenPx.length; i += 4) {
    greenPx[i] = 0;
    greenPx[i + 1] = 255;
    greenPx[i + 2] = 0;
    greenPx[i + 3] = 255;
  }
  const greenFile = path.join(dir, 'green.png');
  fs.writeFileSync(greenFile, nativeImage.createFromBitmap(greenPx, { width: 64, height: 64 }).toPNG());
  const gs = s.studio.create('Studio smoke green', 'square');
  const gsPic = (await s.studio.importFiles(gs.id, [greenFile])).added[0]!;
  const gsClip = s.studio.edit(gs.id, [{ op: 'set_project', width: 240, height: 240, background: '#FF0000' }, { op: 'add_media', assetId: gsPic.id, start: 0, duration: 1 }]).project.tracks[0]!.clips[0]!;
  const pixel = async () => {
    const f = (await s.studio.frames(gs.id, [0.5], 120))[0]!;
    const bmp = nativeImage.createFromBuffer(f.png).toBitmap();
    const at = (60 * 120 + 60) * 4;
    return { b: bmp[at]!, g: bmp[at + 1]!, r: bmp[at + 2]! };
  };
  const beforeKey = await pixel();
  s.studio.edit(gs.id, [{ op: 'set', clip: gsClip.id, chroma: { color: '#00FF00' } }]);
  out.chroma = { before: beforeKey, after: await pixel() };
  s.studio.delete(gs.id);
  // A speed curve, exported for real (on a copy of the second project).
  const sc = s.studio.duplicate(b.id);
  const scClip = s.studio.get(sc.id).tracks.flatMap((t) => t.clips).find((c) => c.type === 'media')!;
  s.studio.edit(sc.id, [{ op: 'set', clip: scClip.id, speedCurve: 'montage' }]);
  const scOut = await s.studio.exportVideo(sc.id);
  out.speedCurve = { frames: scOut.frames, seconds: scOut.durationSec, expected: projectDuration(s.studio.get(sc.id)) };
  fs.rmSync(scOut.file, { force: true });
  s.studio.delete(sc.id);
  for (const f of [first.file, second.file, third.file, moOut.file]) fs.rmSync(f, { force: true });
  s.studio.delete(mo.id);
  s.studio.delete(a.id);
  s.studio.delete(b.id);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * Smoke (KEO_SMOKE_SWITCH=1): opening another data folder in place — no restart — leaves the
 * other folder's data behind and Keo answering in the same window.
 */
function smokeSwitch(win: BrowserWindow, out: string | undefined): void {
  const js = (code: string) => win.webContents.executeJavaScript(`(async () => { const call = async (ch, input) => { const r = await window.keo.invoke(ch, input); if (!r.ok) throw new Error(r.error.message); return r.value; }; ${code} })()`);
  const result: Record<string, unknown> = { pid: process.pid };
  const finish = () => {
    log.info('smoke.result', { keys: Object.keys(result).length });
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
    app.quit();
  };
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        await js(`await call('conversations:create', { title: 'before the switch' }); await call('account:useLocal', {});`);
        result.windowId = win.id;
        win.webContents.once('did-finish-load', () => {
          setTimeout(async () => {
            try {
              Object.assign(
                result,
                await js(`return { titles: (await call('conversations:list', {})).map((c) => c.title), ownKeys: (await call('settings:get', {})).ui.ownKeys };`),
                { sameWindow: !win.isDestroyed() && result.windowId === win.id, mode: accountState.mode },
              );
            } catch (e) {
              result.error = errorMessage(e);
            }
            finish();
          }, 1500);
        });
      } catch (e) {
        result.error = errorMessage(e);
        finish();
      }
    }, 1500);
  });
}

/**
 * Development-only visual review (KEO_SMOKE_SHOTS=<dir>, never in packaged
 * builds): seeds synthetic data through the normal IPC bridge in the
 * disposable smoke profile and screenshots each view. The approval request it
 * creates targets a fake window handle and is never approved.
 */
async function captureViews(win: BrowserWindow, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  // KEO_SMOKE_SIZE=1366x700 reviews a smaller (laptop) window.
  const [sw, sh] = (process.env.KEO_SMOKE_SIZE ?? '1360x860').split('x').map(Number);
  win.setSize(sw || 1360, sh || 860);
  // Hidden windows are not repainted reliably; show it (without stealing focus) while capturing.
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
  const js = (code: string) => win.webContents.executeJavaScript(`(async () => { const call = async (ch, input) => { const r = await window.keo.invoke(ch, input); if (!r.ok) throw new Error(r.error.message); return r.value; }; ${code} })()`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The first-run welcome, as a brand-new user sees it (no provider yet).
  await js(`await call('settings:update', { patch: { activeProvider: null, ui: { onboarded: false } } });`);
  await wait(1200);
  fs.writeFileSync(path.join(dir, 'welcome.png'), (await win.webContents.capturePage()).toPNG());
  // Signed out, Keo shows its sign-in screen: the intro, then the form.
  await wait(2300);
  fs.writeFileSync(path.join(dir, 'signin-intro.png'), (await win.webContents.capturePage()).toPNG());
  await wait(6500);
  fs.writeFileSync(path.join(dir, 'signin-form.png'), (await win.webContents.capturePage()).toPNG());
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
    ['studio', 'Studio'],
    ['settings', 'Settings'],
    ['diagnostics', 'Diagnose'],
  ];
  // A sample Studio project: a picture, a caption-style title and a tone.
  if (services) {
    const media = studioSampleMedia(fs.mkdtempSync(path.join(os.tmpdir(), 'keo-studio-shots-')));
    const sp = services.studio.create('Summer promo', 'vertical');
    const added = (await services.studio.importFiles(sp.id, [media.pic, media.tone])).added;
    const pic = added.find((x) => x.kind === 'image');
    const snd = added.find((x) => x.kind === 'audio');
    if (pic && snd)
      services.studio.edit(sp.id, [
        { op: 'add_media', assetId: pic.id, duration: 6 },
        { op: 'add_text', text: 'Keo makes videos', start: 0.2, duration: 4, animIn: 'words', style: { sizePct: 7, weight: 'black', color2: '#8B6BFF', glow: 18, glowColor: '#8B6BFF', uppercase: true }, transform: { y: 0.46 } },
        { op: 'add_audio', assetId: snd.id },
      ]);
    if (pic) {
      const now = () => services!.studio.get(sp.id);
      services.studio.edit(sp.id, presetOps(now(), 'lower-third', { at: 0.5, duration: 5, text: 'Ada Obi', subtext: 'Founder · Keo' }));
      services.studio.edit(sp.id, presetOps(now(), 'counter', { at: 0.3, duration: 5, text: '10,000 creators', y: 0.66 }));
      services.studio.edit(sp.id, presetOps(now(), 'avatar', { at: 0.2, duration: 5, assetId: pic.id, y: 0.2 }));
      services.studio.edit(sp.id, presetOps(now(), 'progress-bar', { at: 0, duration: 6 }));
    }
  }
  for (const [name, label] of views) {
    await js(`document.querySelector('nav.rail button[title^="${label}"]')?.click();`);
    await wait(400);
    if (name === 'chat') await js(`[...document.querySelectorAll('.conv-item')].find(b => b.textContent.includes('Plan the week'))?.click();`);
    await wait(900);
    if (name === 'studio') {
      // The playhead at 2 seconds (the title is on screen there).
      await wait(1200);
      await js(`const r = document.querySelector('.tl-ruler'); const b = r?.getBoundingClientRect(); if (b) { r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: b.left + 132 + 2 * 60 })); window.dispatchEvent(new PointerEvent('pointerup')); }`);
      await wait(1000);
    }
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    if (name === 'studio') {
      // A text clip selected: the inspector shows its style and animation.
      await js(`document.querySelector('.tl-clip.text')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10 })); window.dispatchEvent(new PointerEvent('pointerup'));`);
      await wait(900);
      fs.writeFileSync(path.join(dir, 'studio-text.png'), (await win.webContents.capturePage()).toPNG());
      // Ask Keo from Studio: a request in the panel, Keo's edit and reply.
      await js(`[...document.querySelectorAll('.side-tabs button')].find((b) => b.textContent.includes('Keo'))?.click();`);
      await wait(600);
      await js(`const ta = document.querySelector('.keo-input textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '/tool studio.preset {"preset":"subscribe","at":1}'); ta.dispatchEvent(new Event('input', { bubbles: true }));`);
      await wait(200);
      await js(`document.querySelector('.keo-input button[type=submit]')?.click();`);
      await wait(3500);
      fs.writeFileSync(path.join(dir, 'studio-keo.png'), (await win.webContents.capturePage()).toPNG());
      // The projects screen.
      await js(`[...document.querySelectorAll('.studio-bar button')].find((b) => b.textContent.includes('Projects'))?.click();`);
      await wait(1500);
      fs.writeFileSync(path.join(dir, 'studio-home.png'), (await win.webContents.capturePage()).toPNG());
      await js(`[...document.querySelectorAll('.studio-new button')].find((b) => b.textContent.trim() === 'Cancel')?.click();`);
      await wait(500);
      // The Text styles in the library, and the Export window.
      await js(`[...document.querySelectorAll('.bin-tabs button')].find((b) => b.textContent.trim() === 'Text')?.click();`);
      await wait(500);
      await js(`[...document.querySelectorAll('.studio-bar button')].find((b) => b.textContent.includes('Export'))?.click();`);
      await wait(600);
      fs.writeFileSync(path.join(dir, 'studio-export.png'), (await win.webContents.capturePage()).toPNG());
      await js(`[...document.querySelectorAll('.export-dialog button')].find((b) => b.textContent.trim() === 'Cancel')?.click();`);
      await wait(300);
      // The faceless creator with the example script.
      await js(`[...document.querySelectorAll('.studio-bar button')].find((b) => b.textContent.includes('New'))?.click();`);
      await wait(500);
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Faceless video from a script'))?.click();`);
      await wait(500);
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Use the example'))?.click();`);
      await wait(900);
      fs.writeFileSync(path.join(dir, 'studio-faceless.png'), (await win.webContents.capturePage()).toPNG());
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')?.click();`);
      await wait(300);
    }
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
  if (process.env.KEO_SMOKE_SWITCH === '1') return smokeSwitch(win, out);
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
        result.studio = await studioSmoke();
      } catch (e) {
        result.studio = { error: errorMessage(e) };
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
