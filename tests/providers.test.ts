import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, mapAnthropicError } from '../src/main/providers/anthropic';
import { mapOpenAIError } from '../src/main/providers/openaiCompat';
import { defaultSettings, mergeSettings } from '../src/shared/settings';

/** Minimal stand-in for the SDK's MessageStream: async-iterable events + finalMessage(). */
function fakeClient(capture: { params?: Record<string, unknown> }, message: Record<string, unknown>) {
  return {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          capture.params = params;
          const events = [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } },
          ];
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as Anthropic;
}

describe('Anthropic adapter (no network)', () => {
  const settings = mergeSettings(defaultSettings(), { activeProvider: 'anthropic' });

  it('requires a key and reports an honest unconfigured status', () => {
    const p = new AnthropicProvider(() => settings, () => null);
    expect(p.status()).toEqual({ kind: 'unconfigured', reason: expect.stringContaining('API key') });
  });

  it('builds a streaming request with effort, tools and refusal fallback; echoes native content', async () => {
    const cap: { params?: Record<string, unknown> } = {};
    const native = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Hi there' },
      { type: 'tool_use', id: 'toolu_1', name: 'memory__search', input: { query: 'x' } },
    ];
    const p = new AnthropicProvider(() => settings, () => 'sk-ant-test', () =>
      fakeClient(cap, { model: 'claude-opus-5-5', content: native, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } }),
    );
    const deltas: string[] = [];
    const phases: string[] = [];
    const r = await p.stream(
      {
        model: 'claude-opus-5-5',
        system: 'sys',
        maxOutputTokens: 1000,
        correlationId: 'c',
        tools: [{ name: 'memory__search', description: 'd', inputSchema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      },
      { onText: (d) => deltas.push(d), onPhase: (ph) => phases.push(ph) },
      new AbortController().signal,
    );
    expect(deltas.join('')).toBe('Hi there');
    expect(phases).toEqual(['thinking', 'generating']);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'memory__search', input: { query: 'x' } }]);
    expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 4 });
    const params = cap.params!;
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.thinking).toBeUndefined();
    expect((params.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'memory__search', eager_input_streaming: true });

    // Second turn: the assistant's native content (incl. thinking) must be echoed unchanged.
    await p.stream(
      {
        model: 'claude-opus-5-5',
        system: 'sys',
        maxOutputTokens: 1000,
        correlationId: 'c',
        tools: [],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ignored' }], native: r.native },
          { role: 'user', content: [{ type: 'tool_result', callId: 'toolu_1', content: '{}', isError: false }] },
        ],
      },
      { onText: () => undefined },
      new AbortController().signal,
    );
    const msgs = cap.params!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]!.content).toEqual(native);
    expect(msgs[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}', is_error: false }]);
  });

  it('maps SDK errors to typed, user-safe provider errors', () => {
    const headers = new Headers();
    expect(mapAnthropicError(new Anthropic.AuthenticationError(401, { message: 'bad key' }, undefined, headers)).kind).toBe('auth');
    expect(mapAnthropicError(new Anthropic.RateLimitError(429, { message: 'slow down' }, undefined, headers))).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapAnthropicError(new Anthropic.BadRequestError(400, { message: 'Your credit balance is too low' }, undefined, headers)).kind).toBe('quota');
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'down' })).kind).toBe('network');
    const aborted = new AbortController();
    aborted.abort();
    expect(mapAnthropicError(new Error('x'), aborted.signal).kind).toBe('cancelled');
    expect(mapAnthropicError(new SyntaxError('Unexpected token')).kind).toBe('malformed');
  });
});

describe('OpenAI-compatible adapter (no network)', () => {
  it('maps quota and rate limits distinctly', () => {
    const h = new Headers();
    expect(mapOpenAIError(new OpenAI.RateLimitError(429, { message: 'You exceeded your current quota' }, undefined, h), undefined, 'OpenAI').kind).toBe('quota');
    expect(mapOpenAIError(new OpenAI.RateLimitError(429, { message: 'Rate limit reached' }, undefined, h), undefined, 'OpenAI')).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapOpenAIError(new OpenAI.AuthenticationError(401, { message: 'nope' }, undefined, h), undefined, 'OpenAI').kind).toBe('auth');
  });
});
