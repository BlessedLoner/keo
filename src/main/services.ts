import type { Settings } from '../shared/settings';
import { ContextBuilder } from './agent/contextBuilder';
import { AgentService } from './agent/agentService';
import { builtinCapabilities, type PlanInput } from './capabilities/builtins';
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
import { findQuote } from './agent/quotes';
import type { AgentEvent } from '../shared/domain';
import { TERMINAL_TASK } from './tasks/stateMachine';

export interface ServiceDeps {
  profile: ProfileInfo;
  cipher: SecretCipher;
  desktopBackend: DesktopBackend;
  captureSource: WindowCaptureSource;
  imageTools: ImageTools;
  testProvider?: TestProvider | null;
  /** Override the web service (tests inject fake fetch/DNS). */
  web?: WebService;
  focusSettleMs?: number;
  logEcho?: boolean;
  logger?: Logger;
}

export type Push = (channel: string, payload: unknown) => void;

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
  readonly agent: AgentService;
  readonly profile: ProfileInfo;
  private push: Push = () => undefined;
  private retentionTimer: NodeJS.Timeout | null = null;

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
    this.desktop = new DesktopService(d.desktopBackend);
    this.vision = new VisionService(this.observations, this.desktop, d.captureSource, d.imageTools, this.providers, d.profile.observationsDir, this.log);
    this.voice = new VoiceService(this.providers.openai, getSettings, () => this.secrets.has('openai'), this.log);
    this.web = d.web ?? new WebService(() => this.secrets.get('brave'), this.log);

    for (const cap of builtinCapabilities({
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
      findUserQuote: (conversationId, quote) => {
        const msgs = this.conversations.recentMessages(conversationId, 40).filter((m) => m.role === 'user');
        const hit = findQuote(msgs.map((m) => ({ id: m.id, text: m.content })), quote);
        return hit ? { messageId: hit } : null;
      },
      focusSettleMs: d.focusSettleMs,
    })) {
      this.registry.register(cap);
    }

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

    this.tasks.onChange((taskId) => {
      this.push('tasks:changed', { taskId });
      this.noteTaskOutcome(taskId);
    });
    this.settings.onChange(() => this.push('settings:changed', {}));
  }

  setPush(p: Push): void {
    this.push = p;
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
    for (const id of this.agent.activeConversations()) this.agent.cancel(id);
    this.tasks.dispose();
    this.desktop.backend.dispose();
    this.log.info('app.shutdown', {});
    this.db.close();
    await this.log.close();
  }
}
