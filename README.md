# Keo

**[Download Keo for Windows](https://blessedloner.github.io/keo/)** · free beta · Windows 10/11 (64-bit) · no account needed — bring your own AI key (OpenRouter, OpenAI, Anthropic) or use a local model. Run `Keo-Setup-<version>.exe`; this beta is not code-signed, so choose *More info → Run anyway* when Windows warns. A short welcome guides the setup. Installed copies **update themselves**: new versions download in the background and install when Keo closes (or click *Restart to update*); turn this off in *Settings → Privacy & data*. [Privacy note](https://blessedloner.github.io/keo/privacy.html)

Keo is a personal AI agent for Windows: a desktop app that talks with you, remembers what you confirm, tracks your projects, and acts on your computer **only through registered capabilities and only with your approval**.

- **Conversation** — streaming replies, history, rename/delete/search, stop, retry, interruption recovery.
- **Memory** — source-attributed, versioned memory. Keo learns durable facts you tell it in chat (your name, where you live, work, people, preferences) and saves them automatically **only when it can quote your own words**; anything else waits for your confirmation. You can correct, supersede or delete everything; conflicts are flagged, never silently resolved.
- **Research** — web search (Brave Search with your key, or DuckDuckGo with no key) and reading of public web pages, with cited sources (opt-in).
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
node node_modules/electron/install.js
```

Electron 44 does not download its runtime during `npm install`; the second command fetches it (needed for `npm run dev`, the checks and packaging).

### Testing the latest code on a second PC

You don't need to build an installer to try changes on another computer: clone the repository there (or `git pull` to update), run the two setup commands above, then `npm run dev`. A source run keeps its own settings in `%APPDATA%\Keo\dev`, separate from an installed Keo. If something works on one PC but not the other, open *Settings → Check & help → Run the check* on both and compare (or *Copy diagnostic report* — it contains versions, display scaling, which switches are on and error codes, never keys, chats or window titles).

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

## Web research

1. **Settings → Web search**: *Automatic* (the default) uses Brave Search when you have stored a key (encrypted) and DuckDuckGo's plain results page otherwise — no key or account needed. You can also pick *Brave Search only* or *DuckDuckGo*. *Test search* runs one real query.
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

The **WhatsApp app** (Microsoft Store) hosts WhatsApp Web inside WinUI 3 + WebView2 without a child window; the classic .NET UI Automation reader sees it as an empty frame. Keo reads such windows with the modern UI Automation client in a separate helper process (verified on the WhatsApp app 2.2640: search, chat list, header and message box recognised; opening a chat verified). If both the app and WhatsApp Web are open, Keo asks which one. Files can be sent with a caption (`whatsapp.send_file`): only a file whose full path you wrote, never programs or scripts, always with a click approval.


Allow WhatsApp (or your browser for WhatsApp Web) in **Access**. Then:

- `whatsapp.open_chat` searches your chats and opens one **only if exactly one name matches**; otherwise it lists the candidates and Keo asks you which one.
- `whatsapp.read_chat` reads the visible messages of the open chat (who wrote what, delivery state) for summaries and reply drafts.
- `whatsapp.send_message` **always needs your approval for that exact text and contact** (never covered by a grant). Before pressing Send, Keo re-checks that the open chat is the right contact and that the draft is exactly the approved text; afterwards it confirms the message appears as your latest one. If it can't confirm, the step is marked *outcome uncertain* and is **not retried automatically** (to avoid double-sends); sending the same text again as your latest message is refused unless you ask for a duplicate.

There is no background or ongoing auto-replying: every message is drafted, shown and approved by you. Keo has no official WhatsApp API (none exists for personal accounts); it works through the visible app like you do, so a WhatsApp redesign can make it report “couldn't find the search box” until the adapter is updated.

## Apps and browser profiles

- **Open apps by name**, including Microsoft Store apps (Calculator, WhatsApp, Settings…): Keo uses Windows' own list of startable apps (`Get-StartApps`: names and app ids) and starts them through `explorer.exe shell:AppsFolder\<app id>` — no executable paths to register. If a window of the app is already open, Keo switches to it. If several apps match ("WhatsApp" and "WhatsApp Web"), Keo asks which one. Opening needs your OK (by click or "yes"); typing or clicking inside an app still needs it in the allowed apps. Requires *Access → Launch applications*.
- **Browser profiles** (Chrome, Edge, Brave): Keo reads only the profile names from the browser's profile list and opens a web address or search in a **new tab** of the profile you choose — your open tabs are not touched. With several profiles Keo asks which one (also when two profiles share a name) and continues the original request after your answer.

## Research, projects and workflows

- **Product research cards**: after reading product pages, Keo can show comparison cards (image, price, merchant, specs, pros/cons, source). Price, merchant and image come from the pages Keo actually fetched — never from the model alone; images are downloaded and shrunk by Keo.
- **Keo mode**: say or type “open Keo mode” (or use the floating Keo) for a full-screen, animated Keo you can just talk to; “close Keo mode” or Esc leaves. Settings → Appearance can also open it with the wake word.
- **Looks**: Noir (black and white, the default) or Classic (dark blue) in Settings → Appearance.
- **Keo's pencil**: press the pencil on the floating icon (or Ctrl+Alt+P), circle or mark anything on your screen and say or type what you want (“what is this?”, “make this bold”, “explain this chart”). Keo sees exactly what you marked and answers — aloud if you spoke, continuing the voice conversation.
- **Research results window**: when a comparison is ready Keo opens a small animated window beside your work with the pictures, prices, sellers and specs (Settings key `research.showWindow`). From there — or by saying “save it as a PDF” / “send it to Mum” — you can **save** it to `Documents\Keo Research\<date> <title>\` (report page, plus a PDF or a picture, plus the product pictures full size) or **send** it on WhatsApp as a picture of the comparison with the prices and links as text. Sending checks the recipient in the chat header and verifies the picture appears; clicking Send in the window is your approval for that one message. The report is rendered in a hidden window with JavaScript off and no network (pictures are embedded).
- **Parallel research**: for multi-part questions Keo runs up to four research sub-agents at once. They can only search and read the web, and only findings tied to pages they read are kept.
- **Project workspaces** (*Projects → Workspace folder*): Keo lists and reads files in the folder you choose, edits files only with your approval (diff shown, backup in `.keo-backups`, atomic write, refused if the file changed meanwhile) and runs only the project's own `package.json` scripts, with a click each time.
- **Workflows**: save a finished task (*Tasks → Save as workflow*) and ask Keo to run it again later; Keo re-plans against the current screen and asks for approval as usual. *Settings → Privacy & data → Export/Import* moves projects and workflows between PCs (no keys, settings or chats).
- **Task chips** above the companion show unfinished tasks with their real state (working, queued, needs you, check result) and a cancel button. Choose which task events notify you in *Settings → Approvals & live chat*.

## Videos (phase 1: local editing with ffmpeg)

Give Keo a template video and a folder of clips — “make a video like `C:\Users\me\Videos\template.mp4` from the clips in `C:\Users\me\Videos\Trip`” — and it makes a similar video in seconds, then lets you direct changes while it plays.

- **ffmpeg is needed and is not installed by Keo.** Install it yourself (for example from ffmpeg.org) and add it to PATH, or choose `ffmpeg.exe` in *Settings → Video* (`ffprobe.exe` must be in the same folder). *Settings → Video* shows whether ffmpeg was found and which encoder it will use. Without ffmpeg, Keo says so and changes nothing.
- **Template analysis** (`video.analyze_template`): length, format, frame rate, the shot list from scene cuts, and the beat of its sound — all with ffmpeg on this PC. When screen-content export to the active model is allowed, up to six frames are shown to the model to describe the look (on-screen text, caption style and colours, hook, pacing, transitions).
- **Clips** (`video.analyze_clips`): every video file in the folder is probed and scanned for its liveliest moments; with screen-content export allowed, one frame per clip is described by the model. **Captions** need the spoken words: only when you tick *Settings → Video → I allow Keo to send my clips’ sound to OpenAI* (and have an OpenAI key) is the sound sent to OpenAI's speech-to-text; otherwise the video is made without captions and Keo says why.
- **The edit recipe** (`video.plan_edit`): a typed, validated plan — shots (clip, in point, length, speed), transition, texts, caption style, music, format (9:16, 16:9, 1:1, 4:5). The template's rhythm is scaled to the length you want and the cuts are moved onto the beat (of your music file if you give one). Music must be a file on your PC that you own or have a licence for; Keo does not download music or stock footage.
- **Preview window and live direction**: a quick 640-pixel preview opens in a small window (it does not take focus). Type “shorter intro”, “bigger captions”, “make it 20 seconds”, “captions at the top”, “no music”… — common instructions are applied at once; anything else goes to Keo, which changes the recipe with `video.direct`. Every change re-renders the preview (a newer change cancels the one in progress); **Undo** goes back a version. You can also just talk to Keo with your voice shortcut while it plays.
- **Saving** (`video.render_final`, needs your OK; the window's *Save video* button is that OK): the full-size MP4 goes into `Videos\Keo` (or the folder chosen in *Settings → Video*) as a new file — existing files are never replaced — and is checked afterwards: length, picture size, sound track and frames at 10 %, 50 % and 90 %.
- Keo prefers libx264 when your ffmpeg has it and otherwise uses Windows' own H.264 encoder (`h264_mf`) or the graphics card's, so LGPL builds of ffmpeg work. Captions and texts need ffmpeg's `subtitles` filter (libass); without it they are left out with a note.

## Trained wake word (optional)

*Settings → Voice & shortcuts → Trained wake word*: Picovoice Porcupine listens on this PC for one trained phrase (no audio leaves the computer). Create a free account at console.picovoice.ai, paste your AccessKey, and either choose a trained “Hey Keo” model (`.ppn` for Windows, made in the Picovoice console) or a built-in word such as “Jarvis”; then pick *Trained wake word* as the speech engine. Commands after the wake word are still understood by Windows speech or OpenAI. If Porcupine cannot start (no key, missing file), Keo says why and uses Windows speech.

## Installed apps

*Access → Allowed applications → Add from installed apps…* and *Launchable applications → Choose from installed apps…* list every app on the PC (Start menu and Microsoft Store, with icons and publishers), including Store apps that have no .exe you could browse to, such as WhatsApp. Store apps launch through Windows by their app id.

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
- reads the chat in the background while you keep working (no screen takeover); to *send* it needs the screen for a moment, so when a reply is ready and you are busy it follows **Settings → When a reply is ready**: **Ask me** (default — shows the reply with *Send now* in a notification, the companion and Tasks, and sends it as soon as you pause), **Wait until I pause**, or **Send immediately**; afterwards it gives your previous window back;
- finds the WhatsApp window itself (WhatsApp Web with its tab in front, or the WhatsApp app) — it never needs a window handle from the model;
- ends on **stop** (say it, the title-bar/companion *Stop*, or Tasks), after the time limit (default 2 h), the reply limit (default 40), or 30 quiet minutes.

The contact's messages are untrusted: they can only ever lead to a reply in that chat or a question for you — never to any other action, and an “answer” is accepted only in your own words. Keep WhatsApp visible and not minimised (a second monitor is ideal): a browser stops updating a covered or minimised tab, so Keo can only refresh it while you pause. Up to 3 live chats can run at once.

## Voice, wake word, command bar and companion

**Settings → Voice & shortcuts**

- **Voice conversation**: after the wake phrase Keo stays in a spoken conversation — it answers out loud and listens again, like a voice assistant, until you say “stop”, “that's all”, “thanks Keo” or stay quiet twice (or press Stop). Say a command together with the wake phrase (“Hey Keo, what's on my screen?”) or after it. Approvals can be answered with “yes” / “no”, except actions that always need a click on screen (raw clicks, payments, deleting…). If the window you are talking about isn't allowed yet, Keo asks — by voice — to allow just that app, then reads it.
- **Wake word** (off by default): uses the Windows speech recognizer on this PC (the modern Windows 10/11 recognizer when available, falling back to the classic one; choose under *Speech engine*). If it mishears your phrase, use *Teach Keo your voice*. Default phrase “hey keo”; add your own (2–4 words) and press *Test* to check Windows understands it. Audio stays local; speech that isn't a wake phrase is discarded. Listening pauses while Keo speaks; mute any time with the mic chip in the title bar or the companion. After the wake phrase, your command is understood by Windows speech (offline) or OpenAI transcription (if configured and consented).
- **Shortcuts**: **Ctrl+K** starts (or ends) a voice conversation; **Ctrl+Shift+K** opens the mini-chat over any app (Enter to send, Esc to close). Both can be changed or turned off in Settings; if another app already holds a shortcut, Settings says so. Installs that still had the old Ctrl+K mini-chat default are moved to Ctrl+Shift+K once; custom shortcuts are kept.
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

With ffmpeg already installed, `KEO_LIVE_VIDEO=1 npx vitest run tests/live-video.test.ts` renders a tiny real video from test pictures ffmpeg makes itself (`KEO_LIVE_VIDEO=<path to ffmpeg.exe>` to use a specific copy).

## Package for Windows

```bash
npm run package:dir   # unpacked app in release/win-unpacked (quick validation)
npm run package:win   # NSIS installer release/Keo-Setup-<version>.exe
```

electron-builder never uploads anything (`--publish never`). The `publish` block in `electron-builder.yml` only tells installed copies where to look for updates (GitHub Releases of this repository); the release workflow uploads the installer with `latest.yml` and the `.blockmap`. Builds are unsigned unless you add a code-signing certificate.

## Check this computer

*Settings → Check & help → Run the check* opens Keo's own small test window for a few seconds and checks, step by step, that Keo can start its desktop helper, bring the window to the front, type, paste (your clipboard is restored), read it back and press a button. Each failing step comes with a likely cause. *Check WhatsApp* reads the WhatsApp window (nothing is clicked or typed) and shows whether Keo finds the search box, message box, header and chat list — layout facts only, never names or messages. A developer can run the same check from a terminal with `KEO_LIVE_SELFTEST=1 npx vitest run tests/live-selftest.test.ts`.

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
  video/           ffmpeg runner, edit recipe, render plan, video studio
  ipc/             handlers + validated router
src/renderer/      React UI, design system, animated emblem
tests/             Vitest suites
scripts/           smoke check, icon renderer
docs/              security boundaries, implementation report
```
