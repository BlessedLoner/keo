import type { AppInfo } from '../../shared/domain';
import type { InvokeChannel, InvokeOutputs, ParsedInput } from '../../shared/ipc';
import { LATEST_SCHEMA_VERSION } from '../db/database';
import { KeoError } from '../util/errors';
import { validateWakePhrase } from '../voice/wakeService';
import type { Services } from '../services';
import fs from 'node:fs';
import path from 'node:path';

export type Handler<C extends InvokeChannel> = (input: ParsedInput<C>) => Promise<InvokeOutputs[C]> | InvokeOutputs[C];
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HostHooks {
  appInfo(): Omit<AppInfo, 'schemaVersion' | 'secretStorage' | 'userDataPath' | 'profile'>;
  openPath(p: string): Promise<boolean>;
  pickExecutable(): Promise<string | null>;
  captureFrom?: never;
  relaunch(): void;
  openMain?(view?: 'chat' | 'tasks' | 'settings'): void;
  showCommandBar?(): void;
  hideCommandBar?(): void;
  hideCompanion?(): void;
  setCompanionInteractive?(interactive: boolean): void;
  companionDrag?(phase: 'start' | 'end'): void;
  shortcutStatus?(): { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  quit?(): void;
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

    'conversations:list': ({ projectId, query }) => s.conversations.list({ projectId: projectId ?? null, ...(query ? { query } : {}) }),
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
        const r = await s.web.search('Keo desktop assistant test', { count: 3, safesearch: 'moderate' }, abortAfter(20000));
        return { ok: true, message: `Brave Search answered with ${r.length} result(s). This used one query from your plan.`, sample: r.slice(0, 3).map((x) => ({ title: x.title, url: x.url })) };
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
    'wake:testPhrase': async ({ phrase }) => {
      const invalid = validateWakePhrase(phrase);
      if (invalid) return { ok: false, recognized: false, confidence: 0, message: invalid };
      try {
        const r = await s.wake.testPhrase(phrase.toLowerCase(), 8);
        const thr = s.settings.get().wake.sensitivity;
        const message = r.recognized
          ? r.confidence >= thr
            ? `Recognised (confidence ${r.confidence.toFixed(2)}). This phrase works.`
            : `Recognised, but confidence ${r.confidence.toFixed(2)} is below your sensitivity ${thr.toFixed(2)}. Speak more clearly or lower the sensitivity.`
          : r.heardSomething
            ? 'Heard speech, but not the phrase. Try again, or choose a phrase with clearer words.'
            : 'Heard nothing within 8 seconds. Check the microphone.';
        return { ok: r.recognized && r.confidence >= thr, recognized: r.recognized, confidence: r.confidence, message };
      } catch (e) {
        return { ok: false, recognized: false, confidence: 0, message: e instanceof Error ? e.message : String(e) };
      }
    },
    'wake:listenNow': () => s.listenAndSend(),
    'wake:cancelListen': () => {
      s.wake.cancelCapture();
      return { ok: true as const };
    },
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
