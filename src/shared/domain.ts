/**
 * Domain types shared by the main process, preload and renderer.
 * These are plain data shapes only — no behaviour and no Node APIs.
 */

export type ISODate = string;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'local' | 'test';
/** Providers that can receive exported data (the test provider never leaves the process). */
export type ExportProviderId = Exclude<ProviderId, 'test'>;

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
  contextTokens: number;
  maxOutputTokens: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export type ProviderStatus =
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'ready' }
  | { kind: 'error'; reason: string };

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  /** Where requests go — shown to the user as the data-export destination. */
  destination: string;
  remote: boolean;
  models: ModelInfo[];
  selectedModel: string;
  status: ProviderStatus;
  supportsAudio: boolean;
}

export interface ProviderDiagnostic {
  providerId: ProviderId;
  ok: boolean;
  checkedAt: ISODate;
  latencyMs: number | null;
  message: string;
  /** Live models reported by the provider, when the provider exposes a listing. */
  remoteModels?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  messageCount: number;
}

export type MessageRole = 'user' | 'assistant' | 'note';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error' | 'cancelled';

/** A research result as the results window shows it. */
export interface ResearchResultView {
  id: string;
  title: string;
  summary: string;
  criteria: string[];
  cards: ProductCard[];
  createdAt: string;
}

/** A product comparison card (research.show_products): every field traced to a fetched page. */
export interface ProductCard {
  name: string;
  url: string;
  pageTitle: string;
  merchant: string | null;
  price: string | null;
  currency: string | null;
  priceFrom: 'page data' | 'page text' | 'not found';
  availability: string | null;
  /** Shrunk copy downloaded by Keo (data: URL), never a remote address. */
  image: string | null;
  /** Where the picture came from (the page's own product image), for saving it full size. */
  imageUrl?: string | null;
  /** 'page': the product page's own picture; 'wikipedia': the matching Wikipedia article's picture. */
  imageFrom?: 'page' | 'wikipedia' | null;
  fit: string | null;
  pros: string[];
  cons: string[];
  specs: string[];
  fetchedAt: string;
}

export interface ToolActivity {
  callId: string;
  capabilityId: string;
  /** Short, user-facing description of what was requested. */
  summary: string;
  outcome:
    | 'rejected'
    | 'executed'
    | 'failed'
    | 'awaiting_authorization'
    | 'denied'
    | 'uncertain'
    | 'proposed';
  detail: string;
  taskId?: string;
  /** Product cards to show with this step (research.show_products). */
  cards?: { summary: string; criteria: string[]; cards: ProductCard[]; dropped: Array<{ name: string; reason: string }>; resultId?: string; title?: string };
  /** Choices to offer as buttons when the action needs the user to pick (app, profile, window). */
  choices?: string[];
}

export interface MessageMeta {
  providerId?: ProviderId;
  model?: string;
  /** Smart routing chose the fast or the strong model for this reply (absent when routing is off). */
  route?: 'fast' | 'strong';
  usage?: TokenUsage;
  error?: string;
  errorKind?: ProviderErrorKind;
  tools?: ToolActivity[];
  memoryIds?: string[];
  correlationId?: string;
  stopReason?: string;
  /** Actions the reply claimed that no capability performed (honesty guard). */
  unsupportedClaims?: string[];
  /** The reply came back in another language and was rewritten in English (text only; no action repeated). */
  languageCorrected?: boolean;
  /** Marks a Keo note about a task outcome (taskId:state). */
  taskNote?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: ISODate;
  meta: MessageMeta;
}

export type ProviderErrorKind =
  | 'unconfigured'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'server'
  | 'refusal'
  | 'cancelled'
  | 'malformed'
  | 'unknown';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryKind = 'fact' | 'preference' | 'instruction' | 'person' | 'context';
export type MemoryStatus = 'proposed' | 'confirmed' | 'superseded' | 'rejected';
/**
 * user_authored  – typed directly by the user (memory view or "remember" action)
 * user_confirmed – proposed by the model, then explicitly accepted by the user
 * user_stated    – extracted by the model from the user's own words and saved
 *                  automatically, because a verbatim quote of the user was verified
 * model_inferred – proposed by the model and NOT yet accepted
 */
export type MemoryProvenance = 'user_authored' | 'user_confirmed' | 'user_stated' | 'model_inferred';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  status: MemoryStatus;
  provenance: MemoryProvenance;
  projectId: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceExcerpt: string | null;
  supersededBy: string | null;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  confirmedAt: ISODate | null;
  /** Ids of other confirmed memories sharing the same subject. */
  conflictsWith: string[];
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  version: number;
  content: string;
  changedAt: ISODate;
  reason: string;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type ProjectItemType = 'objective' | 'decision' | 'blocker' | 'question' | 'progress';
export type ProjectItemStatus = 'proposed' | 'open' | 'resolved' | 'rejected';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
  openItemCount: number;
}

export interface ProjectItem {
  id: string;
  projectId: string;
  type: ProjectItemType;
  content: string;
  status: ProjectItemStatus;
  provenance: MemoryProvenance;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type RiskLevel = 'read' | 'low' | 'medium' | 'high';
export type PermissionKey = 'desktop.observe' | 'desktop.control' | 'desktop.launch' | 'vision.export' | 'web.search' | 'web.fetch';

export interface CapabilityInfo {
  id: string;
  version: string;
  title: string;
  description: string;
  risk: RiskLevel;
  requiresApproval: boolean;
  consequential: boolean;
  idempotent: boolean;
  permissions: PermissionKey[];
  timeoutMs: number;
  maxAttempts: number;
  modelVisible: boolean;
  available: boolean;
  unavailableReason: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskState =
  | 'proposed'
  | 'awaiting_clarification'
  | 'awaiting_authorization'
  | 'ready'
  | 'running'
  | 'waiting_dependency'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_uncertain';

export type StepState =
  | 'pending'
  | 'awaiting_authorization'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'skipped'
  | 'cancelled'
  | 'outcome_uncertain';

export type Verification = 'verified' | 'unverified' | 'verification_failed' | 'not_applicable';

export interface ApprovalPreview {
  summary: string;
  target: string | null;
  consequences: string[];
  /** Destination for any data leaving this computer, if applicable. */
  dataExport: string | null;
  /** Eligible for a time-boxed navigation grant (never for send/delete/submit-like actions). */
  grantable?: boolean;
  /**
   * Approval-level tier: 'routine' runs without asking under "Ask only for
   * important things", 'important' only under "Hands-free", 'always_ask'
   * always needs the user (payments, deleting, sensitive buttons, raw clicks…).
   */
  autoTier?: AutonomyTier;
  /** Why this action always asks (shown on the card). */
  alwaysAskReason?: string | null;
  /** Text the user must have named in the conversation (e.g. the contact) for an automatic approval. */
  mustBeNamed?: string | null;
}

/** routine / important / always_ask: run without asking in Hands-free; critical: always a click on screen (pay, buy, delete, sign in, running code). */
export type AutonomyTier = 'routine' | 'important' | 'always_ask' | 'critical';
export type AutonomyLevel = 'always_ask' | 'important_only' | 'hands_free';

/** A live WhatsApp chat Keo keeps going for the user until stopped. */
export type LiveChatStatus = 'starting' | 'active' | 'waiting_user' | 'paused' | 'ended';
export interface LiveChatLine {
  from: 'them' | 'keo' | 'you' | 'note';
  text: string;
  at: ISODate;
}
export interface LiveChatSession {
  id: string;
  contact: string;
  target: { hwnd: string; pid: number; processName: string };
  goal: string;
  /** The user's own instructions and answers, in order (never the contact's words). */
  guidance: string[];
  status: LiveChatStatus;
  /** What Keo is waiting for the user to decide, when status is waiting_user. */
  question: string | null;
  /** Latest thing Keo did or is waiting for (content-free where possible). */
  activity: string | null;
  replies: number;
  maxReplies: number;
  startedAt: ISODate;
  endsAt: ISODate;
  endedReason: string | null;
  conversationId: string | null;
  transcript: LiveChatLine[];
  /** A reply Keo is ready to send (waiting for the user to pause, or for "Send now"). */
  draft: string | null;
}

export interface NavigationGrant {
  id: string;
  target: { hwnd: string; pid: number; processName: string };
  label: string;
  capabilities: string[];
  createdAt: ISODate;
  expiresAt: ISODate;
  maxActions: number;
  used: number;
}

/** Live presence of the agent, aggregated in the main process from real events only. */
export type PresenceState =
  | 'idle'
  | 'listening'
  | 'understanding'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'awaiting_approval'
  | 'speaking'
  | 'cancelled'
  | 'error';

export interface Presence {
  state: PresenceState;
  /** Short, content-free activity line (capability title + application only). */
  activity: string | null;
  pendingApprovals: number;
  activeTurns: number;
  runningSteps: number;
  wake: { enabled: boolean; listening: boolean; muted: boolean; status: 'off' | 'starting' | 'listening' | 'capturing' | 'error' | 'unavailable'; message: string | null; phrase: string | null };
  grants: number;
  /** Live chats: how many are running and how many wait for the user. */
  liveChats: { active: number; waiting: number; firstWaiting: string | null; ready: number; firstReady: { id: string; contact: string } | null };
  autonomy: AutonomyLevel;
  /** Unfinished tasks (newest first, at most four): title and truthful state only. */
  tasks: Array<{ id: string; title: string; state: 'running' | 'waiting' | 'needs_you' | 'uncertain'; step: string | null }>;
  /** Hands-free conversation after the wake word. */
  voiceMode: { active: boolean; state: 'off' | 'listening' | 'thinking' | 'speaking' | 'confirming'; heard: string | null; said: string | null };
  updatedAt: ISODate;
}

export interface TaskStep {
  id: string;
  taskId: string;
  index: number;
  capabilityId: string;
  capabilityVersion: string;
  title: string;
  input: unknown;
  inputHash: string;
  dependsOn: string[];
  state: StepState;
  requiresApproval: boolean;
  approval: { decision: 'approved' | 'denied'; decidedAt: ISODate; inputHash: string; grantId?: string; policy?: AutonomyLevel } | null;
  preview: ApprovalPreview;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  result: unknown;
  error: string | null;
  errorCode: string | null;
  verification: Verification;
  verificationDetail: string | null;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export type TaskOrigin = 'model' | 'user' | 'plan';

export interface Task {
  id: string;
  title: string;
  rationale: string;
  origin: TaskOrigin;
  conversationId: string | null;
  state: TaskState;
  createdAt: ISODate;
  updatedAt: ISODate;
  finishedAt: ISODate | null;
  steps: TaskStep[];
  note: string | null;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Desktop & vision
// ---------------------------------------------------------------------------

export interface WindowTarget {
  /** Native window handle as a decimal string. */
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
  className: string;
  minimized: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  allowed: boolean;
}

export interface Observation {
  id: string;
  target: { hwnd: string; pid: number; processName: string; title: string };
  capturedAt: ISODate;
  width: number;
  height: number;
  sha256: string;
  method: 'electron.desktopCapturer';
  hasImage: boolean;
  initiatedBy: 'user' | 'task';
  taskId: string | null;
}

export interface ObservationAnalysis {
  id: string;
  observationId: string;
  providerId: ProviderId;
  model: string;
  prompt: string;
  result: string;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface LogEvent {
  ts: ISODate;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  ts: ISODate;
  kind: string;
  capabilityId: string | null;
  taskId: string | null;
  decision: string;
  detail: Record<string, unknown>;
  correlationId: string | null;
}

/** Result of checking GitHub Releases for a newer Keo. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  /** Release page to download from (always on Keo's own GitHub repository). */
  url: string;
  notes: string | null;
  error: string | null;
  /** Background download of the new version (installed builds). */
  download?: UpdateDownload;
}

export interface UpdateDownload {
  state: 'none' | 'downloading' | 'ready' | 'failed';
  version: string | null;
  percent: number | null;
  error: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  profile: string;
  userDataPath: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  schemaVersion: number;
  packaged: boolean;
  testProviderEnabled: boolean;
  secretStorage: 'os-encrypted' | 'unavailable';
}

// ---------------------------------------------------------------------------
// Streaming agent events (main -> renderer)
// ---------------------------------------------------------------------------

/** Turn phases: model reasoning, context gathering, planning, acting, waiting for the user. */
export type AgentPhase = 'thinking' | 'generating' | 'gathering_context' | 'planning' | 'tool' | 'waiting_approval';

export type AgentEvent =
  | { type: 'turn_started'; conversationId: string; messageId: string; correlationId: string }
  | { type: 'text_delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'tool_activity'; conversationId: string; messageId: string; activity: ToolActivity }
  | { type: 'phase'; conversationId: string; messageId: string; phase: AgentPhase }
  | { type: 'turn_finished'; conversationId: string; message: Message };

// ---------------------------------------------------------------------------
// "Check this computer" self-test

export interface SelfTestStep {
  id: 'helper' | 'window' | 'focus' | 'type' | 'paste' | 'read' | 'click';
  title: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  /** One-line hint for the first failing step. */
  advice: string | null;
}

/** A video project as Keo's preview window shows it. */
export interface VideoView {
  id: string;
  title: string;
  status: 'idle' | 'analyzing' | 'rendering' | 'ready' | 'error';
  progress: number | null;
  message: string | null;
  aspect: string;
  totalSec: number;
  shots: Array<{ index: number; clip: string; startSec: number; durationSec: number; speed: number }>;
  texts: Array<{ text: string; startSec: number; endSec: number }>;
  captions: { enabled: boolean; sizePct: number; position: string };
  music: string | null;
  notes: string[];
  lastChanges: string[];
  preview: { version: number; durationSec: number } | null;
  exports: string[];
  canUndo: boolean;
}

