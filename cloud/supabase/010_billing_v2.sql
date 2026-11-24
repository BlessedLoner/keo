-- Keo Cloud, update 10: the approved plans (24 November 2026) and safe AI billing.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
-- DO NOT RUN until the owner approves the production migration.
--
-- What it does:
--   * Plans: the approved prices, a hard monthly AI allowance per plan (US$, never shown to users as
--     dollars), and a daily and weekly share of it. No reset ever goes past the monthly ceiling.
--   * The AI allowance follows each person's own billing month (from the day they paid), not the
--     calendar, so one payment is one month's allowance and one month's Studio credits.
--   * Reservations: before each AI call the gateway holds the most it could cost (one locked row per
--     user), so calls running at the same time cannot overspend; after the call the real cost
--     replaces the hold. A hold the gateway never settled counts at its full amount.
--   * A safety breaker on Keo's total AI spend per day, per provider, with alerts.
--   * Studio credits stay separate: they never pay for AI chat or computer operation.
--   * AI top-ups: extra AI allowance a user buys (packs, or an amount they type: $5 / ₦7,000 to
--     $100 / ₦140,000), used only once the plan's allowance is used up, never for Studio.
--
-- Every number here can be changed later in Table Editor (plans, plan_prices, models, keo_settings)
-- without touching code.

-- ---------------------------------------------------------------- plans
alter table public.plans add column if not exists monthly_cost_usd numeric(10,4);
alter table public.plans add column if not exists week_share numeric(5,4) not null default 0.40;
alter table public.plans add column if not exists day_share numeric(5,4) not null default 0.15;

update public.plans set
  price_usd_month = 0, monthly_cost_usd = 0.60, max_tier = 1, daily_requests = 60, daily_tokens = 400000,
  features = features || '{"web_search": 3, "images": 0, "voice_minutes": 5, "background_jobs": 1, "studio_credits": 0}'::jsonb
  where id = 'free';
update public.plans set
  price_usd_month = 20, monthly_cost_usd = 12, max_tier = 2, daily_requests = 600, daily_tokens = 8000000,
  features = features || '{"web_search": 50, "images": 10, "voice_minutes": 30, "background_jobs": 2, "studio_credits": 200}'::jsonb
  where id = 'pro';
update public.plans set
  price_usd_month = 29, monthly_cost_usd = 12, max_tier = 2, daily_requests = 800, daily_tokens = 8000000,
  features = features || '{"web_search": 100, "images": 40, "voice_minutes": 60, "background_jobs": 3, "studio_credits": 1500}'::jsonb
  where id = 'creator';
update public.plans set
  price_usd_month = 49, monthly_cost_usd = 28, max_tier = 3, daily_requests = 2000, daily_tokens = 15000000,
  features = features || '{"web_search": 200, "images": 60, "voice_minutes": 120, "background_jobs": 4, "studio_credits": 500}'::jsonb
  where id = 'max';

-- Prices (smallest unit: cents, kobo). People already subscribed keep their old Paystack plan and
-- price until they change plan; new checkouts get these.
insert into public.plan_prices (plan, currency, amount) values
  ('pro', 'USD', 2000), ('pro', 'NGN', 2800000),
  ('creator', 'USD', 2900), ('creator', 'NGN', 4000000),
  ('max', 'USD', 4900), ('max', 'NGN', 6800000)
on conflict (plan, currency) do update set amount = excluded.amount;

-- ---------------------------------------------------------------- model prices (for reservations)
-- List prices per million tokens on OpenRouter. The gateway holds input × 1.25 (a cache write costs
-- that) plus the longest answer allowed; the real cost from OpenRouter replaces the hold.
alter table public.models add column if not exists price_in_per_m numeric(10,4) not null default 5;
alter table public.models add column if not exists price_out_per_m numeric(10,4) not null default 25;
update public.models set price_in_per_m = 0.10, price_out_per_m = 0.50 where id = 'keo-fast';
update public.models set price_in_per_m = 2.00, price_out_per_m = 10.00 where id = 'keo-strong';
update public.models set price_in_per_m = 4.00, price_out_per_m = 20.00 where id = 'keo-best';

-- ---------------------------------------------------------------- the billing month
-- When the current paid month started (the payment's time). Free accounts use the calendar month.
alter table public.profiles add column if not exists period_start timestamptz;
update public.profiles
  set period_start = plan_until - interval '1 month' - interval '3 days'
  where plan <> 'free' and plan_until is not null and period_start is null;

-- ---------------------------------------------------------------- settings for the owner
create table if not exists public.keo_settings (
  key text primary key,
  value numeric not null,
  note text
);
insert into public.keo_settings (key, value, note) values
  ('breaker_openrouter_day_usd', 60, 'Keo''s total AI chat, voice, picture and search spend per UTC day; at this, AI calls stop until midnight UTC.'),
  ('breaker_fal_day_usd', 60, 'Keo''s total fal.ai (Studio) spend per UTC day; at this, Studio AI stops until midnight UTC.'),
  ('alert_share', 0.8, 'An alert is raised when a breaker reaches this share of its limit.'),
  ('hold_minutes', 20, 'A reservation the gateway never settled counts at its full amount after this many minutes.'),
  ('ngn_per_usd', 1380, 'For the admin money page: Naira payments converted to dollars at this rate.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- reservations
create table if not exists public.ai_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(12,6) not null check (amount >= 0),
  kind text not null default 'chat',           -- chat, search, picture, voice, listen
  status text not null default 'open',         -- open, expired (counted at its full amount)
  created_at timestamptz not null default now()
);
create index if not exists ai_holds_user on public.ai_holds (user_id, status);

-- Keo's spend per provider and UTC day (the breaker and the money page).
create table if not exists public.spend_daily (
  day date not null,
  provider text not null,                      -- openrouter, fal
  cost_usd numeric(14,6) not null default 0,
  primary key (day, provider)
);

-- Alerts for the owner (shown on the admin page; emailed when an email service is set up).
create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  day date not null,
  kind text not null,
  message text not null,
  sent boolean not null default false,
  created_at timestamptz not null default now(),
  unique (day, kind)
);

create or replace function public.keo_setting(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.keo_settings where key = p_key), p_default);
$$;

-- Raises one alert per day and kind (true when it is new).
create or replace function public.raise_alert(p_day date, p_kind text, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  made boolean := false;
begin
  insert into public.alerts (day, kind, message) values (p_day, p_kind, p_message)
    on conflict (day, kind) do nothing
    returning true into made;
  return coalesce(made, false);
end $$;

-- ---------------------------------------------------------------- AI top-ups
-- Extra AI allowance a user buys when theirs runs out (instead of moving to a bigger plan). Kept
-- apart from Studio credits: it pays only for AI chat, building and computer operation, never Studio.
-- Used only after the plan's own allowance (day, week or month) is used up; never expires. Stored in
-- US$ of AI cost (users see it as builds and tasks, never dollars).
create table if not exists public.ai_topups (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance_usd numeric(12,6) not null default 0 check (balance_usd >= 0),
  updated_at timestamptz not null default now()
);

-- Top-up packs: price per currency (smallest unit) and the AI allowance it adds (US$ of AI cost).
create table if not exists public.topup_packs (
  id text not null,                     -- 'small', 'medium', 'large'
  currency text not null check (currency in ('NGN', 'USD', 'GHS', 'KES', 'ZAR')),
  amount bigint not null check (amount > 0),
  value_usd numeric(10,4) not null check (value_usd > 0),
  primary key (id, currency)
);
insert into public.topup_packs (id, currency, amount, value_usd) values
  ('small', 'USD', 500, 2.50), ('medium', 'USD', 1000, 5.50), ('large', 'USD', 2000, 12.00),
  ('small', 'NGN', 700000, 2.50), ('medium', 'NGN', 1400000, 5.50), ('large', 'NGN', 2800000, 12.00)
on conflict (id, currency) do nothing;

-- A top-up's receipt says how much AI allowance it added.
alter table public.payments add column if not exists topup_usd numeric(10,4);
-- What a day's AI cost was paid from top-ups (cost_usd stays the plan's own allowance).
alter table public.usage_daily add column if not exists topup_cost_usd numeric(12,6) not null default 0;
-- Which allowance a hold is taken from.
alter table public.ai_holds add column if not exists source text not null default 'plan';   -- plan, topup

insert into public.keo_settings (key, value, note) values
  ('topup_custom_share', 0.5, 'A top-up of an amount the user types adds this share of what they paid as AI allowance (0.5 = the Small pack''s rate).'),
  ('topup_min_usd', 5, 'Smallest top-up a user may type, in US$.'),
  ('topup_max_usd', 100, 'Largest top-up a user may type, in US$.'),
  ('topup_min_ngn', 7000, 'Smallest top-up a user may type, in Naira.'),
  ('topup_max_ngn', 140000, 'Largest top-up a user may type, in Naira.'),
  ('topup_month_cap_usd', 100, 'The most one account may spend on top-ups in 30 days (US$; Naira at ngn_per_usd).')
on conflict (key) do nothing;

-- Adds bought (or given) top-up; answers with the new balance.
create or replace function public.add_topup(p_user uuid, p_usd numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  b numeric;
begin
  if p_usd <= 0 then raise exception 'bad_amount'; end if;
  insert into public.ai_topups (user_id, balance_usd) values (p_user, p_usd)
    on conflict (user_id) do update set balance_usd = public.ai_topups.balance_usd + excluded.balance_usd, updated_at = now()
    returning balance_usd into b;
  return b;
end $$;

-- Takes a top-up's cost (never below zero) and records it on the day as paid from top-ups.
create or replace function public.spend_topup(p_user uuid, p_day date, p_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ai_topups set balance_usd = greatest(0, balance_usd - greatest(0, p_usd)), updated_at = now() where user_id = p_user;
  insert into public.usage_daily (user_id, day, topup_cost_usd) values (p_user, p_day, greatest(0, p_usd))
    on conflict (user_id, day) do update set topup_cost_usd = public.usage_daily.topup_cost_usd + excluded.topup_cost_usd;
end $$;

-- ---------------------------------------------------------------- reserve and settle
-- Holds what an AI call could cost and answers with the hold's id: "<id>" from the plan's allowance,
-- "topup:<id>" from the user's top-up once the plan's allowance is used up. Or, holding nothing:
--   allowance_day, allowance_week, allowance_month (used up, and not enough top-up)
--   keo_breaker (Keo's own daily safety limit)
-- It answers instead of raising an error, so the alert it writes is kept.
-- One user's calls queue on their profile row, so two at once can never both take the last of it.
drop function if exists public.reserve_ai(uuid, numeric, text, date, date, date, numeric, numeric, numeric);
create or replace function public.reserve_ai(
  p_user uuid, p_amount numeric, p_kind text,
  p_day date, p_week_from date, p_month_from date,
  p_day_cap numeric, p_week_cap numeric, p_month_cap numeric
) returns text language plpgsql security definer set search_path = public as $$
declare
  stale record;
  used_day numeric;
  used_week numeric;
  used_month numeric;
  held numeric;
  held_topup numeric;
  topup numeric;
  spent_today numeric;
  held_all numeric;
  breaker numeric;
  hold_id uuid;
  src text := 'plan';
  short text := null;
begin
  if p_amount < 0 then raise exception 'bad_amount'; end if;
  perform 1 from public.profiles where id = p_user for update;
  if not found then raise exception 'no_profile'; end if;

  -- Holds never settled (the gateway stopped): counted at their full amount, on their own day.
  for stale in
    update public.ai_holds set status = 'expired'
      where user_id = p_user and status = 'open' and created_at < now() - make_interval(mins => public.keo_setting('hold_minutes', 20)::int)
      returning amount, created_at, source
  loop
    if stale.source = 'topup' then
      perform public.spend_topup(p_user, (stale.created_at at time zone 'utc')::date, stale.amount);
    else
      perform public.add_usage(p_user, (stale.created_at at time zone 'utc')::date, 0, 0, 0, stale.amount, 0, 0, 0);
    end if;
    insert into public.spend_daily (day, provider, cost_usd) values ((stale.created_at at time zone 'utc')::date, 'openrouter', stale.amount)
      on conflict (day, provider) do update set cost_usd = public.spend_daily.cost_usd + excluded.cost_usd;
  end loop;

  select coalesce(sum(cost_usd) filter (where day = p_day), 0),
         coalesce(sum(cost_usd) filter (where day >= p_week_from), 0),
         coalesce(sum(cost_usd) filter (where day >= p_month_from), 0)
    into used_day, used_week, used_month
    from public.usage_daily where user_id = p_user and day >= least(p_week_from, p_month_from, p_day);
  select coalesce(sum(amount) filter (where source = 'plan'), 0), coalesce(sum(amount) filter (where source = 'topup'), 0)
    into held, held_topup from public.ai_holds where user_id = p_user and status = 'open';

  if p_month_cap > 0 and used_month + held + p_amount > p_month_cap then short := 'allowance_month';
  elsif p_week_cap > 0 and used_week + held + p_amount > p_week_cap then short := 'allowance_week';
  elsif p_day_cap > 0 and used_day + held + p_amount > p_day_cap then short := 'allowance_day';
  end if;
  -- The plan's allowance is used up: the top-up pays, if there is enough of it.
  if short is not null then
    select coalesce((select balance_usd from public.ai_topups where user_id = p_user), 0) into topup;
    if topup - held_topup < p_amount then return short; end if;
    src := 'topup';
  end if;

  -- Keo's own safety breaker (all users together).
  breaker := public.keo_setting('breaker_openrouter_day_usd', 0);
  if breaker > 0 then
    select coalesce((select cost_usd from public.spend_daily where day = p_day and provider = 'openrouter'), 0) into spent_today;
    select coalesce(sum(amount), 0) into held_all from public.ai_holds where status = 'open';
    if spent_today + held_all + p_amount > breaker then
      perform public.raise_alert(p_day, 'breaker_openrouter', 'Keo''s AI spend reached today''s safety limit of $' || breaker || '. AI calls are stopped until midnight UTC.');
      return 'keo_breaker';
    end if;
    if spent_today + held_all + p_amount > breaker * public.keo_setting('alert_share', 0.8) then
      perform public.raise_alert(p_day, 'near_openrouter', 'Keo''s AI spend today passed ' || round(public.keo_setting('alert_share', 0.8) * 100) || '% of its $' || breaker || ' safety limit.');
    end if;
  end if;

  insert into public.ai_holds (user_id, amount, kind, source) values (p_user, p_amount, p_kind, src) returning id into hold_id;
  return case when src = 'topup' then 'topup:' || hold_id::text else hold_id::text end;
end $$;

-- Replaces a hold with what the call really cost (and its counts), from the plan's allowance or the
-- top-up it was held on. An expired hold was already counted at its full amount: only a cost above
-- that is added.
create or replace function public.settle_ai(
  p_hold uuid, p_user uuid, p_day date,
  p_requests integer, p_in bigint, p_out bigint, p_cost numeric,
  p_searches integer default 0, p_images integer default 0, p_voice_seconds integer default 0
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  h public.ai_holds;
  add_cost numeric;
begin
  delete from public.ai_holds where id = p_hold and user_id = p_user returning * into h;
  if not found then return false; end if;
  add_cost := case when h.status = 'expired' then greatest(0, p_cost - h.amount) else greatest(0, p_cost) end;
  if h.source = 'topup' then
    perform public.add_usage(p_user, p_day, p_requests, p_in, p_out, 0, p_searches, p_images, p_voice_seconds);
    perform public.spend_topup(p_user, p_day, add_cost);
  else
    perform public.add_usage(p_user, p_day, p_requests, p_in, p_out, add_cost, p_searches, p_images, p_voice_seconds);
  end if;
  insert into public.spend_daily (day, provider, cost_usd) values (p_day, 'openrouter', add_cost)
    on conflict (day, provider) do update set cost_usd = public.spend_daily.cost_usd + excluded.cost_usd;
  return true;
end $$;

-- Studio's provider spend: checked against the fal.ai breaker and added in one step (negative to
-- give back a refunded job). Answers with the day's new total, or keo_breaker (nothing added; the
-- alert is kept).
drop function if exists public.reserve_spend(text, date, numeric);
create or replace function public.reserve_spend(p_provider text, p_day date, p_amount numeric)
returns text language plpgsql security definer set search_path = public as $$
declare
  breaker numeric := public.keo_setting('breaker_' || p_provider || '_day_usd', 0);
  cur numeric;
begin
  insert into public.spend_daily (day, provider) values (p_day, p_provider) on conflict (day, provider) do nothing;
  select cost_usd into cur from public.spend_daily where day = p_day and provider = p_provider for update;
  if p_amount > 0 and breaker > 0 and cur + p_amount > breaker then
    perform public.raise_alert(p_day, 'breaker_' || p_provider, 'Keo''s ' || p_provider || ' spend reached today''s safety limit of $' || breaker || '. Studio AI is stopped until midnight UTC.');
    return 'keo_breaker';
  end if;
  if p_amount > 0 and breaker > 0 and cur + p_amount > breaker * public.keo_setting('alert_share', 0.8) then
    perform public.raise_alert(p_day, 'near_' || p_provider, 'Keo''s ' || p_provider || ' spend today passed ' || round(public.keo_setting('alert_share', 0.8) * 100) || '% of its $' || breaker || ' safety limit.');
  end if;
  update public.spend_daily set cost_usd = greatest(0, cur + p_amount) where day = p_day and provider = p_provider;
  return greatest(0, cur + p_amount)::text;
end $$;

-- Gives back exactly what a job took when fal.ai refused it at once (monthly credits stay monthly).
create or replace function public.return_credits(p_user uuid, p_month text, p_from_monthly integer, p_from_bought integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.studio_credits
    set monthly_used = case when month = p_month then greatest(0, monthly_used - p_from_monthly) else monthly_used end,
        bought = bought + p_from_bought,
        updated_at = now()
    where user_id = p_user;
end $$;

-- A refunded job whose month has passed gives back nothing from the old month's credits
-- (they would have expired), and never turns them into bought credits.
create or replace function public.refund_credits(p_request text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  j public.studio_jobs;
begin
  select * into j from public.studio_jobs where request_id = p_request and status <> 'refunded' for update;
  if not found then return false; end if;
  update public.studio_jobs set status = 'refunded' where request_id = p_request;
  update public.studio_credits
    set monthly_used = case when month = j.month then greatest(0, monthly_used - j.from_monthly) else monthly_used end,
        bought = bought + j.from_bought,
        updated_at = now()
    where user_id = j.user_id;
  return true;
end $$;

-- Only the gateway (service_role) may call these.
revoke all on function public.keo_setting(text, numeric) from public, anon, authenticated;
revoke all on function public.raise_alert(date, text, text) from public, anon, authenticated;
revoke all on function public.reserve_ai(uuid, numeric, text, date, date, date, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.settle_ai(uuid, uuid, date, integer, bigint, bigint, numeric, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.reserve_spend(text, date, numeric) from public, anon, authenticated;
revoke all on function public.add_topup(uuid, numeric) from public, anon, authenticated;
revoke all on function public.spend_topup(uuid, date, numeric) from public, anon, authenticated;
revoke all on function public.return_credits(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.refund_credits(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- row-level security
alter table public.keo_settings enable row level security;
alter table public.ai_holds enable row level security;
alter table public.spend_daily enable row level security;
alter table public.alerts enable row level security;
alter table public.ai_topups enable row level security;
alter table public.topup_packs enable row level security;
drop policy if exists "read own top-up" on public.ai_topups;
create policy "read own top-up" on public.ai_topups for select using (auth.uid() = user_id);
drop policy if exists "top-up packs are public" on public.topup_packs;
create policy "top-up packs are public" on public.topup_packs for select using (true);
-- No policies: only the gateway (service_role) reads or writes these.

notify pgrst, 'reload schema';
