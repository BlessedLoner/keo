import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const log = new Logger(profile.logsDir, !app.isPackaged && !SMOKE);
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
function createWindow(): BrowserWindow {
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
    },
  });
  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
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
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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
      testProvider: TEST_PROVIDER ? new TestProvider() : null,
      logger: log,
    });
    services.setPush(push);
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
      pickExecutable: async () => {
        const r = await dialog.showOpenDialog(mainWindow ?? undefined!, { title: 'Choose an application', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['exe'] }] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
    });
    registerIpc(ipcMain, handlers, { trustedOrigin: TRUSTED_ORIGIN, trustedWebContentsId: () => mainWindow?.webContents.id ?? null }, log);
    const recovered = services.start();
    log.info('app.ready', { profile: profile.profile, ...recovered.recovery, interruptedMessages: recovered.interruptedMessages, secretStorage: cipher.isAvailable() });
    mainWindow = createWindow();
    if (SMOKE) runSmoke(mainWindow);
  } catch (err) {
    log.error('app.startup_failed', { error: errorMessage(err) });
    dialog.showErrorBox('Keo could not start', errorMessage(err));
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (e) => {
  if (shuttingDown || !services) return;
  e.preventDefault();
  shuttingDown = true;
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
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Appearance'))?.click();`);
  await wait(900);
  fs.writeFileSync(path.join(dir, 'appearance.png'), (await win.webContents.capturePage()).toPNG());
  // Leave the pending approval unanswered; cancel the turn so nothing lingers.
  await js(`for (const id of await call('chat:active')) await call('chat:cancel', { conversationId: id });`);
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
            try { const x = await fetch('https://example.com'); r.rendererNetwork = 'allowed:' + x.status; } catch (e) { r.rendererNetwork = 'blocked'; }
            r.rootRendered = !!document.querySelector('#root')?.children.length;
            return r;
          })()`,
        )) as Record<string, unknown>;
      } catch (e) {
        result = { error: errorMessage(e) };
      }
      log.info('smoke.result', { keys: Object.keys(result).length });
      if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
      const shots = process.env.KEO_SMOKE_SHOTS;
      if (shots && !app.isPackaged) await captureViews(win, shots).catch((e) => log.error('smoke.shots_failed', { error: errorMessage(e) }));
      app.quit();
    }, 1500);
  });
}
