# Keo

Keo is a personal AI agent for Windows: a desktop app that talks with you, remembers what you confirm, tracks your projects, and acts on your computer **only through registered capabilities and only with your approval**.

- **Conversation** — streaming replies, history, rename/delete/search, stop, retry, interruption recovery.
- **Memory** — source-attributed, versioned memory. The model can only *propose*; you confirm, correct, supersede or delete. Conflicts are flagged, never silently resolved.
- **Projects** — objectives, decisions, blockers, open questions and progress, each marked with who stated it.
- **Capabilities** — a typed registry (16 built-ins) with strict schemas, risk levels, timeouts and audit records.
- **Tasks** — a validated lifecycle with approvals bound to exact inputs, dependencies, cancellation, bounded retries, execution receipts, honest *outcome uncertain* states and safe restart recovery.
- **Desktop & vision (Windows)** — allow-listed windows only; focus/move/type/keys/click/launch with per-action approval; single-window capture with provenance and no full-screen fallback.
- **Voice** — push-to-talk speech input (OpenAI transcription, opt-in) and spoken replies (local Windows voices or OpenAI voices).
- **Identity** — an original animated emblem whose state follows real events (idle, listening, thinking, speaking, working, needs-approval, error), with reduced-motion support.

See [docs/SECURITY.md](docs/SECURITY.md) for boundaries and [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md) for what is verified versus what needs your credentials.

## Requirements

- Windows 10/11 x64
- Node.js ≥ 22.12 (developed with Node 24.6, npm 11.5)
- No native build tools: storage uses Node's built-in `node:sqlite`, which Electron 44 ships.

## Setup

```bash
npm install
```

If `npm install` could not download the Electron binary (e.g. behind a proxy), run `node node_modules/electron/install.js`.

## Run in the isolated development profile

```bash
npm run dev
```

Unpackaged runs use `%APPDATA%\Keo\dev`. Packaged builds use `%APPDATA%\Keo\default`. Use a throwaway directory with:

```bash
set KEO_USER_DATA_DIR=C:\Temp\keo-scratch && npm run dev
```

To try the UI without any provider account, enable the **deterministic test provider** (scripted, offline, clearly labelled as *not an AI model*):

```bash
set KEO_ENABLE_TEST_PROVIDER=1 && npm run dev
```

With the test provider, `/tool <capability.id> {json}` makes it propose exactly that tool call, which is useful for exercising approvals.

## Configure a model provider

Open **Settings → Providers** (or click the provider chip in the title bar):

1. **Anthropic (Claude)** — paste an API key from the Anthropic Console, pick a model (default `claude-opus-5-5`), choose effort, click **Use for chat**, then **Test connection** (it lists models; no tokens are generated). Server-side refusal fallback is on by default and can be turned off on the same card.
2. **OpenAI** — paste a key, enter a model id (Test connection lists the ids your account offers), declare whether it supports tools and images.
3. **Local model** — any OpenAI-compatible server on `127.0.0.1`/`localhost` (Ollama: `http://127.0.0.1:11434/v1`). Non-loopback URLs are refused.

Keys are encrypted with Windows DPAPI (Electron `safeStorage`) and never shown again or logged. Keo does not reuse any other application's credentials.

## Enabling computer interaction

Everything is off by default. In **Access**:

1. Turn on *Window observation*, then in **Vision** use *Show all windows → Allow this app* for each application Keo may work with.
2. Optionally turn on *Desktop control* (focus, move, type, keys, click) and/or *Application launch* (register executables with *Add application…*).
3. To let the model look at a window, enable *Screen-content export* for the provider that should receive screenshots.

Every action shows a preview (target, operation, consequences, data leaving the PC) and needs **Approve once** — in the chat or in **Tasks**.

## Voice

**Settings → Voice**: choose OpenAI transcription and tick the consent box to enable the microphone button (hold to talk, or click to start/stop). Spoken replies can use local Windows voices (offline) or OpenAI voices.

## Checks

```bash
npm run typecheck   # tsc for main/preload/shared and renderer
npm run lint        # ESLint (incl. bans on dangerouslySetInnerHTML/eval and Node imports in the renderer)
npm test            # Vitest: unit + integration with fake providers/desktop (no network, no real input)
npm run build       # production bundles (electron-vite)
npm run smoke       # builds, then launches the real app twice in a disposable profile
npm run check       # typecheck + lint + test + build
```

## Package for Windows

```bash
npm run package:dir   # unpacked app in release/win-unpacked (quick validation)
npm run package:win   # NSIS installer release/Keo-Setup-<version>.exe
```

Nothing is published (`--publish never`, no publish provider). Builds are unsigned unless you add a code-signing certificate.

## Layout

```
src/shared/        domain types, settings schema, IPC contract (Zod), channel allow-list
src/preload/       sandboxed bridge (only `invoke` + `on`)
src/main/
  index.ts         Electron bootstrap: profile, app:// protocol, CSP, permissions, window
  services.ts      composition root (also used by integration tests)
  db/              node:sqlite wrapper + append-only migrations
  repos/           conversations, memory, projects, tasks, audit, observations
  providers/       Anthropic, OpenAI-compatible (OpenAI/local), deterministic test provider
  agent/           system prompt, bounded context builder, tool-call loop
  capabilities/    registry/admission gateway + built-in capabilities
  tasks/           state machine + orchestrator
  desktop/         Win32 helper (fixed PowerShell script) + identity validation
  vision/          capture pipeline, provenance, retention
  voice/           speech-to-text / text-to-speech services
  ipc/             handlers + validated router
src/renderer/      React UI, design system, animated emblem
tests/             Vitest suites
scripts/           smoke check, icon renderer
docs/              security boundaries, implementation report
```
