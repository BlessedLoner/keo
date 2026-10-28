-- Keo Cloud, update 4: better models, and a daily spending cap for each plan.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.

-- What each plan may cost per day in AI charges (US$), whichever models are used. Bigger models
-- use the day's allowance up faster than small ones, so a plan never costs more than it brings in.
-- Change them any time in Table Editor → plans → daily_cost_usd.
alter table public.plans add column if not exists daily_cost_usd numeric(10,4);
update public.plans set daily_cost_usd = 0.05 where id = 'free' and daily_cost_usd is null;
update public.plans set daily_cost_usd = 0.35 where id = 'pro' and daily_cost_usd is null;
update public.plans set daily_cost_usd = 1.00 where id = 'max' and daily_cost_usd is null;

-- Keo's three models on OpenRouter (see openrouter.ai/models; change them any time).
update public.models set upstream = 'openai/gpt-6-luna' where id = 'keo-fast';
update public.models set upstream = 'anthropic/claude-sonnet-5.5' where id = 'keo-strong';
update public.models set upstream = 'anthropic/claude-opus-5.5' where id = 'keo-best';

-- Make the change visible to the API right away.
notify pgrst, 'reload schema';
