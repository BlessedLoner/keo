import { AutoSpeechEngine, ModernSpeechEngine } from './voice/modernSpeech';
import { VoiceMode } from './voice/voiceMode';
import { launchPowerShellTestWindow, runSelfTest, type SelfTestReport, type TestWindow } from './desktop/selfTest';
import type { Settings } from '../shared/settings';
import { ContextBuilder } from './agent/contextBuilder';
import { AgentService } from './agent/agentService';
import { advancedCapabilities, whatsappCheck } from './capabilities/advanced';
import { liveChatCapabilities } from './capabilities/liveChat';
import { accessCapabilities } from './capabilities/access';
import { LiveChatService } from './livechat/liveChatService';
import { builtinCapabilities, type CapabilityDeps, type PlanInput } from './capabilities/builtins';
import { SnapshotStore } from './desktop/uia';
import { GrantService } from './tasks/grants';
import { CapabilityRegistry } from './capabilities/registry';
import type { PlannedStep } from './tasks/orchestrator';
import { openDatabase, type Database } from './db/database';
import type { DesktopBackend } from './desktop/backend';
import { DesktopService } from './desktop/desktopService';
import type { ProfileInfo } from './env/profile';
import { Logger } from './logging/logger';
import { AuditRepo } from './repos/audit';
import { ConversationRepo } from './repos/conversations';
import { MemoryRepo } from './repos/memory';
import { ObservationRepo } from './repos/observations';
import { ProjectRepo } from './repos/projects';
import { TaskRepo } from './repos/tasks';
import { ProviderService } from './providers/providerService';
import type { TestProvider } from './providers/testProvider';
import { SecretStore, type SecretCipher } from './secrets/secretStore';
import { SettingsStore } from './settings/settingsStore';
import { TaskOrchestrator } from './tasks/orchestrator';
import { KeoError } from './util/errors';
import { VisionService, type ImageTools, type WindowCaptureSource } from './vision/visionService';
import { VoiceService } from './voice/voiceService';
import { WebService } from './web/webService';
import { PresenceService, type VoiceReport } from './presence/presenceService';
import { PowerShellSpeechEngine, WakeService, type SpeechEngine } from './voice/wakeService';
import { findQuote, nameMentioned } from './agent/quotes';
import type { AgentEvent, LiveChatSession } from '../shared/domain';
import { TERMINAL_TASK } from './tasks/stateMachine';

export interface ServiceDeps {
  profile: ProfileInfo;
  cipher: SecretCipher;
  desktopBackend: DesktopBackend;
  captureSource: WindowCaptureSource;
  imageTools: ImageTools;
  testProvider?: TestProvider | null;
  /** System clipboard; the app passes Electron's, tests use an in-memory one. */
  clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Override the web service (tests inject fake fetch/DNS). */
  web?: WebService;
  focusSettleMs?: number;
  logEcho?: boolean;
  logger?: Logger;
  /** Local speech engine (Windows SAPI helper in the app; a fake in tests). */
  speechEngine?: SpeechEngine;
  /** Voice-mode microphone and speaker (tests); the app uses the main window's recorder/speech. */
  voiceIo?: { listen(): Promise<{ text: string | null; reason: string }>; speak(text: string): Promise<void> };
  /** Throw-away window for "Check this computer" (tests use a fake). */
  launchTestWindow?: (title: string) => TestWindow;
  /** Faster live chat timings for tests (poll, debounce, gap between replies, sleep). */
  liveChatTiming?: { pollMs?: number; debounceMs?: number; minGapMs?: number; sleep?: (ms: number) => Promise<void> };
}

export type Push = (channel: string, payload: unknown) => void;

export function memoryClipboard(initial = ''): { readText(): Promise<string>; writeText(text: string): Promise<void> } {
  let v = initial;
  return {
    readText: async () => v,
    writeText: async (t) => {
      v = t;
    },
  };
}

/** Composition root shared by the Electron app and the integration tests. */
export class Services {
  readonly log: Logger;
  readonly db: Database;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly audit: AuditRepo;
  readonly conversations: ConversationRepo;
  readonly memory: MemoryRepo;
  readonly projects: ProjectRepo;
  readonly taskRepo: TaskRepo;
  readonly observations: ObservationRepo;
  readonly providers: ProviderService;
  readonly registry: CapabilityRegistry;
  readonly tasks: TaskOrchestrator;
  readonly desktop: DesktopService;
  readonly vision: VisionService;
  readonly voice: VoiceService;
  readonly web: WebService;
  readonly grants: GrantService;
  readonly live: LiveChatService;
  /** Shared dependencies of the capabilities (used by the dev-only desktop e2e). */
  readonly capDeps: CapabilityDeps;
  readonly snapshots = new SnapshotStore();
  readonly presence: PresenceService;
  readonly wake: WakeService;
  /** Window hooks supplied by the Electron shell (no-ops in tests). */
  /** Window-side hooks set by the Electron entry point (no-ops in tests). */
  ui: { showCommandBar(): void; notify(title: string, body: string): void; showMain?(view: 'chat' | 'tasks' | 'settings'): void; ensureVoiceWindow?(): Promise<void> } = { showCommandBar: () => undefined, notify: () => undefined };
  readonly voiceMode: VoiceMode;
  /** Renderer round-trips for voice mode (recording, speaking), keyed by request id. */
  private voiceWaiters = new Map<string, (v: { text: string | null; reason: string }) => void>();
  readonly agent: AgentService;
  readonly profile: ProfileInfo;
  private push: Push = () => undefined;
  private retentionTimer: NodeJS.Timeout | null = null;
  private readonly clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  private readonly launchTestWindow: (title: string) => TestWindow;
  private selfTestRunning: Promise<SelfTestReport> | null = null;
  lastSelfTest: { at: string; report: SelfTestReport } | null = null;
  lastWhatsAppCheck: { at: string; ok: boolean; lines: string[] } | null = null;

  constructor(d: ServiceDeps) {
    this.profile = d.profile;
    this.log = d.logger ?? new Logger(d.profile.logsDir, d.logEcho ?? false);
    this.db = openDatabase(d.profile.dbFile);
    this.settings = new SettingsStore(d.profile.userData, this.log);
    this.secrets = new SecretStore(d.profile.secretsDir, d.cipher);
    this.audit = new AuditRepo(this.db);
    this.conversations = new ConversationRepo(this.db);
    this.memory = new MemoryRepo(this.db);
    this.projects = new ProjectRepo(this.db);
    this.taskRepo = new TaskRepo(this.db);
    this.observations = new ObservationRepo(this.db);
    const getSettings = (): Settings => this.settings.get();
    if (d.testProvider && getSettings().activeProvider === null) this.settings.update({ activeProvider: 'test' });
    this.providers = new ProviderService(getSettings, this.secrets, this.log, { testProvider: d.testProvider ?? null });
    this.registry = new CapabilityRegistry(getSettings, this.audit, this.log);
    this.tasks = new TaskOrchestrator(this.taskRepo, this.registry, this.audit, this.log, getSettings);
    this.grants = new GrantService(this.audit);
    this.desktop = new DesktopService(d.desktopBackend);
    this.vision = new VisionService(this.observations, this.desktop, d.captureSource, d.imageTools, this.providers, d.profile.observationsDir, this.log);
    this.voice = new VoiceService(this.providers.openai, getSettings, () => this.secrets.has('openai'), this.log);
    this.web = d.web ?? new WebService(() => this.secrets.get('brave'), this.log);

    this.clipboard = d.clipboard ?? memoryClipboard();
    this.launchTestWindow = d.launchTestWindow ?? launchPowerShellTestWindow;
    const capDeps: CapabilityDeps = {
      memory: this.memory,
      projects: this.projects,
      observations: this.observations,
      desktop: this.desktop,
      vision: this.vision,
      activeProviderDestination: () => {
        const id = getSettings().activeProvider;
        return id && this.providers.has(id) ? this.providers.get(id).destination() : 'no provider configured';
      },
      activeProviderId: () => getSettings().activeProvider,
      proposePlan: (plan, ctx) => this.proposePlan(plan, ctx),
      web: this.web,
      clipboard: this.clipboard,
      findUserQuote: (conversationId, quote) => {
        const msgs = this.conversations.recentMessages(conversationId, 40).filter((m) => m.role === 'user');
        const hit = findQuote(msgs.map((m) => ({ id: m.id, text: m.content })), quote);
        return hit ? { messageId: hit } : null;
      },
      focusSettleMs: d.focusSettleMs,
    };
    this.capDeps = capDeps;
    this.live = new LiveChatService({
      cap: capDeps,
      providers: this.providers,
      settings: getSettings,
      audit: this.audit,
      log: this.log,
      conversations: this.conversations,
      alert: (session, text, kind) => this.liveChatAlert(session, text, kind),
      research: async (query, signal) => {
        const st = getSettings();
        if (!st.permissions.webSearchEnabled || !this.web.hasKey()) return null;
        return this.web.search(query, { count: 5, safesearch: st.web.safesearch }, signal);
      },
      changed: () => {
        this.presence?.setLiveChats(this.live.counts());
        this.push('livechat:changed', { sessions: this.live.list() });
      },
      ...(d.liveChatTiming ?? {}),
    });
    for (const cap of [
      ...builtinCapabilities(capDeps),
      ...advancedCapabilities({ ...capDeps, snapshots: this.snapshots }),
      ...accessCapabilities({ ...capDeps, updateSettings: (permissions) => this.settings.update({ permissions }), currentSettings: getSettings }),
      ...liveChatCapabilities({
        ...capDeps,
        live: this.live,
        userMessage: (id) => {
          const m = id ? this.conversations.getMessage(id) : null;
          return m && m.role === 'user' ? m.content : null;
        },
      }),
    ]) {
      this.registry.register(cap);
    }
    this.tasks.grantMatcher = (step) => this.grants.match(step);
    this.tasks.policyMatcher = (step, task) => {
      const level = getSettings().autonomy.level;
      const tier = step.preview.autoTier ?? 'important';
      if (level === 'always_ask' || tier === 'always_ask') return null;
      // Granting access always needs an explicit yes (on screen or by voice).
      if (step.capabilityId.startsWith('access.')) return null;
      if (level === 'important_only' && tier !== 'routine') return null;
      // Only actions from a conversation with the user (where "named" can be checked) run without asking.
      if (task.origin === 'plan' || !task.conversationId) return null;
      const named = step.preview.mustBeNamed;
      if (named) {
        const said = this.conversations.recentMessages(task.conversationId, 40).filter((m) => m.role === 'user');
        if (!nameMentioned(said.map((m) => ({ text: m.content })), named)) return null;
      }
      return level;
    };

    const context = new ContextBuilder(this.conversations, this.memory, this.projects);
    this.agent = new AgentService(
      this.conversations,
      context,
      this.providers,
      this.registry,
      this.tasks,
      this.audit,
      this.log,
      getSettings,
      (e: AgentEvent) => this.push('agent:event', e),
      (capId) => {
        if (capId.startsWith('memory.')) this.push('memory:changed', { memoryId: null });
        if (capId.startsWith('project.')) this.push('projects:changed', { projectId: null });
      },
    );

    this.agent.systemExtra = () =>
      this.live.agentContext() +
      this.activeWindowContext() +
      (this.voiceMode?.isActive()
        ? '\n\n# Voice conversation\nThe user is talking to you by voice and hears your reply spoken aloud. Answer in one to three short, natural sentences (no lists, Markdown, tables or code unless asked — those stay on screen). Act with tools as usual; Keo asks the user for approvals by voice.'
        : '');
    // Answers to a waiting live chat (and "stop" / "send it") go straight to it — never lost to a model
    // that only *says* it passed them on. The command bar (voice) may answer any running chat.
    this.agent.interceptor = (conversationId, text) => {
      const reply = this.live.routeUserMessage(conversationId, text, { anyConversation: conversationId === getSettings().commandBar.conversationId });
      if (reply !== null) setTimeout(() => this.push('conversations:changed', { conversationId }), 0);
      return reply;
    };
    this.presence = new PresenceService(this.registry);
    this.presence.setAutonomy(getSettings().autonomy.level);
    this.presence.onChange((p) => this.push('presence:changed', p));
    this.tasks.onChange((taskId) => {
      this.push('tasks:changed', { taskId });
      this.noteTaskOutcome(taskId);
      this.updateApprovals();
    });
    this.tasks.onActivity((a) => {
      const step = this.taskRepo.stepById(a.stepId);
      const app = (step?.input as { target?: { processName?: string } } | null)?.target?.processName ?? null;
      this.presence.stepActivity(a, app);
    });
    this.grants.onChange(() => {
      const list = this.grants.list();
      this.presence.setGrants(list.length);
      this.push('grants:changed', { grants: list });
    });
    this.wake = new WakeService(d.speechEngine ?? new AutoSpeechEngine(new ModernSpeechEngine(d.profile.runtimeDir), new PowerShellSpeechEngine(d.profile.runtimeDir), () => getSettings().wake.engine), getSettings, this.log, {
      onWake: (_phrase, rest) => void this.handleWake(rest),
      onState: (st) => this.presence.setWake({ status: st.status, message: st.message, muted: st.muted, listening: st.status === 'listening', enabled: getSettings().wake.enabled, phrase: getSettings().wake.phrases[0] ?? null }),
    });
    this.voiceMode = new VoiceMode({
      listen: () => (d.voiceIo ? d.voiceIo.listen() : this.voiceListen()),
      speak: (text) => (d.voiceIo ? d.voiceIo.speak(text) : this.voiceSpeak(text)),
      send: (text) => {
        try {
          const sent = this.agent.send(this.commandConversation(), text);
          this.push('conversations:changed', { conversationId: this.commandConversation() });
          return sent;
        } catch {
          return null;
        }
      },
      conversationId: () => this.commandConversation(),
      tasks: this.tasks,
      audit: this.audit,
      log: this.log,
      pauseWake: (p) => this.wake.setVoiceMode(p),
      showApprovals: () => this.ui.showMain?.('tasks'),
      changed: (v) => {
        this.presence.setVoiceMode(v);
        // Cancel a pending recording or speech when voice mode ends.
        if (!v.active) {
          for (const [, w] of this.voiceWaiters) w({ text: null, reason: 'cancelled' });
          this.voiceWaiters.clear();
          this.wake.cancelCapture();
          this.push('presence:command', { type: 'stop_speaking' });
          this.push('presence:command', { type: 'voice_cancel' });
        }
      },
    });
    let lastWake = JSON.stringify(this.settings.get().wake);
    this.settings.onChange((st) => {
      this.push('settings:changed', {});
      this.presence.setAutonomy(st.autonomy.level);
      const w = JSON.stringify(st.wake);
      if (w !== lastWake) {
        lastWake = w;
        void this.wake.apply();
      }
    });
  }

  setPush(p: Push): void {
    this.push = (channel, payload) => {
      if (channel === 'agent:event') this.presence.agentEvent(payload as AgentEvent);
      p(channel, payload);
    };
  }

  private updateApprovals(): void {
    const active = this.tasks.list(200).filter((t) => !TERMINAL_TASK.has(t.state));
    const waiting = active.flatMap((t) => t.steps.filter((s) => s.state === 'awaiting_authorization'));
    const proposed = active.filter((t) => t.state === 'proposed').length;
    const first = waiting[0];
    const app = (first?.input as { target?: { processName?: string } } | null)?.target?.processName ?? null;
    this.presence.setApprovals(waiting.length + proposed, first ? { capabilityId: first.capabilityId, app } : null);
  }

  /** Renderer windows report real audio activity (playback, recording). */
  reportVoice(v: VoiceReport): void {
    this.presence.reportVoice(v);
    this.wake.setSpeaking(v.speaking);
  }

  /** Stops everything eligible: replies, queued/waiting actions, grants, listening, speech. */
  /** A live chat needs the user: note in its conversation, Windows notification, spoken line. */
  private liveChatAlert(session: LiveChatSession, text: string, kind: 'question' | 'draft' | 'sent'): void {
    const st = this.settings.get().liveChat;
    // Questions and confirmed sends go into the conversation (so answers can follow, and nothing is claimed
    // before it happened); ready drafts only notify.
    if (kind !== 'draft' && session.conversationId && this.conversations.get(session.conversationId)) {
      this.conversations.addMessage({ conversationId: session.conversationId, role: 'assistant', content: `${kind === 'sent' ? '✅' : '💬'} **Live chat with ${session.contact}:** ${text}`, status: 'complete' });
      this.push('conversations:changed', { conversationId: session.conversationId });
    }
    if (kind === 'sent') return;
    if (st.notify) this.ui.notify(kind === 'draft' ? `Reply to ${session.contact} ready` : `${session.contact} needs you`, text);
    if (st.speak) this.push('presence:command', { type: 'announce', text });
  }

  stopAll(): { cancelledTurns: number; cancelledTasks: number; revokedGrants: number } {
    let cancelledTurns = 0;
    for (const id of this.agent.activeConversations()) if (this.agent.cancel(id)) cancelledTurns++;
    let cancelledTasks = 0;
    for (const t of this.tasks.list(200)) {
      if (['awaiting_authorization', 'ready', 'running', 'waiting_dependency'].includes(t.state)) {
        try {
          this.tasks.cancel(t.id);
          cancelledTasks++;
        } catch {
          /* settled meanwhile */
        }
      }
    }
    const revokedGrants = this.grants.revokeAll();
    this.voiceMode.stop('stop_everything');
    const stoppedLiveChats = this.live.stopAll('Stopped with Stop everything');
    this.wake.cancelCapture();
    this.push('presence:command', { type: 'stop_speaking' });
    this.presence.flash('cancelled', 2500);
    this.audit.record({ kind: 'user.stop_all', decision: 'stopped', detail: { cancelledTurns, cancelledTasks, revokedGrants, stoppedLiveChats } });
    this.log.info('presence.stop_all', { cancelledTurns, cancelledTasks, revokedGrants, stoppedLiveChats });
    return { cancelledTurns, cancelledTasks, revokedGrants };
  }

  /** The conversation used by the command bar and voice commands. */
  commandConversation(fresh = false): string {
    const id = this.settings.get().commandBar.conversationId;
    if (!fresh && id && this.conversations.get(id)) return id;
    const c = this.conversations.create('Quick commands');
    this.settings.update({ commandBar: { conversationId: c.id } });
    this.push('conversations:changed', { conversationId: c.id });
    return c.id;
  }

  private async handleWake(rest = ''): Promise<void> {
    await this.noteActiveWindow();
    // Hands-free: talk with Keo by voice (no command bar); "stop" ends it.
    this.voiceMode.start(rest);
  }

  /** The window the user was in when they called Keo (wake word or Ctrl+K), for "this", "here", "line 10"… */
  private activeWindow: { at: number; hwnd: string; pid: number; processName: string; title: string; allowed: boolean } | null = null;

  /**
   * Remembers the foreground window right before Keo's own command bar takes
   * focus. Bounded to a few hundred ms so it never delays the command bar much.
   */
  async noteActiveWindow(): Promise<void> {
    const look = async () => {
      const a = await this.desktop.backend.userActivity();
      if (!a.foreground) return;
      const all = await this.desktop.listWindows(this.settings.get(), true);
      const w = all.find((x) => x.hwnd === a.foreground);
      if (!w) return; // Keo's own windows and hidden/tool windows are not listed
      this.activeWindow = { at: Date.now(), hwnd: w.hwnd, pid: w.pid, processName: w.processName, title: w.title, allowed: w.allowed };
    };
    await Promise.race([look().catch(() => undefined), new Promise((r) => setTimeout(r, 600))]);
  }

  private activeWindowContext(): string {
    const w = this.activeWindow;
    if (!w || Date.now() - w.at > 5 * 60_000) return '';
    const target = JSON.stringify({ hwnd: w.hwnd, pid: w.pid, processName: w.processName });
    return w.allowed
      ? `\n\n# Where the user is\nWhen the user called Keo, the active window was “${w.title.slice(0, 120)}” (${w.processName}), target ${target}. Words like “this”, “here”, “the error”, “line 10”, “this page” refer to it. To look at it use desktop__inspect_window (or vision__observe_window for a picture; browser__read_page for a browser) with exactly this target.`
      : `\n\n# Where the user is\nWhen the user called Keo, the active window was “${w.title.slice(0, 120)}” (${w.processName}), target ${target}, which is NOT in the allowed apps yet. If the request is about it (“my screen”, “this”, “here”…), call access__allow_app with exactly this target and a short purpose — Keo asks the user (by voice in a voice conversation) — then read it with desktop__inspect_window (browser__read_page for a browser). Do not send the user to Settings, and do not try to read it before access is granted.`;
  }

  /** "Check this computer": focus, type, paste, read and click on a test window Keo opens itself. */
  checkComputer(): Promise<SelfTestReport> {
    if (this.selfTestRunning) return this.selfTestRunning;
    this.audit.record({ kind: 'diagnostics.self_test', decision: 'started' });
    this.selfTestRunning = runSelfTest({ backend: this.desktop.backend, launch: this.launchTestWindow, clipboard: this.clipboard })
      .then((r) => {
        this.lastSelfTest = { at: new Date().toISOString(), report: r };
        this.audit.record({ kind: 'diagnostics.self_test', decision: r.ok ? 'passed' : 'failed', detail: { failed: r.steps.filter((s) => !s.ok).map((s) => s.id) } });
        return r;
      })
      .finally(() => {
        this.selfTestRunning = null;
      });
    return this.selfTestRunning;
  }

  /** Read-only: what Keo recognises in the WhatsApp window (layout facts only). */
  async checkWhatsApp(): Promise<{ ok: boolean; lines: string[] }> {
    const r = await whatsappCheck(this.capDeps, this.settings.get());
    this.lastWhatsAppCheck = { at: new Date().toISOString(), ...r };
    this.audit.record({ kind: 'diagnostics.whatsapp_check', decision: r.ok ? 'passed' : 'failed' });
    return r;
  }

  /** Starts or stops voice mode from the UI (companion / title bar). */
  startVoiceMode(): void {
    void this.noteActiveWindow().finally(() => this.voiceMode.start());
  }

  /** One utterance for voice mode: OpenAI transcription in the main window when chosen, else Windows speech. */
  private async voiceListen(): Promise<{ text: string | null; reason: string }> {
    const s = this.settings.get();
    if (s.wake.commandRecognizer === 'openai' && this.voice.sttStatus(s).available) {
      await this.ui.ensureVoiceWindow?.();
      const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          this.voiceWaiters.delete(id);
          resolve({ text: null, reason: 'silence' });
        }, 60_000);
        this.voiceWaiters.set(id, (v) => {
          clearTimeout(t);
          resolve(v);
        });
        this.push('presence:command', { type: 'voice_listen', id });
      });
    }
    const r = await this.wake.capture();
    if (!r.text && r.reason === 'online_speech_off') return { text: null, reason: 'Windows “Online speech recognition” is off — turn it on (Settings → Privacy & security → Speech) or choose OpenAI transcription' };
    return r;
  }

  /** Speaks in the main window and resolves when playback ends (bounded by the text length). */
  private async voiceSpeak(text: string): Promise<void> {
    await this.ui.ensureVoiceWindow?.();
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.voiceWaiters.delete(id);
        resolve();
      }, 4000 + text.length * 90);
      this.voiceWaiters.set(id, () => {
        clearTimeout(t);
        resolve();
      });
      this.push('presence:command', { type: 'voice_say', id, text });
    });
  }

  /** The main window reports a finished recording or utterance. */
  voiceDone(id: string, text: string | null, reason: string): void {
    const w = this.voiceWaiters.get(id);
    if (!w) return;
    this.voiceWaiters.delete(id);
    w({ text, reason });
  }

  /** Captures one spoken command (locally or via the command bar's recorder) and sends it. */
  async listenAndSend(): Promise<{ text: string | null; reason: string; sent: boolean; conversationId: string | null }> {
    const s = this.settings.get();
    if (s.wake.commandRecognizer === 'openai' && this.voice.sttStatus(s).available) {
      // The command bar records with voice-activity detection and sends the transcript itself.
      this.push('presence:command', { type: 'record_command' });
      return { text: null, reason: 'recording_in_command_bar', sent: false, conversationId: null };
    }
    let r = await this.wake.capture();
    // The modern engine's dictation needs Windows' online speech; use OpenAI if available, else say so.
    if (!r.text && r.reason === 'online_speech_off' && this.voice.sttStatus(s).available) {
      this.push('presence:command', { type: 'record_command' });
      return { text: null, reason: 'recording_in_command_bar', sent: false, conversationId: null };
    }
    if (!r.text && r.reason === 'online_speech_off') r = { text: null, reason: 'Turn on Windows “Online speech recognition” (Settings → Privacy & security → Speech) or choose OpenAI transcription for commands.' };
    if (!r.text) {
      this.push('presence:command', { type: 'listen_result', reason: r.reason });
      return { ...r, sent: false, conversationId: null };
    }
    const conversationId = this.commandConversation();
    this.push('presence:command', { type: 'transcript', text: r.text, conversationId });
    try {
      const sent = this.agent.send(conversationId, r.text);
      sent.done.catch((e) => this.log.error('agent.unhandled', { error: String(e) }));
      this.push('conversations:changed', { conversationId });
      return { text: r.text, reason: 'ok', sent: true, conversationId };
    } catch (e) {
      this.log.warn('wake.send_failed', { error: String(e) });
      return { text: r.text, reason: 'busy', sent: false, conversationId };
    }
  }

  emit(channel: string, payload: unknown): void {
    this.push(channel, payload);
  }

  /** Startup recovery: interrupted messages and tasks are surfaced, never replayed blindly. */
  start(): { interruptedMessages: number; recovery: ReturnType<TaskOrchestrator['recover']> } {
    const interruptedMessages = this.conversations.markInterrupted();
    const recovery = this.tasks.recover();
    this.tasks.pump();
    const purge = () => {
      try {
        this.vision.purgeExpired(this.settings.get().privacy.observationRetentionHours);
      } catch (e) {
        this.log.warn('vision.retention_error', { error: String(e) });
      }
    };
    purge();
    // Pre-start the desktop helper (it compiles its Win32 bindings once) only if the user enabled desktop features.
    const p = this.settings.get().permissions;
    if ((p.observationEnabled || p.desktopControlEnabled) && this.desktop.support().supported) {
      this.desktop.backend.list().catch((e) => this.log.warn('desktop.warmup_failed', { error: String(e) }));
    }
    this.retentionTimer = setInterval(purge, 15 * 60 * 1000);
    this.retentionTimer.unref?.();
    this.log.info('app.recovered', { interruptedMessages, ...recovery });
    return { interruptedMessages, recovery };
  }

  /** Validates a model plan step by step. Nothing executes; the task stays "proposed". */
  proposePlan(plan: PlanInput, ctx: { conversationId: string | null; correlationId: string }): { taskId: string; rejected: string[] } {
    const steps: PlannedStep[] = [];
    const rejected: string[] = [];
    plan.steps.forEach((s, i) => {
      if (s.capability === 'task.propose_plan') {
        rejected.push(`Step ${i + 1}: plans cannot nest other plans.`);
        return;
      }
      const a = this.registry.admit({ capabilityId: s.capability, input: s.input, origin: 'plan', correlationId: ctx.correlationId });
      if (!a.ok) {
        rejected.push(`Step ${i + 1} (${s.capability}): ${a.reason}`);
        return;
      }
      steps.push({ admission: a, title: s.title, dependsOnIndexes: s.dependsOn.map((n) => n - 1) });
    });
    if (rejected.length) {
      throw new KeoError('plan_rejected', `The plan was not created because some steps are invalid: ${rejected.join(' | ')}`);
    }
    for (const [i, s] of steps.entries()) {
      if (s.dependsOnIndexes.some((d) => d < 0 || d >= i)) throw new KeoError('plan_rejected', `Step ${i + 1} depends on a step that does not come before it.`);
    }
    const task = this.tasks.create({ title: plan.title, rationale: plan.rationale, origin: 'plan', conversationId: ctx.conversationId, correlationId: ctx.correlationId, steps });
    return { taskId: task.id, rejected };
  }

  /** When a task from a conversation settles and no live turn is waiting on it, add a visible note. */
  private noteTaskOutcome(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t || !t.conversationId) return;
    if (!(TERMINAL_TASK.has(t.state) || t.state === 'outcome_uncertain')) return;
    if (this.agent.isAwaitingTask(taskId)) return;
    const marker = `${t.id}:${t.state}`;
    const exists = this.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE role = 'note' AND conversation_id = ? AND meta LIKE ?", [
      t.conversationId,
      `%"taskNote":"${marker}"%`,
    ]);
    if (exists && exists.n > 0) return;
    // Only note tasks the conversation already knows about (plans, or model tasks that outlived their turn).
    const state = t.state.replace(/_/g, ' ');
    try {
      this.conversations.addMessage({
        conversationId: t.conversationId,
        role: 'note',
        content: `Task “${t.title}” is now ${state}.${t.steps.some((s) => s.error) ? ` ${t.steps.find((s) => s.error)?.error ?? ''}` : ''}`,
        status: 'complete',
        meta: { taskNote: marker },
      });
      this.push('conversations:changed', { conversationId: t.conversationId });
    } catch {
      /* conversation may have been deleted */
    }
  }

  /** Deletes all of Keo's user data in this profile (conversations, memory, tasks, observations, secrets). */
  deleteAllData(): void {
    this.tasks.dispose();
    for (const o of this.observations.list(100000)) this.vision.delete(o.id);
    this.db.tx(() => {
      for (const table of ['observation_analyses', 'observations', 'execution_receipts', 'task_steps', 'tasks', 'memory_revisions', 'memory_items', 'project_items', 'messages', 'conversations', 'projects', 'audit_log', 'usage_log']) {
        this.db.run(`DELETE FROM ${table}`);
      }
    });
    this.db.db.exec('VACUUM');
    this.secrets.clear();
    this.log.info('data.deleted_all', {});
  }

  async shutdown(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.voiceMode.stop('closing');
    this.wake.stop();
    this.live.stopAll('Keo was closed');
    this.grants.revokeAll();
    this.snapshots.clear();
    for (const id of this.agent.activeConversations()) this.agent.cancel(id);
    this.tasks.dispose();
    this.desktop.backend.dispose();
    this.log.info('app.shutdown', {});
    this.db.close();
    await this.log.close();
  }
}
