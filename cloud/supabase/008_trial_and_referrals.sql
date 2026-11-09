-- Keo Cloud, update 8: free trial credits and referrals.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
--   * Trial: every account gets a one-time gift of Studio credits the first time it opens Studio's
--     AI (the number is the TRIAL_CREDITS variable in wrangler.toml; 0 turns it off). Bought credits:
--     they never expire.
--   * Referrals: every user has a code. A new account (under 14 days old, never referred before) that
--     enters someone's code gets REFERRAL_CREDITS, and so does the friend who invited them (at most
--     20 rewarded invites a month each, so it cannot be farmed).

-- ---------------------------------------------------------------- trial
alter table public.studio_credits add column if not exists trial_given boolean not null default false;

-- Gives the trial once (true when given now).
create or replace function public.give_trial(p_user uuid, p_amount integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  given boolean;
begin
  if p_amount <= 0 then return false; end if;
  insert into public.studio_credits (user_id) values (p_user) on conflict (user_id) do nothing;
  update public.studio_credits set bought = bought + p_amount, trial_given = true, updated_at = now()
    where user_id = p_user and not trial_given
    returning true into given;
  return coalesce(given, false);
end $$;

-- ---------------------------------------------------------------- referrals
create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique check (code ~ '^[A-Z0-9]{6,12}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  user_id uuid primary key references auth.users (id) on delete cascade,   -- the new account (once)
  referrer_id uuid not null references auth.users (id) on delete cascade,
  credits integer not null,
  rewarded boolean not null default true,                                   -- false: the referrer was over the month's limit
  created_at timestamptz not null default now()
);
create index if not exists referrals_referrer on public.referrals (referrer_id, created_at desc);

-- Redeems a code for a new account: both get the credits (the referrer within the month's limit).
-- Fails with: no_such_code, own_code, already_referred, too_old.
create or replace function public.redeem_referral(p_user uuid, p_code text, p_amount integer, p_max_age_days integer, p_monthly_limit integer)
returns json language plpgsql security definer set search_path = public as $$
declare
  ref uuid;
  created timestamptz;
  this_month integer;
  rewarded boolean;
begin
  select user_id into ref from public.referral_codes where code = upper(p_code);
  if ref is null then raise exception 'no_such_code'; end if;
  if ref = p_user then raise exception 'own_code'; end if;
  if exists (select 1 from public.referrals where user_id = p_user) then raise exception 'already_referred'; end if;
  select created_at into created from auth.users where id = p_user;
  if created < now() - make_interval(days => p_max_age_days) then raise exception 'too_old'; end if;
  select count(*) into this_month from public.referrals where referrer_id = ref and rewarded and created_at >= date_trunc('month', now());
  rewarded := this_month < p_monthly_limit;
  insert into public.referrals (user_id, referrer_id, credits, rewarded) values (p_user, ref, p_amount, rewarded);
  perform public.add_credits(p_user, p_amount);
  if rewarded then perform public.add_credits(ref, p_amount); end if;
  return json_build_object('credits', p_amount, 'referrer_rewarded', rewarded);
end $$;

revoke all on function public.give_trial(uuid, integer) from public, anon, authenticated;
revoke all on function public.redeem_referral(uuid, text, integer, integer, integer) from public, anon, authenticated;

alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
drop policy if exists "read own code" on public.referral_codes;
create policy "read own code" on public.referral_codes for select using (auth.uid() = user_id);
drop policy if exists "read own referrals" on public.referrals;
create policy "read own referrals" on public.referrals for select using (auth.uid() = referrer_id or auth.uid() = user_id);
