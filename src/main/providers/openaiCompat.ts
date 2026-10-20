import OpenAI, { toFile } from 'openai';
import type { ModelInfo, ProviderDiagnostic, ProviderId, ProviderStatus } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { nowIso } from '../util/errors';
import {
  ProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type StopReason,
  type StreamHandlers,
  type ToolCall,
} from './types';

type Kind = 'openai' | 'openrouter' | 'local';

export type ClientFactory = (opts: { apiKey: string; baseURL: string }) => OpenAI;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Chat Completions provider used for three configurations:
 *  - "openai": OpenAI's hosted API with the user's own key.
 *  - "openrouter": OpenRouter's OpenAI-compatible gateway with the user's own
 *              key; it forwards requests to the chosen model's vendor.
 *  - "local":  an OpenAI-compatible server on this computer (e.g. Ollama,
 *              LM Studio). Restricted to loopback addresses so "local" can
 *              never silently send data elsewhere.
 * Model capabilities are declared by the user in settings, not assumed.
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly description: string;
  readonly requiresApiKey: boolean;
  readonly remote: boolean;
  readonly supportsAudio: boolean;
  /**
   * Models that reject function tools together with their default reasoning on
   * Chat Completions (e.g. gpt-6-*): requests with tools send reasoning_effort
   * "none" for them, learned from OpenAI's 400 the first time.
   */
  private readonly noReasoningWithTools = new Set<string>();

  constructor(
    private readonly kind: Kind,
    private readonly getSettings: () => Settings,
    private readonly getKey: () => string | null,
    private readonly clientFactory: ClientFactory = ({ apiKey, baseURL }) => new OpenAI({ apiKey, baseURL, maxRetries: 2, timeout: 10 * 60 * 1000 }),
  ) {
    this.id = kind;
    this.label = LABEL[kind];
    this.description = DESCRIPTION[kind];
    this.requiresApiKey = kind !== 'local';
    this.remote = kind !== 'local';
    this.supportsAudio = kind === 'openai';
  }

  private cfg() {
    return this.getSettings().providers[this.kind];
  }

  destination(): string {
    try {
      const suffix = this.kind === 'local' ? ' (this computer)' : this.kind === 'openrouter' ? ' (OpenRouter → model vendor)' : ' (OpenAI)';
      return `${new URL(this.cfg().baseUrl).host}${suffix}`;
    } catch {
      return 'invalid URL';
    }
  }

  models(): ModelInfo[] {
    const c = this.cfg();
    if (!c.model) return [];
    return [
      {
        id: c.model,
        label: c.model,
        capabilities: { tools: c.supportsTools, vision: c.supportsVision, streaming: true, contextTokens: c.contextTokens, maxOutputTokens: c.maxOutputTokens },
      },
    ];
  }

  selectedModel(): string {
    return this.cfg().model;
  }

  status(): ProviderStatus {
    const c = this.cfg();
    if (this.kind === 'local' && !isLoopbackUrl(c.baseUrl)) {
      return { kind: 'error', reason: 'The local provider only accepts loopback addresses (127.0.0.1 / localhost).' };
    }
    if (this.kind !== 'local' && !c.baseUrl.startsWith('https://')) return { kind: 'error', reason: `The ${this.label} base URL must use https.` };
    if (this.requiresApiKey && !this.getKey()) return { kind: 'unconfigured', reason: `Add an ${this.label} API key in Settings → Providers.` };
    if (!c.model) return { kind: 'unconfigured', reason: 'Enter a model id in Settings → Providers.' };
    return { kind: 'ready' };
  }

  client(): OpenAI {
    const st = this.status();
    if (st.kind === 'error') throw new ProviderError('unconfigured', st.reason);
    const key = this.getKey();
    if (this.requiresApiKey && !key) throw new ProviderError('unconfigured', 'API key is not configured.');
    return this.clientFactory({ apiKey: key ?? 'not-required', baseURL: this.cfg().baseUrl });
  }

  async stream(req: ChatRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<ChatResult> {
    const client = this.client();
    const c = this.cfg();
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (m.role === 'user') {
        const toolResults = m.content.filter((b) => b.type === 'tool_result');
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: tr.callId, content: tr.content });
        }
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const b of m.content) {
          if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
          if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` } });
        }
        if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n\n') : parts });
      } else {
        const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        const calls = m.content.filter((b) => b.type === 'tool_call');
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((b) => {
                  const call = b as { id: string; name: string; input: unknown };
                  return { id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } };
                }),
              }
            : {}),
        });
      }
    }
    const tools: OpenAI.Chat.ChatCompletionTool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages,
      stream: true,
      // OpenRouter always reports usage in the final chunk and does not document stream_options.
      ...(this.kind === 'openrouter' ? {} : { stream_options: { include_usage: true } }),
      ...(this.kind === 'openai' ? { max_completion_tokens: Math.min(req.maxOutputTokens, c.maxOutputTokens) } : { max_tokens: Math.min(req.maxOutputTokens, c.maxOutputTokens) }),
      ...(tools.length ? { tools } : {}),
      ...(tools.length && this.noReasoningWithTools.has(req.model) ? { reasoning_effort: 'none' as const } : {}),
    };

    let text = '';
    let finish: string | null = null;
    let usage: ChatResult['usage'] = null;
    const partial = new Map<number, { id: string; name: string; args: string }>();
    try {
      let stream;
      try {
        stream = await client.chat.completions.create(body, { signal });
      } catch (err) {
        // "Function tools with reasoning_effort are not supported for <model> … set reasoning_effort to 'none'".
        const status = (err as { status?: number }).status;
        if (status !== 400 || !tools.length || body.reasoning_effort === 'none' || !/reasoning_effort/i.test(String((err as Error).message))) throw err;
        this.noReasoningWithTools.add(req.model);
        stream = await client.chat.completions.create({ ...body, reasoning_effort: 'none' }, { signal });
      }
      handlers.onPhase?.('generating');
      for await (const chunk of stream) {
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          handlers.onText(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = partial.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          partial.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      throw mapOpenAIError(err, signal, this.label);
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, p]) => {
        const id = p.id || `call_${i}`;
        try {
          return { id, name: p.name, input: p.args ? JSON.parse(p.args) : {} };
        } catch {
          return { id, name: p.name, input: null, parseError: 'Tool arguments were not valid JSON.' };
        }
      });
    const stopReason: StopReason =
      finish === 'tool_calls' || (toolCalls.length && finish === 'stop')
        ? 'tool_use'
        : finish === 'stop'
          ? 'end'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'content_filter'
              ? 'refusal'
              : 'other';
    return { text, toolCalls, stopReason, usage, model: req.model, native: undefined };
  }

  async diagnose(signal: AbortSignal): Promise<ProviderDiagnostic> {
    const started = Date.now();
    const base = { providerId: this.id, checkedAt: nowIso() } as const;
    const st = this.status();
    if (st.kind === 'error') return { ...base, ok: false, latencyMs: null, message: st.reason };
    if (this.requiresApiKey && !this.getKey()) return { ...base, ok: false, latencyMs: null, message: 'No API key configured.' };
    try {
      const client = this.client();
      // OpenRouter's model list is public, so verify the key separately (free, no tokens).
      let keyNote = '';
      if (this.kind === 'openrouter') {
        const info = await client.get<{ data?: OpenRouterKeyInfo }>('/key', { signal });
        keyNote = describeOpenRouterKey(info.data);
      }
      const list = await client.models.list({ signal });
      const ids: string[] = [];
      let selectedRaw: unknown = null;
      const model = this.selectedModel();
      for await (const m of list) {
        ids.push(m.id);
        if (m.id === model) selectedRaw = m;
        if (ids.length >= 2000) break;
      }
      const has = !model || ids.includes(model);
      const hint = selectedRaw ? describeReportedCapabilities(selectedRaw) : '';
      return {
        ...base,
        ok: !!model && has,
        latencyMs: Date.now() - started,
        message:
          keyNote +
          (!model ? `Connected (${ids.length} models listed). Choose a model id.` : has ? `Connected. ${model} is available.${hint}` : `Connected, but ${model} was not listed by the server.`),
        remoteModels: ids.slice(0, 200),
      };
    } catch (err) {
      return { ...base, ok: false, latencyMs: Date.now() - started, message: mapOpenAIError(err, signal, this.label).message };
    }
  }

  // -- audio (OpenAI only) -----------------------------------------------------

  async transcribe(audio: Uint8Array, mimeType: string, model: string, signal: AbortSignal, opts: { language?: string; prompt?: string } = {}): Promise<string> {
    if (this.kind !== 'openai') throw new ProviderError('unconfigured', 'Speech-to-text is only available through the OpenAI provider.');
    try {
      const ext = mimeType === 'audio/wav' ? 'wav' : mimeType === 'audio/ogg' ? 'ogg' : 'webm';
      const file = await toFile(Buffer.from(audio), `speech.${ext}`, { type: mimeType });
      const r = await this.client().audio.transcriptions.create({ file, model, ...(opts.language ? { language: opts.language } : {}), ...(opts.prompt ? { prompt: opts.prompt } : {}) }, { signal });
      return r.text ?? '';
    } catch (err) {
      throw mapOpenAIError(err, signal, this.label);
    }
  }

  async speak(text: string, model: string, voice: string, signal: AbortSignal): Promise<Uint8Array> {
    if (this.kind !== 'openai') throw new ProviderError('unconfigured', 'Cloud text-to-speech is only available through the OpenAI provider.');
    try {
      // gpt-4o voices take a speaking style; tts-1 models do not.
      const style = /^gpt-4o/i.test(model) ? { instructions: 'Speak like a warm, upbeat, friendly assistant: natural, smooth and lively, with a light smile in your voice.' } : {};
      const res = await this.client().audio.speech.create({ model, voice, input: text, response_format: 'mp3', ...style }, { signal });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw mapOpenAIError(err, signal, this.label);
    }
  }
}

const LABEL: Record<Kind, string> = { openai: 'OpenAI', openrouter: 'OpenRouter', local: 'Local model (OpenAI-compatible)' };
const DESCRIPTION: Record<Kind, string> = {
  openai: 'OpenAI models via the official Chat Completions API, using your own OpenAI API key. Also provides optional speech-to-text and text-to-speech.',
  openrouter:
    'Models from many vendors (OpenAI, Anthropic, Google, Meta and others) through OpenRouter’s OpenAI-compatible API, using your own OpenRouter key. Requests pass through OpenRouter to the chosen model’s vendor. No voice features.',
  local: 'A model server running on this computer (Ollama, LM Studio, llama.cpp server) that exposes an OpenAI-compatible API on a loopback address.',
};

interface OpenRouterKeyInfo {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  is_free_tier?: boolean;
}

export function describeOpenRouterKey(d: OpenRouterKeyInfo | undefined): string {
  if (!d) return 'Key accepted. ';
  const parts = ['Key accepted'];
  if (d.is_free_tier) parts.push('free tier');
  if (typeof d.limit_remaining === 'number') parts.push(`$${d.limit_remaining.toFixed(2)} of key limit remaining`);
  else if (d.limit === null) parts.push('no key spending limit');
  return `${parts.join(' · ')}. `;
}

/**
 * Reads what the server *reports* about a model (OpenRouter includes
 * supported_parameters and input modalities). Shown as a hint only — Keo still
 * uses the capabilities the user declares.
 */
export function describeReportedCapabilities(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as { supported_parameters?: unknown; architecture?: { input_modalities?: unknown }; context_length?: unknown };
  const params = Array.isArray(r.supported_parameters) ? (r.supported_parameters as unknown[]) : null;
  const inputs = Array.isArray(r.architecture?.input_modalities) ? (r.architecture?.input_modalities as unknown[]) : null;
  if (!params && !inputs) return '';
  const bits: string[] = [];
  if (params) bits.push(`tools ${params.includes('tools') ? 'yes' : 'no'}`);
  if (inputs) bits.push(`images ${inputs.includes('image') ? 'yes' : 'no'}`);
  if (typeof r.context_length === 'number') bits.push(`context ${r.context_length.toLocaleString('en-US')} tokens`);
  return ` The server reports: ${bits.join(', ')}. Set the toggles below to match.`;
}

export function mapOpenAIError(err: unknown, signal: AbortSignal | undefined, label: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted || err instanceof OpenAI.APIUserAbortError) return new ProviderError('cancelled', 'Request cancelled.');
  if (err instanceof OpenAI.AuthenticationError) return new ProviderError('auth', `${label} rejected the API key (401).`, { status: 401 });
  if (err instanceof OpenAI.PermissionDeniedError) return new ProviderError('auth', `${label} denied access to this model or feature (403).`, { status: 403 });
  if (err instanceof OpenAI.NotFoundError) return new ProviderError('bad_request', `${label}: model or endpoint not found (404).`, { status: 404 });
  if (err instanceof OpenAI.RateLimitError) {
    const quota = /quota|billing/i.test(String(err.message));
    return new ProviderError(quota ? 'quota' : 'rate_limit', quota ? `${label} reports the account quota is exhausted.` : `Rate limited by ${label} (429).`, {
      status: 429,
      retryable: !quota,
    });
  }
  if (err instanceof OpenAI.BadRequestError) return new ProviderError('bad_request', `${label} rejected the request: ${String(err.message).slice(0, 300)}`, { status: 400 });
  if (err instanceof OpenAI.InternalServerError) return new ProviderError('server', `${label} server error (${err.status}).`, { status: err.status ?? 500, retryable: true });
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError('timeout', `The request to ${label} timed out.`, { retryable: true });
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('network', `Could not reach ${label}. Is the server running and reachable?`, { retryable: true });
  if (err instanceof OpenAI.APIError) return new ProviderError('unknown', `${label} API error ${err.status ?? ''}`.trim(), { status: err.status ?? null });
  return new ProviderError('malformed', `${label} returned a response that could not be parsed.`);
}
