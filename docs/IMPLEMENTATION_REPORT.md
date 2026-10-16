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
