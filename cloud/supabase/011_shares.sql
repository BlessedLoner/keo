-- Keo Cloud, update 11: a day and a week may use more of the month (approved 25 November 2026).
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- One real edit (real photos + custom icons + checks) used most of Pro's old daily share (15% of
-- $12 = $1.80) and paused mid-task. Now: 35% a day, 60% a week. The monthly allowance (the hard
-- ceiling that protects the margins) does not change, so the worst-case margins do not either.
-- A task already under way also finishes past today's or this week's share (only the month stops it).
-- Change these any time in Table Editor → plans → day_share / week_share.
alter table public.plans alter column day_share set default 0.35;
alter table public.plans alter column week_share set default 0.60;
update public.plans set day_share = 0.35, week_share = 0.60;

notify pgrst, 'reload schema';
