-- Keo Cloud, update 6: problem reports.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- "Report a problem" in Keo (Diagnostics → Report a problem) sends what the user wrote, which Keo
-- they run, and (only if they tick it) Keo's recent activity log with personal details removed.
-- The user sees the exact text before it is sent. Only the gateway (service role) reads or writes
-- this table; read the reports in Table Editor → problem_reports.

create table if not exists public.problem_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  version text not null default '',
  message text not null check (char_length(message) between 1 and 4000),
  report text not null check (char_length(report) <= 200000),
  status text not null default 'new' check (status in ('new', 'seen', 'fixed', 'closed'))
);
create index if not exists problem_reports_user_day on public.problem_reports (user_id, created_at desc);

alter table public.problem_reports enable row level security;
-- No policies: the app's users never read or write this table directly (only through the gateway).
revoke all on public.problem_reports from anon, authenticated;
