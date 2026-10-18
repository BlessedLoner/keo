import { z } from 'zod';
import type {
  UpdateInfo,
  SelfTestResult,
  LiveChatSession,
  AppInfo,
  AuditRecord,
  CapabilityInfo,
  Conversation,
  LogEvent,
  MemoryItem,
  MemoryRevision,
  Message,
  NavigationGrant,
  Observation,
  ObservationAnalysis,
  Presence,
  Project,
  ProjectItem,
  ProviderDiagnostic,
  ProviderInfo,
  Task,
  WindowTarget,
} from './domain';
import type { Settings } from './settings';
import { LINK_IDS } from './release';

/**
 * The complete renderer -> main contract. Every channel has a strict input
 * schema that the main process validates before any handler runs; the preload
 * refuses channels that are not listed here.
 */
const id = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'invalid id');
const empty = z.object({}).strict();
const text = (max: number) => z.string().max(max);

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'openrouter', 'local', 'test']);

export const invokeSchemas = {
  'app:info': empty,
  'app:openLink': z.object({ id: z.enum(LINK_IDS) }).strict(),
  'app:checkUpdate': z.object({ force: z.boolean().default(false) }).strict(),
  'app:openDataFolder': empty,
  'app:installUpdate': empty,
  'diag:checkComputer': empty,
  'diag:report': empty,
  'diag:checkWhatsApp': empty,

  'settings:get': empty,
  'settings:update': z.object({ patch: z.record(z.string(), z.unknown()) }).strict(),

  'providers:list': empty,
  'providers:setKey': z.object({ providerId: ProviderIdSchema, apiKey: z.string().trim().min(8).max(500) }).strict(),
  'providers:clearKey': z.object({ providerId: ProviderIdSchema }).strict(),
  'providers:diagnose': z.object({ providerId: ProviderIdSchema }).strict(),

  'conversations:list': z.object({ projectId: id.nullable().optional(), query: text(200).optional() }).strict(),
  'conversations:create': z.object({ title: text(200).optional(), projectId: id.nullable().optional() }).strict(),
  'conversations:rename': z.object({ id, title: z.string().trim().min(1).max(200) }).strict(),
  'conversations:setProject': z.object({ id, projectId: id.nullable() }).strict(),
  'conversations:delete': z.object({ id }).strict(),
  'conversations:messages': z.object({ id }).strict(),

  'chat:send': z.object({ conversationId: id, text: z.string().trim().min(1).max(32000) }).strict(),
  'chat:retry': z.object({ conversationId: id }).strict(),
  'chat:cancel': z.object({ conversationId: id }).strict(),
  'chat:active': empty,

  'memory:list': z
    .object({
      status: z.enum(['proposed', 'confirmed', 'superseded', 'rejected', 'all']).default('all'),
      query: text(200).optional(),
    })
    .strict(),
  'memory:create': z
    .object({
      kind: z.enum(['fact', 'preference', 'instruction', 'person', 'context']),
      subject: z.string().trim().max(120).nullable().optional(),
      content: z.string().trim().min(1).max(2000),
      projectId: id.nullable().optional(),
    })
    .strict(),
  'memory:rememberMessage': z.object({ messageId: id }).strict(),
  'memory:update': z
    .object({ id, content: z.string().trim().min(1).max(2000), subject: z.string().trim().max(120).nullable().optional() })
    .strict(),
  'memory:confirm': z.object({ id }).strict(),
  'memory:reject': z.object({ id }).strict(),
  'memory:supersede': z.object({ keepId: id, supersededId: id }).strict(),
  'memory:delete': z.object({ id }).strict(),
  'memory:revisions': z.object({ id }).strict(),

  'projects:list': empty,
  'projects:create': z.object({ name: z.string().trim().min(1).max(120), description: text(2000).default('') }).strict(),
  'projects:update': z
    .object({
      id,
      name: z.string().trim().min(1).max(120).optional(),
      description: text(2000).optional(),
      status: z.enum(['active', 'paused', 'done', 'archived']).optional(),
    })
    .strict(),
  'projects:delete': z.object({ id }).strict(),
  'projects:items': z.object({ projectId: id }).strict(),
  'projects:addItem': z
    .object({
      projectId: id,
      type: z.enum(['objective', 'decision', 'blocker', 'question', 'progress']),
      content: z.string().trim().min(1).max(2000),
    })
    .strict(),
  'projects:setItemStatus': z.object({ id, status: z.enum(['open', 'resolved', 'rejected']) }).strict(),
  'projects:deleteItem': z.object({ id }).strict(),

  'capabilities:list': empty,

  'tasks:list': z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict(),
  'tasks:get': z.object({ id }).strict(),
  'tasks:approveStep': z.object({ stepId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  'tasks:denyStep': z.object({ stepId: id }).strict(),
  'tasks:approvePlan': z.object({ taskId: id, inputHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict(),
  'tasks:cancel': z.object({ id }).strict(),
  'tasks:reconcileStep': z.object({ stepId: id, resolution: z.enum(['mark_succeeded', 'mark_failed', 'retry']) }).strict(),

  'desktop:listWindows': z.object({ includeAll: z.boolean().default(false) }).strict(),
  'desktop:pickLaunchable': empty,
  'desktop:commonApps': empty,

  'web:status': empty,
  'web:setKey': z.object({ apiKey: z.string().trim().min(8).max(200) }).strict(),
  'web:clearKey': empty,
  'web:test': empty,

  'vision:capture': z.object({ hwnd: z.string().regex(/^\d{1,20}$/), pid: z.number().int().positive() }).strict(),
  'vision:list': z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
  'vision:image': z.object({ id }).strict(),
  'vision:analyze': z.object({ observationId: id, prompt: z.string().trim().min(1).max(2000) }).strict(),
  'vision:analyses': z.object({ observationId: id }).strict(),
  'vision:delete': z.object({ id }).strict(),

  'voice:transcribe': z
    .object({
      audio: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 12 * 1024 * 1024, 'audio size'),
      mimeType: z.enum(['audio/webm', 'audio/ogg', 'audio/wav']),
    })
    .strict(),
  'voice:speak': z.object({ text: z.string().trim().min(1).max(4000) }).strict(),

  'app:quit': empty,
  'presence:get': empty,
  'presence:report': z.object({ speaking: z.boolean(), recording: z.boolean(), transcribing: z.boolean() }).strict(),
  'presence:stopAll': empty,
  'presence:openMain': z.object({ view: z.enum(['chat', 'tasks', 'settings']).optional() }).strict(),
  'companion:setInteractive': z.object({ interactive: z.boolean() }).strict(),
  'companion:drag': z.object({ phase: z.enum(['start', 'end']) }).strict(),
  'companion:hide': empty,
  'commandBar:show': empty,
  'commandBar:hide': empty,
  'commandBar:conversation': z.object({ fresh: z.boolean().default(false) }).strict(),
  'wake:status': empty,
  'wake:setMuted': z.object({ muted: z.boolean() }).strict(),
  'wake:testPhrase': z.object({ phrase: z.string().trim().min(1).max(40) }).strict(),
  'wake:learnSample': z.object({ phrase: z.string().trim().min(2).max(40) }).strict(),
  'voice:done': z.object({ id: z.string().regex(/^[vs][a-z0-9]{4,40}$/), text: z.string().max(4000).nullable(), reason: z.string().max(200) }).strict(),
  'voice:modeStart': empty,
  'voice:modeStop': empty,
  'wake:forgetLearned': empty,
  'wake:listenNow': empty,
  'wake:cancelListen': empty,
  'grants:list': empty,
  'grants:revoke': z.object({ id }).strict(),
  'grants:revokeAll': empty,
  'livechat:list': empty,
  'livechat:answer': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/), text: z.string().trim().min(1).max(1500) }).strict(),
  'livechat:pause': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/) }).strict(),
  'livechat:resume': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/) }).strict(),
  'livechat:stop': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/).optional() }).strict(),
  'livechat:sendNow': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/) }).strict(),
  'livechat:discardDraft': z.object({ id: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/) }).strict(),
  'grants:approveAndGrant': z.object({ stepId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/), minutes: z.number().int().min(1).max(30).default(10) }).strict(),
  'diagnostics:logs': z.object({ limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  'diagnostics:audit': z.object({ limit: z.number().int().min(1).max(1000).default(200) }).strict(),

  'data:backup': empty,
  'data:deleteAll': z.object({ confirm: z.literal('DELETE') }).strict(),
} as const;

export type InvokeChannel = keyof typeof invokeSchemas;
export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeSchemas)[C]>;
export type ParsedInput<C extends InvokeChannel> = z.output<(typeof invokeSchemas)[C]>;

export interface InvokeOutputs {
  'app:info': AppInfo;
  'app:openLink': { opened: boolean };
  'app:checkUpdate': UpdateInfo | null;
  'app:openDataFolder': { opened: boolean };
  'app:installUpdate': { started: boolean };
  'diag:checkComputer': SelfTestResult;
  'diag:report': { text: string };
  'diag:checkWhatsApp': { ok: boolean; lines: string[] };
  'settings:get': Settings;
  'settings:update': Settings;
  'providers:list': ProviderInfo[];
  'providers:setKey': ProviderInfo[];
  'providers:clearKey': ProviderInfo[];
  'providers:diagnose': ProviderDiagnostic;
  'conversations:list': Conversation[];
  'conversations:create': Conversation;
  'conversations:rename': Conversation;
  'conversations:setProject': Conversation;
  'conversations:delete': { deleted: boolean };
  'conversations:messages': Message[];
  'chat:send': { accepted: true; userMessageId: string };
  'chat:retry': { accepted: true };
  'chat:cancel': { cancelled: boolean };
  'chat:active': string[];
  'memory:list': MemoryItem[];
  'memory:create': MemoryItem;
  'memory:rememberMessage': MemoryItem;
  'memory:update': MemoryItem;
  'memory:confirm': MemoryItem;
  'memory:reject': MemoryItem;
  'memory:supersede': MemoryItem;
  'memory:delete': { deleted: boolean };
  'memory:revisions': MemoryRevision[];
  'projects:list': Project[];
  'projects:create': Project;
  'projects:update': Project;
  'projects:delete': { deleted: boolean };
  'projects:items': ProjectItem[];
  'projects:addItem': ProjectItem;
  'projects:setItemStatus': ProjectItem;
  'projects:deleteItem': { deleted: boolean };
  'capabilities:list': CapabilityInfo[];
  'tasks:list': Task[];
  'tasks:get': Task | null;
  'tasks:approveStep': Task;
  'tasks:denyStep': Task;
  'tasks:approvePlan': Task;
  'tasks:cancel': Task;
  'tasks:reconcileStep': Task;
  'desktop:listWindows': { supported: boolean; reason: string | null; windows: WindowTarget[] };
  'desktop:pickLaunchable': { path: string | null };
  'desktop:commonApps': Array<{ id: string; label: string; path: string; processName: string; available: boolean }>;
  'web:status': WebStatus;
  'web:setKey': WebStatus;
  'web:clearKey': WebStatus;
  'web:test': { ok: boolean; message: string; sample: Array<{ title: string; url: string }> };
  'vision:capture': Observation;
  'vision:list': Observation[];
  'vision:image': { dataUrl: string | null; reason: string | null };
  'vision:analyze': ObservationAnalysis;
  'vision:analyses': ObservationAnalysis[];
  'vision:delete': { deleted: boolean };
  'voice:transcribe': { text: string };
  'voice:speak': { audio: Uint8Array; mimeType: string };
  'app:quit': { ok: true };
  'presence:get': Presence;
  'presence:report': { ok: true };
  'presence:stopAll': { cancelledTurns: number; cancelledTasks: number; revokedGrants: number };
  'presence:openMain': { ok: true };
  'companion:setInteractive': { ok: true };
  'companion:drag': { ok: true };
  'companion:hide': { ok: true };
  'commandBar:show': { ok: true };
  'commandBar:hide': { ok: true };
  'commandBar:conversation': { conversationId: string };
  'wake:status': WakeStatusInfo;
  'wake:setMuted': WakeStatusInfo;
  'wake:testPhrase': { ok: boolean; recognized: boolean; confidence: number; message: string };
  'wake:learnSample': { heard: string | null; added: string[]; alreadyRecognized: boolean; learned: string[] };
  'voice:done': { ok: true };
  'voice:modeStart': { ok: true };
  'voice:modeStop': { ok: true };
  'wake:forgetLearned': { learned: string[] };
  'wake:listenNow': { text: string | null; reason: string; sent: boolean; conversationId: string | null };
  'wake:cancelListen': { ok: true };
  'grants:list': NavigationGrant[];
  'grants:revoke': { revoked: boolean };
  'grants:revokeAll': { revoked: number };
  'grants:approveAndGrant': Task;
  'livechat:list': LiveChatSession[];
  'livechat:answer': LiveChatSession;
  'livechat:pause': LiveChatSession;
  'livechat:resume': LiveChatSession;
  'livechat:stop': { stopped: number };
  'livechat:sendNow': LiveChatSession;
  'livechat:discardDraft': LiveChatSession;
  'diagnostics:logs': LogEvent[];
  'diagnostics:audit': AuditRecord[];
  'data:backup': { path: string };
  'data:deleteAll': { deleted: boolean };
}

// Compile-time check that every channel has an output type and vice versa.
type _Exhaustive = [InvokeChannel] extends [keyof InvokeOutputs]
  ? [keyof InvokeOutputs] extends [InvokeChannel]
    ? true
    : never
  : never;
export const _contractIsExhaustive: _Exhaustive = true;

export { pushChannels, INVOKE_PREFIX, type PushChannel } from './channels';

export interface WakeStatusInfo {
  status: 'off' | 'starting' | 'listening' | 'capturing' | 'error' | 'unavailable';
  message: string | null;
  muted: boolean;
  recognizers: Array<{ culture: string; name: string }>;
  shortcut: { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  voiceShortcut: { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  /** Speech engine in use ("modern" Windows 10/11 or "classic"), and why modern isn't, if it isn't. */
  engine: { kind: string | null; fallbackReason: string | null };
}

export interface WebStatus {
  hasKey: boolean;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  secretStorage: boolean;
}

/** Errors crossing IPC are serialised to this shape; never raw stacks. */
export interface IpcErrorShape {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorShape };

