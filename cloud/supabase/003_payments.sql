-- Keo Cloud, update 3: paying for Pro and Max with Paystack.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- Prices are per plan and currency (Table Editor → plan_prices), in the currency's smallest unit:
-- kobo for NGN (₦20,000 = 2000000), cents for USD ($15 = 1500).

-- ---------------------------------------------------------------- prices
create table if not exists public.plan_prices (
  plan text not null references public.plans (id) on delete cascade,
  currency text not null check (currency in ('NGN', 'USD', 'GHS', 'KES', 'ZAR')),
  amount bigint not null check (amount > 0),
  primary key (plan, currency)
);

insert into public.plan_prices (plan, currency, amount) values
  ('pro', 'USD', 1500),
  ('max', 'USD', 4000),
  ('pro', 'NGN', 2000000),
  ('max', 'NGN', 5000000)
on conflict (plan, currency) do nothing;

-- ---------------------------------------------------------------- Paystack plans
-- The Paystack plan (monthly subscription) the gateway made for each price; test and live keys
-- have separate plans. Written only by the gateway.
create table if not exists public.paystack_plans (
  plan_code text primary key,
  plan text not null references public.plans (id) on delete cascade,
  currency text not null,
  amount bigint not null,
  live boolean not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- the user's subscription
alter table public.profiles add column if not exists billing_status text;            -- active, non-renewing, attention, cancelled
alter table public.profiles add column if not exists billing_currency text;
alter table public.profiles add column if not exists paystack_customer text;
alter table public.profiles add column if not exists paystack_subscription text;
alter table public.profiles add column if not exists paystack_email_token text;

-- ---------------------------------------------------------------- payments (receipts)
create table if not exists public.payments (
  reference text primary key,
  user_id uuid references auth.users (id) on delete set null,
  plan text,
  currency text not null,
  amount bigint not null,
  status text not null,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row-level security
alter table public.plan_prices enable row level security;
alter table public.paystack_plans enable row level security;
alter table public.payments enable row level security;

drop policy if exists "prices are public" on public.plan_prices;
create policy "prices are public" on public.plan_prices for select using (true);
drop policy if exists "read own payments" on public.payments;
create policy "read own payments" on public.payments for select using (auth.uid() = user_id);
-- No write policies: only the gateway (service_role) writes. Users cannot change their own plan.

-- Make the change visible to the API right away.
notify pgrst, 'reload schema';
