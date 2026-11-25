-- Keo Cloud, update 12: the early-access list (sign-ups from heykeo.com).
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
-- Only the gateway writes it (5 sign-ups an hour per network; the network address is stored only as a hash).
create table if not exists public.waitlist (
  email text primary key check (email = lower(email) and length(email) <= 254),
  platform text not null default 'windows',      -- windows, ios, android
  source text not null default 'site',
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists waitlist_ip on public.waitlist (ip_hash, created_at desc);
alter table public.waitlist enable row level security;
-- No policies: only the gateway (service_role) reads or writes it.

notify pgrst, 'reload schema';
