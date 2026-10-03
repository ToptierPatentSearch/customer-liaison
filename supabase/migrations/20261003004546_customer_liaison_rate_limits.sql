-- Application quotas are shared across all Edge Function instances.
-- Browser roles must never be able to inspect or reset another account's counters.
create table if not exists public.app_rate_limits (
  user_id uuid not null,
  action text not null,
  window_started_at timestamptz not null,
  requests integer not null check (requests > 0),
  primary key (user_id, action)
);

alter table public.app_rate_limits enable row level security;
revoke all on table public.app_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.app_rate_limits to service_role;
create index if not exists app_rate_limits_window_idx on public.app_rate_limits (window_started_at);

create or replace function public.consume_app_rate_limit(p_user_id uuid, p_action text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit integer;
  v_window_seconds integer;
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count integer;
  v_stored_window timestamptz;
begin
  if p_user_id is null then
    raise exception 'An authenticated user is required';
  end if;

  -- These policies are server-owned; callers cannot submit a higher quota.
  case p_action
    when 'api' then v_limit := 120; v_window_seconds := 60;
    when 'submit_discussion' then v_limit := 5; v_window_seconds := 3600;
    when 'submit_quote' then v_limit := 5; v_window_seconds := 3600;
    when 'submit_order' then v_limit := 5; v_window_seconds := 3600;
    when 'upload_authorization' then v_limit := 20; v_window_seconds := 3600;
    when 'client_reply' then v_limit := 30; v_window_seconds := 3600;
    when 'admin_operation' then v_limit := 120; v_window_seconds := 3600;
    when 'admin_status' then v_limit := 120; v_window_seconds := 3600;
    when 'failed_authorization' then v_limit := 10; v_window_seconds := 900;
    else raise exception 'Unknown rate-limit action';
  end case;

  v_window := to_timestamp(floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds);

  -- ON CONFLICT locks this account/action row. Parallel calls cannot exceed the quota.
  -- A delayed call from the prior window cannot move a newer counter backward.
  insert into public.app_rate_limits as counters (user_id, action, window_started_at, requests)
  values (p_user_id, p_action, v_window, 1)
  on conflict (user_id, action) do update
    set requests = case when counters.window_started_at < excluded.window_started_at
                        then 1 else counters.requests + 1 end,
        window_started_at = excluded.window_started_at
    where counters.window_started_at < excluded.window_started_at
       or (counters.window_started_at = excluded.window_started_at and counters.requests < v_limit)
  returning requests into v_count;

  if found then
    return query select true, 0;
  else
    select window_started_at into v_stored_window
      from public.app_rate_limits where user_id = p_user_id and action = p_action;
    return query select false, greatest(1, ceil(extract(epoch from
      (v_stored_window + make_interval(secs => v_window_seconds) - clock_timestamp())))::integer);
  end if;
end;
$$;

revoke all on function public.consume_app_rate_limit(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_app_rate_limit(uuid, text) to service_role;

comment on table public.app_rate_limits is
  'Private per-account/action counters. One row per action; remove expired rows during maintenance.';
