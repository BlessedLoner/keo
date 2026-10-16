import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo, ProviderDiagnostic, ProviderStatus } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { nowIso } from '../util/errors';
import {
  ProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type NeutralMessage,
  type StopReason,
  type StreamHandlers,
  type ToolCall,
} from './types';

/** Explicitly declared model capabilities (not inferred at runtime). */
const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', capabilities: { tools: true, vision: true, streaming: true, contextTokens: 1_000_000, maxOutputTokens: 128_000 } },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', capabilities: { tools: true, vision: true, streaming: true, contextTokens: 1_000_000, maxOutputTokens: 128_000 } },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', capabilities: { tools: true, vision: true, streaming: true, contextTokens: 1_000_000, maxOutputTokens: 128_000 } },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', capabilities: { tools: true, vision: true, streaming: true, contextTokens: 1_000_000, maxOutputTokens: 128_000 } },
];

/** Models that accept the server-side refusal fallback ("default" form). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic (Claude)';
  readonly description = 'Claude models through the official Anthropic Messages API, using your own Anthropic API key.';
  readonly requiresApiKey = true;
  readonly remote = true;
  readonly supportsAudio = false;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly getKey: () => string | null,
    private readonly clientFactory: (apiKey: string) => Anthropic = (apiKey) =>
      new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 }),
  ) {}

  destination(): string {
    return 'api.anthropic.com (Anthropic)';
  }

  models(): ModelInfo[] {
    return MODELS;
  }

  selectedModel(): string {
    return this.getSettings().providers.anthropic.model;
  }

  status(): ProviderStatus {
    if (!this.getKey()) return { kind: 'unconfigured', reason: 'Add an Anthropic API key in Settings → Providers.' };
    if (!MODELS.some((m) => m.id === this.selectedModel())) return { kind: 'error', reason: `Unknown model ${this.selectedModel()}.` };
    return { kind: 'ready' };
  }

  private client(): Anthropic {
    const key = this.getKey();
    if (!key) throw new ProviderError('unconfigured', 'Anthropic API key is not configured.');
    return this.clientFactory(key);
  }

  private toParams(messages: NeutralMessage[], model: string): Anthropic.Beta.BetaMessageParam[] {
    return messages.map((m): Anthropic.Beta.BetaMessageParam => {
      if (m.role === 'assistant' && m.native && m.native.providerId === 'anthropic' && m.native.model === model) {
        // Echo the provider's own content unchanged (thinking blocks must be preserved).
        return { role: 'assistant', content: m.native.content as Anthropic.Beta.BetaContentBlockParam[] };
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const b of m.content) {
        switch (b.type) {
          case 'text':
            if (b.text) content.push({ type: 'text', text: b.text });
            break;
          case 'image':
            content.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 } });
            break;
          case 'tool_call':
            content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
            break;
          case 'tool_result':
            content.push({ type: 'tool_result', tool_use_id: b.callId, content: b.content, is_error: b.isError });
            break;
        }
      }
      if (!content.length) content.push({ type: 'text', text: '(empty)' });
      return { role: m.role, content };
    });
  }

  async stream(req: ChatRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<ChatResult> {
    const s = this.getSettings().providers.anthropic;
    const client = this.client();
    const useFallback = s.refusalFallback && FALLBACK_MODELS.has(req.model);
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: this.toParams(req.messages, req.model),
      output_config: { effort: s.effort },
      cache_control: { type: 'ephemeral' },
      stream: true,
      ...(tools.length ? { tools } : {}),
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };

    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking') handlers.onPhase?.('thinking');
          else if (event.content_block.type === 'text') handlers.onPhase?.('generating');
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          handlers.onText(event.delta.text);
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      throw mapAnthropicError(err, signal);
    }

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const stopReason: StopReason =
      message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
        ? 'end'
        : message.stop_reason === 'tool_use'
          ? 'tool_use'
          : message.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : message.stop_reason === 'refusal'
              ? 'refusal'
              : 'other';
    const u = message.usage;
    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      },
      model: message.model,
      native: { providerId: 'anthropic', model: req.model, content: message.content },
    };
  }

  async diagnose(signal: AbortSignal): Promise<ProviderDiagnostic> {
    const started = Date.now();
    const base = { providerId: this.id, checkedAt: nowIso() } as const;
    if (!this.getKey()) return { ...base, ok: false, latencyMs: null, message: 'No API key configured.' };
    try {
      // Listing models is free and verifies the key without generating tokens.
      const page = await this.client().models.list({ limit: 50 }, { signal });
      const ids = page.data.map((m) => m.id);
      const selected = this.selectedModel();
      const has = ids.includes(selected);
      return {
        ...base,
        ok: has,
        latencyMs: Date.now() - started,
        message: has
          ? `Connected. ${selected} is available to this key.`
          : `Connected, but ${selected} was not in the model list returned for this key.`,
        remoteModels: ids,
      };
    } catch (err) {
      const e = mapAnthropicError(err, signal);
      return { ...base, ok: false, latencyMs: Date.now() - started, message: e.message };
    }
  }
}

export function mapAnthropicError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return new ProviderError('cancelled', 'Request cancelled.');
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('auth', 'Anthropic rejected the API key (401).', { status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', 'This API key is not permitted to use the requested model or feature (403).', { status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new ProviderError('bad_request', 'Model or endpoint not found for this key (404).', { status: 404 });
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', 'Rate limited by Anthropic (429). Try again shortly.', { status: 429, retryable: true });
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message ?? '');
    if (/credit balance|billing|quota/i.test(msg)) return new ProviderError('quota', 'Anthropic reports insufficient credit or quota for this key.', { status: 400 });
    return new ProviderError('bad_request', `Anthropic rejected the request: ${msg.slice(0, 300)}`, { status: 400 });
  }
  if (err instanceof Anthropic.InternalServerError) return new ProviderError('server', `Anthropic server error (${err.status}).`, { status: err.status ?? 500, retryable: true });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'The request to Anthropic timed out.', { retryable: true });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'Could not reach Anthropic. Check your network connection.', { retryable: true });
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? null;
    if (status === 529) return new ProviderError('server', 'Anthropic is temporarily overloaded (529).', { status, retryable: true });
    return new ProviderError('unknown', `Anthropic API error ${status ?? ''}`.trim(), { status });
  }
  // Non-API errors here are local stream/parse failures (e.g. unparseable tool input).
  return new ProviderError('malformed', 'The model response could not be parsed.', { retryable: true });
}
