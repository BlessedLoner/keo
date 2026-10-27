-- Keo Cloud: accounts, plans, models and usage.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again (it only adds what is missing).
--
-- Who can do what:
--   * Signed-in users can read their own profile and usage, and the public plans/models lists.
--   * Only the Keo gateway (with the service_role key, which stays in Cloudflare) changes plans or counts usage.

-- ---------------------------------------------------------------- plans
-- Edit limits and features here (Table Editor → plans) without a new Keo release.
create table if not exists public.plans (
  id text primary key,                         -- 'free', 'pro', 'max'
  name text not null,
  price_usd_month numeric(10,2) not null default 0,
  daily_requests integer not null,             -- model calls per day (each step of a task is one)
  daily_tokens bigint not null,                -- input + output tokens per day
  max_tier integer not null default 1,         -- strongest model tier allowed (1 fast, 2 strong, 3 best)
  features jsonb not null default '{}'::jsonb, -- e.g. {"web_search": 20, "images": 0, "background_jobs": 1}
  sort integer not null default 0
);

insert into public.plans (id, name, price_usd_month, daily_requests, daily_tokens, max_tier, features, sort) values
  ('free', 'Free', 0, 60, 300000, 1, '{"web_search": 10, "images": 0, "voice_minutes": 10, "background_jobs": 1, "video": false}', 0),
  ('pro', 'Pro', 15, 600, 4000000, 2, '{"web_search": 150, "images": 10, "voice_minutes": 120, "background_jobs": 3, "video": true}', 1),
  ('max', 'Max', 40, 2000, 15000000, 3, '{"web_search": 600, "images": 60, "voice_minutes": 600, "background_jobs": 6, "video": true}', 2)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- models
-- What Keo's model names mean on OpenRouter. Review these ids against openrouter.ai/models before launch.
create table if not exists public.models (
  id text primary key,                 -- what the Keo app asks for: 'keo-fast', 'keo-strong', 'keo-best'
  label text not null,
  upstream text not null,              -- the OpenRouter model id
  tier integer not null,               -- 1 fast, 2 strong, 3 best (compared with plans.max_tier)
  vision boolean not null default true,
  tools boolean not null default true,
  context_tokens integer not null default 128000,
  max_output_tokens integer not null default 8192,
  enabled boolean not null default true
);

insert into public.models (id, label, upstream, tier, vision, tools, context_tokens, max_output_tokens) values
  ('keo-fast', 'Keo Fast', 'openai/gpt-4o-mini', 1, true, true, 128000, 8192),
  ('keo-strong', 'Keo Strong', 'openrouter/auto', 2, true, true, 128000, 8192),
  ('keo-best', 'Keo Best', 'openrouter/auto', 3, true, true, 128000, 8192)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free' references public.plans (id),
  plan_until timestamptz,              -- paid plans: until when (set by the payment webhook)
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

-- A profile for every new account.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- usage
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,   -- what OpenRouter charged (for your own accounting)
  web_searches integer not null default 0,
  images integer not null default 0,
  primary key (user_id, day)
);

-- Adds to today's usage in one atomic step (called by the gateway after each model call).
create or replace function public.add_usage(p_user uuid, p_day date, p_requests integer, p_in bigint, p_out bigint, p_cost numeric, p_searches integer default 0, p_images integer default 0)
returns void language sql security definer set search_path = public as $$
  insert into public.usage_daily (user_id, day, requests, input_tokens, output_tokens, cost_usd, web_searches, images)
  values (p_user, p_day, p_requests, p_in, p_out, p_cost, p_searches, p_images)
  on conflict (user_id, day) do update set
    requests = usage_daily.requests + excluded.requests,
    input_tokens = usage_daily.input_tokens + excluded.input_tokens,
    output_tokens = usage_daily.output_tokens + excluded.output_tokens,
    cost_usd = usage_daily.cost_usd + excluded.cost_usd,
    web_searches = usage_daily.web_searches + excluded.web_searches,
    images = usage_daily.images + excluded.images;
$$;
revoke all on function public.add_usage(uuid, date, integer, bigint, bigint, numeric, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- row-level security
alter table public.plans enable row level security;
alter table public.models enable row level security;
alter table public.profiles enable row level security;
alter table public.usage_daily enable row level security;

drop policy if exists "plans are public" on public.plans;
create policy "plans are public" on public.plans for select using (true);
drop policy if exists "models are public" on public.models;
create policy "models are public" on public.models for select using (enabled);
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "read own usage" on public.usage_daily;
create policy "read own usage" on public.usage_daily for select using (auth.uid() = user_id);
-- No insert/update/delete policies: only the service_role (the gateway) writes.

-- Make the new tables visible to the API right away.
notify pgrst, 'reload schema';
