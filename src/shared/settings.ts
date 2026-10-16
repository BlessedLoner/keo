import { z } from 'zod';

/**
 * Versioned settings schema. Settings never contain secrets — API keys live in
 * the OS-encrypted secret store and are never sent to the renderer.
 */
export const SETTINGS_VERSION = 1;

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL');

const modelId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/@-]+$/, 'Invalid model id');

export const AnthropicSettings = z
  .object({
    model: modelId.default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    maxOutputTokens: z.number().int().min(256).max(128000).default(32000),
    refusalFallback: z.boolean().default(true),
  })
  .strict();

export const OpenAICompatSettings = z
  .object({
    baseUrl: httpUrl,
    model: z.string().trim().max(200).default(''),
    supportsTools: z.boolean().default(true),
    supportsVision: z.boolean().default(false),
    contextTokens: z.number().int().min(1024).max(2_000_000).default(128000),
    maxOutputTokens: z.number().int().min(256).max(128000).default(8192),
  })
  .strict();

export const AllowedApp = z
  .object({
    processName: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9 ._-]+$/),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export const LaunchableApp = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    label: z.string().trim().min(1).max(120),
    path: z.string().trim().min(3).max(400).regex(/\.exe$/i, 'Must be an .exe'),
  })
  .strict();

export const SettingsSchema = z
  .object({
    version: z.literal(SETTINGS_VERSION).default(SETTINGS_VERSION),
    activeProvider: z.enum(['anthropic', 'openai', 'openrouter', 'local', 'test']).nullable().default(null),
    providers: z
      .object({
        anthropic: AnthropicSettings.prefault({}),
        openai: OpenAICompatSettings.default({
          baseUrl: 'https://api.openai.com/v1',
          model: '',
          supportsTools: true,
          supportsVision: true,
          contextTokens: 128000,
          maxOutputTokens: 8192,
        }),
        openrouter: OpenAICompatSettings.default({
          baseUrl: 'https://openrouter.ai/api/v1',
          model: '',
          supportsTools: true,
          supportsVision: false,
          contextTokens: 128000,
          maxOutputTokens: 8192,
        }),
        local: OpenAICompatSettings.default({
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: '',
          supportsTools: false,
          supportsVision: false,
          contextTokens: 32000,
          maxOutputTokens: 4096,
        }),
      })
      .strict()
      .prefault({}),
    agent: z
      .object({
        toolsEnabled: z.boolean().default(true),
        maxToolIterations: z.number().int().min(1).max(20).default(8),
        contextMessageLimit: z.number().int().min(2).max(200).default(30),
        contextCharBudget: z.number().int().min(2000).max(400000).default(60000),
        memoryTopK: z.number().int().min(0).max(30).default(8),
        approvalWaitSeconds: z.number().int().min(10).max(1800).default(300),
      })
      .strict()
      .prefault({}),
    permissions: z
      .object({
        observationEnabled: z.boolean().default(false),
        desktopControlEnabled: z.boolean().default(false),
        launchEnabled: z.boolean().default(false),
        /** Send search queries to Brave Search with the user's key. */
        webSearchEnabled: z.boolean().default(false),
        /** Download public web pages as text (private networks always refused). */
        webFetchEnabled: z.boolean().default(false),
        allowedApps: z.array(AllowedApp).max(100).default([]),
        launchableApps: z.array(LaunchableApp).max(50).default([]),
        visionExport: z
          .object({
            anthropic: z.boolean().default(false),
            openai: z.boolean().default(false),
            openrouter: z.boolean().default(false),
            local: z.boolean().default(false),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    voice: z
      .object({
        sttProvider: z.enum(['none', 'openai']).default('none'),
        sttModel: modelId.default('gpt-4o-mini-transcribe'),
        ttsEngine: z.enum(['none', 'system', 'openai']).default('system'),
        systemVoice: z.string().max(200).default(''),
        openaiTtsModel: modelId.default('gpt-4o-mini-tts'),
        openaiTtsVoice: z.string().regex(/^[a-z]{2,20}$/).default('alloy'),
        speakResponses: z.boolean().default(false),
        /** Explicit consent to send recorded audio to the configured STT provider. */
        audioExportConsent: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    web: z
      .object({
        safesearch: z.enum(['off', 'moderate', 'strict']).default('moderate'),
        resultsPerSearch: z.number().int().min(1).max(20).default(8),
      })
      .strict()
      .prefault({}),
    memory: z
      .object({
        /**
         * from_user_words: when the model proposes a memory whose evidence is a
         * verified verbatim quote of the user, save it as confirmed (provenance
         * user_stated). ask: always leave proposals for the user to confirm.
         */
        learning: z.enum(['from_user_words', 'ask']).default('from_user_words'),
      })
      .strict()
      .prefault({}),
    wake: z
      .object({
        /** Off by default: listening is an explicit choice. Processing is local (Windows speech). */
        enabled: z.boolean().default(false),
        phrases: z
          .array(z.string().trim().min(6).max(40).regex(/^[\p{L}' -]+$/u, 'Letters only'))
          .min(1)
          .max(5)
          .default(['hey keo']),
        culture: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).default('en-US'),
        /** Minimum recognizer confidence for the wake phrase (higher = fewer false wakes). */
        sensitivity: z.number().min(0.5).max(0.98).default(0.82),
        /** How a spoken command is turned into text after the wake phrase. */
        commandRecognizer: z.enum(['local', 'openai']).default('local'),
      })
      .strict()
      .prefault({}),
    shortcuts: z
      .object({
        commandBarEnabled: z.boolean().default(true),
        /** Electron accelerator, e.g. "Control+K", "Control+Alt+K". */
        commandBar: z.string().trim().min(3).max(40).regex(/^((Control|Ctrl|Alt|Shift|Super|CommandOrControl)\+){1,3}([A-Z0-9]|F([1-9]|1[0-2])|Space)$/i, 'Invalid shortcut').default('Control+K'),
      })
      .strict()
      .prefault({}),
    companion: z
      .object({
        enabled: z.boolean().default(true),
        alwaysOnTop: z.boolean().default(true),
        x: z.number().int().nullable().default(null),
        y: z.number().int().nullable().default(null),
      })
      .strict()
      .prefault({}),
    commandBar: z
      .object({
        conversationId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).nullable().default(null),
      })
      .strict()
      .prefault({}),
    privacy: z
      .object({
        observationRetentionHours: z.number().int().min(0).max(24 * 30).default(24),
      })
      .strict()
      .prefault({}),
    ui: z
      .object({
        reducedMotion: z.enum(['system', 'reduce', 'full']).default('system'),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/** Deep partial patch accepted from the renderer; validated by re-parsing the merged result. */
export const SettingsPatch = z.record(z.string(), z.unknown());

export function mergeSettings(base: Settings, patch: Record<string, unknown>): Settings {
  const merged = deepMerge(base as unknown as Record<string, unknown>, patch);
  return SettingsSchema.parse(merged);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
