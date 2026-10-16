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
}

export interface MessageMeta {
  providerId?: ProviderId;
  model?: string;
  usage?: TokenUsage;
  error?: string;
  errorKind?: ProviderErrorKind;
  tools?: ToolActivity[];
  memoryIds?: string[];
  correlationId?: string;
  stopReason?: string;
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
  approval: { decision: 'approved' | 'denied'; decidedAt: ISODate; inputHash: string } | null;
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

export type AgentEvent =
  | { type: 'turn_started'; conversationId: string; messageId: string; correlationId: string }
  | { type: 'text_delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'tool_activity'; conversationId: string; messageId: string; activity: ToolActivity }
  | { type: 'phase'; conversationId: string; messageId: string; phase: 'thinking' | 'generating' | 'tool' | 'waiting_approval' }
  | { type: 'turn_finished'; conversationId: string; message: Message };
