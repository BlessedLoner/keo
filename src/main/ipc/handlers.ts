import type { AppInfo } from '../../shared/domain';
import { LINKS } from '../../shared/release';
import type { UpdateInfo } from '../../shared/domain';
import type { InvokeChannel, InvokeOutputs, ParsedInput } from '../../shared/ipc';
import { LATEST_SCHEMA_VERSION } from '../db/database';
import { KeoError } from '../util/errors';
import { validateWakePhrase } from '../voice/wakeService';
import { diagnosticReport } from '../desktop/diagnosticReport';
import { packageScripts } from '../projects/workspace';
import { importBundle } from '../workflows/portability';
import { locateFfmpeg } from '../video/ffmpeg';
import type { Services } from '../services';
import fs from 'node:fs';
import path from 'node:path';

export type Handler<C extends InvokeChannel> = (input: ParsedInput<C>) => Promise<InvokeOutputs[C]> | InvokeOutputs[C];
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HostHooks {
  appInfo(): Omit<AppInfo, 'schemaVersion' | 'secretStorage' | 'userDataPath' | 'profile'>;
  openPath(p: string): Promise<boolean>;
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
  openMain?(view?: 'chat' | 'tasks' | 'settings'): void;
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
export function createHandlers(s: Services, host: HostHooks): HandlerMap {
  const changed = (channel: string, payload: unknown) => s.emit(channel, payload);
  const abortAfter = (ms: number) => AbortSignal.timeout(ms);
  const wakeStatus = async () => ({
    ...s.wake.getState(),
    recognizers: await s.wake.recognizers(),
    engine: s.wake.engineInfo(),
    picovoiceKey: s.secrets.has('picovoice'),
    voiceShortcut: host.voiceShortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.voice, enabled: s.settings.get().shortcuts.voiceEnabled, registered: false, error: 'Not available in this build.' },
    pencilShortcut: host.pencilShortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.pencil, enabled: s.settings.get().shortcuts.pencilEnabled, registered: false, error: 'Not available in this build.' },
    shortcut: host.shortcutStatus?.() ?? { accelerator: s.settings.get().shortcuts.commandBar, enabled: s.settings.get().shortcuts.commandBarEnabled, registered: false, error: 'Not available in this build.' },
  });
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

    'chat:send': ({ conversationId, text }) => {
      const r = s.agent.send(conversationId, text);
      r.done.catch((e) => s.log.error('agent.unhandled', { error: String(e) }));
      changed('conversations:changed', { conversationId });
      return { accepted: true as const, userMessageId: r.userMessageId };
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
        return { ok: true, message: `${source} answered with ${r.length} result(s).${source === 'Brave Search' ? ' This used one query from your plan.' : ''}`, sample: r.slice(0, 3).map((x) => ({ title: x.title, url: x.url })) };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e), sample: [] };
      }
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
    'voice:speak': async ({ text }) => ({ audio: await s.voice.speak(text, abortAfter(120000)), mimeType: 'audio/mpeg' }),

    'presence:get': () => s.presence.get(),
    'presence:report': (v) => {
      s.reportVoice(v);
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
    'grants:list': () => s.grants.list(),
    'grants:revoke': ({ id }) => ({ revoked: s.grants.revoke(id) }),
    'grants:revokeAll': () => ({ revoked: s.grants.revokeAll() }),
    'grants:approveAndGrant': ({ stepId, inputHash, minutes }) => {
      const step = s.taskRepo.stepById(stepId);
      if (!step) throw new KeoError('not_found', 'Step not found.');
      if (!step.preview.grantable) throw new KeoError('not_grantable', 'This action cannot be covered by navigation permission; approve it on its own.');
      const target = (step.input as { target?: { hwnd: string; pid: number; processName: string } }).target;
      if (!target) throw new KeoError('not_grantable', 'This action has no window target.');
      const task = s.tasks.approveStep(stepId, inputHash);
      s.grants.create(target, `Navigate in ${target.processName}`, minutes);
      return task;
    },
    'diagnostics:logs': ({ limit }) => s.log.recent(limit),
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
