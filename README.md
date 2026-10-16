# Keo

Keo is a personal AI agent for Windows: a desktop app that talks with you, remembers what you confirm, tracks your projects, and acts on your computer **only through registered capabilities and only with your approval**.

- **Conversation** — streaming replies, history, rename/delete/search, stop, retry, interruption recovery.
- **Memory** — source-attributed, versioned memory. Keo learns durable facts you tell it in chat (your name, where you live, work, people, preferences) and saves them automatically **only when it can quote your own words**; anything else waits for your confirmation. You can correct, supersede or delete everything; conflicts are flagged, never silently resolved.
- **Research** — web search through Brave Search and reading of public web pages, with cited sources (opt-in).
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
3. **OpenRouter** — paste your OpenRouter key, enter a model id in `vendor/model` form from openrouter.ai/models, click **Use for chat**, then **Test connection**. It checks the key (free, shows remaining key credit when a limit is set) and reports whether OpenRouter says the model supports tools and images; set the two toggles to match. Requests go through OpenRouter to that model’s vendor. OpenRouter is chat-only in Keo — voice features need an OpenAI key.
4. **Local model** — any OpenAI-compatible server on `127.0.0.1`/`localhost` (Ollama: `http://127.0.0.1:11434/v1`). Non-loopback URLs are refused.

Keys are encrypted with Windows DPAPI (Electron `safeStorage`) and never shown again or logged. Keo does not reuse any other application's credentials.

## Web research (Brave Search)

1. **Settings → Web search**: paste your Brave Search API key (stored encrypted). *Test search* runs one real query.
2. **Access → Web research**: turn on *Web search* and, for deeper research, *Read web pages*.

Keo then searches and reads pages on its own when you ask for research or current information, and cites the URLs it used. Page reading refuses anything on your computer or local network.

## Memory learning

**Settings → Agent → Memory learning** chooses between *remember what I tell Keo about myself automatically* (default) and *ask me first*. Learned items show as “Learned from your words in chat” in **Memory**, with the quoted sentence and a link to the conversation. Your name and other `user.*` facts are included in every reply's context.

## Enabling computer interaction

Everything is off by default. In **Access**:

1. Turn on *Window observation*, then in **Vision** use *Show all windows → Allow this app* for each application Keo may work with.
2. Optionally turn on *Desktop control* (focus, move, type, keys, click) and/or *Application launch* (register executables with *Add application…*).
3. To let the model look at a window, enable *Screen-content export* for the provider that should receive screenshots.

Every action shows a preview (target, operation, consequences, data leaving the PC) and needs **Approve once** — in the chat or in **Tasks**. Typing, key presses and clicks bring their target window to the front themselves after you approve (approving happens in Keo's window), and send nothing if Windows refuses the switch.

Long or multi-line text is **pasted** through the clipboard (exact and instant; your previous clipboard text is restored); short text is typed in small chunks. Afterwards Keo reads the window's text back (Windows UI Automation) and only marks the step *verified* if your text is really there. If the model ever *says* it did something on your computer without actually running a capability, Keo flags it in the reply, asks the model once to really do it or correct itself, and tells you if nothing was done.

Quick start for Notepad: **Access → Launchable applications → + Notepad** registers Notepad, allows its windows and turns on launching. Then ask Keo to open Notepad and write something.

## Working inside applications (UI Automation)

With observation and control on, Keo works **observe → act → verify**:

- `desktop.inspect_window` reads an allowed window's controls (buttons, tabs, fields, lists, dialogs) through Windows UI Automation and gives each one a short id. Password fields are listed but their contents are never read.
- `desktop.invoke_element` (click/select/toggle/expand), `desktop.set_text` (replace a field's text, read back to verify) and `desktop.scroll` act on an element from a **recent** observation (≤ 2 minutes). Right before acting, Keo re-reads that element and refuses — sending nothing — if it vanished, changed its name/role, or became disabled.
- After each action Keo reports what it saw (state changed, control gone, new dialog/window) and stops at any new dialog to ask you.

**Navigation grants.** Approving every click while browsing an app's menus is tedious, so an approval card for a safe navigation step also offers **Approve + allow navigation (10 min)**. That lets Keo inspect, click, scroll and switch sections *in that one window* for up to 10 minutes / 40 actions. Grants live in memory only, show in **Tasks**, are revoked by **Stop** (title bar or companion) and never cover sensitive controls (send, delete, submit, pay, buy, save, upload, sign in, …) or typing — those always ask.

## Browser and screen context

`browser.read_page` reads the active tab of an allowed browser (Chrome, Edge, Brave, Firefox, Opera, Vivaldi, Arc): its address, title, your **selected text** and the visible page text — so “summarize this page”, “explain what I selected” and “compare this with …” work without copying. It uses UI Automation (no extension, no access to cookies or other tabs). Page text is marked untrusted: instructions inside a page never authorize anything. Product research combines the page with Brave Search results and cites sources; prices and availability are stated only when a source shows them, with the date read.

## WhatsApp (desktop app or WhatsApp Web)

Allow WhatsApp (or your browser for WhatsApp Web) in **Access**. Then:

- `whatsapp.open_chat` searches your chats and opens one **only if exactly one name matches**; otherwise it lists the candidates and Keo asks you which one.
- `whatsapp.read_chat` reads the visible messages of the open chat (who wrote what, delivery state) for summaries and reply drafts.
- `whatsapp.send_message` **always needs your approval for that exact text and contact** (never covered by a grant). Before pressing Send, Keo re-checks that the open chat is the right contact and that the draft is exactly the approved text; afterwards it confirms the message appears as your latest one. If it can't confirm, the step is marked *outcome uncertain* and is **not retried automatically** (to avoid double-sends); sending the same text again as your latest message is refused unless you ask for a duplicate.

There is no background or ongoing auto-replying: every message is drafted, shown and approved by you. Keo has no official WhatsApp API (none exists for personal accounts); it works through the visible app like you do, so a WhatsApp redesign can make it report “couldn't find the search box” until the adapter is updated.

## Approval levels

**Settings → Approvals & live chat** sets how much Keo may do without asking:

- **Always ask** (default) — every action that changes something waits for *Approve*.
- **Ask only for important things** — looking around, opening chats, switching tabs/menus, scrolling and reading run on their own; typing, sending, launching apps and other buttons ask.
- **Hands-free** — for voice use: Keo carries out what you asked without stopping at each step, including sending messages to people **you named yourself** in the conversation.

At every level these still ask: payments and purchases, deleting, buttons like Send/Delete/Buy/Confirm, keys like Enter/Delete, clicks on raw screen positions, and messaging anyone you did not name. Keo never types passwords. Automatic approvals are recorded in the audit log (`approved_by_policy`). When a level other than *Always ask* is on, a chip in the title bar shows it — one click returns to *Always ask*.

## Live chats (WhatsApp)

Ask e.g. *“chat with Ma Glo on WhatsApp until I say stop, and tell me if she needs me”* or *“reply to John’s message and keep the conversation going”*. You approve once (contact, goal, limits); Keo then:

- watches that chat and replies in your voice, using only what you told it;
- **pauses and asks you** about money and prices, payments, meetings and times, calls and files, personal or urgent matters, “are you a bot?” (Keo never denies being an assistant), your own extra topics, or whenever it is unsure — you get a Windows notification, the companion shows it, and Keo says it out loud if spoken replies are on;
- continues when you answer by typing or voice (*“tell her it’s $50 each, I can give a discount”*) — or in **Tasks → Live chats**, which also shows the conversation and has Pause / Resume / Stop;
- types only after you have been idle for a few seconds, then gives your previous window back;
- ends on **stop** (say it, the title-bar/companion *Stop*, or Tasks), after the time limit (default 2 h), the reply limit (default 40), or 30 quiet minutes.

The contact's messages are untrusted: they can only ever lead to a reply in that chat or a question for you — never to any other action, and an “answer” is accepted only in your own words. Keep WhatsApp visible (a second monitor is ideal); when it is covered or minimised Keo checks it only while you are idle. Up to 3 live chats can run at once.

## Voice, wake word, command bar and companion

**Settings → Voice & shortcuts**

- **Wake word** (off by default): uses the Windows speech recognizer on this PC. Default phrase “hey keo”; add your own (2–4 words) and press *Test* to check Windows understands it. Audio stays local; speech that isn't a wake phrase is discarded. Listening pauses while Keo speaks; mute any time with the mic chip in the title bar or the companion. After the wake phrase, your command is understood by Windows speech (offline) or OpenAI transcription (if configured and consented).
- **Command bar shortcut**: Ctrl+K by default opens a small command bar over any app (Enter to send, Esc to close). A global shortcut takes that key away from other apps while Keo runs (Ctrl+K is used by browsers, VS Code, Slack), so you can change it (Ctrl+Alt+K, Ctrl+Shift+Space, …) or turn it off; if another app already holds it, Settings says so.
- **Floating companion**: a small emblem that always shows what Keo is really doing — idle, listening, understanding, planning, acting, verifying, waiting for your approval, speaking, cancelled, error — with the current step (e.g. “Pressing ‘Settings’ · WhatsApp”). It never takes keyboard focus. Hover for controls: open Keo, Stop everything, mute, command bar. Drag to move (position is remembered and kept on screen when monitors change). Respects *reduced motion*.

Push-to-talk in the chat (OpenAI transcription with consent) and spoken replies (Windows voices offline, or OpenAI voices) work as before.

## Checks

```bash
npm run typecheck   # tsc for main/preload/shared and renderer
npm run lint        # ESLint (incl. bans on dangerouslySetInnerHTML/eval and Node imports in the renderer)
npm test            # Vitest: unit + integration with fake providers/desktop (no network, no real input)
npm run build       # production bundles (electron-vite)
npm run smoke       # builds, then launches the real app twice in a disposable profile (incl. companion/command bar/shortcut lifecycle)
npm run e2e:desktop # builds, then drives a disposable WhatsApp-like test app through real UI Automation, incl. a live chat (moves/clicks inside that test window only; offline test provider)
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
