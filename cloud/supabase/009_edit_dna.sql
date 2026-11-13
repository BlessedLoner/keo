-- Keo Cloud, update 9: the shared Edit DNA library.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- Keo users can publish an Edit DNA blueprint (the editing only: shots, timing, transitions, camera
-- moves, text styles and words, effects — never footage, music or file names) after saying why they
-- may share it. Other signed-in users find it and save it to their own Edit DNA. Only the gateway
-- (service role) reads or writes these tables. Three reports from different users hide a blueprint
-- (hidden = true) until someone looks at it in Table Editor → dna_shared.

create table if not exists public.dna_shared (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{6,40}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  category text not null default 'Experimental',
  tags text not null default '',
  description text not null default '' check (char_length(description) <= 400),
  rights text not null check (rights in ('own', 'licensed', 'technique-only')),
  seconds real not null default 0,
  shots integer not null default 0,
  aspect text not null default 'vertical' check (aspect in ('vertical', 'square', 'landscape')),
  blueprint jsonb not null,
  saves integer not null default 0,
  hidden boolean not null default false,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dna_shared_listing on public.dna_shared (saves desc, published_at desc) where not hidden;
create index if not exists dna_shared_user_day on public.dna_shared (user_id, published_at desc);

create table if not exists public.dna_reports (
  shared_id text not null references public.dna_shared (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (shared_id, user_id)
);

-- Counting a save (the gateway calls it when someone else saves a shared blueprint).
create or replace function public.dna_saved(p_id text) returns void
language sql security definer set search_path = public as $$
  update public.dna_shared set saves = saves + 1 where id = p_id;
$$;

alter table public.dna_shared enable row level security;
alter table public.dna_reports enable row level security;
-- No policies: the app's users never read or write these tables directly (only through the gateway).
revoke all on public.dna_shared from anon, authenticated;
revoke all on public.dna_reports from anon, authenticated;
revoke all on function public.dna_saved(text) from anon, authenticated, public;
