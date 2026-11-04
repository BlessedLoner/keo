-- Keo Cloud, update 5: Studio credits and the Creator plan.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- Keo Studio's AI work (AI shots, character swap / Clone a video, same-face pictures, character
-- voices) runs on Keo's own fal.ai account through the gateway and is paid in Studio credits:
--   * 1 credit = 1 US cent to the user, and covers half a cent of fal.ai's price (about 2×).
--   * Each plan includes credits every calendar month (plans.features.studio_credits); they reset
--     on the 1st (UTC) and do not carry over.
--   * Bought credits (credit packs) never expire and are used after the month's credits.
-- Change the numbers any time in Table Editor (plans → features, credit_packs).

-- ---------------------------------------------------------------- the Creator plan
insert into public.plans (id, name, price_usd_month, daily_requests, daily_tokens, max_tier, features, sort) values
  ('creator', 'Creator', 29, 800, 6000000, 2, '{"web_search": 200, "images": 40, "voice_minutes": 300, "background_jobs": 4, "video": true, "studio_credits": 1500}', 2)
on conflict (id) do nothing;
-- Max moves one place down the list.
update public.plans set sort = 3 where id = 'max' and sort = 2;
update public.plans set daily_cost_usd = 0.45 where id = 'creator' and daily_cost_usd is null;

-- Credits included in the other plans (Free: none, so AI video always starts with a choice to pay).
update public.plans set features = features || '{"studio_credits": 0}'::jsonb where id = 'free' and not (features ? 'studio_credits');
update public.plans set features = features || '{"studio_credits": 100}'::jsonb where id = 'pro' and not (features ? 'studio_credits');
update public.plans set features = features || '{"studio_credits": 400}'::jsonb where id = 'max' and not (features ? 'studio_credits');

insert into public.plan_prices (plan, currency, amount) values
  ('creator', 'USD', 2900),
  ('creator', 'NGN', 4000000)
on conflict (plan, currency) do nothing;

-- ---------------------------------------------------------------- credit packs
create table if not exists public.credit_packs (
  id text not null,                     -- 'small', 'medium', 'large'
  credits integer not null check (credits > 0),
  currency text not null check (currency in ('NGN', 'USD', 'GHS', 'KES', 'ZAR')),
  amount bigint not null check (amount > 0),   -- smallest unit: kobo, cents
  primary key (id, currency)
);
insert into public.credit_packs (id, credits, currency, amount) values
  ('small', 500, 'USD', 600),
  ('medium', 1500, 'USD', 1600),
  ('large', 4000, 'USD', 4000),
  ('small', 500, 'NGN', 900000),
  ('medium', 1500, 'NGN', 2400000),
  ('large', 4000, 'NGN', 6000000)
on conflict (id, currency) do nothing;

-- ---------------------------------------------------------------- each user's credits
create table if not exists public.studio_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  month text not null default '',              -- 'YYYY-MM' the monthly count belongs to
  monthly_used integer not null default 0 check (monthly_used >= 0),
  bought integer not null default 0 check (bought >= 0),
  updated_at timestamptz not null default now()
);

-- Every AI request paid with credits: who, what it cost, and whether it was given back.
create table if not exists public.studio_jobs (
  request_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  credits integer not null,
  from_monthly integer not null default 0,
  from_bought integer not null default 0,
  month text not null,
  status_url text not null,
  response_url text not null,
  cancel_url text,
  status text not null default 'running',      -- running, done, refunded
  created_at timestamptz not null default now()
);
create index if not exists studio_jobs_user on public.studio_jobs (user_id, created_at desc);

-- A credit pack's receipt says how many credits it bought (plan is empty for those).
alter table public.payments add column if not exists credits integer;

-- Takes credits (the month's first, then bought ones) or fails with 'not_enough_credits'.
create or replace function public.spend_credits(p_user uuid, p_month text, p_allowance integer, p_amount integer)
returns json language plpgsql security definer set search_path = public as $$
declare
  r public.studio_credits;
  monthly_left integer;
  take_monthly integer;
  take_bought integer;
begin
  if p_amount <= 0 then raise exception 'bad_amount'; end if;
  insert into public.studio_credits (user_id, month) values (p_user, p_month) on conflict (user_id) do nothing;
  select * into r from public.studio_credits where user_id = p_user for update;
  if r.month <> p_month then
    r.month := p_month;
    r.monthly_used := 0;
  end if;
  monthly_left := greatest(0, p_allowance - r.monthly_used);
  if monthly_left + r.bought < p_amount then raise exception 'not_enough_credits'; end if;
  take_monthly := least(monthly_left, p_amount);
  take_bought := p_amount - take_monthly;
  update public.studio_credits
    set month = r.month, monthly_used = r.monthly_used + take_monthly, bought = r.bought - take_bought, updated_at = now()
    where user_id = p_user;
  return json_build_object('from_monthly', take_monthly, 'from_bought', take_bought, 'left', monthly_left - take_monthly + r.bought - take_bought);
end $$;

-- Gives back what a failed request took (once: the job is marked refunded).
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
        bought = bought + j.from_bought + case when month = j.month then 0 else j.from_monthly end,
        updated_at = now()
    where user_id = j.user_id;
  return true;
end $$;

-- Adds bought credits (after a credit pack is paid).
create or replace function public.add_credits(p_user uuid, p_amount integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.studio_credits (user_id, bought) values (p_user, p_amount)
    on conflict (user_id) do update set bought = public.studio_credits.bought + p_amount, updated_at = now();
end $$;

-- Only the gateway (service_role) may call these.
revoke all on function public.spend_credits(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.refund_credits(text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- row-level security
alter table public.credit_packs enable row level security;
alter table public.studio_credits enable row level security;
alter table public.studio_jobs enable row level security;
drop policy if exists "packs are public" on public.credit_packs;
create policy "packs are public" on public.credit_packs for select using (true);
drop policy if exists "read own credits" on public.studio_credits;
create policy "read own credits" on public.studio_credits for select using (auth.uid() = user_id);
drop policy if exists "read own studio jobs" on public.studio_jobs;
create policy "read own studio jobs" on public.studio_jobs for select using (auth.uid() = user_id);
-- No write policies: only the gateway writes.

notify pgrst, 'reload schema';
