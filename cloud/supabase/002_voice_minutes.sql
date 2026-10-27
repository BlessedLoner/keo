-- Keo Cloud, update 2: counts voice seconds (Keo's voice and listening) per day.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.

alter table public.usage_daily add column if not exists voice_seconds integer not null default 0;

drop function if exists public.add_usage(uuid, date, integer, bigint, bigint, numeric, integer, integer);
create or replace function public.add_usage(p_user uuid, p_day date, p_requests integer, p_in bigint, p_out bigint, p_cost numeric, p_searches integer default 0, p_images integer default 0, p_voice_seconds integer default 0)
returns void language sql security definer set search_path = public as $$
  insert into public.usage_daily (user_id, day, requests, input_tokens, output_tokens, cost_usd, web_searches, images, voice_seconds)
  values (p_user, p_day, p_requests, p_in, p_out, p_cost, p_searches, p_images, p_voice_seconds)
  on conflict (user_id, day) do update set
    requests = usage_daily.requests + excluded.requests,
    input_tokens = usage_daily.input_tokens + excluded.input_tokens,
    output_tokens = usage_daily.output_tokens + excluded.output_tokens,
    cost_usd = usage_daily.cost_usd + excluded.cost_usd,
    web_searches = usage_daily.web_searches + excluded.web_searches,
    images = usage_daily.images + excluded.images,
    voice_seconds = usage_daily.voice_seconds + excluded.voice_seconds;
$$;
revoke all on function public.add_usage(uuid, date, integer, bigint, bigint, numeric, integer, integer, integer) from public, anon, authenticated;

-- Make the change visible to the API right away.
notify pgrst, 'reload schema';
