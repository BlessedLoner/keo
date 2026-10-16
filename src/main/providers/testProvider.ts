import type { ModelInfo, ProviderDiagnostic, ProviderStatus } from '../../shared/domain';
import { nowIso } from '../util/errors';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type StreamHandlers } from './types';

export type Script = (req: ChatRequest, call: number) => ChatResult | Promise<ChatResult>;

/**
 * Deterministic, offline test double. It is NOT a language model: it is only
 * registered when KEO_ENABLE_TEST_PROVIDER=1 (automated checks, development)
 * and is labelled as a test provider everywhere in the UI.
 *
 * Default behaviour:
 *  - "/tool <capability_id> <json>" -> proposes exactly that tool call
 *  - anything else -> a fixed acknowledgement describing what it received
 */
export class TestProvider implements ChatProvider {
  readonly id = 'test' as const;
  readonly label = 'Deterministic test provider';
  readonly description = 'Offline scripted responses for automated checks. Not an AI model; never use for real work.';
  readonly requiresApiKey = false;
  readonly remote = false;
  readonly supportsAudio = false;
  calls = 0;
  lastRequest: ChatRequest | null = null;

  constructor(
    private script: Script | null = null,
    private readonly delayMs = 0,
  ) {}

  setScript(s: Script | null): void {
    this.script = s;
    this.calls = 0;
  }

  destination(): string {
    return 'none (runs inside Keo)';
  }

  models(): ModelInfo[] {
    return [{ id: 'keo-test-1', label: 'keo-test-1', capabilities: { tools: true, vision: true, streaming: true, contextTokens: 200_000, maxOutputTokens: 8192 } }];
  }

  selectedModel(): string {
    return 'keo-test-1';
  }

  status(): ProviderStatus {
    return { kind: 'ready' };
  }

  async stream(req: ChatRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<ChatResult> {
    this.lastRequest = req;
    const n = this.calls++;
    const result = this.script ? await this.script(req, n) : defaultScript(req, n);
    handlers.onPhase?.('generating');
    // Emit in small chunks so streaming paths are exercised.
    for (let i = 0; i < result.text.length; i += 12) {
      if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      handlers.onText(result.text.slice(i, i + 12));
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
    return result;
  }

  async diagnose(): Promise<ProviderDiagnostic> {
    return { providerId: 'test', ok: true, checkedAt: nowIso(), latencyMs: 0, message: 'Test provider is always available (offline, scripted).' };
  }
}

function lastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== 'user') continue;
    const texts = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    if (texts.length) return texts[texts.length - 1] ?? '';
  }
  return '';
}

function defaultScript(req: ChatRequest, call: number): ChatResult {
  const last = req.messages[req.messages.length - 1];
  const hasToolResult = last?.content.some((b) => b.type === 'tool_result');
  const text = lastUserText(req);
  const m = /^\/tool\s+([a-z_.]+)\s*(\{[\s\S]*\})?\s*$/.exec(text.trim());
  if (m && !hasToolResult) {
    let input: unknown;
    try {
      input = m[2] ? JSON.parse(m[2]) : {};
    } catch {
      input = null;
    }
    return {
      text: '',
      toolCalls: [{ id: `toolu_test_${call}`, name: (m[1] ?? '').replace(/\./g, '__'), input }],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'keo-test-1',
      native: undefined,
    };
  }
  if (hasToolResult) {
    const tr = last?.content.find((b) => b.type === 'tool_result') as { content: string; isError: boolean } | undefined;
    return {
      text: `[test provider] Tool ${tr?.isError ? 'returned an error' : 'returned a result'}: ${(tr?.content ?? '').slice(0, 400)}`,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'keo-test-1',
      native: undefined,
    };
  }
  return {
    text: `[test provider] Received ${text.length} characters. This is a deterministic offline response, not a model answer.`,
    toolCalls: [],
    stopReason: 'end',
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'keo-test-1',
    native: undefined,
  };
}
