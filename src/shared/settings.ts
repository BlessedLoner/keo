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

const Accelerator = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^((Control|Ctrl|Alt|Shift|Super|CommandOrControl)\+){1,3}([A-Z0-9]|F([1-9]|1[0-2])|Space)$/i, 'Invalid shortcut');

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
    /** Desktop apps: the .exe chosen in the file picker or from the installed-apps list. */
    path: z.string().trim().min(3).max(400).regex(/\.exe$/i, 'Must be an .exe').optional(),
    /** Microsoft Store and other registered apps: their Windows app id (started through Windows). */
    appId: z.string().trim().min(1).max(300).regex(/^[\w.{}\\:~ !-]+$/).optional(),
  })
  .strict()
  .refine((a) => !!a.path || !!a.appId, 'Give a path or an app id.');

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
        /**
         * How the user's own voice comes out of the Windows recognizer when they
         * say the wake phrase ("Teach Keo your voice"), accepted as the phrase.
         */
        learned: z.array(z.string().trim().min(4).max(40)).max(20).default([]),
        /** Speech engine: the modern Windows 10/11 recognizer (better with accents), or the classic one. */
        engine: z.enum(['auto', 'modern', 'classic', 'porcupine']).default('auto'),
        /** Trained wake word (Picovoice Porcupine, on this PC): a .ppn model file or a built-in keyword. The access key is kept with the other keys. */
        porcupine: z
          .object({
            keywordPath: z.string().trim().max(400).nullable().default(null),
            builtin: z.enum(['jarvis', 'computer', 'hey siri', 'alexa', 'hey google', 'ok google', 'picovoice', 'porcupine', 'bumblebee', 'terminator']).nullable().default(null),
            sensitivity: z.number().min(0).max(1).default(0.6),
          })
          .strict()
          .prefault({}),
        /** How a spoken command is turned into text after the wake phrase. */
        commandRecognizer: z.enum(['local', 'openai']).default('local'),
      })
      .strict()
      .prefault({}),
    /** Project id → workspace folder the user chose with the folder picker. */
    projectWorkspaces: z.record(z.string().regex(/^[\w-]{1,80}$/), z.string().min(3).max(400)).default({}),
    shortcuts: z
      .object({
        commandBarEnabled: z.boolean().default(true),
        /** Mini-chat (command bar). Electron accelerator, e.g. "Control+Shift+K". */
        commandBar: Accelerator.default('Control+Shift+K'),
        /** Talk to Keo (starts or stops a voice conversation). */
        voiceEnabled: z.boolean().default(true),
        voice: Accelerator.default('Control+K'),
        /** One-time move of the mini-chat from the old default Ctrl+K to Ctrl+Shift+K (Ctrl+K is voice now). */
        layoutV2: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    /**
     * How much Keo may do without asking. Whatever the level, payments,
     * purchases, deleting, sensitive buttons, raw clicks and messaging someone
     * the user did not name always ask (see capability autonomy tiers).
     */
    autonomy: z
      .object({
        level: z.enum(['always_ask', 'important_only', 'hands_free']).default('always_ask'),
      })
      .strict()
      .prefault({}),
    /** Defaults and limits for live WhatsApp chat sessions. */
    /** Which task events show a Windows notification (only while Keo's window is not in front). */
    notifications: z
      .object({
        approvals: z.boolean().default(true),
        finished: z.boolean().default(true),
        failed: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    liveChat: z
      .object({
        maxMinutes: z.number().int().min(5).max(720).default(120),
        maxReplies: z.number().int().min(1).max(300).default(40),
        /** End a session after this long without any new message. */
        quietMinutes: z.number().int().min(5).max(240).default(30),
        /** "Idle" = no keyboard/mouse input for this long. */
        idleSeconds: z.number().int().min(0).max(60).default(4),
        /**
         * When a reply is ready while the user is busy: 'ask' = show it with
         * Send now (and send when they pause), 'when_idle' = send when they
         * pause, 'immediately' = send at once (Keo takes the screen briefly).
         */
        sendMode: z.enum(['ask', 'when_idle', 'immediately']).default('ask'),
        /** Extra words/phrases that always make Keo pause and ask (besides the built-in topics). */
        attentionTopics: z.array(z.string().trim().min(2).max(60)).max(40).default([]),
        /** Show a Windows notification when a contact needs the user. */
        notify: z.boolean().default(true),
        /** Say it out loud (when spoken replies are enabled). */
        speak: z.boolean().default(true),
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
    /** Ask GitHub once a day whether a newer Keo is out (nothing else is sent). */
    updates: z
      .object({
        check: z.boolean().default(true),
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
        /** The first-run welcome has been completed or skipped. */
        onboarded: z.boolean().default(false),
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
