import { StudioError } from '../studio/studioService';
import { buildReport } from '../../shared/problemReport';
import { BuildError, type BuildManifest } from '../build/projects';
import { CALENDAR_SCOPE, MAIL_SCOPE } from '../calendar/googleAuth';
import type { AttachmentView } from '../../shared/ipc';
import type { PreparedAttachment } from '../chat/attachments';
import type { AppInfo } from '../../shared/domain';
import { LINKS } from '../../shared/release';
import type { UpdateInfo } from '../../shared/domain';
import type { BuildSummary, InvokeChannel, InvokeOutputs, ParsedInput } from '../../shared/ipc';
import { LATEST_SCHEMA_VERSION } from '../db/database';
import { KeoError } from '../util/errors';
import { validateWakePhrase } from '../voice/wakeService';
import { diagnosticReport } from '../desktop/diagnosticReport';
import { packageScripts } from '../projects/workspace';
import { importBundle } from '../workflows/portability';
import { locateFfmpeg } from '../video/ffmpeg';
import type { Services } from '../services';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCalendarLink } from '../briefing/briefing';
import { plainToOpen } from '../capabilities/findFiles';

export type Handler<C extends InvokeChannel> = (input: ParsedInput<C>) => Promise<InvokeOutputs[C]> | InvokeOutputs[C];
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HostHooks {
  /** File Explorer with the item selected. */
  showInFolder?(p: string): void;
  /** Windows' file picker for chat attachments (several files). */
  pickFiles?(): Promise<string[]>;
  /** Windows' file picker for Keo Studio: videos, pictures and sound (several files). */
  pickMedia?(): Promise<string[]>;
  /** A picture of the screen with Keo's own window out of the way. */
  screenshotBehindKeo?(): Promise<Buffer | null>;
  /** Sends to Keo's presence windows only (the bar, Keo mode). */
  broadcastPresence?(channel: 'presence:level', payload: unknown): void;
  appInfo(): Omit<AppInfo, 'schemaVersion' | 'secretStorage' | 'userDataPath' | 'profile'>;
  openPath(p: string): Promise<boolean>;
  /** Moves a file or folder to the Recycle Bin (it can be restored from there). */
  trashItem?(p: string): Promise<void>;
  /** Opens one of Keo's allow-listed web pages in the default browser. */
  openExternal?(url: string): Promise<void>;
  /** Writes text to the clipboard (the renderer's own clipboard access is not granted). Write-only. */
  copyText?(text: string): Promise<void> | void;
  /** Checks GitHub Releases (packaged app only unless forced); null when not applicable. */
  checkUpdate?(force: boolean): Promise<UpdateInfo | null>;
  /** Restarts into a downloaded update; false when none is ready. */
  installUpdate?(): boolean;
  pickExecutable(): Promise<string | null>;
  /** Folder picker (project workspace). */
  pickFolder?(title: string): Promise<string | null>;
  /** File picker for a trained wake word model (.ppn). */
  pickWakeModel?(): Promise<string | null>;
  /** Save/open dialogs for export/import (JSON). */
  pickSaveFile?(defaultName: string): Promise<string | null>;
  pickOpenFile?(): Promise<string | null>;
  captureFrom?: never;
  relaunch(): void;
  /** Use Keo without a Keo account: start again on the local (own API keys) data. */
  useLocal?(): void;
  /** Keo's render window has loaded and listens for jobs. */
  renderReady?(): void;
  openMain?(view?: 'chat' | 'tasks' | 'settings' | 'call'): void;
  showCommandBar?(): void;
  hideCommandBar?(): void;
  hideCompanion?(): void;
  hideResults?(): void;
  hideVideo?(): void;
  /** File picker for ffmpeg.exe. */
  pickFfmpeg?(): Promise<string | null>;
  /** The marks the on-screen drawing window shows (in its own pixels). */
  currentMarks?(): { marks: Array<{ shape: 'circle' | 'box' | 'arrow' | 'underline' | 'label'; x: number; y: number; w?: number; h?: number; fromX?: number; fromY?: number; label?: string }>; seconds: number } | null;
  setCompanionInteractive?(interactive: boolean): void;
  companionDrag?(phase: 'start' | 'end'): void;
  shortcutStatus?(): { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  voiceShortcutStatus?(): { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  pencilShortcutStatus?(): { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  quit?(): void;
  /** Connected displays (size and scaling only). */
  displays?(): Array<{ width: number; height: number; scale: number; primary: boolean }>;
}

/**
 * Application-service handlers behind every IPC channel. Inputs arrive here
 * already validated against the channel schema by the router.
 */
/** An attachment without its text and picture (those stay in the main process until sent). */
const view = (a: PreparedAttachment): AttachmentView => {
  const { text: _text, image: _image, ...rest } = a;
  return rest;
};

export function createHandlers(s: Services, host: HostHooks): HandlerMap {
  const changed = (channel: string, payload: unknown) => s.emit(channel, payload);
  const abortAfter = (ms: number) => AbortSignal.timeout(ms);
  /** A problem report's text: the user's words, Keo's version, and (if they agree) the recent log, personal details out. */
  const problemReport = (message: string, includeLog: boolean) => {
    const info = host.appInfo();
    return buildReport({ message, env: { version: info.version, platform: info.platform, electron: info.electron, packaged: info.packaged, home: os.homedir() }, ...(includeLog ? { logs: s.log.recent(400) } : {}) });
  };
  const wakeStatus = async () => ({
    ...s.wake.getState(),
    recognizers: await s.wake.recognizers(),
    engine: s.wake.engineInfo(),
    picovoiceKey: s.secrets.has('picovoice'),
    voiceShortcut: host.voiceShortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.voice, enabled: s.settings.get().shortcuts.voiceEnabled, registered: false, error: 'Not available in this build.' },
    pencilShortcut: host.pencilShortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.pencil, enabled: s.settings.get().shortcuts.pencilEnabled, registered: false, error: 'Not available in this build.' },
    shortcut: host.shortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.commandBar, enabled: s.settings.get().shortcuts.commandBarEnabled, registered: false, error: 'Not available in this build.' },
  });
  /** After signing in: Keo's own AI is used, unless the user already has a working provider. */
  const useKeoIfNothingElse = () => s.useKeoIfNothingElse();
  /** Studio refusals reach the window as a plain message. */
  const studioCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof StudioError) throw new KeoError('studio', e.message);
      throw e;
    }
  };
  /** For promise chains: a Studio refusal as a plain message, anything else as it is. */
  /** A build as the Builds page shows it. */
  const buildSummary = (m: BuildManifest): BuildSummary => {
    let files: number;
    try {
      files = s.builds.files(m.id).length;
    } catch {
      files = 0;
    }
    return { id: m.id, title: m.title, kind: m.kind, brief: m.brief, libraries: m.libraries, backend: m.backend, todo: m.todo, files, createdAt: m.createdAt, updatedAt: m.updatedAt };
  };
  const buildErr = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof BuildError) throw new KeoError('build', e.message);
      throw e;
    }
  };
  const aiVideoStatus = async () => {
    const own = s.secrets.has('fal');
    const keo = !own && s.account.signedIn();
    const credits = keo ? await s.account.studioCredits().catch(() => null) : null;
    return { hasKey: own, secretStorage: s.secrets.available(), ...s.falSpending(), via: own ? ('own' as const) : keo ? ('keo' as const) : null, credits };
  };
  const studioErr = (e: unknown): never => {
    if (e instanceof StudioError) throw new KeoError('studio', e.message);
    throw e;
  };
  const emailStatus = () => ({ connected: s.email.connected(), loginRefused: s.email.lastTestOk === false, address: s.email.address(), hasPassword: s.secrets.has('email_password'), secretStorage: s.secrets.available(), viaGoogle: s.settings.get().email.useGoogle });
  const calendarStatus = () => {
    const at = s.googleAuth.obtainedAt();
    return { clientId: s.settings.get().calendar.googleClientId, builtIn: !!s.builtinGoogle, builtInId: s.builtinGoogle?.id ?? null, hasClientSecret: s.secrets.has('google_client_secret'), signedIn: s.googleAuth.signedIn(), signingIn: s.googleAuth.signingIn(), googleEmail: s.googleAuth.email(), calendarAllowed: s.googleAuth.hasScope(CALENDAR_SCOPE), mailAllowed: s.googleAuth.hasScope(MAIL_SCOPE), signedInAt: at ? new Date(at).toISOString() : null, secretStorage: s.secrets.available() };
  };
  const webStatus = () => {
    const st = s.settings.get();
    return { hasKey: s.secrets.has('brave'), searchEnabled: st.permissions.webSearchEnabled, fetchEnabled: st.permissions.webFetchEnabled, secretStorage: s.secrets.available() };
  };

  return {
    'app:info': () => ({
      ...host.appInfo(),
      profile: s.profile.profile,
      userDataPath: s.profile.userData,
      schemaVersion: s.db.schemaVersion() || LATEST_SCHEMA_VERSION,
      secretStorage: s.secrets.available() ? 'os-encrypted' : 'unavailable',
    }),
    'app:openDataFolder': async () => ({ opened: await host.openPath(s.profile.userData) }),
    'app:openLink': async ({ id }) => {
      if (!host.openExternal) return { opened: false };
      await host.openExternal(LINKS[id]);
      return { opened: true };
    },
    'app:installUpdate': () => ({ started: host.installUpdate?.() ?? false }),
    'diag:checkComputer': () => s.checkComputer(),
    // Installed apps with icons for the Access pickers (read-only; names, ids, process names, icons).
    'apps:installed': async () => s.apps.installed(),
    // Picovoice access key for the trained wake word: stored encrypted like the other keys; empty removes it.
    'wake:setPicovoiceKey': ({ key }) => {
      if (key) s.secrets.set('picovoice', key);
      else s.secrets.delete('picovoice');
      s.porcupine.reset();
      void s.wake.apply();
      return { hasKey: s.secrets.has('picovoice') };
    },
    'wake:pickKeywordFile': async () => {
      const file = (await host.pickWakeModel?.()) ?? null;
      if (file) s.settings.update({ wake: { porcupine: { keywordPath: file, builtin: null } } });
      return { path: file };
    },
    'results:get': ({ id }) => {
      const r = s.results.get(id);
      return r ? { id: r.id, title: r.title, summary: r.summary, criteria: r.criteria, cards: r.cards, createdAt: r.createdAt } : null;
    },
    // The buttons in Keo's results window are the user's own instruction (recipient/format shown there).
    'results:save': async ({ id, format }) => {
      const r = await s.runUserAction('research.save_result', { resultId: id, format });
      return { ok: r.ok, folder: r.ok ? ((r.result as { folder: string }).folder ?? null) : null, error: r.error };
    },
    'results:send': async ({ id, contact, which, note }) => {
      const r = await s.runUserAction('research.send_whatsapp', { resultId: id, contact, ...(which ? { which } : {}), ...(note ? { note } : {}) });
      return { ok: r.ok, error: r.error, detail: r.detail };
    },
    'results:openFolder': async ({ folder }) => {
      // Only folders Keo saved research into.
      const root = s.researchSaveRoot();
      const full = path.resolve(folder);
      if (!full.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(full)) return { opened: false };
      return { opened: await host.openPath(full) };
    },
    'results:close': () => {
      host.hideResults?.();
      return { closed: true };
    },
    'video:get': () => s.video.view(),
    'video:preview': ({ id, version }) => ({ bytes: s.video.previewBytes(id, version) }),
    // Typed in Keo's own preview window: the user's instruction.
    'video:say': ({ text }) => s.videoSay(text),
    'video:undo': () => s.videoUndo(),
    // The window's Save button is the user's own click; it runs through the normal task path.
    'video:export': async ({ name }) => {
      const p = s.video.get(undefined);
      const r = await s.runUserAction('video.render_final', { ...(p ? { projectId: p.id } : {}), ...(name ? { name } : {}) });
      return { ok: r.ok, file: r.ok ? ((r.result as { file: string }).file ?? null) : null, error: r.error, detail: r.detail };
    },
    'video:openFolder': async () => {
      // Only the folder Keo saves videos into.
      const root = s.videoOutputRoot();
      return { opened: fs.existsSync(root) ? await host.openPath(root) : false };
    },
    'video:close': () => {
      host.hideVideo?.();
      return { closed: true };
    },
    'video:status': () => s.video.status(AbortSignal.timeout(30_000)),
    'video:pickFfmpeg': async () => {
      const file = (await host.pickFfmpeg?.()) ?? null;
      if (!file) return { path: null, ok: false, message: 'Nothing chosen.' };
      if (!locateFfmpeg(file)) return { path: file, ok: false, message: 'Choose ffmpeg.exe; ffprobe.exe must be in the same folder. Nothing was changed.' };
      s.settings.update({ video: { ffmpegPath: file } });
      const st = await s.video.status(AbortSignal.timeout(30_000));
      return { path: file, ok: st.found, message: st.message };
    },
    // Keo's own ffmpeg: only ever started by the user's click in Settings → Video.
    'video:setupState': () => s.ffmpegSetup.state(),
    'video:setupStart': () => s.ffmpegSetup.start(),
    'video:setupCancel': () => s.ffmpegSetup.cancel(),
    'video:setupRemove': () => s.ffmpegSetup.remove(),
    'files:pickFolder': async ({ list }) => {
      const title = list === 'roots' ? 'Choose a folder Keo may search' : list === 'photoFolders' ? 'Choose a folder whose pictures Keo may describe' : 'Choose a folder Keo should never search';
      const dir = (await host.pickFolder?.(title)) ?? null;
      if (dir) {
        const cur = s.settings.get().files[list];
        if (!cur.some((x) => x.toLowerCase() === dir.toLowerCase())) s.settings.update({ files: { [list]: [...cur, dir] } });
      }
      return { path: dir };
    },
    // Pictures are sent only after the user's click here (and with the switch and consent on).
    'files:photosState': () => s.photos.state(),
    'files:photosEstimate': () => s.photos.estimate(),
    'files:photosStart': () => s.photos.start(),
    'files:photosPause': () => s.photos.pause(),
    'files:photosClear': () => s.photos.clear(),
    'video:pickOutput': async () => {
      const dir = (await host.pickFolder?.('Where should Keo save finished videos?')) ?? null;
      if (dir) s.settings.update({ video: { outputDir: dir } });
      return { path: dir };
    },
    'workflows:list': () => s.workflows.list().map((w) => ({ id: w.id, name: w.name, description: w.description, steps: w.steps.length, imported: w.imported, createdAt: w.createdAt })),
    'workflows:saveFromTask': ({ taskId, name }) => {
      const task = s.tasks.get(taskId);
      if (!task) throw new KeoError('not_found', 'Task not found.');
      const wf = s.workflows.fromTask(task, name);
      return { id: wf.id, name: wf.name };
    },
    'workflows:delete': ({ id }) => ({ deleted: s.workflows.delete(id) }),
    // Projects (with their items) and workflows; never settings, keys or conversations.
    'data:export': async () => {
      const file = await host.pickSaveFile?.(`keo-export-${new Date().toISOString().slice(0, 10)}.json`);
      if (!file) return { path: null, projects: 0, workflows: 0 };
      const projects = s.projects.list().map((p) => ({ name: p.name, description: p.description, status: p.status, items: s.projects.items(p.id).filter((it) => it.status !== 'proposed').map((it) => ({ type: it.type, content: it.content, status: it.status })) }));
      const workflows = s.workflows.list().map(({ name, description, steps }) => ({ name, description, steps }));
      fs.writeFileSync(file, JSON.stringify({ format: 'keo-export', version: 1, exportedAt: new Date().toISOString(), projects, workflows }, null, 1));
      return { path: file, projects: projects.length, workflows: workflows.length };
    },
    'data:import': async () => {
      const file = await host.pickOpenFile?.();
      if (!file) return null;
      const r = importBundle(s, fs.readFileSync(file, 'utf8'));
      return r;
    },
    // A project's workspace is only ever set by the user choosing a folder in the picker.
    'projects:pickWorkspace': async ({ projectId }) => {
      if (!s.projects.get(projectId)) throw new KeoError('not_found', 'Project not found.');
      const dir = (await host.pickFolder?.('Choose the project folder')) ?? null;
      if (!dir) return { path: null, scripts: [] };
      s.settings.update({ projectWorkspaces: { ...s.settings.get().projectWorkspaces, [projectId]: dir } });
      s.audit.record({ kind: 'project.workspace', decision: 'set', detail: { projectId } });
      return { path: dir, scripts: Object.keys(packageScripts(dir)) };
    },
    'projects:clearWorkspace': ({ projectId }) => {
      const next = { ...s.settings.get().projectWorkspaces };
      const had = projectId in next;
      delete next[projectId];
      s.settings.replace({ ...s.settings.get(), projectWorkspaces: next });
      return { cleared: had };
    },
    'diag:checkWhatsApp': () => s.checkWhatsApp(),
    'diag:report': () => {
      const info = host.appInfo();
      const failures = s.tasks
        .list(30)
        .flatMap((t) => t.steps)
        .filter((st) => st.state === 'failed' && st.errorCode)
        .slice(0, 8)
        .map((st) => ({ capabilityId: st.capabilityId, code: st.errorCode! }));
      return {
        text: diagnosticReport({
          version: info.version,
          packaged: info.packaged,
          electron: info.electron,
          settings: s.settings.get(),
          providersWithKeys: (['anthropic', 'openai', 'openrouter', 'brave'] as const).filter((id) => s.secrets.has(id)),
          speech: { ...s.wake.engineInfo(), wakeStatus: s.wake.getState().status },
          displays: host.displays?.() ?? [],
          selfTest: s.lastSelfTest,
          whatsapp: s.lastWhatsAppCheck,
          recentFailures: failures,
        }),
      };
    },
    // Only pages Keo actually read (shown as research sources) can be opened from the app.
    'app:copyText': async ({ text }) => {
      if (!host.copyText) return { copied: false };
      await host.copyText(text);
      return { copied: true };
    },
    'app:openUrl': async ({ url }) => {
      const page = s.web.visitedPage(url);
      if (!page || !/^https?:\/\//i.test(page.finalUrl) || !host.openExternal) return { opened: false };
      await host.openExternal(page.finalUrl);
      return { opened: true };
    },
    'app:checkUpdate': async ({ force }) => (force || s.settings.get().updates.check ? ((await host.checkUpdate?.(force)) ?? null) : null),

    'settings:get': () => s.settings.get(),
    'settings:update': ({ patch }) => {
      const before = s.settings.get();
      const next = s.settings.update(patch);
      const p = (k: string, a: unknown, b: unknown) => a !== b && s.audit.record({ kind: 'permission.setting', decision: `${k}=${String(b)}` });
      p('observationEnabled', before.permissions.observationEnabled, next.permissions.observationEnabled);
      p('desktopControlEnabled', before.permissions.desktopControlEnabled, next.permissions.desktopControlEnabled);
      p('launchEnabled', before.permissions.launchEnabled, next.permissions.launchEnabled);
      p('webSearchEnabled', before.permissions.webSearchEnabled, next.permissions.webSearchEnabled);
      p('webFetchEnabled', before.permissions.webFetchEnabled, next.permissions.webFetchEnabled);
      p('memoryLearning', before.memory.learning, next.memory.learning);
      for (const k of ['anthropic', 'openai', 'openrouter', 'local'] as const) p(`visionExport.${k}`, before.permissions.visionExport[k], next.permissions.visionExport[k]);
      p('audioExportConsent', before.voice.audioExportConsent, next.voice.audioExportConsent);
      if (next.activeProvider && !s.providers.has(next.activeProvider)) {
        s.settings.update({ activeProvider: before.activeProvider });
        throw new KeoError('invalid_input', 'That provider is not available in this build.');
      }
      return s.settings.get();
    },

    'providers:list': () => s.providers.list(),
    'providers:setKey': ({ providerId, apiKey }) => {
      s.providers.setKey(providerId, apiKey);
      return s.providers.list();
    },
    'providers:clearKey': ({ providerId }) => {
      s.providers.clearKey(providerId);
      return s.providers.list();
    },
    'providers:diagnose': async ({ providerId }) => {
      const d = await s.providers.get(providerId).diagnose(abortAfter(30000));
      s.log[d.ok ? 'info' : 'warn']('provider.diagnostic', { providerId, ok: d.ok, latencyMs: d.latencyMs });
      return d;
    },

    // Background jobs' own conversations stay out of the list (their reports are in the conversation that asked).
    'conversations:list': ({ projectId, query }) => s.conversations.list({ projectId: projectId ?? null, ...(query ? { query } : {}) }).filter((c) => !s.jobs.isJobConversation(c.id)),
    'conversations:create': ({ title, projectId }) => {
      if (projectId) s.projects.require(projectId);
      const c = s.conversations.create(title ?? 'New conversation', projectId ?? null);
      changed('conversations:changed', { conversationId: c.id });
      return c;
    },
    'conversations:rename': ({ id, title }) => {
      const c = s.conversations.rename(id, title);
      changed('conversations:changed', { conversationId: id });
      return c;
    },
    'conversations:setProject': ({ id, projectId }) => {
      if (projectId) s.projects.require(projectId);
      const c = s.conversations.setProject(id, projectId);
      changed('conversations:changed', { conversationId: id });
      return c;
    },
    'conversations:delete': ({ id }) => {
      s.agent.cancel(id);
      const deleted = s.conversations.delete(id);
      changed('conversations:changed', { conversationId: id });
      return { deleted };
    },
    'conversations:messages': ({ id }) => {
      s.conversations.require(id);
      return s.conversations.messages(id);
    },

    'chat:send': ({ conversationId, text, attachments }) => {
      const attached = attachments?.length ? s.attachments.take(attachments) : [];
      if (attachments?.length && !attached.length && !text) throw new KeoError('attachments_expired', 'The attachments are no longer ready. Attach them again.');
      const r = s.agent.send(conversationId, text, attached.length ? { attachments: attached } : {});
      r.done.catch((e) => s.log.error('agent.unhandled', { error: String(e) }));
      changed('conversations:changed', { conversationId });
      return { accepted: true as const, userMessageId: r.userMessageId };
    },
    'chat:pickAttachments': async () => {
      const files = (await host.pickFiles?.()) ?? [];
      const out = [];
      for (const f of files.slice(0, 8)) {
        try {
          out.push(view(await s.attachments.fromPath(f, abortAfter(120000))));
        } catch (e) {
          throw new KeoError('attach_failed', (e as Error).message);
        }
      }
      return out;
    },
    'chat:attachBytes': async ({ name, dataBase64 }) => {
      try {
        return view(await s.attachments.fromBytes(name, Buffer.from(dataBase64, 'base64'), abortAfter(120000)));
      } catch (e) {
        throw new KeoError('attach_failed', (e as Error).message);
      }
    },
    'chat:attachScreenshot': async () => {
      const png = await host.screenshotBehindKeo?.();
      if (!png) throw new KeoError('unavailable', 'Taking a screenshot is not available in this build.');
      return view(await s.attachments.fromPicture(`Screenshot ${new Date().toLocaleTimeString()}.png`, png));
    },
    'account:status': () => s.account.status(),
    'account:signUp': async ({ email, password }) => {
      try {
        const r = await s.account.signUp(email, password);
        if (!r.needsConfirmation) useKeoIfNothingElse();
        return { needsConfirmation: r.needsConfirmation, status: s.account.status() };
      } catch (e) {
        throw new KeoError('account', (e as Error).message);
      }
    },
    'account:signIn': async ({ email, password }) => {
      try {
        await s.account.signIn(email, password);
      } catch (e) {
        throw new KeoError('account', (e as Error).message);
      }
      useKeoIfNothingElse();
      return s.account.status();
    },
    'account:signOut': async () => {
      await s.account.signOut();
      // Like any signed-in app: signing out goes back to the sign-in screen (not to "no provider").
      s.settings.update({ ui: { ownKeys: false }, ...(s.settings.get().activeProvider === 'keo' ? { activeProvider: null } : {}) });
      return s.account.status();
    },
    'account:resetPassword': async ({ email }) => {
      try {
        await s.account.resetPassword(email);
      } catch (e) {
        throw new KeoError('account', (e as Error).message);
      }
      return { ok: true as const };
    },
    'studio:list': () => s.studio.list(),
    'studio:create': ({ name, format }) => s.studio.create(name, format),
    'studio:get': ({ id }) => s.studio.get(id),
    'studio:open': ({ id }) => s.studio.open(id),
    'studio:duplicate': ({ id }) => studioCall(() => s.studio.duplicate(id)),
    // The user picks their clips in Windows' own picker; they go into the template's slots.
    'studio:useTemplate': async ({ id }) => {
      const files = host.pickMedia ? await host.pickMedia() : [];
      if (!files.length) return null;
      return s.studio.fromTemplate(id, files).catch(studioErr);
    },
    'studio:saveFrame': async ({ id, time }) => ({ file: await s.studio.saveFrame(id, time).catch(studioErr) }),
    'studio:delete': ({ id }) => {
      s.studio.delete(id);
      return { ok: true as const };
    },
    'studio:edit': ({ id, ops }) => studioCall(() => s.studio.edit(id, ops)),
    'studio:undo': ({ id }) => studioCall(() => s.studio.undoEdit(id)),
    'studio:redo': ({ id }) => studioCall(() => s.studio.redoEdit(id)),
    'studio:history': ({ id }) => s.studio.canUndo(id),
    // The user's own click in Studio (after the page showed where the sound goes).
    'studio:captions': async ({ id, maxWords }) => {
      const r = await s.studioCaptions(id, { maxWords }).catch((e: unknown) => {
        throw e instanceof StudioError ? new KeoError('studio', e.message) : e;
      });
      return { lines: r.lines.length, words: r.words, exact: r.exact, skipped: r.skipped };
    },
    // The user's own click in Studio, after the page showed where the sound goes.
    'studio:transcribe': async ({ id }) => {
      const r = await s.studioTranscribe(id).catch(studioErr);
      return { words: r.words, exact: r.exact, skipped: r.skipped };
    },
    'studio:cleanup': async ({ id, dryRun, ...o }) => {
      const r = dryRun ? { plan: await s.studio.planCleanup(id, o).catch(studioErr) } : await s.studio.cleanup(id, o).catch(studioErr);
      const byReason: Record<string, number> = {};
      for (const c of r.plan.cuts) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
      return { cuts: r.plan.cuts.length, seconds: r.plan.seconds, byReason, notes: r.plan.notes };
    },
    'studio:punchIn': async ({ id, scale }) => ({ points: (await s.studio.punchIn(id, { ...(scale ? { scale } : {}) }).catch(studioErr)).points }),
    // The user's own click in Studio, after the page showed what is made and sent where.
    'studio:faceless': async (board) => s.facelessCreate(board).catch(studioErr),
    'studio:facelessPlan': (board) => s.facelessPlan(board),
    'studio:focus': ({ id, time, selected }) => {
      s.setStudioFocus({ projectId: id, time, selected });
      return { ok: true as const };
    },
    'studio:assetIssue': ({ id, assetId, issue }) => {
      s.noteStudioIssue(id, assetId, issue);
      return { ok: true as const };
    },
    'studio:conversation': ({ id }) => studioCall(() => ({ conversationId: s.studioConversation(id, s.studio.get(id).name) })),
    'studio:soundEffect': ({ id, kind, at }) => {
      try {
        const { asset } = s.studio.soundEffect(id, kind);
        s.studio.edit(id, [{ op: 'add_audio', assetId: asset.id, trackName: 'Effects', start: at, volume: 0.6 }]);
      } catch (e) {
        studioErr(e);
      }
      return { ok: true as const };
    },
    'studio:captionSource': () => {
      const t = s.studioTranscriber();
      return t ? { destination: t.destination, exact: !!t.words, reason: null } : { destination: null, exact: false, reason: 'Captions need speech-to-text: sign in to your Keo account, or add an OpenAI API key in Settings → Providers.' };
    },
    'studio:import': async ({ id, paths }) => {
      const files = paths ?? (host.pickMedia ? await host.pickMedia() : []);
      return s.studio.importFiles(id, files);
    },
    'studio:exportCancel': ({ id }) => ({ cancelled: s.studio.cancelExport(id) }),
    'studio:reframe': async ({ id, clip }) => s.studioReframe(id, clip).catch(studioErr),
    // The user's own click in Studio.
    'studio:readAloud': async ({ id, clip, voice }) => s.studioReadAloud(id, clip, voice).catch(studioErr),
    'studio:saveRecording': async ({ id, wavBase64, at }) => s.studio.saveRecording(id, Buffer.from(wavBase64, 'base64'), at).catch(studioErr),
    'studio:analyzeSpeech': async ({ id }) => ({ analysed: (await s.studio.analyzeSpeech(id).catch(studioErr)).analysed }),
    'studio:track': async ({ id, clip, box }) => {
      const r = await s.studio.trackMotion(id, clip, box).catch(studioErr);
      return { points: r.points, lost: r.lost };
    },
    'studio:stabilize': async ({ id, clip, strength }) => {
      const r = await s.studio.stabilize(id, clip, strength).catch(studioErr);
      return { points: r.points, zoom: r.zoom };
    },
    'studio:templates': () => s.studio.recipes(),
    'studio:learnTemplate': async ({ id, assetId, name }) => s.studio.learnTemplate(id, assetId, name ? { name } : {}).catch(studioErr),
    'studio:applyTemplate': async ({ id, recipe, endText }) => {
      const r = await s.studio.asKeo(() => s.studio.applyTemplate(id, recipe, endText ? { endText } : {})).catch(studioErr);
      return { cutaways: r.cutaways, captions: r.captions, music: r.music, needsWords: r.needsWords };
    },
    'studio:deleteTemplate': ({ recipe }) => {
      studioCall(() => s.studio.deleteRecipe(recipe));
      return { ok: true as const };
    },
    'studio:sounds': ({ query, kind, genre }) => s.studio.sounds.list({ ...(query ? { query } : {}), ...(kind ? { kind } : {}), ...(genre ? { genre } : {}) }),
    'studio:soundsAdd': async ({ paths, kind }) => {
      const files = paths ?? (host.pickMedia ? await host.pickMedia() : []);
      return s.studio.sounds.add(files, kind ? { kind } : {}).catch(studioErr);
    },
    'studio:soundUpdate': ({ sound, ...patch }) => studioCall(() => s.studio.sounds.update(sound, patch)),
    'studio:soundDelete': ({ sound }) => {
      studioCall(() => s.studio.sounds.remove(sound));
      return { ok: true as const };
    },
    'studio:soundUse': async ({ id, sound, at, role }) => ({ clip: (await s.studio.useSound(id, sound, { ...(at !== undefined ? { at } : {}), ...(role ? { role } : {}) }).catch(studioErr)).clip }),
    'studio:watch': ({ id, on }) => {
      s.studio.watch(id, on);
      return { ok: true as const };
    },
    'studio:brand': ({ patch }) => (patch ? s.studio.setBrand(patch) : s.studio.brand()),
    // Characters for faceless videos (the user's clicks on the Characters page).
    'studio:characters': async ({ action, patch, id, picture, pose, audio, about }) => {
      if (action === 'save') {
        if (!patch) throw new StudioError('Nothing to save.');
        s.studio.saveCharacter(patch);
      } else if (action === 'delete') s.studio.deleteCharacter(id ?? '');
      else if (action === 'addPicture') {
        const files = host.pickMedia ? await host.pickMedia() : [];
        for (const f of files.filter((x) => /\.(jpe?g|png|webp)$/i.test(x)).slice(0, 4)) s.studio.addCharacterPicture(id ?? '', f);
      } else if (action === 'removePicture') s.studio.removeCharacterPicture(id ?? '', picture ?? '');
      // The user's click after seeing what it costs (the page asks first).
      else if (action === 'createPicture') await s.characterCreatePicture(id ?? '', new AbortController().signal).catch(studioErr);
      // A voice sample the page recorded or read from the user's file (as WAV), or one designed from words.
      else if (action === 'setVoice') {
        if (!audio) throw new StudioError('No recording to use.');
        s.studio.setCharacterVoice(id ?? '', Buffer.from(audio, 'base64'), { ext: 'wav' });
      } else if (action === 'removeVoice') s.studio.removeCharacterVoice(id ?? '');
      else if (action === 'designVoice') await s.characterDesignVoice(id ?? '', about ?? '', new AbortController().signal).catch(studioErr);
      else if (action === 'morePose') await s.characterMorePose(id ?? '', pose ?? 'standing, smiling at the camera', new AbortController().signal).catch(studioErr);
      return s.studio.characters();
    },
    // Clone a video: the user's click after the page showed the price.
    'builds:list': () => s.builds.list().map((m) => buildSummary(m)),
    'builds:get': ({ id }) => {
      const m = buildErr(() => s.builds.manifest(id));
      const folder = s.builds.dir(id);
      let guide: string | null;
      try {
        guide = fs.readFileSync(path.join(folder, 'PUT-IT-ONLINE.md'), 'utf8');
      } catch {
        guide = null;
      }
      return { build: buildSummary(m), folder, files: s.builds.files(id), pages: s.builds.pages(id), guide };
    },
    'builds:open': async ({ id, page }) => {
      if (!s.buildHost) throw new KeoError('unavailable', 'The preview is not available here.');
      await s.buildHost.open(id, page ?? '').catch((e: unknown) => {
        throw new KeoError('build', e instanceof Error ? e.message : String(e));
      });
      return { opened: true };
    },
    'builds:folder': async ({ id, file }) => {
      const dir = buildErr(() => s.builds.dir(id));
      if (file) {
        const full = buildErr(() => s.builds.file(id, file));
        if (host.showInFolder && fs.existsSync(full)) {
          host.showInFolder(full);
          return { opened: true };
        }
      }
      return { opened: await host.openPath(dir) };
    },
    'builds:todo': ({ id, index, done }) => {
      const m = buildErr(() => s.builds.manifest(id));
      if (!m.todo[index]) throw new KeoError('build', 'That to-do item is not there any more.');
      return buildSummary(s.builds.update(id, { todo: m.todo.map((t, i) => (i === index ? { ...t, done } : t)) }));
    },
    'builds:delete': async ({ id }) => {
      const dir = buildErr(() => s.builds.dir(id));
      if (!host.trashItem) throw new KeoError('unavailable', 'Keo cannot move folders to the Recycle Bin here.');
      await host.trashItem(dir);
      s.builds.forget(id);
      return { deleted: true };
    },
    'studio:aiVideoPlan': async (o) => s.aiVideoPlanShots(o, new AbortController().signal).catch(studioErr),
    // The user's click after seeing the shots and the price.
    'studio:aiVideoMake': async ({ plan }) => s.aiVideoCreate(plan, new AbortController().signal, { background: true }).catch(studioErr),
    'studio:aiJobs': ({ id }) =>
      s.aiVideo
        .pending()
        .filter((j) => j.context?.projectId === id)
        .map((j) => ({ about: j.context?.about ?? 'AI clip', submittedAt: j.submittedAt, kind: j.model === 'wan-animate-replace' ? ('swap' as const) : j.ext && j.ext !== 'mp4' ? ('other' as const) : ('shot' as const) })),
    // The user's own clicks (after the page showed the price and what is sent).
    'studio:shotAgain': async ({ id, clip, mode, prompt, model, seconds }) =>
      (mode === 'redo' ? s.studioRedoShot(id, { clip, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}) }, new AbortController().signal) : s.studioExtendShot(id, { clip, seconds: seconds ?? 5, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}) }, new AbortController().signal)).catch(studioErr),
    'studio:aiMusic': async ({ id, prompt, seconds, vocals, at, volume }) => s.studioAiMusic(id, { prompt, ...(seconds ? { seconds } : {}), ...(vocals ? { vocals } : {}), ...(at !== undefined ? { at } : {}), ...(volume !== undefined ? { volume } : {}) }, new AbortController().signal).catch(studioErr),
    'studio:aiSound': async ({ id, prompt, seconds, at, loop, volume }) => s.studioAiSound(id, { prompt, seconds, at, ...(loop ? { loop } : {}), ...(volume !== undefined ? { volume } : {}) }, new AbortController().signal).catch(studioErr),
    'studio:talk': async ({ id, character, text, audioAsset, scene, prompt, quality, at }) =>
      s.studioTalkingCharacter(id, { character, quality, ...(text ? { text } : {}), ...(audioAsset ? { audioAsset } : {}), ...(scene ? { scene } : {}), ...(prompt ? { prompt } : {}), ...(at !== undefined ? { at } : {}) }, new AbortController().signal).catch(studioErr),
    'studio:talkPlan': async ({ id, character, text, audioAsset, scene, quality }) => {
      try {
        return s.studioTalkPlan(id, { character, quality, ...(text ? { text } : {}), ...(audioAsset ? { audioAsset } : {}), ...(scene?.trim() ? { scene } : {}) });
      } catch (e) {
        return studioErr(e);
      }
    },
    'studio:swap': async ({ id, clip, character, resolution, smooth, mode }) => s.studioSwapCharacter(id, { clip, character, resolution, ...(smooth ? { smooth } : {}), ...(mode ? { mode } : {}) }, new AbortController().signal).catch(studioErr),
    // Hearing a character's voice before choosing it (one short line, spoken by that voice's service).
    'studio:characterVoice': async ({ voice, text, character }) => {
      if (voice === 'own') {
        const c = character ? s.studio.character(character) : null;
        if (!c?.voiceSample) throw new StudioError('Add their own voice first: upload, record or design it.');
        voice = `own:${c.id}:sample`;
      }
      const narrator = s.studioNarrator(voice);
      if (!narrator) throw new StudioError(voice.startsWith('own:') ? 'Their own voice needs your Keo account: sign in (Settings → Providers → Keo account).' : voice === 'female' || voice === 'male' ? 'Keo voices need your Keo account: sign in.' : 'OpenAI voices need an OpenAI API key in Settings → Providers.');
      const r = await narrator.speak(text, new AbortController().signal);
      return { mimeType: r.mimeType, base64: Buffer.from(r.audio).toString('base64') };
    },
    'studio:versions': ({ id, action, name, version }) => {
      if (action === 'save') s.studio.saveVersion(id, name ?? 'Version');
      else if ((action === 'restore' || action === 'delete') && !version) throw new StudioError('Choose a version.');
      else if (action === 'restore') s.studio.restoreVersion(id, version!);
      else if (action === 'delete') s.studio.deleteVersion(id, version!);
      return s.studio.versions(id);
    },
    'studio:liveEdits': ({ on }) => {
      if (on !== undefined) s.studio.liveEdits = on;
      return { on: s.studio.liveEdits };
    },
    'studio:skipShow': ({ id }) => {
      s.studio.skipShow(id);
      return { ok: true as const };
    },
    'studio:previewCopies': async ({ id, assets }) => ({ made: (await s.studio.makePreviewCopies(id, assets).catch(studioErr)).made }),
    'studio:cleanSound': async ({ id, clip, strength }) => ({ seconds: (await s.studio.cleanSound(id, clip, strength).catch(studioErr)).seconds }),
    'studio:reverse': async ({ id, clip }) => ({ seconds: (await s.studio.reverseClip(id, clip).catch(studioErr)).seconds }),
    'studio:splitScenes': async ({ id, clips }) => {
      const r = await s.studio.splitScenes(id, clips).catch(studioErr);
      return { splits: r.splits, clips: r.clips };
    },
    'studio:beatSync': async ({ id, every }) => {
      const r = await s.studio.beatCut(id, { every }).catch(studioErr);
      return { placed: r.placed, bpm: r.bpm };
    },
    'studio:export': ({ id, options }) => {
      // Runs in the background; progress and the result come as studio:progress.
      void s.studio
        .exportVideo(id, options ?? {})
        .then((r) => s.emit('studio:progress', { projectId: id, stage: 'done', file: r.file }))
        .catch((e: unknown) => s.emit('studio:progress', { projectId: id, stage: 'failed', error: e instanceof Error ? e.message : 'The export failed.' }));
      return { started: true as const };
    },
    'studio:current': () => ({ id: s.studio.current }),
    'studio:videoTrack': ({ projectId, assetId }) => s.studio.videoTrack(projectId, assetId),
    'studio:videoSamples': ({ projectId, assetId, time, from, count }) => studioCall(() => s.studio.videoSamples(projectId, assetId, { ...(time !== undefined ? { time } : {}), ...(from !== undefined ? { from } : {}), count })),
    'studio:exportBegin': ({ exportId, projectId, video, audio }) => {
      s.studio.beginExport(exportId, projectId, { width: video.width, height: video.height, avcC: Buffer.from(video.avcC) }, audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, config: Buffer.from(audio.config) } : null);
      return { ok: true as const };
    },
    'studio:exportChunk': ({ exportId, kind, data, timeUs, durationUs, key }) => {
      s.studio.exportChunk(exportId, kind, data, timeUs, durationUs, key);
      return { ok: true as const };
    },
    'studio:exportEnd': ({ exportId }) => studioCall(() => s.studio.endExport(exportId)),
    'studio:exportAbort': ({ exportId }) => {
      s.studio.abortExport(exportId);
      return { ok: true as const };
    },
    'studio:exportProgress': ({ projectId, stage, done, total }) => {
      if (stage !== 'video' || done % 300 === 0) s.log.info('studio.export_progress', { stage, done, total });
      s.emit('studio:progress', { projectId, stage, done, total });
      return { ok: true as const };
    },
    'studio:jobDone': ({ jobId, result, error }) => {
      s.studio.jobDone(jobId, result, error);
      return { ok: true as const };
    },
    'studio:renderReady': () => {
      host.renderReady?.();
      return { ok: true as const };
    },
    'account:useLocal': () => {
      host.useLocal?.();
      return { ok: true as const };
    },
    'account:upgrade': async () => {
      let url: string;
      try {
        url = await s.account.upgradeUrl(abortAfter(20000));
      } catch (e) {
        throw new KeoError('account', (e as Error).message);
      }
      if (!host.openExternal) return { opened: false };
      await host.openExternal(url);
      return { opened: true };
    },
    'account:refresh': async () => {
      await s.account.refreshMe().catch(() => undefined);
      return s.account.status();
    },
    'picture:view': ({ path: p }) => {
      const v = s.viewablePicture(p);
      if (!v) throw new KeoError('forbidden', 'Keo shows only pictures and animations from Documents\\Keo or your allowed folders.');
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        throw new KeoError('not_found', 'That file is no longer there.');
      }
      if (st.size > 60 * 1024 * 1024) throw new KeoError('too_large', 'That file is too large to show here; open it instead.');
      return { mimeType: v.mimeType, dataBase64: fs.readFileSync(p).toString('base64') };
    },
    'picture:open': async ({ path: p, reveal }) => {
      if (!s.viewablePicture(p) || !fs.existsSync(p)) throw new KeoError('forbidden', 'Keo opens only pictures and animations from Documents\\Keo or your allowed folders.');
      if (reveal) {
        host.showInFolder?.(p);
        return { opened: true };
      }
      return { opened: await host.openPath(p) };
    },
    'chat:discardAttachment': ({ id }) => {
      s.attachments.discard(id);
      return { ok: true as const };
    },
    'chat:retry': ({ conversationId }) => {
      s.agent.retry(conversationId).catch((e) => s.log.error('agent.unhandled', { error: String(e) }));
      return { accepted: true as const };
    },
    'chat:cancel': ({ conversationId }) => ({ cancelled: s.agent.cancel(conversationId) }),
    'chat:active': () => s.agent.activeConversations(),

    'memory:list': ({ status, query }) => s.memory.list(status, query),
    'memory:create': ({ kind, subject, content, projectId }) => {
      const m = s.memory.create({ kind, subject: subject ?? null, content, status: 'confirmed', provenance: 'user_authored', projectId: projectId ?? null });
      changed('memory:changed', { memoryId: m.id });
      return m;
    },
    'memory:rememberMessage': ({ messageId }) => {
      const msg = s.conversations.getMessage(messageId);
      if (!msg || msg.role !== 'user') throw new KeoError('invalid_input', 'Only your own messages can be remembered directly.');
      const conv = s.conversations.require(msg.conversationId);
      const m = s.memory.create({
        kind: 'fact',
        content: msg.content.slice(0, 2000),
        status: 'confirmed',
        provenance: 'user_authored',
        projectId: conv.projectId,
        sourceConversationId: msg.conversationId,
        sourceMessageId: msg.id,
        sourceExcerpt: msg.content.slice(0, 500),
      });
      changed('memory:changed', { memoryId: m.id });
      return m;
    },
    'memory:update': ({ id, content, subject }) => {
      const m = s.memory.update(id, content, subject);
      changed('memory:changed', { memoryId: id });
      return m;
    },
    'memory:confirm': ({ id }) => {
      const m = s.memory.confirm(id);
      s.audit.record({ kind: 'memory.decision', decision: 'confirmed', detail: { memoryId: id } });
      changed('memory:changed', { memoryId: id });
      return m;
    },
    'memory:reject': ({ id }) => {
      const m = s.memory.reject(id);
      s.audit.record({ kind: 'memory.decision', decision: 'rejected', detail: { memoryId: id } });
      changed('memory:changed', { memoryId: id });
      return m;
    },
    'memory:supersede': ({ keepId, supersededId }) => {
      const m = s.memory.supersede(keepId, supersededId);
      changed('memory:changed', { memoryId: supersededId });
      return m;
    },
    'memory:delete': ({ id }) => {
      const deleted = s.memory.delete(id);
      s.audit.record({ kind: 'memory.decision', decision: 'deleted', detail: { memoryId: id } });
      changed('memory:changed', { memoryId: id });
      return { deleted };
    },
    'memory:revisions': ({ id }) => s.memory.revisions(id),

    'projects:list': () => s.projects.list(),
    'projects:create': ({ name, description }) => {
      const p = s.projects.create(name, description);
      changed('projects:changed', { projectId: p.id });
      return p;
    },
    'projects:update': ({ id, ...patch }) => {
      const p = s.projects.update(id, patch);
      changed('projects:changed', { projectId: id });
      return p;
    },
    'projects:delete': ({ id }) => {
      const deleted = s.projects.delete(id);
      changed('projects:changed', { projectId: id });
      changed('conversations:changed', { conversationId: null });
      return { deleted };
    },
    'projects:items': ({ projectId }) => s.projects.items(projectId),
    'projects:addItem': ({ projectId, type, content }) => {
      const it = s.projects.addItem({ projectId, type, content, status: 'open', provenance: 'user_authored' });
      changed('projects:changed', { projectId });
      return it;
    },
    'projects:setItemStatus': ({ id, status }) => {
      const it = s.projects.setItemStatus(id, status);
      changed('projects:changed', { projectId: it.projectId });
      return it;
    },
    'projects:deleteItem': ({ id }) => {
      const it = s.projects.getItem(id);
      const deleted = s.projects.deleteItem(id);
      if (it) changed('projects:changed', { projectId: it.projectId });
      return { deleted };
    },

    'capabilities:list': () => s.registry.list(),

    'tasks:list': ({ limit }) => s.tasks.list(limit),
    'tasks:get': ({ id }) => s.tasks.get(id),
    'tasks:approveStep': ({ stepId, inputHash }) => s.tasks.approveStep(stepId, inputHash),
    'tasks:denyStep': ({ stepId }) => s.tasks.denyStep(stepId),
    'tasks:approvePlan': ({ taskId, inputHashes }) => s.tasks.approvePlan(taskId, inputHashes),
    'tasks:cancel': ({ id }) => s.tasks.cancel(id),
    'tasks:reconcileStep': ({ stepId, resolution }) => s.tasks.reconcile(stepId, resolution),

    'desktop:listWindows': async ({ includeAll }) => {
      const sup = s.desktop.support();
      if (!sup.supported) return { supported: false, reason: sup.reason, windows: [] };
      const settings = s.settings.get();
      if (!settings.permissions.observationEnabled && !includeAll) {
        return { supported: true, reason: 'Window observation is turned off.', windows: [] };
      }
      return { supported: true, reason: null, windows: await s.desktop.listWindows(settings, includeAll) };
    },
    'desktop:pickLaunchable': async () => ({ path: await host.pickExecutable() }),
    'desktop:commonApps': () => {
      const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      return [
        { id: 'notepad', label: 'Notepad', path: path.join(sys, 'notepad.exe'), processName: 'Notepad' },
        { id: 'paint', label: 'Paint', path: path.join(sys, 'mspaint.exe'), processName: 'mspaint' },
      ].map((a) => ({ ...a, available: fs.existsSync(a.path) }));
    },

    // fal.ai, for AI shots in Studio (the user's own account): the key is stored encrypted, never shown again.
    'aivideo:status': () => aiVideoStatus(),
    'aivideo:setKey': ({ apiKey }) => {
      s.secrets.set('fal', apiKey.trim());
      s.log.info('aivideo.key_set', {});
      return aiVideoStatus();
    },
    'aivideo:clearKey': () => {
      s.secrets.delete('fal');
      s.log.info('aivideo.key_cleared', {});
      return aiVideoStatus();
    },
    'aivideo:setLimit': ({ monthlyLimitUsd }) => {
      s.settings.update({ aiVideo: { monthlyLimitUsd } });
      return aiVideoStatus();
    },
    'web:status': () => webStatus(),
    'web:setKey': ({ apiKey }) => {
      s.secrets.set('brave', apiKey.trim());
      s.log.info('web.key_set', {});
      return webStatus();
    },
    'web:clearKey': () => {
      s.secrets.delete('brave');
      s.log.info('web.key_cleared', {});
      return webStatus();
    },
    'web:test': async () => {
      try {
        const { results: r, source } = await s.web.find('Keo desktop assistant test', { count: 3, safesearch: 'moderate', engine: s.settings.get().web.engine }, abortAfter(20000));
        return { ok: true, message: `${source} answered with ${r.length} result(s).${source === 'Brave Search' ? ' This used one query from your plan.' : source === 'Keo Search' ? ' This used one of today’s Keo searches.' : ''}`, sample: r.slice(0, 3).map((x) => ({ title: x.title, url: x.url })) };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e), sample: [] };
      }
    },

    // The email account: settings plus the app password (encrypted; never returned or logged).
    'email:status': () => emailStatus(),
    'email:save': ({ password, ...account }) => {
      const before = s.settings.get().email;
      const accountChanged = before.address.toLowerCase() !== account.address.toLowerCase() || before.imapHost !== account.imapHost || before.smtpHost !== account.smtpHost;
      if (!password && (!s.secrets.has('email_password') || accountChanged)) throw new KeoError('password_needed', 'Enter the app password for this account.');
      if (password) s.secrets.set('email_password', password);
      // An account with its own app password replaces Gmail through the Google sign-in.
      s.settings.update({ email: { ...account, useGoogle: false } });
      s.email.reset();
      s.log.info('email.account_saved', { provider: account.provider, passwordChanged: !!password });
      s.audit.record({ kind: 'permission.setting', decision: 'email.account_connected', detail: { provider: account.provider } });
      return emailStatus();
    },
    'email:test': () => s.email.test(abortAfter(60000)),
    'email:disconnect': () => {
      s.secrets.delete('email_password');
      s.settings.update({ email: { address: '', checkNew: false } });
      s.email.reset();
      s.log.info('email.account_removed', {});
      s.audit.record({ kind: 'permission.setting', decision: 'email.account_removed' });
      return emailStatus();
    },
    'calendar:status': () => calendarStatus(),
    'calendar:setClientSecret': ({ secret }) => {
      if (secret) s.secrets.set('google_client_secret', secret);
      else s.secrets.delete('google_client_secret');
      s.log.info('calendar.client_secret_set', { stored: !!secret });
      return calendarStatus();
    },
    'calendar:signIn': async ({ mail }) => {
      try {
        const r = await s.googleAuth.signIn({ mail: !!mail });
        // Gmail allowed: email goes through this Google sign-in from now on (no app password).
        if (r.mail && r.email) s.settings.update({ email: { useGoogle: true, provider: 'gmail', address: r.email } });
        s.audit.record({ kind: 'permission.setting', decision: 'calendar.google_signed_in' });
        const what = r.mail && r.calendar ? 'Gmail and Google Calendar are' : r.mail ? 'Gmail is' : 'Google Calendar is';
        return { ok: true, message: `${what} connected${r.email ? ` (${r.email})` : ''}.${mail && !r.mail ? ' Gmail was not allowed on Google’s page, so email still needs its own setup.' : ''}` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Google did not complete the sign-in.' };
      }
    },
    'calendar:cancelSignIn': () => {
      s.googleAuth.cancelSignIn();
      return calendarStatus();
    },
    'calendar:signOut': async () => {
      await s.googleAuth.signOut();
      if (s.settings.get().email.useGoogle) s.settings.update({ email: { useGoogle: false } });
      s.audit.record({ kind: 'permission.setting', decision: 'calendar.google_signed_out' });
      return calendarStatus();
    },

    'vision:capture': async ({ hwnd, pid }) => {
      const settings = s.settings.get();
      const w = await s.desktop.backend.info(hwnd);
      if (!w || w.pid !== pid) throw new KeoError('target_gone', 'That window is no longer available.');
      // User-initiated from the Vision view: the click itself is the authorization.
      s.audit.record({ kind: 'permission.decision', decision: 'user_initiated_capture', capabilityId: 'vision.capture', detail: { processName: w.processName } });
      const o = await s.vision.capture({ hwnd, pid, processName: w.processName }, settings, 'user', null);
      changed('observations:changed', { observationId: o.id });
      return o;
    },
    'vision:list': ({ limit }) => s.vision.list(limit),
    'vision:image': ({ id }) => {
      const png = s.vision.readImage(id);
      if (!png) return { dataUrl: null, reason: 'Image not retained (retention policy) or deleted.' };
      return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, reason: null };
    },
    'vision:analyze': async ({ observationId, prompt }) => {
      s.audit.record({ kind: 'permission.decision', decision: 'user_initiated_analysis', capabilityId: 'vision.analyze', detail: { observationId } });
      const a = await s.vision.analyze(observationId, prompt, s.settings.get(), abortAfter(180000));
      changed('observations:changed', { observationId });
      return a;
    },
    'vision:analyses': ({ observationId }) => s.vision.analyses(observationId),
    'vision:delete': ({ id }) => {
      const deleted = s.vision.delete(id);
      changed('observations:changed', { observationId: id });
      return { deleted };
    },

    'voice:transcribe': async ({ audio, mimeType }) => ({ text: await s.voice.transcribe(audio, mimeType, abortAfter(120000)) }),
    'voice:speak': async ({ text }) => s.voice.speak(text, abortAfter(120000)),

    'presence:get': () => s.presence.get(),
    'voice:level': (v) => {
      host.broadcastPresence?.('presence:level', v);
      return { ok: true as const };
    },
    'presence:report': (v, from?: { role: string }) => {
      s.reportVoice(v, from?.role ?? 'main');
      return { ok: true as const };
    },
    'presence:stopAll': () => s.stopAll(),
    'presence:openMain': ({ view }) => {
      host.openMain?.(view);
      return { ok: true as const };
    },
    'companion:setInteractive': ({ interactive }) => {
      host.setCompanionInteractive?.(interactive);
      return { ok: true as const };
    },
    'companion:drag': ({ phase }) => {
      host.companionDrag?.(phase);
      return { ok: true as const };
    },
    'companion:hide': () => {
      s.settings.update({ companion: { enabled: false } });
      host.hideCompanion?.();
      return { ok: true as const };
    },
    'app:quit': () => {
      setTimeout(() => host.quit?.(), 50);
      return { ok: true as const };
    },
    'commandBar:show': () => {
      host.showCommandBar?.();
      return { ok: true as const };
    },
    'pencil:start': () => s.startPencil(),
    'marks:get': () => host.currentMarks?.() ?? null,
    'call:fullscreen': () => {
      s.openFullScreenCall();
      return { ok: true as const };
    },
    'keomode:open': () => {
      s.openKeoMode();
      return { ok: true as const };
    },
    'keomode:close': () => {
      s.closeKeoMode();
      return { ok: true as const };
    },
    'pencil:context': () => s.pencilContext(),
    'pencil:submit': (i) => s.pencilSubmit(i),
    'pencil:cancel': () => {
      s.pencilCancel();
      return { ok: true as const };
    },
    'pencil:allowExport': () => ({ allowed: s.pencilAllowExport() }),
    'pencil:listen': () => ({ started: s.pencilListen() }),
    'commandBar:hide': () => {
      host.hideCommandBar?.();
      return { ok: true as const };
    },
    'commandBar:conversation': ({ fresh }) => ({ conversationId: s.commandConversation(fresh) }),
    'wake:status': () => wakeStatus(),
    'wake:setMuted': async ({ muted }) => {
      await s.wake.setMuted(muted);
      return await wakeStatus();
    },
    'voice:done': ({ id, text, reason }) => {
      s.voiceDone(id, text, reason);
      return { ok: true as const };
    },
    'voice:modeStart': () => {
      s.startVoiceMode();
      return { ok: true as const };
    },
    'voice:modeStop': () => {
      s.voiceMode.stop('stopped_by_user');
      return { ok: true as const };
    },
    'wake:learnSample': async ({ phrase }) => {
      const r = await s.wake.learnSample(phrase);
      const learned = [...new Set([...s.settings.get().wake.learned, ...r.added])].slice(-20);
      if (r.added.length) s.settings.update({ wake: { learned } });
      s.audit.record({ kind: 'voice.wake', decision: 'learned_sample', detail: { added: r.added.length } });
      return { ...r, learned };
    },
    'wake:forgetLearned': () => {
      s.settings.update({ wake: { learned: [] } });
      return { learned: [] };
    },
    'wake:testPhrase': async ({ phrase }) => {
      const invalid = validateWakePhrase(phrase);
      if (invalid) return { ok: false, recognized: false, confidence: 0, message: invalid };
      try {
        const r = await s.wake.testPhrase(phrase.toLowerCase(), 8);
        const heard = r.heard ? `“${r.heard.slice(0, 60)}”` : 'something';
        const message = r.recognized
          ? r.how === 'learned'
            ? `Recognised — Windows heard ${heard}, which Keo learned as your way of saying it.`
            : r.how === 'sounds_like'
              ? `Recognised — Windows heard ${heard}, which sounds like your phrase.`
              : `Recognised (confidence ${r.confidence.toFixed(2)}). This phrase works.`
          : r.heardSomething
            ? `Windows heard ${heard}, not your phrase. Use “Teach Keo your voice” below so Keo learns how you say it.`
            : 'Heard nothing within 8 seconds. Check the microphone.';
        return { ok: r.recognized, recognized: r.recognized, confidence: r.confidence, message };
      } catch (e) {
        return { ok: false, recognized: false, confidence: 0, message: e instanceof Error ? e.message : String(e) };
      }
    },
    'wake:listenNow': () => s.listenAndSend(),
    'wake:cancelListen': () => {
      s.wake.cancelCapture();
      return { ok: true as const };
    },
    'livechat:list': () => s.live.list(),
    // From Keo's own UI, so the text is the user's own answer.
    'livechat:answer': ({ id, text }) => s.live.answer(id, text, true),
    'livechat:pause': ({ id }) => s.live.pause(id),
    'livechat:resume': ({ id }) => s.live.resume(id),
    'livechat:stop': ({ id }) => ({ stopped: id ? (s.live.stop(id) ? 1 : 0) : s.live.stopAll() }),
    'livechat:sendNow': ({ id }) => s.live.sendDraftNow(id),
    'livechat:discardDraft': ({ id }) => s.live.discardDraft(id),
    'jobs:list': () => s.jobs.list(),
    'jobs:cancel': ({ id }) => ({ cancelled: s.jobs.cancel(id) }),
    'schedule:list': () => s.schedule.list(),
    'schedule:pause': ({ id, paused }) => s.schedule.setPaused(id, paused),
    'schedule:delete': ({ id }) => ({ deleted: s.schedule.delete(id) }),

    'briefing:openEvent': async ({ url }) => {
      if (!isCalendarLink(url) || !host.openExternal) return { opened: false };
      await host.openExternal(url);
      return { opened: true };
    },
    // The click is the approval; files.open still checks the allowed folders. Programs and macro files are only shown in their folder.
    'briefing:openFile': async ({ path: p }) => {
      const r = await s.runUserAction(plainToOpen(p) ? 'files.open' : 'files.reveal', { path: p });
      return { opened: r.ok, error: r.error };
    },
    'briefing:morningDue': () => ({ due: s.briefingMorningDue() }),
    'grants:list': () => s.grants.list(),
    'grants:revoke': ({ id }) => ({ revoked: s.grants.revoke(id) }),
    'grants:revokeAll': () => ({ revoked: s.grants.revokeAll() }),
    'grants:approveAndGrant': ({ stepId, inputHash, minutes }) => {
      const step = s.taskRepo.stepById(stepId);
      if (!step) throw new KeoError('not_found', 'Step not found.');
      if (!step.preview.grantable) throw new KeoError('not_grantable', 'This action cannot be covered by navigation permission; approve it on its own.');
      const target = (step.input as { target?: { hwnd: string; pid: number; processName: string } }).target ?? step.preview.grantTarget;
      if (!target) throw new KeoError('not_grantable', 'This action has no window target.');
      const task = s.tasks.approveStep(stepId, inputHash);
      s.grants.create(target, `Navigate in ${target.processName}`, minutes);
      return task;
    },
    'diagnostics:logs': ({ limit }) => s.log.recent(limit),
    // Report a problem: the user sees this exact text, then sends it to Keo Cloud or saves it.
    'report:preview': ({ message, includeLog }) => ({ text: problemReport(message, includeLog), canSend: s.account.signedIn() }),
    'report:send': async ({ message, includeLog, to }) => {
      const text = problemReport(message, includeLog);
      if (to === 'keo') {
        if (!s.account.signedIn()) throw new KeoError('invalid_input', 'Sign in to your Keo account to send the report, or save it to a file.');
        const reference = await s.account.report({ message: message.slice(0, 4000), report: text, version: host.appInfo().version }, abortAfter(60_000)).catch((e: unknown) => {
          throw new KeoError('provider_unavailable', e instanceof Error ? e.message : 'The report could not be sent: save it to a file instead.');
        });
        s.log.info('report.sent', { log: includeLog });
        return { sent: true, reference: reference || null, file: null };
      }
      const dir = s.reportsDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Keo problem report ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`);
      fs.writeFileSync(file, text, 'utf8');
      await host.openPath(dir).catch(() => false);
      s.log.info('report.saved', { log: includeLog });
      return { sent: false, reference: null, file };
    },
    'diagnostics:audit': ({ limit }) => s.audit.recent(limit),

    'data:backup': () => {
      const target = path.join(s.profile.backupsDir, `keo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      s.db.backupTo(target);
      s.log.info('data.backup_created', { file: path.basename(target) });
      return { path: target };
    },
    'data:deleteAll': () => {
      s.deleteAllData();
      setTimeout(() => host.relaunch(), 300);
      return { deleted: true };
    },
  };
}
