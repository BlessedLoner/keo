# Keo Cloud

Accounts, plans and the AI gateway, so Keo works right after sign-up, with no API keys for users.

- **Supabase** (`snacuyukgzizjqdwxexn`): sign-up/sign-in, plans, models, daily usage.
- **Cloudflare Worker** `keo-cloud` → `https://keo-cloud.blessednoble90.workers.dev`: the AI gateway. The Keo app sends its AI requests here with the user's sign-in. The gateway checks the plan and today's usage, forwards to OpenRouter with Keo's key, and counts the tokens.

Provider keys never reach the app, and the gateway stores no conversation text.

## One-time setup

### 1. Database (Supabase, 2 minutes)

1. Supabase → your project → **SQL Editor** → **New query**.
2. Paste all of [`supabase/001_keo_cloud.sql`](supabase/001_keo_cloud.sql) → **Run**. It should say *Success. No rows returned*.
3. **Authentication → Sign In / Providers → Email**: keep it on, with *Confirm email* on.
4. **Authentication → URL Configuration → Site URL**: `https://blessedloner.github.io/keo/` (change it to your domain later).

5. Later updates: paste and run [`supabase/002_voice_minutes.sql`](supabase/002_voice_minutes.sql) the same way (it counts voice seconds).

The **plans** and **models** tables can be edited any time in the Table Editor: prices, daily limits, which OpenRouter model `keo-fast` / `keo-strong` / `keo-best` use. Check the model ids at <https://openrouter.ai/models> before launch.

### 2. OpenRouter (Keo's AI)

1. <https://openrouter.ai> → sign in → **Settings → Credits**: add a small amount to start.
2. **Settings → Keys → Create key**, name `keo-cloud`, and set a **credit limit** on the key (for example $10 to start). Copy the key; it starts with `sk-or-`.

### 3. Deploy the gateway (Cloudflare)

In a terminal in this folder (`keo\cloud`):

```bash
npx wrangler login
```

A browser opens: allow access to your Cloudflare account. Then:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Paste the **service_role** key (Supabase → Project Settings → API keys → *service_role* → Reveal) and press Enter. It is secret: only Cloudflare keeps it.

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

Paste the OpenRouter key from step 2. Then:

```bash
npx wrangler deploy
```

Check it: open <https://keo-cloud.blessednoble90.workers.dev/health>. It should show `{"ok":true,"service":"keo-cloud"}`.

## How it works

| Endpoint | What |
|---|---|
| `GET /health` | Is the gateway up |
| `GET /v1/models` | The Keo models in the user's plan (OpenAI format) |
| `GET /v1/me` | The user, their plan and today's usage |
| `POST /v1/chat/completions` | Chat (streaming or not), OpenAI-compatible: plan check → OpenRouter → usage counted |
| `POST /v1/search` | Web search (OpenRouter's web plugin) → titles, links, snippets; `features.web_search` per day |
| `POST /v1/images` | A new picture, or a changed copy of one (OpenRouter images); `features.images` per day |
| `POST /v1/speech` | Text read aloud, female or male voice (WAV); `features.voice_minutes` per day |
| `POST /v1/transcribe` | A WAV recording turned into text; counts toward `features.voice_minutes` |

- **Sign-in**: `Authorization: Bearer <Supabase access token>`, checked with Supabase (`/auth/v1/user`) and cached for a minute.
- **Limits**: `plans.daily_requests` (each model call, so each step of a task) and `plans.daily_tokens`. Both reset at 00:00 UTC. A paid plan past `profiles.plan_until` counts as Free.
- **Models**: a model above `plans.max_tier` is refused with a clear message to upgrade.
- **Usage**: tokens and OpenRouter's cost go to `usage_daily` via `add_usage`, so you can see what each user costs.
- **Which models do search, pictures and voice**: the `KEO_*` variables in `wrangler.toml` (also editable in Cloudflare → keo-cloud → Settings → Variables). A feature a plan gives 0 of is refused with a message to upgrade.

## Tests

```bash
cd cloud && ../node_modules/.bin/vitest run
```

The tests use a fake Supabase and a fake OpenRouter in memory: sign-in refused, models per plan, forwarding with Keo's key, streaming and usage, plan and daily limits, expired plans, blocked accounts, upstream errors.
