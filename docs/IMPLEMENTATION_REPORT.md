# Keo — Implementation report

Date: 2026-10-15 · Version 0.1.0 · Electron 44.7.2 (Node 24.21, Chromium) · React 19.3 · TypeScript 5.9.3

This report separates what was **verified by checks that were actually executed** from what **exists but could not be verified here** (credentials, devices, or actions that must not be performed automatically).

## 1. What was built

A Windows desktop agent with:

| Area | Implementation |
|---|---|
| Shell & security | Electron main/preload/renderer split; sandboxed renderer on `app://keo` with strict CSP; renderer network blocked; navigation/new-window/webview blocked; mic-audio-only permission policy; single instance; isolated `%APPDATA%\Keo\<profile>` |
| IPC | 57 channels, each with a strict Zod schema; sender id/frame/origin validation; structured `{ok, error}` results; allow-list asserted equal to schema table |
| Storage | `node:sqlite` (built into Electron's Node — no native modules), WAL, foreign keys, append-only migrations with downgrade refusal, online backup |
| Providers | Anthropic (official SDK, streaming, tools, vision, effort, adaptive thinking defaults, server-side refusal fallback, prompt caching), OpenAI (official SDK, Chat Completions, plus transcription/speech), OpenRouter (official OpenAI SDK against OpenRouter's documented OpenAI-compatible API; https only; own key slot; key check via `GET /key`), local OpenAI-compatible (loopback only), deterministic test provider (env-gated, labelled) |
| Agent | Stable system prompt; bounded context (message limit + character budget + top-K confirmed memories + project state + unresolved tasks); tool loop with per-call admission; truncated tool calls never run; refusal/empty/malformed handling; cancel, retry, interruption recovery |
| Memory | Provenance (`user_authored` / `user_confirmed` / `model_inferred`), source conversation/message/excerpt, versions + revision history, subject-based conflict detection, supersede, reject, delete, secret refusal, BM25-style bounded retrieval over confirmed items only |
| Projects | Projects with objectives/decisions/blockers/questions/progress; model items start as proposals; conversation linking |
| Capabilities | 16 registered capabilities with full contracts (see `CapabilityInfo`); admission gateway; consequential ⇒ approval enforced at registration |
| Tasks | Validated state machines (task + step), approvals bound to input SHA-256, dependencies with failure propagation, bounded retries for safe steps only, timeouts, cancellation, execution receipts, `outcome_uncertain` + user reconciliation, restart recovery that never replays consequential work |
| Desktop | Fixed Win32 helper (EnumWindows, SetForegroundWindow, SetWindowPos, SendInput) behind identity revalidation, allow-listed apps, foreground/occlusion/client-area checks, Windows-key exclusion, registered-executable launch |
| Vision | Single-window `desktopCapturer` capture, blank/empty/missing-source refusal (no full-screen fallback), provenance (identity, time, SHA-256, initiator), fresh vs stored distinction, per-destination export consent, retention purge |
| Voice | Push-to-talk recorder with real mic-level metering, OpenAI transcription (consent-gated), Windows voices via `speechSynthesis` or OpenAI TTS with real amplitude analysis, interruption |
| UI | Chat, Tasks, Memory, Projects, Vision, Access, Settings, Diagnostics; inline approval cards; keyboard shortcuts (Ctrl+1…8, Ctrl+N, Enter/Shift+Enter, Esc); empty/error/loading states; reduced-motion |
| Identity | Original animated SVG emblem (robotic head, segmented halo, circuit traces, core) with 7 event-driven states; app icon rendered from the same artwork |
| Observability | JSONL logs with redaction and rotation, correlation ids, durable audit trail, token usage log |
| Packaging | electron-builder NSIS (per-user, no elevation) + unpacked target; no publish provider |

## 2. Important design decisions

- **`node:sqlite` instead of `better-sqlite3`.** Avoids native modules that must be rebuilt against Electron's ABI. Verified to work inside Electron 44.7.2 (SQLite 3.53.4, FTS5 available). Trade-off: Node still labels the module *experimental* (an `ExperimentalWarning` is printed in tests). The data layer is isolated in `src/main/db/database.ts` so it can be swapped.
- **TypeScript 5.9.3, not 7.x.** `typescript-eslint` 8.71 supports `<6.1`.
- **Lexical retrieval, no embeddings.** Memory volumes for one user are small; BM25-style scoring is deterministic, explainable and has no extra dependency or data export. Retrieval is bounded (≤5000 scanned, top-K returned).
- **Approval binding by hash.** The renderer must send back the exact `inputHash` it displayed; the orchestrator re-hashes the stored input before execution.
- **Receipts before dispatch.** `running` + receipt `started` are written in one transaction; a leftover `started` receipt blocks automatic re-execution.
- **Model-initiated work waits in-turn for approval** (default 300 s, configurable). If you decide later, the task still runs from Task Activity and a note is added to the conversation; the model is not re-invoked automatically.
- **Anthropic defaults** follow current API guidance: `claude-opus-5-5`, streaming, adaptive thinking (default), `output_config.effort` (default *medium*), `eager_input_streaming` tools with Keo-side validation, automatic prompt caching, and the **server-side refusal fallback (`fallbacks: "default"`) enabled by default** for Opus 5.5 / Sonnet 5.5 / Fable 5.1 — it can be turned off in Settings → Providers → Anthropic.
- **Renderer never talks to the network**; it cannot even reach providers. Everything goes through validated main-process services.

## 3. Verification actually executed

All commands below were run in this repository on Windows 11 (10.0.22621) with Node 24.6.0 / npm 11.5.1, and their successful completion was observed.

| Command / check | Result |
|---|---|
| `npm run typecheck` (main+preload+shared, renderer) | pass, 0 errors |
| `npm run lint` | pass, 0 problems |
| `npm test` (Vitest) | **105/105 passed** in 8 files |
| `npm run build` | pass (main 233 kB, preload 2.7 kB with only `require("electron")`, renderer 320 kB minified) |
| `npm run smoke` — real Electron, disposable profile, two launches | **17/17 passed** |
| Same smoke hooks under `electron-vite dev` (dev server + HMR CSP) | all checks passed |
| Same smoke hooks against packaged `release/win-unpacked/Keo.exe` | all checks passed (profile `default`) |
| `electron-builder --win --dir` and `--win` | unpacked app and `release/Keo-Setup-0.1.0.exe` built; version resources set; **NotSigned** |
| Win32 helper, read-only: `ping`, `list` | helper compiled (~11 s first start), listed windows with all fields; an input command to a non-existent window was refused with `target_gone` before sending anything |
| Real Windows focus → type check | With two windows owned by the check itself: typing into the background window was refused (`not_foreground`, the error first reported from use), the helper brought it to the front, and the typed text arrived exactly |
| Real Windows text-entry check | In a window owned by the check: chunked typing of 229 characters (symbols, parentheses, accents, newlines) and a clipboard paste both arrived exactly; the clipboard was restored; UI Automation read-back found the text |
| Visual review | screenshots of every view captured from the real app with synthetic data and reviewed; two UI bugs found and fixed (pending approvals not persisted on the message; memory badge not refreshed) |
| `npm audit --omit=dev` | 0 vulnerabilities in shipped dependencies |

What the automated suites cover:

- **Architecture/data:** profile isolation; migrations (fresh, idempotent, atomic rollback, newer-schema refusal); backup; conversation persistence across restart; interrupted-message recovery; search; cascades; settings defaults (all execution permissions off), strict validation, prototype-pollution resistance, corrupt-file quarantine; secret store never writes plaintext and refuses without OS encryption.
- **Memory/projects:** proposals never retrieved as facts; confirmation provenance; source attribution survives source deletion; conflict detection + supersede; versioned corrections; deletion; credential refusal; bounded ranked retrieval; model project items stay proposals.
- **Tasks:** invalid transitions rejected; approval required and hash-bound; denial skips dependents; plan approval requires every reviewed hash; dependency failure propagation; bounded retries; consequential timeout ⇒ uncertain and never retried; cancellation (consequential ⇒ uncertain, safe ⇒ cancelled); duplicate prevention via receipts; finished-receipt reuse; reconciliation; retry needs fresh approval; restart recovery (uncertain / re-authorize / safe requeue).
- **Agent & security:** streaming + usage; bounded context; missing provider ⇒ honest error; empty response ⇒ error; cancel + retry; unknown capability / extra params / malformed args rejected and audited; model text claiming approval cannot bypass it; denied actions never run; prompt-injected window titles cannot authorize or target non-allow-listed apps; untrusted-output marking; disabled permissions hide tools; truncated tool calls not executed; memory proposals carry evidence; plans validated and non-executable until approved; cancelling a turn cancels its pending approvals; IPC sender/origin/frame validation; unknown channels and invalid inputs rejected; keys never returned to the renderer; permission changes audited; registry contract completeness; consequential-without-approval registration refused; redaction; **log files contain no keys or message text**; production CSP; loopback-only local provider.
- **Vision/desktop:** identity revalidation (gone / changed pid / not allowed / hwnd reuse); fresh captures distinct with provenance; failed captures create no observation; minimized and disabled observation refused; stored observations marked `fresh:false`; export permission per destination; retention purge keeps metadata; blank-frame detection. **No real input is sent in any automated test** (fake backend records calls; assertions check it stays empty).
- **Desktop/web/memory additions:** focus-before-input (and nothing sent when focus is refused), `notepad.exe`≡`Notepad`, launch errors list registered ids, invented handles reported clearly; Brave query/header/parse, auth/quota/no-key errors, private-destination refusal incl. DNS and redirects, text extraction, capability hidden until key + permission; memory saved only from verbatim user quotes, proposals otherwise, *ask first* setting, duplicate detection, profile facts always in context; v1→v2 migration preserves memories/revisions and keeps foreign keys enforced.
- **Providers (no network):** OpenRouter (separate https-only provider with its own key; `max_tokens`, no `stream_options`; tool-call assembly; usage; `/key` check; reported capabilities never override declared ones); Anthropic request construction (model, effort, tools with eager streaming, refusal fallback beta, no disabled thinking), streaming deltas/phases, usage incl. cache tokens, native content (thinking blocks) echoed unchanged, tool-result mapping; SDK error mapping (auth, rate limit, quota, network, cancel, malformed) for Anthropic and OpenAI.

### Desktop autonomy, voice activation and context-aware actions (current iteration)

Run on Windows 11 (10.0.22621), Electron 44.7.2.

| Command / check | Result |
|---|---|
| `npm run check` (typecheck, lint, tests, build) | pass; **136/136 tests** in 9 files (30+ new in `tests/autonomy.test.ts`) |
| `npm run smoke` | **34/34**, incl. new presence checks: one companion window, non-focusable, on a display, role-restricted IPC (companion cannot read memory or chat; command bar cannot change settings or list windows), shortcut registers and is released when disabled, companion closes when disabled, no windows left after shutdown |
| `npm run e2e:desktop` — real Win32 + UI Automation against a disposable WhatsApp-like Electron app | **10/10**: observe, tab navigation, unchanged element re-validated, vanished element refused (nothing dispatched), ambiguous contact → candidates, exact contact opened + verified, chat read with correct directions, nothing sent while pending or after denial, approved send verified on screen, duplicate blocked. (One cold start timed out before the test app was up; startup wait raised to 90 s.) |
| UIA helper on real windows | ~80-node snapshot in ≈0.7 s; invoke / set_value / toggle / scroll; password field refused and hidden; stale id → `element_gone`; browser context survives DOM mutation (Chromium access violation caught) |
| Wake word helper (SAPI, en-US recognizer) | “hey keo” recognised via emulation, ordinary sentence rejected by the competing grammar, custom phrase “okay jarvis” recognised, unknown culture → `no_recognizer` |
| Visual review | companion, command bar and *Voice & shortcuts* settings captured from the real app; a misleading shortcut note was found and reworded |

Bugs found by the real e2e and fixed: Chromium names list items with their concatenated text (“Daniel Okafor10:40”) → trailing time stripped; message rows are full-width so direction is now taken from the bubble's content position; an e2e step that re-clicked the wrong tab.

### Approval levels and live chats

| Check | Result |
|---|---|
| `npm run check` | pass; **158/158 tests** in 10 files (13 new in `tests/livechat.test.ts`: one-approval start, autonomous reply, price question paused despite a model reply, answer used, injection ignored, "are you a bot?" asked, reply limit, idle wait + window restore, answer provenance, message arriving mid-send not swallowed, Stop everything, approval levels incl. named-contact rule, raw click and Enter always ask) |
| `npm run e2e:desktop` (real UI Automation, offline test provider as reply model) | **16/16**: live chat starts after one approval, replies on its own, pauses on a price question without sending, continues with the user's answer, sends nothing after stop |
| `npm run smoke` | 34/34 |
| Real WhatsApp Web (read-only probes, earlier) | search, chat list, header, message text and directions recognised; live chat **not** run against your WhatsApp |

Bug found by the real e2e and fixed: a message arriving while Keo was verifying its own send was marked handled; now only messages up to Keo's reply count as handled.

### Voice conversation, screen reading by voice, self-test and automatic updates

| Check | Result |
|---|---|
| `tests/voicemode.test.ts` | 10/10: spoken conversation ends on “stop”; command with the wake phrase; two silences end it; short spoken answers requested from the model; approve by “yes please” / deny by “no”; *always ask* never approvable by voice; allowing a not-yet-allowed window by voice adds only that app (no control, no screenshots) and is never auto-approved by hands-free; wake paused and resumed; Stop everything |
| `tests/selftest.test.ts` | 4/4 on the fake desktop: all steps pass and only the test window receives input, clipboard restored; failing step pinpointed with advice; early stop when focus is refused; diagnostic report has no keys, app names or typed text |
| `tests/release.test.ts` | +3 updater tests: background download, ready notice, install only on request; setting respected, at most daily; failures reported without details; no updater in development |
| Real self-test on this PC (`KEO_LIVE_SELFTEST=1`) | **first run failed at typing**: “abc 123” arrived as “bc 123” because the ALT tap used to win the foreground opened the test window's system menu. Fixed (masked ALT, menu-mode check); now 7/7 pass |
| `npm run package:win` | builds `Keo-Setup-<version>.exe`, `.blockmap` and `latest.yml`; `app-update.yml` points at BlessedLoner/keo; `electron-updater` is inside `app.asar` |
| Modern Windows speech helper | compiles (~4 s) and starts/pauses wake listening on this PC; recognition accuracy depends on the microphone and was not measured |

Not verified end-to-end: an installed copy actually updating itself (needs a published release newer than the installed one), and the other laptop's original WhatsApp/Notepad failure (the ALT/menu bug above is a likely cause; *Check this computer* on that laptop will tell).

### Next iteration (uncommitted): background jobs — several long tasks at once

- **What**: a long request (research, video planning/rendering, reading many pages, anything with many tool calls) no longer blocks the conversation. The model hands it to `jobs.start_background` with a self-contained brief and answers at once ("On it — I'll tell you when it's done"). The job runs as an ordinary agent run in its own hidden conversation, through the same `AgentService` loop: same provider/model choice and smart routing, same tools, same admission and approval rules (no auto-approval; job approvals appear in Task Activity like any other, and in a voice conversation Keo asks for them by voice between turns). A job cannot start or stop other jobs.
- **Code**: `src/main/agent/backgroundJobs.ts` — `BackgroundJobs` (queue, cap, start/cancel/find, recovery, persistence in `background-jobs.json`, report posting, system-prompt context), `DesktopLease`, and the capabilities `jobs.start_background`, `jobs.list`, `jobs.cancel`. `AgentService` gains `send(..., { background })` (no interceptor for a job's brief), `desktopGate` and `whenBusy`. Settings: `agent.maxBackgroundJobs` (1–6, default 3; Settings → Agent behaviour). IPC `jobs:list`, `jobs:cancel`, push `jobs:changed` (also allowed in the command bar). UI: a *Background jobs* list with Stop buttons at the top of Task Activity.
- **Concurrency**: up to `maxBackgroundJobs` jobs run at once; more wait in order and start when one ends. Jobs that only use the web, files or ffmpeg run truly in parallel. Anything with `desktop.control` or `desktop.launch` first takes the `DesktopLease`: a job keeps it from its first desktop action until it ends (so two jobs never interleave mouse/keyboard work, and a waiting job does not even ask for approval yet — the list shows "Waiting for the desktop"); the user's own turns take it for one action at a time. The per-action `desktop.exclusive` lock is unchanged underneath.
- **Finishing**: when a job completes, fails or is stopped, its report goes into the conversation that started it (assistant message with `meta.jobId`), a Windows notification follows (finished/failed preferences respected; a job the user stopped does not alert), and in a voice conversation a short spoken summary is queued — said at the next pause, after any current reply, never while Keo is listening. Research results still open the results window and video previews the preview window, as before. Jobs running when Keo closes are reported as interrupted at the next start and never replayed.
- **Seeing and stopping**: the user's turns get a short "Background jobs" status in the system context, so "what are you working on?" is answered from real state; "stop the video one" → `jobs.cancel` by id or title words (several matches → Keo asks which). Stop everything cancels jobs too.
- **No more "still working"**: a new request typed or spoken while the conversation is still busy (command bar, voice, chat) is handed to a background job with the user's own words as the brief, instead of being refused. One-word answers ("yes", "stop") and pencil pictures are not turned into jobs.
- **Safety detail**: a job's brief is written by the model, so checks that rely on "the user said it" (automatic approval of named contacts, memory quotes, secret-file names, live-chat answers, video texts) read the parent conversation's user messages, never the brief.
- **Tests**: `tests/jobs.test.ts` (fake provider, fake desktop; no live calls): three jobs running at once while a normal request is answered immediately and a fourth queues; completion reports + notifications; cancel by name and from the UI; nested jobs refused; two desktop-driving jobs serialized (the second asks for approval only after the first ends, typing order checked); busy hand-off; spoken report only after the current reply; `DesktopLease` ordering and cancellation.
- **Not verified**: real-model behaviour — whether a given model reliably chooses `jobs.start_background` for long work and writes good briefs depends on the model; checked only with the scripted test provider.

### Next iteration (uncommitted): videos, phase 1 — local ffmpeg editing

- **What**: the user gives a template video and a folder of clips; Keo analyses both with ffmpeg/ffprobe on the PC, builds a typed edit recipe, renders a 640-pixel preview into its own data folder, opens a small preview window, applies live instructions, and on approval renders the full-size MP4 into `Videos\Keo` and checks it. The model only understands and decides (style from frames, structured changes); it never writes ffmpeg commands.
- **Code**: `src/main/video/recipe.ts` (zod recipe schema; `buildRecipe`: template rhythm scaled to the target length, cuts snapped to beats, best clip moments spread over the shots; `applyDirection`: 17 validated change types, all-or-nothing; `parseDirection`: common phrases understood locally; `captionCues`), `src/main/video/ffmpeg.ts` (locator — chosen `ffmpeg.exe` with `ffprobe.exe` beside it, else PATH; process runner without a shell, killed on cancel/timeout; probe, scene scores, onset/tempo detection on 11 kHz mono PCM, frame grabs, encoder detection: libx264 → h264_mf → nvenc/qsv/amf → openh264 → mpeg4), `src/main/video/render.ts` (recipe → one ffmpeg run: per-shot trim/scale-to-fill/fps, concat or xfade + acrossfade chains, silence for clips without sound, music mix with fade-out, captions and texts from an ASS file in the render's own folder), `src/main/video/studio.ts` (projects, background previews with cancel/restart, final render with unique names, verification), `src/main/capabilities/video.ts` (8 capabilities), the preview window (`#video`, role `video`, `src/renderer/src/presence/VideoApp.tsx`), *Settings → Video*, and `OpenAICompatProvider.transcribeWords` (whisper-1 word timestamps).
- **Capabilities and tiers**: `video.check_tools` (read), `video.choose` (Windows picker), `video.analyze_template`, `video.analyze_clips`, `video.plan_edit`, `video.direct`, `video.undo` — routine, no approval (they read files the user named or picked and write only into Keo's data folder); `video.render_final` — `approval: 'always'`, consequential, routine tier (a new file in the output folder; nothing replaced or sent), verified with ffprobe. Every admission and execution is in the audit log; frames sent to the model (`video.frames`) and sound sent for captions (`video.transcribe`) are audited too. Errors say what happened and that nothing was changed/read/made.
- **Tests**: `tests/video.test.ts` — 32 tests with a fake ffmpeg (`tests/fakeFfmpeg.ts`; no process starts): recipe building and beat snapping, strict schema, caption timing with speed changes, live direction (local phrases, clip-length limits, all-or-nothing errors), probe/scene/beat parsing (a 120 BPM click track is found), locator rules, encoder fallback, render arguments (no user text in arguments, ASS escaping, xfade offsets, music mix, preview size), the full capability flow (analyse → plan → preview → window instruction → undo → model change → approval-gated save → verification → a second save gets “(2)”), missing ffmpeg, untrusted paths refused, captions skipped without consent, a failed render leaves no file, preview restart, preview-window channel limits. `tests/live-video.test.ts` renders a tiny real video only with `KEO_LIVE_VIDEO=1` and an ffmpeg that is already installed (it makes its own test pictures with ffmpeg's `testsrc`); **not run here — ffmpeg is not installed on this PC**. Smoke: the preview window renders, does not take focus, is limited to its own channels and closes.
- **Not verified**: a real render (no ffmpeg on this PC), how burned-in captions look with real fonts, OpenAI word timestamps (behind consent; no live provider calls in tests), the vision model's style description on real templates, and beat detection on real music (only synthetic clicks).
- **Next phases (designed, not built)**: phase 2 — OBS through obs-websocket (scenes and recording driven by its API, not UI clicks); phase 3 — export the recipe as an editable project (e.g. a timeline CapCut or Premiere can open) for hand-off. Recipes are already saved as JSON next to every render for that.

### 1.10.0: smart routing

- Optional (off by default; Settings → Providers): Keo picks the model per message — a fast model for voice, small talk and quick questions, the strong model for pictures, code, research, analysis, planning, multi-step and long typed requests (a local rule, no extra model call). Both models are the user's choice; each reply shows which one answered. With the setting off nothing changes. Tests: `tests/routing.test.ts`.

### 1.9.0: WhatsApp text check, pencil over videos, Keo points things out on screen

- **WhatsApp** (user's laptop): “The message box does not contain the approved text” — the text was in the box, but WhatsApp there reports the box differently (e.g. only its current paragraph). Keo now compares letters and digits only and accepts a box that holds a solid part of the approved text and nothing else (Keo clears the box first and only ever puts the approved text in it); a box that really differs is cleared and nothing is sent. Reproduced with a fake box that reports only its last paragraph: fails without the fix (the user's exact error), passes with it.
- **Pencil over videos**: a full-screen transparent window makes Chrome treat the video as hidden and stop painting it (blank video). The pencil now shows the screen picture it took as a still frame under the drawing layer — nothing goes blank and the video does not move while marking.
- **Keo points things out**: `screen.look` (the active model looks at the whole screen and answers with 0–1000 positions; screen-content consent required; hands-free may do it) and `screen.point_out` (circles, boxes, arrows, underlines and numbered notes drawn one after another, then faded; display-only, click-through, never focused, sized to the marked area so videos keep playing). The prompt tells Keo to point at things on the pencil's whole-screen picture or after looking, while explaining.
- Tests: `tests/screen.test.ts`, WhatsApp partial-box test; smoke: marks drawn, click-through, partial window, channel limits, closed.

### 1.8.0: text and picture on WhatsApp, real product pictures, continuous voice, new Keo art

- **WhatsApp**: research results are sent as the prices-and-links text first (a normal message — the most dependable way on every PC), then the picture on its own (no caption box). WhatsApp steps never press Ctrl+A any more (with the keyboard outside the box it selected the whole page — the “highlighted UI text”); boxes are cleared through accessibility. Live (approved, own chat): text, then picture, both verified.
- **Product pictures**: Keo now tries every picture a page offers (declared product image, Open Graph/Twitter/itemprop/image_src, <img> pictures whose description names the product, largest srcset size; logos/icons skipped), asks image servers for JPEG/PNG, and converts WebP/AVIF/GIF to PNG in a hidden, script-free window of the locked-down report session. When a page has no usable picture, the matching Wikipedia article's picture is used (Wikipedia API) and labelled “Picture: Wikipedia”. Live: mbusa.com offers 3 product photos (WebP — converted), apple.com opens directly, Wikipedia finds GLE / MacBook Air.
- **Voice**: parts of a reply are queued and said back to back (the next part's cloud audio downloads while one plays) — one continuous answer, no pause per sentence. Voice replies are warmer and livelier (prompt; gpt-4o voices also get a cheerful speaking style).
- **Pencil**: typed requests no longer open the mini-chat; research opens the results window, other answers arrive as a notification.
- **Keo's art**: the new black-and-white Keo — the portrait (studio background) in the emblem/orb and the app icon (`scripts/render-icon.cjs`, also `site/icon.png`); the cut-out (background removed) in Keo mode, with open eyes over the closed lids that follow the mouse and blink. The old robot icon (`build/icon.svg`) is removed.

### 1.7.0: Noir look, Keo's character, Keo mode; WhatsApp focus fix

- **WhatsApp text after the picture** (user's laptop): the picture arrived but the text did not. Likely cause: after the Windows file dialog closes, focus does not return to WhatsApp there, so typing/pasting was refused. Keo now puts WhatsApp back in front after the dialog, before the caption and before the follow-up text, and types straight into the message box as a last way in. Not reproducible on this PC (focus returns there); covered by the existing fake-WhatsApp tests.
- **Noir** (new default look, Settings → Appearance; *Classic* keeps the earlier dark blue): black and white with Keo's ice-blue glow; white primary buttons; neutral greys.
- **Keo's character** (user-supplied art, `src/renderer/src/assets/keo.webp`) in the animated emblem (title bar, chat, welcome, companion), keeping the state-driven halo, rim and chest-light animations.
- **Floating Keo**: a levitating orb with Keo's portrait and a turning state ring; a frosted capsule with round actions on hover (now with Pencil and Keo mode).
- **Pencil** toolbar reorganised: header with steps (Mark → Ask → Send), a tools row (pen/highlighter, colours, undo/clear, hint) and an ask row (mic, what Keo heard or a text box, Send).
- **Keo mode** (“open Keo mode” typed or spoken, the companion button, or optionally the wake word): full-screen Keo floating in depth (tilts toward the mouse), turning holographic rings, drifting glass cards, snow, a chest light and rings that follow Keo's real state, and live captions; a voice conversation starts with it; Esc / “close Keo mode” leaves. The window may only use presence, voice start/stop, close, settings and wake status.
- Tests: `tests/keomode.test.ts`; smoke: Keo mode opens with the art, channel limits, closes.

### 1.6.2 fixes: the text always arrives with the picture

- Reported (user's laptop, 1.6.1): “WhatsApp did not take the text for the picture, so nothing was sent” — the new safety check stopped a picture without its text, but the caption still did not go in there.
- The caption is now tried three ways (click + paste, accessibility value, typing straight into the box — which also works where simulated input is blocked) and read back; a half-entered caption is cleared. If the preview still does not take it, the picture is sent and the caption (prices and links) follows immediately as the next message, both verified; Keo's report says so.
- Messages of several lines are verified by their first and last lines among my newest rows (the app shows each line as a row) — this also fixes “cannot see the message” after multi-line sends.
- Live (approved, own chat): normal send — picture with caption; forced fallback — picture, then the text as the next message (both arrived; the verification gap found there is the multi-line fix above, covered by a test).

### 1.6.1 fixes: picture captions, faster cloud voice choice

- Reported: the picture was sent without its caption (prices and links), WhatsApp's page text was highlighted first, then “could not find the picture” (shown twice).
- Found live: the preview's caption box is named “Type a message” and focused; some WhatsApp versions name the message box the same, so Keo took it for an existing box and typed into the hidden message box behind the preview (select-all highlighted the page). The caption box is now recognised by element (focused or new since the preview opened); the caption is entered with a real click + paste (no select-all) and read back; if it cannot be confirmed the attachment is removed and nothing is sent. A newly appeared picture entry also counts as proof of sending. The same error is shown once.
- Settings → Voice: OpenAI TTS model choice (tts-1 fastest to start, gpt-4o-mini-tts most natural, tts-1-hd).
- Live (approved, own chat): picture + caption + links sent through the file-dialog route and verified.

### 1.6.0: Keo's pencil, file dialog, faster spoken answers

- **WhatsApp on other PCs:** the Attach → Photos & videos file dialog stayed open untouched while a pasted picture appeared. Likely cause: the dialog's file list (a folder with many pictures) used up the accessibility reading budget before the “File name” box, so Keo fell back to pasting. Keo now operates the dialog as a Windows dialog: the visible `#32770` dialog owned by WhatsApp's window or process (or the only new one) gets the path in its “File name” box (id 1148, `WM_SETTEXT`, read back) and its OK command; a dialog Keo opened is cancelled if anything fails, never left open. Live here: dialog found (owned by WhatsApp), file chosen, preview in 5 s, then removed — nothing sent.
- **Spoken answers start sooner:** in voice mode Keo speaks finished sentences while the model is still writing (sentence ends ignore decimals, abbreviations and code), then the rest — nothing twice.
- **Keo's pencil** (floating icon button, `Ctrl+Alt+P`): Keo takes a picture of the display, opens a drawing layer over it (pen, highlighter, colours, undo, clear) and listens; the user circles what they mean and says or types what they want. It sends by itself once there is a mark and a request (or on Send/Enter). The model receives a close-up of the marked area and the whole screen with the marks (≤ 1600 px each, for that turn only, not stored) plus the window under the marks, so it can act there. Spoken requests are answered aloud and the voice conversation continues; typed ones open the mini-chat. The first use with a real provider asks for consent (sets `visionExport` for that provider). The overlay window may only use its own channels.
- Tests: `tests/pencil.test.ts`, early speech tests, dialog route via the fake; smoke: pencil opens, draw + type + Send reaches Keo, channel limits. Live: `tests/live-whatsapp-attach.test.ts` (no send).

### 1.5.4 fixes: WhatsApp sending on other PCs, cloud voice

- Reported on two laptops: sending a research result failed (“attachment preview not shown”, “header shows nothing recognisable / Delivered”, “WhatsApp.Root not allowed”), and the OpenAI voice answered late and over the Windows voice.
- Reproduced here: with a wide or maximised WhatsApp window the chat list is narrower than 30 % of the width, so the header name was treated as part of the list. The conversation pane now starts where the list actually ends; a lone delivery status is never a header; header-area buttons and the selected chat can confirm (never choose) the chat the user named. Searching for “Name(You)” searches “Name”.
- `WhatsApp.Root` (the app's window process) counts as the allowed “WhatsApp” app.
- Pictures and files are attached through WhatsApp's own Attach menu and the Windows file dialog (file name box id 1148, Open id 1), entirely through accessibility — this works where Windows blocks simulated keyboard input; pasting remains the fallback and the WhatsApp Web route.
- Cloud voice: a reply still downloading when it is stopped (listening started, the Windows fallback took over) is dropped instead of played late; replies are fetched and played sentence by sentence (short first part), so speech starts sooner.
- Live (user-approved, own chat): a picture with caption sent from the results window with only “WhatsApp” allowed and the contact typed as “Emmanuel(You)”; verified by Keo. The OpenAI voice path is covered by tests only (no live cloud calls).

### 1.5.3 fixes: spoken replies, copy, drawing

- Voice replies were silent, then spoken late: a Windows voice can take several seconds to start the first time (5.2 s measured here, longer on slower PCs) and Keo waited only 2.5 s, then listened again while the reply was still queued; the chat view also spoke replies itself when *Speak responses* was on. Now Keo waits up to 15 s for the voice to start, warms it up when the wake word or spoken replies are on, cancels anything still queued before listening (so nothing plays during or after a session), and if the app voice still does not start says the reply with Windows' own voice (System.Speech). The chat view does not speak replies during voice mode. Two microphone hiccups are retried before a session ends.
- Copy in the chat failed: the page's clipboard permission is not granted (only microphone audio is). Copy now goes through a write-only `app:copyText` channel.
- Drawing (“draw me a dog”) had no drag action. New `desktop.draw` (strokes on a 0–1000 scale in the canvas box, every point inside the window and not covered; hands-free only in drawing apps). It uses simulated mouse input, and when Windows refuses that, Windows' synthetic pen input (which the new Paint takes), then posted mouse messages. Live in Paint on this PC: mouse and pen both draw; posted messages do not.
- Live checks: `KEO_SMOKE_VOICE=1` (a reply spoken by the app voice), copy (smoke), `tests/live-paint.test.ts`.

### 1.5.2 fixes: sending research pictures on WhatsApp Desktop (live-verified)

- Reported: Send from the results window failed with "not in the foreground" while the results window stayed above WhatsApp; by voice only text and links were sent.
- Found on this PC (live): WhatsApp Desktop's chat content is a separate WebView2 top-level window of its child process that takes the foreground when the message box is used, so the helper's exact-window check refused the paste. The app also does not take a pasted file, only a pasted image; accessibility focus does not move the keyboard into its message box (a click does); and Keo restored the clipboard before WhatsApp had read it.
- Fixes: overlay windows of the target app count as the target (same or child process, within its bounds); pictures go on the clipboard as image data; the message box is clicked; the clipboard is restored after the preview shows; WhatsApp Desktop's media preview (“Send 1 selected”, “Remove attachment”, caption box) is recognised; an unsent preview is removed on failure; success is checked by a new picture element. The results window steps aside during desktop work. The model is told about the result on screen, and a text-only copy of it is refused in favour of `research.send_whatsapp`.
- Live (user-approved, own chat only): two test pictures with captions were delivered to “Emmanuel (You)” from the results window; the first runs failed safely without sending (foreground, then preview not shown). The final success report after the id-based check was confirmed read-only (ids stable across reads), not by a third send.

### Next iteration (uncommitted): research results window, save/send, search without a key

- Reported: a request like “compare the best prices of the MacBook Pro/Air M4 32 GB and show me the result” opened a browser on Google results and sent only links and text prices on WhatsApp, with no picture.
- Research now goes through web search + the sellers' product pages + `research.show_products`; the result is kept (last ten, in memory) and opens an animated **results window** (pictures, prices, sellers, specs, pros/cons, sources).
- **Save** (`research.save_result`): `Documents\Keo Research\<date> <title>\` with `report.html`, `report.pdf` or `report.png` and the product pictures (full size from the page when possible). **Send** (`research.send_whatsapp`): a picture of the comparison plus prices and links as the caption, via the existing verified WhatsApp file path (app or Web). Both work from the window's buttons or by voice/chat (“save it as a PDF”, “send it to …”).
- Web search works without a Brave key: engine setting *Automatic / Brave only / DuckDuckGo*.
- Tests: `tests/results.test.ts` (store, report escaping/CSP, prices, save with a fake renderer writing real files, send through the fake WhatsApp, folder opening limits, window channel limits, DuckDuckGo parsing, engine choice, human-check stop). Not live-tested: the real PDF/PNG rendering and a real DuckDuckGo query and WhatsApp send.

### 1.4 iteration: hands-free, faster WhatsApp, installed apps, trained wake word

- Live chat asked the user even for “hey how are you”: the prompt told the model to ask for anything not covered by instructions, and unparseable answers defaulted to asking. Now small talk is answered, malformed answers are retried, and in Hands-free the chat never pauses (careful replies + a notification).
- Hands-free approves all but the critical tier (pay/buy/delete/reset/sign-in controls, running project code); plan steps included; forgiving name matching.
- WhatsApp app reading: 9 s → ~2 s (live: 234 elements, search/compose/6 chats found) by reading pattern details only for interactive elements and skipping the second copy of the page; fixed pauses replaced by polling; live chat polls every 1.5 s, debounce 2.5 s, gap 2.5 s.
- Installed-apps picker with icons (live: 117 apps, 103 with process names, 102 icons; WhatsApp → WhatsApp.Root) for allowed and launchable apps; Store apps launch by app id.
- Porcupine trained wake word (optional engine; built-in “Jarvis” or a trained “Hey Keo” .ppn). Not live-tested: needs the user's Picovoice AccessKey.

### 1.3 iteration: WhatsApp app, research cards, sub-agents, workspaces, workflows

- **WhatsApp app (verified live on this PC, WhatsApp 2.2640.100.0):** the window is WinUI 3 hosting WebView2 windowlessly. Root causes: (1) Keo only treated `Chrome_RenderWidgetHostHWND` as embedded content; the app uses `Chrome_WidgetWin_0` inside `Microsoft.UI.Content.DesktopChildSiteBridge`; (2) once the classic .NET UI Automation client has been used in a process, the COM client in that process also sees an empty frame. Fix: content roots include those classes, and a modern (COM) reader runs in its own helper process, chosen automatically per window. Live: classic 15 elements / modern 782–1094, search box and 8 chats found; your own chat (“Emmanuel (You)”) searched, opened and header-verified (header form “Name (You) Message yourself” now understood). Nothing was sent.
- WhatsApp app-or-web choice (`which`), choice buttons for questions, open questions saved across restarts, Store-app publishers (live: Calculator → Microsoft Corporation, WhatsApp → WhatsApp Inc.).
- New: `research.show_products` (cards), `agents.research` (parallel sub-agents), `files.*` (workspaces), `whatsapp.send_file`, `workflows.*`, export/import, task chips, notification preferences.
- Not done: app icons in lists; a trained wake-word model (Windows speech recognition remains the engine; custom phrases work as well as Windows recognises them).

### Next iteration (uncommitted): shortcuts, app discovery, browser profiles, desktop ownership, open questions

- Ctrl+K = voice conversation, Ctrl+Shift+K = mini-chat; both registered by one manager that releases its previous registrations first; conflicts reported per shortcut; one-time move of the old Ctrl+K mini-chat default.
- `apps.find` / `apps.open`: Windows app discovery (Start menu + Microsoft Store via `Get-StartApps`), launch by app id, switch to an open window, ambiguity → question. Live read-only check on this PC passed (Calculator found as a Store app).
- `browser.list_profiles` / `browser.open_tab`: Chrome/Edge/Brave profile names, new tab in the chosen profile; duplicate profile names (seen on this PC: two “Blessed2”) are ambiguous.
- Desktop input queue (one owner) for desktop actions and live chats.
- Open questions per conversation so "Personal" completes "research … in Chrome".
- Tests: `tests/apps.test.ts` (16), `tests/desktoplock.test.ts` (5) — fakes only, nothing launched.

### 1.1.3 investigation: WhatsApp Desktop and unexpected Spanish

- **Not a packaging defect.** Every helper (desktop, speech) is an embedded script written to the profile's runtime folder at start; nothing depends on repository paths. The packaged build includes its runtime dependencies (checked in `app.asar`) and the packaged `Keo.exe` passes the smoke checks and the desktop self-test in a disposable profile. What differed: the earlier successes ran **WhatsApp Web in a browser**; the failing laptop runs the **WhatsApp app**, which hosts its page in an embedded WebView2 child window.
- **Root cause (WhatsApp):** `KeoUia.Snapshot` / `Find` / `ReadText` walked UI Automation only from the top-level window. When the host frame does not lead the classic walker into the embedded page, Keo saw a frame without controls → "could not find the search box". Reproduced on this PC with an Edge window whose page was not reachable from the frame (`contentRoots: 1`); after the fix the page is read through its `Chrome_RenderWidgetHostHWND` child, and the search field, rich-text box and button worked there (live check). **Not verified against the WhatsApp app itself** (not installed here).
- Also: WhatsApp states are reported precisely (signed out / loading / window contents not readable / layout not recognised); the snapshot waits while a web page's accessibility tree is still being built; *Check WhatsApp* lists the window, its embedded windows, what was read, the state and the result.
- **Root cause (Spanish):** no language policy existed, so the model followed the conversation: a misheard voice command ("Raisme ekvaleta en krum.") was answered in Spanish and later turns stayed Spanish (gpt-4o-mini via OpenRouter). Fixed by an English-first policy in the system prompt, a bounded English rewrite of clearly non-English replies (text only, no action repeated), a misheard-command guard in voice mode, English transcription hints (1.1.2) and an English default TTS voice.

### 1.1.2 fixes (second laptop, WhatsApp Desktop)

- Every simulated key/click was refused on that laptop (WhatsApp Desktop and Brave alike), shown as *Only part of the input was delivered / outcome uncertain*. Now a refused send is reported as `input_blocked` (nothing sent) and Keo switches to direct delivery for text, single keys and clicks. Verified live on this PC: WinForms text (with accents and new lines), Backspace and a button click; Chromium (Edge test page) input and rich-text box. Not verified on that laptop.
- OpenAI transcription now uses the wake-word language and a short context prompt, and drops phrases speech-to-text invents for silence (“Gracias.”, subtitle credits), so short or quiet answers are no longer “heard” in Spanish.
- The wake word comes back on its own after a conversation: a watchdog restarts listening when it should be on but is not (failed restart, lost “finished speaking” signal, recognizer error); the modern helper retries starting once.

### 1.1.1 fixes (reported from the second laptop)

- *“Only part of the input was delivered”* when bringing WhatsApp to the front: the masked ALT tap could be partly refused by Windows and failed the whole action (and could leave ALT held). It is now best effort and modifiers are released afterwards. Live self-test 7/7.
- *“Could not find WhatsApp’s chat search box”*: recognition now accepts other interface languages and unnamed fields (by position), waits once for a late page, and in the WhatsApp app tries Ctrl+F. *Check WhatsApp* reports what Keo sees. Not verified against that laptop's WhatsApp.
- *“Couldn't listen”* after the first answer: a cancelled capture the helper never confirmed blocked every later one (“busy”). Captures now carry ids, cancel immediately, have a watchdog, retry once after a microphone hiccup, and a crashed speech helper restarts on its own. Both helpers compile and answer on this PC.
- Not answering while minimized: silence detection ran on animation frames, which stop for minimized windows; it now runs on a timer, the window is not throttled in the background, and a hidden window is loaded for voice if Keo's window was closed.

## 4. Integrations that require configuration (not live-verified)

| Integration | Status |
|---|---|
| Anthropic API | Implemented with the official SDK; request shape tested with a fake client. **No live call was made** (no key here; live paid calls were out of scope). Add a key in Settings → Providers and use *Test connection* (free model listing). |
| OpenAI chat | Implemented with the official SDK; not live-tested. Model id and capabilities are user-declared. |
| Brave Search / page reading | Implemented; request shape, error mapping, SSRF guards, redirects, HTML-to-text and untrusted marking tested with fake fetch/DNS. **Not live-tested** (no key used here). |
| OpenRouter | Implemented; request body, streaming/tool-call assembly, usage and the key check are tested with a fake client. **Not live-tested.** OpenRouter-reported model capabilities are shown as hints only. |
| Local OpenAI-compatible server | Implemented; not tested against a running Ollama/LM Studio here. |
| Speech-to-text (OpenAI) | Implemented, consent-gated; not live-tested; microphone capture not exercised automatically. |
| Text-to-speech | Windows voices via `speechSynthesis` and OpenAI TTS implemented; not exercised automatically. |
| Window capture | Pipeline tested with a fake capture source; the Electron `desktopCapturer` path was **not** run against your windows (to avoid capturing your screen without a request). |
| Desktop input actions | Executed only against windows owned by the checks themselves (test windows and the disposable WhatsApp-like app); never against your applications. |
| WhatsApp (real) | Not tested against your WhatsApp — no messages were sent. Needs the physical acceptance test in the README/final report. |
| Wake word with a real microphone | Recognition logic verified with emulated audio; real-microphone use needs physical acceptance. |
| Ctrl+K in real use | Registration/release verified with a non-conflicting accelerator; whether Ctrl+K is free on your PC depends on your other apps. |
| Installer | Built, **not installed** (installing would modify your system). Not code-signed. |

## 5. Known limitations and risks

- `node:sqlite` is marked experimental by Node; an API change in a future Electron could require adapting `database.ts`.
- Context budgeting is by characters, not tokens; very large single messages are kept whole (the newest message is always included).
- Verification of input actions is delivery-only; Keo reports such steps as *not independently verified*.
- First desktop action after startup can take ~10 s while the helper compiles its Win32 bindings (pre-warmed at startup when desktop features are enabled).
- The audit trail and usage log are not pruned automatically (they contain no message text).
- Markdown rendering is intentionally minimal (no tables/HTML).
- Wake word uses Windows speech recognition: accuracy depends on microphone, room and accent; only installed recognizer languages are offered. Not exercised with a real microphone automatically.
- WhatsApp and browser reading depend on what those apps expose to UI Automation; verified against a disposable look-alike app, **not** against real WhatsApp or a real Chrome page (that would touch your accounts).
- Dev tooling (`electron-builder` → `@electron/get` → `global-agent` → `sprintf-js`) has 8 moderate audit advisories; they are not shipped in the app.
- The installer and executable are unsigned; SmartScreen will warn.

## 6. Isolation statement

All work happened inside `C:\Users\bless\keo` plus disposable directories under the system temp folder (test and smoke profiles, deleted after use) and the standard npm/Electron/electron-builder download caches. No other project, application directory or application data was opened, read or modified. Nothing was committed, pushed, published, deployed or installed.

## 7. Actions that need your decision

- Supplying provider API keys (OpenRouter now; Anthropic and/or OpenAI later) or running a local model server.
- Code-signing certificate, if you want signed builds.
- Whether to commit this iteration (not committed).
- Running the installer on a machine.
- **Videos: bundling ffmpeg** (a separate decision). Today Keo uses an ffmpeg the user installs. Bundling an **LGPL** build (for example the BtbN or gyan.dev “lgpl” Windows builds; they leave out libx264, which is GPL) would make videos work out of the box; Keo already falls back to Windows' `h264_mf` encoder for such builds. It adds roughly 80–130 MB to the installer and LGPL obligations (ship the licence, name the build, offer or link its source, let users replace the libraries — use the shared-library build). Nothing was downloaded or installed.
- **Videos: licensed music/stock** (later, opt-in): only from sources with clear licences, approved per use; never copyrighted songs or other people's footage. Phase 1 uses only the user's own files.
