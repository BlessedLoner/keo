import type { Sound } from './studioSounds';
import type { Recipe } from './studioRecipe';
import { Storyboard } from './studioFaceless';
import { Brand, BrandPatch } from './studioBrand';

/** The user's fal.ai set-up and what Keo spent on it. */
export interface AiVideoStatus {
  hasKey: boolean;
  secretStorage: boolean;
  todayUsd: number;
  monthUsd: number;
  limitUsd: number | null;
  /** Where Studio's AI goes: the user's own fal.ai key, Keo Cloud (Studio credits), or nowhere yet (signed out). */
  via: 'own' | 'keo' | null;
  /** Studio credits left (through Keo Cloud), or null when unknown. */
  credits: { total: number; monthlyLeft: number; monthlyAllowance: number; bought: number; plan: string; ready: boolean } | null;
}
import { Character, CharacterId, CharacterPatch } from './studioCharacters';
import { AiVideoPlan, type AiShot } from './studioAiVideo';
import { EditOp, ExportOptions, type Asset as StudioAsset, type Project as StudioProject, type ProjectSummary } from './studio';
import type { AccountStatus } from './cloud';
import { z } from 'zod';
import type {
  MessageAttachment,
  BackgroundJob,
  ScheduledItem,
  UpdateInfo,
  SelfTestResult,
  ResearchResultView,
  VideoView,
  VideoToolsSetup,
  PhotoIndexState,
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
const studioProjectId = z.string().regex(/^pr_[A-Za-z0-9]{4,24}$/);
const studioAssetId = z.string().regex(/^as_[A-Za-z0-9]{4,24}$/);
const text = (max: number) => z.string().max(max);

export const ProviderIdSchema = z.enum(['keo', 'anthropic', 'openai', 'openrouter', 'local', 'test']);

export const invokeSchemas = {
  'app:info': empty,
  'app:openLink': z.object({ id: z.enum(LINK_IDS) }).strict(),
  /** Opens a source page Keo read (research cards) in the default browser. */
  'app:openUrl': z.object({ url: z.string().min(8).max(2000) }).strict(),
  'app:copyText': z.object({ text: z.string().max(200_000) }).strict(),
  'app:checkUpdate': z.object({ force: z.boolean().default(false) }).strict(),
  'app:openDataFolder': empty,
  'app:installUpdate': empty,
  'diag:checkComputer': empty,
  'projects:pickWorkspace': z.object({ projectId: z.string().min(1).max(80) }).strict(),
  'wake:setPicovoiceKey': z.object({ key: z.string().trim().max(400) }).strict(),
  'wake:pickKeywordFile': empty,
  'results:get': z.object({ id: z.string().regex(/^rr_[a-z0-9]{6,20}$/).optional() }).strict(),
  'results:save': z.object({ id: z.string().regex(/^rr_[a-z0-9]{6,20}$/), format: z.enum(['pdf', 'png', 'page']) }).strict(),
  'results:send': z.object({ id: z.string().regex(/^rr_[a-z0-9]{6,20}$/), contact: z.string().trim().min(1).max(120), which: z.enum(['app', 'web']).optional(), note: z.string().trim().max(300).optional() }).strict(),
  'results:openFolder': z.object({ folder: z.string().min(3).max(500) }).strict(),
  'results:close': empty,
  'video:get': empty,
  'video:preview': z.object({ id: z.string().regex(/^vp_[a-z0-9]{6,20}$/), version: z.number().int().min(1).max(1_000_000) }).strict(),
  'video:say': z.object({ text: z.string().trim().min(1).max(1000) }).strict(),
  'video:undo': empty,
  'video:export': z.object({ name: z.string().trim().min(1).max(60).optional() }).strict(),
  'video:openFolder': empty,
  'video:close': empty,
  'video:status': empty,
  'video:pickFfmpeg': empty,
  'video:pickOutput': empty,
  'files:pickFolder': z.object({ list: z.enum(['roots', 'excluded', 'photoFolders']) }).strict(),
  'files:photosState': empty,
  'files:photosEstimate': empty,
  'files:photosStart': empty,
  'files:photosPause': empty,
  'files:photosClear': empty,
  'video:setupState': empty,
  'video:setupStart': empty,
  'video:setupCancel': empty,
  'video:setupRemove': empty,
  'workflows:list': empty,
  'apps:installed': z.object({ refresh: z.boolean().default(false) }).strict(),
  'workflows:saveFromTask': z.object({ taskId: z.string().min(1).max(80), name: z.string().trim().min(1).max(80) }).strict(),
  'workflows:delete': z.object({ id: z.string().regex(/^wf_[a-z0-9]{6,20}$/) }).strict(),
  'data:export': empty,
  'data:import': empty,
  'projects:clearWorkspace': z.object({ projectId: z.string().min(1).max(80) }).strict(),
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

  'chat:send': z
    .object({ conversationId: id, text: z.string().trim().max(32000), attachments: z.array(z.string().regex(/^att_[A-Za-z0-9]{8,40}$/)).max(8).optional() })
    .strict()
    .refine((x) => x.text.length > 0 || (x.attachments?.length ?? 0) > 0, 'Write a message or attach something.'),
  'chat:pickAttachments': empty,
  'chat:attachBytes': z.object({ name: z.string().trim().min(1).max(200), dataBase64: z.string().max(36_000_000) }).strict(),
  'chat:attachScreenshot': empty,
  'account:status': empty,
  'account:signUp': z.object({ email: z.string().trim().email().max(254), password: z.string().min(8).max(200) }).strict(),
  'account:signIn': z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).strict(),
  'account:signOut': empty,
  'account:resetPassword': z.object({ email: z.string().trim().email().max(254) }).strict(),
  'account:refresh': empty,
  'account:upgrade': empty,
  'account:useLocal': empty,
  'studio:list': empty,
  'studio:create': z.object({ name: z.string().trim().min(1).max(120), format: z.enum(['vertical', 'landscape', 'square', 'portrait']).default('vertical') }).strict(),
  'studio:get': z.object({ id: studioProjectId }).strict(),
  'studio:open': z.object({ id: studioProjectId }).strict(),
  'studio:delete': z.object({ id: studioProjectId }).strict(),
  'studio:duplicate': z.object({ id: studioProjectId }).strict(),
  'studio:useTemplate': z.object({ id: studioProjectId }).strict(),
  'studio:saveFrame': z.object({ id: studioProjectId, time: z.number().min(0).max(86400) }).strict(),
  'studio:edit': z.object({ id: studioProjectId, ops: z.array(EditOp).min(1).max(200) }).strict(),
  'studio:undo': z.object({ id: studioProjectId }).strict(),
  'studio:redo': z.object({ id: studioProjectId }).strict(),
  'studio:history': z.object({ id: studioProjectId }).strict(),
  'studio:captions': z.object({ id: studioProjectId, maxWords: z.number().int().min(1).max(8).default(3) }).strict(),
  'studio:captionSource': empty,
  'studio:transcribe': z.object({ id: studioProjectId }).strict(),
  'studio:cleanup': z
    .object({ id: studioProjectId, silences: z.boolean().default(false), fillers: z.boolean().default(false), retakes: z.boolean().default(false), minSilence: z.number().min(0.25).max(5).optional(), keep: z.number().min(0).max(1).optional(), dryRun: z.boolean().default(false) })
    .strict(),
  'studio:punchIn': z.object({ id: studioProjectId, scale: z.number().min(1.03).max(1.6).optional() }).strict(),
  'studio:faceless': Storyboard,
  'studio:focus': z.object({ id: studioProjectId, time: z.number().min(0).max(86400), selected: z.array(z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/)).max(200) }).strict(),
  'studio:conversation': z.object({ id: studioProjectId }).strict(),
  'studio:assetIssue': z.object({ id: studioProjectId, assetId: studioAssetId, issue: z.string().trim().min(1).max(300) }).strict(),
  'studio:facelessPlan': Storyboard,
  'studio:soundEffect': z.object({ id: studioProjectId, kind: z.enum(['whoosh', 'pop', 'click', 'ding', 'riser', 'boom', 'swipe']), at: z.number().min(0).max(86400) }).strict(),
  /** No paths: Keo opens a file picker. */
  'studio:import': z.object({ id: studioProjectId, paths: z.array(z.string().trim().min(3).max(1000)).max(200).optional() }).strict(),
  'studio:export': z.object({ id: studioProjectId, options: ExportOptions.partial().optional() }).strict(),
  'studio:exportCancel': z.object({ id: studioProjectId }).strict(),
  'studio:readAloud': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/), voice: z.string().regex(/^[a-z]{2,20}$/).default('female') }).strict(),
  /** A voice-over recorded in Studio (16-bit WAV), put on the Voice track at `at`. */
  'studio:saveRecording': z.object({ id: studioProjectId, wavBase64: z.string().min(100).max(64_000_000), at: z.number().min(0).max(86400) }).strict(),
  'studio:reframe': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/) }).strict(),
  'studio:analyzeSpeech': z.object({ id: studioProjectId }).strict(),
  'studio:track': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/), box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).strict() }).strict(),
  'studio:stabilize': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/), strength: z.number().min(0.1).max(1).default(0.7) }).strict(),
  'studio:templates': z.object({}).strict(),
  'studio:learnTemplate': z.object({ id: studioProjectId, assetId: studioAssetId, name: z.string().trim().min(1).max(80).optional() }).strict(),
  'studio:applyTemplate': z.object({ id: studioProjectId, recipe: z.string().regex(/^rc_[A-Za-z0-9]{4,24}$/), endText: z.string().trim().min(1).max(120).optional() }).strict(),
  'studio:deleteTemplate': z.object({ recipe: z.string().regex(/^rc_[A-Za-z0-9]{4,24}$/) }).strict(),
  'studio:sounds': z.object({ query: z.string().max(200).optional(), kind: z.enum(['music', 'effect']).optional(), genre: z.string().max(40).optional() }).strict(),
  'studio:soundsAdd': z.object({ paths: z.array(z.string().min(1).max(1000)).max(200).optional(), kind: z.enum(['music', 'effect']).optional() }).strict(),
  'studio:soundUpdate': z.object({ sound: z.string().regex(/^sn_[A-Za-z0-9]{4,24}$/), name: z.string().trim().min(1).max(120).optional(), kind: z.enum(['music', 'effect']).optional(), genre: z.string().max(40).optional(), tags: z.array(z.string().max(30)).max(12).optional() }).strict(),
  'studio:soundDelete': z.object({ sound: z.string().regex(/^sn_[A-Za-z0-9]{4,24}$/) }).strict(),
  'studio:soundUse': z.object({ id: studioProjectId, sound: z.string().regex(/^(sn|sfx)_[A-Za-z0-9]{3,24}$/), at: z.number().min(0).optional(), role: z.enum(['music', 'effect']).optional() }).strict(),
  'studio:watch': z.object({ id: studioProjectId, on: z.boolean() }).strict(),
  'studio:liveEdits': z.object({ on: z.boolean().optional() }).strict(),
  'studio:brand': z.object({ patch: BrandPatch.optional() }).strict(),
  'studio:characters': z
    .object({
      action: z.enum(['list', 'save', 'delete', 'addPicture', 'removePicture', 'createPicture', 'morePose', 'setVoice', 'removeVoice', 'designVoice']),
      patch: CharacterPatch.optional(),
      id: CharacterId.optional(),
      picture: z.string().min(3).max(1000).optional(),
      pose: z.string().trim().min(3).max(300).optional(),
      /** A voice sample as base64 WAV (30 s of mono 24 kHz is under 2 MB). */
      audio: z.string().max(8_000_000).optional(),
      /** A voice to design, in words. */
      about: z.string().trim().min(5).max(300).optional(),
    })
    .strict(),
  'studio:characterVoice': z.object({ voice: z.string().regex(/^[a-z]{2,20}$/), text: z.string().trim().min(1).max(200), character: CharacterId.optional() }).strict(),
  // Real AI video from a description: the shot plan (Keo's model, nothing paid yet), then the video.
  'studio:aiVideoPlan': z.object({ description: z.string().trim().min(10).max(8000), seconds: z.number().int().min(5).max(60), model: z.enum(['kling-3-pro', 'veo-3.1-fast']), cast: z.array(CharacterId).max(3) }).strict(),
  'studio:aiVideoMake': z.object({ plan: AiVideoPlan }).strict(),
  /** AI requests still being made for a project (they survive closing Keo). */
  'studio:aiJobs': z.object({ id: studioProjectId }).strict(),
  'studio:swap': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/), character: CharacterId, resolution: z.enum(['480p', '580p', '720p']), smooth: z.boolean().optional(), mode: z.enum(['stable', 'quick']).optional() }).strict(),
  'studio:versions': z
    .object({ id: z.string().regex(/^pr_[A-Za-z0-9]{4,24}$/), action: z.enum(['list', 'save', 'restore', 'delete']), name: z.string().trim().min(1).max(80).optional(), version: z.string().regex(/^vr_[A-Za-z0-9]{4,24}$/).optional() })
    .strict(),
  'studio:skipShow': z.object({ id: studioProjectId }).strict(),
  'studio:previewCopies': z.object({ id: studioProjectId, assets: z.array(z.string().regex(/^as_[A-Za-z0-9]{4,24}$/)).max(200).optional() }).strict(),
  'studio:cleanSound': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/), strength: z.number().min(0.1).max(1).default(0.8) }).strict(),
  'studio:reverse': z.object({ id: studioProjectId, clip: z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/) }).strict(),
  'studio:splitScenes': z.object({ id: studioProjectId, clips: z.array(z.string().regex(/^cl_[A-Za-z0-9]{4,24}$/)).max(500).optional() }).strict(),
  'studio:beatSync': z.object({ id: studioProjectId, every: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(2) }).strict(),
  'studio:current': empty,
  'studio:videoTrack': z.object({ projectId: studioProjectId, assetId: studioAssetId }).strict(),
  'studio:videoSamples': z.object({ projectId: studioProjectId, assetId: studioAssetId, time: z.number().min(0).max(86400).optional(), from: z.number().int().min(0).optional(), count: z.number().int().min(1).max(240) }).strict(),
  'studio:exportBegin': z
    .object({
      exportId: z.string().regex(/^ex_[0-9a-f]{12}$/),
      projectId: studioProjectId,
      video: z.object({ width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), avcC: z.instanceof(Uint8Array) }).strict(),
      audio: z.object({ codec: z.enum(['aac', 'opus']), sampleRate: z.number().int().min(8000).max(192000), channels: z.number().int().min(1).max(8), config: z.instanceof(Uint8Array) }).strict().nullable(),
    })
    .strict(),
  'studio:exportChunk': z
    .object({
      exportId: z.string().regex(/^ex_[0-9a-f]{12}$/),
      kind: z.enum(['video', 'audio']),
      data: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 32 * 1024 * 1024, 'chunk size'),
      timeUs: z.number().min(0),
      durationUs: z.number().min(0),
      key: z.boolean(),
    })
    .strict(),
  'studio:exportEnd': z.object({ exportId: z.string().regex(/^ex_[0-9a-f]{12}$/) }).strict(),
  'studio:exportAbort': z.object({ exportId: z.string().regex(/^ex_[0-9a-f]{12}$/) }).strict(),
  'studio:exportProgress': z.object({ projectId: studioProjectId, stage: z.enum(['sound', 'video', 'saving']), done: z.number().min(0), total: z.number().min(0) }).strict(),
  'studio:jobDone': z.object({ jobId: z.string().regex(/^job_[0-9a-f]{12}$/), result: z.unknown(), error: z.string().max(1000).nullable() }).strict(),
  'studio:renderReady': empty,
  'picture:view': z.object({ path: z.string().trim().min(3).max(1000) }).strict(),
  'picture:open': z.object({ path: z.string().trim().min(3).max(1000), reveal: z.boolean().default(false) }).strict(),
  'chat:discardAttachment': z.object({ id: z.string().regex(/^att_[A-Za-z0-9]{8,40}$/) }).strict(),
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
  'aivideo:status': empty,
  'aivideo:setKey': z.object({ apiKey: z.string().trim().min(8).max(300) }).strict(),
  'aivideo:clearKey': empty,
  'aivideo:setLimit': z.object({ monthlyLimitUsd: z.number().min(1).max(100000).nullable() }).strict(),
  'web:test': empty,

  'email:status': empty,
  'email:save': z
    .object({
      provider: z.enum(['gmail', 'outlook', 'yahoo', 'icloud', 'custom']),
      address: z.string().trim().min(3).max(254).regex(/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/, 'Invalid email address'),
      displayName: z.string().trim().max(120).default(''),
      imapHost: z.string().trim().min(3).max(253).regex(/^[A-Za-z0-9.-]+$/, 'Invalid server name'),
      imapPort: z.number().int().min(1).max(65535),
      imapSecure: z.boolean(),
      smtpHost: z.string().trim().min(3).max(253).regex(/^[A-Za-z0-9.-]+$/, 'Invalid server name'),
      smtpPort: z.number().int().min(1).max(65535),
      smtpSecure: z.boolean(),
      /** Omitted = keep the stored app password. */
      password: z.string().min(4).max(200).optional(),
    })
    .strict(),
  'email:test': empty,
  'email:disconnect': empty,
  'calendar:status': empty,
  /** Empty removes it. */
  'calendar:setClientSecret': z.object({ secret: z.string().trim().max(200) }).strict(),
  /** Sign in with Google: Calendar, and with `mail` also Gmail. */
  'calendar:signIn': z.object({ mail: z.boolean().optional() }).strict().optional().default({}),
  'calendar:cancelSignIn': empty,
  'calendar:signOut': empty,

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
  'call:fullscreen': empty,
  'voice:level': z.object({ level: z.number().min(0).max(1), source: z.enum(['mic', 'playback']).nullable() }).strict(),
  'presence:report': z.object({ speaking: z.boolean(), recording: z.boolean(), transcribing: z.boolean() }).strict(),
  'presence:stopAll': empty,
  'presence:openMain': z.object({ view: z.enum(['chat', 'tasks', 'settings', 'call']).optional() }).strict(),
  'companion:setInteractive': z.object({ interactive: z.boolean() }).strict(),
  'companion:drag': z.object({ phase: z.enum(['start', 'end']) }).strict(),
  'companion:hide': empty,
  'commandBar:show': empty,
  'pencil:start': empty,
  'keomode:open': empty,
  'marks:get': empty,
  'keomode:close': empty,
  'pencil:context': empty,
  'pencil:submit': z
    .object({
      text: z.string().max(2000),
      crop: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(16_000_000),
      full: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(16_000_000),
      box: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).strict(),
    })
    .strict(),
  'pencil:cancel': empty,
  'pencil:allowExport': empty,
  'pencil:listen': empty,
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
  'jobs:list': empty,
  'jobs:cancel': z.object({ id: z.string().regex(/^job_[A-Za-z0-9]{6,64}$/) }).strict(),
  'schedule:list': empty,
  'schedule:pause': z.object({ id: z.string().regex(/^sch_[A-Za-z0-9]{6,64}$/), paused: z.boolean() }).strict(),
  'schedule:delete': z.object({ id: z.string().regex(/^sch_[A-Za-z0-9]{6,64}$/) }).strict(),

  /** The morning briefing card: open an event's Google Calendar page, or a file it listed. */
  'briefing:openEvent': z.object({ url: z.string().min(8).max(2000) }).strict(),
  'briefing:openFile': z.object({ path: z.string().trim().min(3).max(1000) }).strict(),
  /** True once each morning when "show it when I first open Keo" is on (and records that it was shown). */
  'briefing:morningDue': empty,
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
  'app:openUrl': { opened: boolean };
  'app:copyText': { copied: boolean };
  'app:checkUpdate': UpdateInfo | null;
  'app:openDataFolder': { opened: boolean };
  'app:installUpdate': { started: boolean };
  'diag:checkComputer': SelfTestResult;
  'projects:pickWorkspace': { path: string | null; scripts: string[] };
  'apps:installed': Array<{ name: string; appId: string; kind: 'store' | 'desktop'; publisher: string | null; processName: string | null; exePath: string | null; icon: string | null }>;
  'wake:setPicovoiceKey': { hasKey: boolean };
  'wake:pickKeywordFile': { path: string | null };
  'results:get': ResearchResultView | null;
  'results:save': { ok: boolean; folder: string | null; error: string | null };
  'results:send': { ok: boolean; error: string | null; detail: string | null };
  'results:openFolder': { opened: boolean };
  'results:close': { closed: boolean };
  'video:get': VideoView | null;
  'video:preview': { bytes: Uint8Array | null };
  'video:say': { applied: boolean; changes: string[]; forwarded: boolean; error: string | null };
  'video:undo': { ok: boolean; error: string | null };
  'video:export': { ok: boolean; file: string | null; error: string | null; detail: string | null };
  'video:openFolder': { opened: boolean };
  'video:close': { closed: boolean };
  'video:status': { found: boolean; encoder: string | null; captions: boolean; message: string };
  'video:pickFfmpeg': { path: string | null; ok: boolean; message: string };
  'video:pickOutput': { path: string | null };
  'files:pickFolder': { path: string | null };
  'files:photosState': PhotoIndexState;
  'files:photosEstimate': PhotoIndexState;
  'files:photosStart': PhotoIndexState;
  'files:photosPause': PhotoIndexState;
  'files:photosClear': PhotoIndexState;
  'video:setupState': VideoToolsSetup;
  'video:setupStart': VideoToolsSetup;
  'video:setupCancel': VideoToolsSetup;
  'video:setupRemove': VideoToolsSetup;
  'workflows:list': Array<{ id: string; name: string; description: string; steps: number; imported: boolean; createdAt: string }>;
  'workflows:saveFromTask': { id: string; name: string };
  'workflows:delete': { deleted: boolean };
  'data:export': { path: string | null; projects: number; workflows: number };
  'data:import': { projects: number; workflows: number; skipped: number } | null;
  'projects:clearWorkspace': { cleared: boolean };
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
  'chat:pickAttachments': AttachmentView[];
  'chat:attachBytes': AttachmentView;
  'chat:attachScreenshot': AttachmentView;
  'chat:discardAttachment': { ok: true };
  'picture:view': { mimeType: string; dataBase64: string };
  'account:status': AccountStatus;
  'account:signUp': { needsConfirmation: boolean; status: AccountStatus };
  'account:signIn': AccountStatus;
  'account:signOut': AccountStatus;
  'account:resetPassword': { ok: true };
  'account:refresh': AccountStatus;
  'account:upgrade': { opened: boolean };
  'account:useLocal': { ok: true };
  'studio:list': ProjectSummary[];
  'studio:create': StudioProject;
  'studio:get': StudioProject;
  'studio:open': StudioProject;
  'studio:delete': { ok: true };
  'studio:duplicate': StudioProject;
  'studio:useTemplate': { project: StudioProject; filled: number; slots: number } | null;
  'studio:saveFrame': { file: string };
  'studio:edit': { project: StudioProject; changes: string[] };
  'studio:undo': StudioProject;
  'studio:redo': StudioProject;
  'studio:history': { undo: boolean; redo: boolean; undoLabels: string[]; redoLabels: string[] };
  'studio:captions': { lines: number; words: number; exact: boolean };
  'studio:captionSource': { destination: string | null; exact: boolean; reason: string | null };
  'studio:transcribe': { words: number; exact: boolean };
  'studio:cleanup': { cuts: number; seconds: number; byReason: Record<string, number>; notes: string[] };
  'studio:punchIn': { points: number };
  'studio:soundEffect': { ok: true };
  'studio:faceless': { projectId: string; duration: number; scenes: number; pictures: number; voice: string };
  'studio:focus': { ok: true };
  'studio:conversation': { conversationId: string };
  'studio:assetIssue': { ok: true };
  'studio:facelessPlan': { voice: string | null; pictures: string | null; aiPictures: number; narrations: number; reason: string | null; characterPictures: number; characterCostUsd: number };
  'studio:import': { project: StudioProject; added: StudioAsset[]; skipped: string[] };
  'studio:export': { started: true };
  'studio:exportCancel': { cancelled: boolean };
  'studio:beatSync': { placed: number; bpm: number | null };
  'studio:splitScenes': { splits: number; clips: number };
  'studio:reverse': { seconds: number };
  'studio:cleanSound': { seconds: number };
  'studio:previewCopies': { made: number };
  'studio:watch': { ok: true };
  'studio:templates': Recipe[];
  'studio:learnTemplate': Recipe;
  'studio:applyTemplate': { cutaways: number; captions: boolean; music: string | null; needsWords: boolean };
  'studio:deleteTemplate': { ok: true };
  'studio:sounds': Sound[];
  'studio:soundsAdd': { added: Sound[]; skipped: string[] };
  'studio:soundUpdate': Sound;
  'studio:soundDelete': { ok: true };
  'studio:soundUse': { clip: string };
  'studio:liveEdits': { on: boolean };
  'studio:brand': Brand;
  'studio:characters': Character[];
  'studio:characterVoice': { mimeType: string; base64: string };
  'studio:aiVideoPlan': { title: string; style: string; shots: AiShot[] };
  'studio:aiVideoMake': { projectId: string; shots: number; ready: number; pending: number };
  'studio:aiJobs': Array<{ about: string; submittedAt: string; kind: 'shot' | 'swap' | 'other' }>;
  'studio:swap': { clip: string | null; seconds: number; cached: boolean; costUsd: number; pending: boolean };
  'studio:versions': import('./studio').StudioVersion[];
  'studio:skipShow': { ok: true };
  'studio:track': { points: number; lost: number };
  'studio:stabilize': { points: number; zoom: number };
  'studio:analyzeSpeech': { analysed: number };
  'studio:reframe': { points: number; axis: 'x' | 'y' };
  'studio:readAloud': { clip: string; seconds: number };
  'studio:saveRecording': { clip: string; seconds: number };
  'studio:current': { id: string | null };
  'studio:videoTrack': { codec: string; description: Uint8Array | null; width: number; height: number; rotation: number; samples: number; keyTimes: number[] } | null;
  'studio:videoSamples': { from: number; samples: Array<{ data: Uint8Array; time: number; duration: number; key: boolean }> };
  'studio:exportBegin': { ok: true };
  'studio:exportChunk': { ok: true };
  'studio:exportEnd': { file: string; durationSec: number; frames: number; bytes: number };
  'studio:exportAbort': { ok: true };
  'studio:exportProgress': { ok: true };
  'studio:jobDone': { ok: true };
  'studio:renderReady': { ok: true };
  'picture:open': { opened: boolean };
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
  'aivideo:status': AiVideoStatus;
  'aivideo:setKey': AiVideoStatus;
  'aivideo:clearKey': AiVideoStatus;
  'aivideo:setLimit': AiVideoStatus;
  'web:test': { ok: boolean; message: string; sample: Array<{ title: string; url: string }> };
  'email:status': EmailStatus;
  'email:save': EmailStatus;
  'email:test': { ok: boolean; message: string };
  'email:disconnect': EmailStatus;
  'calendar:status': CalendarStatus;
  'calendar:setClientSecret': CalendarStatus;
  'calendar:signIn': { ok: boolean; message: string };
  'calendar:cancelSignIn': CalendarStatus;
  'calendar:signOut': CalendarStatus;
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
  'voice:level': { ok: true };
  'call:fullscreen': { ok: true };
  'presence:stopAll': { cancelledTurns: number; cancelledTasks: number; revokedGrants: number };
  'presence:openMain': { ok: true };
  'companion:setInteractive': { ok: true };
  'companion:drag': { ok: true };
  'companion:hide': { ok: true };
  'commandBar:show': { ok: true };
  'pencil:start': { ok: boolean; error: string | null };
  'keomode:open': { ok: true };
  'marks:get': { marks: Array<{ shape: 'circle' | 'box' | 'arrow' | 'underline' | 'label'; x: number; y: number; w?: number; h?: number; fromX?: number; fromY?: number; label?: string }>; seconds: number } | null;
  'keomode:close': { ok: true };
  'pencil:context': { image: string; width: number; height: number; provider: string; consentNeeded: boolean; visionModel: boolean; listening: boolean; heard: string | null } | null;
  'pencil:submit': { ok: boolean; error: string | null };
  'pencil:cancel': { ok: true };
  'pencil:allowExport': { allowed: boolean };
  'pencil:listen': { started: boolean };
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
  'jobs:list': BackgroundJob[];
  'jobs:cancel': { cancelled: boolean };
  'schedule:list': ScheduledItem[];
  'schedule:pause': ScheduledItem | null;
  'schedule:delete': { deleted: boolean };

  'briefing:openEvent': { opened: boolean };
  'briefing:openFile': { opened: boolean; error: string | null };
  'briefing:morningDue': { due: boolean };
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
  pencilShortcut: { accelerator: string; enabled: boolean; registered: boolean; error: string | null };
  /** A Picovoice access key is stored (never the key itself). */
  picovoiceKey: boolean;
  /** Speech engine in use ("modern" Windows 10/11 or "classic"), and why modern isn't, if it isn't. */
  engine: { kind: string | null; fallbackReason: string | null };
}

export interface WebStatus {
  hasKey: boolean;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  secretStorage: boolean;
}

/** An attachment as the chat shows it before sending (its text and picture stay in the main process). */
export type AttachmentView = Omit<MessageAttachment, 'text'>;

/** The email account, without its password (only whether one is stored). */
export interface EmailStatus {
  /** An account and app password are saved (not that the server accepted them: see loginRefused). */
  connected: boolean;
  /** The last connection test since saving failed. */
  loginRefused: boolean;
  address: string;
  hasPassword: boolean;
  secretStorage: boolean;
  /** Gmail through the Google sign-in (no app password). */
  viaGoogle: boolean;
}

/** Google Calendar sign-in state (never the tokens or the client secret). */
export interface CalendarStatus {
  /** The user's own client ID (Settings); empty when Keo's built-in client is used. */
  clientId: string;
  /** This build ships Keo's own Google client: users only choose Sign in with Google. */
  builtIn: boolean;
  /** Keo's built-in Google client ID (public by design), to recognise it when typed in as "your own". */
  builtInId: string | null;
  hasClientSecret: boolean;
  signedIn: boolean;
  signingIn: boolean;
  /** The signed-in Google account and what it allowed. */
  googleEmail: string | null;
  calendarAllowed: boolean;
  mailAllowed: boolean;
  /** When the user signed in (ISO), for the 7-day "Testing" limit hint. */
  signedInAt: string | null;
  secretStorage: boolean;
}

/** Errors crossing IPC are serialised to this shape; never raw stacks. */
export interface IpcErrorShape {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorShape };

