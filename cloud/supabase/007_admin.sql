-- Keo Cloud, update 7: the admin page's log.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- The admin page (https://<your gateway>/admin) is for the emails in the gateway's ADMIN_EMAILS
-- secret. Every change made there (credits given, plan changed, account blocked or unblocked,
-- report status) is written here with the admin's email. Only the gateway reads or writes it.

create table if not exists public.admin_actions (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin_email text not null,
  action text not null,
  target_user uuid references auth.users (id) on delete set null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists admin_actions_at on public.admin_actions (at desc);

alter table public.admin_actions enable row level security;
revoke all on public.admin_actions from anon, authenticated;
