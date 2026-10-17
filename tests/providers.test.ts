import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, mapAnthropicError } from '../src/main/providers/anthropic';
import { mapOpenAIError, OpenAICompatProvider } from '../src/main/providers/openaiCompat';
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

describe('OpenRouter (no network)', () => {
  const withModel = mergeSettings(defaultSettings(), { activeProvider: 'openrouter', providers: { openrouter: { model: 'vendor/some-model' } } });

  function fakeOpenRouter(capture: { body?: Record<string, unknown>; baseURL?: string; paths: string[] }) {
    return ({ baseURL }: { apiKey: string; baseURL: string }) => {
      capture.baseURL = baseURL;
      return {
        get: async (path: string) => {
          capture.paths.push(path);
          return { data: { label: 'k', limit: 10, limit_remaining: 7.5, is_free_tier: false } };
        },
        models: {
          list: async () => [
            { id: 'other/model' },
            { id: 'vendor/some-model', supported_parameters: ['tools', 'max_tokens'], architecture: { input_modalities: ['text', 'image'] }, context_length: 200000 },
          ],
        },
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              capture.body = body;
              const chunks = [
                { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'memory__search', arguments: '{"query":' } }] }, finish_reason: null }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
              ];
              return (async function* () {
                for (const c of chunks) yield c;
              })();
            },
          },
        },
      } as unknown as OpenAI;
    };
  }

  it('is a separate, https-only provider that needs its own key', () => {
    const p = new OpenAICompatProvider('openrouter', () => withModel, () => null);
    expect(p.label).toBe('OpenRouter');
    expect(p.supportsAudio).toBe(false);
    expect(p.destination()).toContain('openrouter.ai');
    expect(p.status()).toEqual({ kind: 'unconfigured', reason: expect.stringContaining('OpenRouter API key') });
    const insecure = mergeSettings(withModel, { providers: { openrouter: { baseUrl: 'http://openrouter.ai/api/v1' } } });
    expect(new OpenAICompatProvider('openrouter', () => insecure, () => 'sk-or-v1-x').status().kind).toBe('error');
    expect(defaultSettings().permissions.visionExport.openrouter).toBe(false);
  });

  it('streams text, assembles tool calls and reports usage using max_tokens', async () => {
    const cap: { body?: Record<string, unknown>; baseURL?: string; paths: string[] } = { paths: [] };
    const p = new OpenAICompatProvider('openrouter', () => withModel, () => 'sk-or-v1-test', fakeOpenRouter(cap));
    const deltas: string[] = [];
    const r = await p.stream(
      { model: 'vendor/some-model', system: 's', maxOutputTokens: 4000, correlationId: 'c', tools: [{ name: 'memory__search', description: 'd', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { onText: (d) => deltas.push(d) },
      new AbortController().signal,
    );
    expect(cap.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(cap.body).toMatchObject({ model: 'vendor/some-model', stream: true, max_tokens: 4000 });
    expect(cap.body).not.toHaveProperty('max_completion_tokens');
    expect(cap.body).not.toHaveProperty('stream_options');
    expect(deltas.join('')).toBe('Hello');
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'memory__search', input: { query: 'x' } }]);
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('diagnostics verify the key and surface reported capabilities as hints', async () => {
    const cap: { paths: string[] } = { paths: [] };
    const p = new OpenAICompatProvider('openrouter', () => withModel, () => 'sk-or-v1-test', fakeOpenRouter(cap));
    const d = await p.diagnose(new AbortController().signal);
    expect(cap.paths).toEqual(['/key']);
    expect(d.ok).toBe(true);
    expect(d.message).toContain('Key accepted');
    expect(d.message).toContain('$7.50');
    expect(d.message).toContain('tools yes, images yes');
    // Hints never change the declared capabilities.
    expect(p.models()[0]?.capabilities.vision).toBe(false);
  });
});

describe('OpenAI-compatible adapter (no network)', () => {
  it('gpt-6 models: retries tool requests with reasoning_effort "none" when OpenAI requires it, and remembers', async () => {
    const st = mergeSettings(defaultSettings(), { activeProvider: 'openai', providers: { openai: { model: 'gpt-6-luna' } } });
    const bodies: Array<Record<string, unknown>> = [];
    const factory = () =>
      ({
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              bodies.push(body);
              if (body.tools && body.reasoning_effort !== 'none') {
                throw new OpenAI.BadRequestError(400, { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." }, undefined, new Headers());
              }
              return (async function* () {
                yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
              })();
            },
          },
        },
      }) as unknown as OpenAI;
    const p = new OpenAICompatProvider('openai', () => st, () => 'sk-test', factory);
    const req = (tools: boolean) => ({
      model: 'gpt-6-luna',
      system: 's',
      maxOutputTokens: 1000,
      correlationId: 'c',
      tools: tools ? [{ name: 'memory__search', description: 'd', inputSchema: { type: 'object' } }] : [],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    });
    const r1 = await p.stream(req(true), { onText: () => undefined }, new AbortController().signal);
    expect(r1.text).toBe('ok');
    expect(bodies.map((b) => b.reasoning_effort ?? null)).toEqual([null, 'none']);
    await p.stream(req(true), { onText: () => undefined }, new AbortController().signal);
    expect(bodies.at(-1)?.reasoning_effort).toBe('none'); // learned: no failing first attempt
    expect(bodies).toHaveLength(3);
    await p.stream(req(false), { onText: () => undefined }, new AbortController().signal);
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort'); // without tools the model keeps its reasoning
  });

  it('maps quota and rate limits distinctly', () => {
    const h = new Headers();
    expect(mapOpenAIError(new OpenAI.RateLimitError(429, { message: 'You exceeded your current quota' }, undefined, h), undefined, 'OpenAI').kind).toBe('quota');
    expect(mapOpenAIError(new OpenAI.RateLimitError(429, { message: 'Rate limit reached' }, undefined, h), undefined, 'OpenAI')).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapOpenAIError(new OpenAI.AuthenticationError(401, { message: 'nope' }, undefined, h), undefined, 'OpenAI').kind).toBe('auth');
  });
});
