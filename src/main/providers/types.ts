import type { ModelInfo, ProviderDiagnostic, ProviderErrorKind, ProviderId, ProviderStatus, TokenUsage } from '../../shared/domain';
import { KeoError } from '../util/errors';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type NeutralBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; dataBase64: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean };

export interface NeutralMessage {
  role: 'user' | 'assistant';
  content: NeutralBlock[];
  /**
   * Provider-native assistant content, replayed verbatim within the same turn
   * (e.g. Anthropic thinking blocks must be echoed back unchanged).
   */
  native?: { providerId: ProviderId; model: string; content: unknown };
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: NeutralMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  correlationId: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the provider's tool input could not be parsed. */
  parseError?: string;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage | null;
  model: string;
  native: NeutralMessage['native'];
}

export interface StreamHandlers {
  onText(delta: string): void;
  onPhase?(phase: 'thinking' | 'generating'): void;
}

export class ProviderError extends KeoError {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(kind: ProviderErrorKind, message: string, opts: { retryable?: boolean; status?: number | null } = {}) {
    super(`provider_${kind}`, message);
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? null;
  }
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly description: string;
  readonly requiresApiKey: boolean;
  readonly remote: boolean;
  readonly supportsAudio: boolean;
  destination(): string;
  models(): ModelInfo[];
  selectedModel(): string;
  status(): ProviderStatus;
  stream(req: ChatRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<ChatResult>;
  diagnose(signal: AbortSignal): Promise<ProviderDiagnostic>;
}

export function modelInfo(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}
