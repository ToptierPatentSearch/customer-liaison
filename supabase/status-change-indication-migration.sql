-- Status-change indication support for Customer Liaison
-- Tracks status-specific timestamps and versions, per-user seen state, and status history.

alter table public.project_discussions
  add column if not exists status_updated_at timestamptz;

update public.project_discussions
set status_updated_at = coalesce(updated_at, created_at, now())
where status_updated_at is null;

alter table public.project_discussions
  alter column status_updated_at set default now(),
  alter column status_updated_at set not null;

alter table public.project_discussions
  add column if not exists status_version integer not null default 1;

alter table public.quote_requests
  add column if not exists status_updated_at timestamptz;

update public.quote_requests
set status_updated_at = coalesce(updated_at, created_at, now())
where status_updated_at is null;

alter table public.quote_requests
  alter column status_updated_at set default now(),
  alter column status_updated_at set not null;

alter table public.quote_requests
  add column if not exists status_version integer not null default 1;

alter table public.order_requests
  add column if not exists status_updated_at timestamptz;

update public.order_requests
set status_updated_at = coalesce(updated_at, created_at, now())
where status_updated_at is null;

alter table public.order_requests
  alter column status_updated_at set default now(),
  alter column status_updated_at set not null;

alter table public.order_requests
  add column if not exists status_version integer not null default 1;

create table if not exists public.request_status_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  request_type text not null check (request_type in ('discussion', 'quote', 'order')),
  from_status text,
  to_status text not null,
  status_version integer not null check (status_version >= 1),
  changed_at timestamptz not null default now(),
  unique (request_type, request_id, status_version)
);

alter table public.request_status_history enable row level security;

revoke all on table public.request_status_history from anon, authenticated;
grant all on table public.request_status_history to service_role;

create index if not exists request_status_history_request_idx
  on public.request_status_history (request_type, request_id, status_version desc);

create table if not exists public.request_status_views (
  request_id uuid not null,
  request_type text not null check (request_type in ('discussion', 'quote', 'order')),
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_status_version integer not null default 1 check (seen_status_version >= 1),
  seen_at timestamptz not null default now(),
  primary key (request_type, request_id, user_id)
);

alter table public.request_status_views enable row level security;

revoke all on table public.request_status_views from anon, authenticated;
grant all on table public.request_status_views to service_role;

create index if not exists request_status_views_user_idx
  on public.request_status_views (user_id, request_type, request_id);

create or replace function public.prepare_request_status_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.status_version := coalesce(new.status_version, 1);
    new.status_updated_at := coalesce(new.status_updated_at, new.created_at, now());
  elsif new.status is distinct from old.status then
    new.status_version := coalesce(old.status_version, 1) + 1;
    new.status_updated_at := now();
  end if;

  return new;
end;
$$;

create or replace function public.record_request_status_history()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  previous_status text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;

  previous_status := case when tg_op = 'UPDATE' then old.status else null end;

  insert into public.request_status_history (
    request_id,
    request_type,
    from_status,
    to_status,
    status_version,
    changed_at
  )
  values (
    new.id,
    tg_argv[0],
    previous_status,
    new.status,
    new.status_version,
    new.status_updated_at
  )
  on conflict (request_type, request_id, status_version) do nothing;

  return null;
end;
$$;

revoke all on function public.prepare_request_status_change() from public, anon, authenticated;
revoke all on function public.record_request_status_history() from public, anon, authenticated;
grant execute on function public.prepare_request_status_change() to service_role;
grant execute on function public.record_request_status_history() to service_role;

drop trigger if exists project_discussions_prepare_status_change on public.project_discussions;
create trigger project_discussions_prepare_status_change
before insert or update of status on public.project_discussions
for each row execute function public.prepare_request_status_change();

drop trigger if exists project_discussions_record_status_history on public.project_discussions;
create trigger project_discussions_record_status_history
after insert or update of status on public.project_discussions
for each row execute function public.record_request_status_history('discussion');

drop trigger if exists quote_requests_prepare_status_change on public.quote_requests;
create trigger quote_requests_prepare_status_change
before insert or update of status on public.quote_requests
for each row execute function public.prepare_request_status_change();

drop trigger if exists quote_requests_record_status_history on public.quote_requests;
create trigger quote_requests_record_status_history
after insert or update of status on public.quote_requests
for each row execute function public.record_request_status_history('quote');

drop trigger if exists order_requests_prepare_status_change on public.order_requests;
create trigger order_requests_prepare_status_change
before insert or update of status on public.order_requests
for each row execute function public.prepare_request_status_change();

drop trigger if exists order_requests_record_status_history on public.order_requests;
create trigger order_requests_record_status_history
after insert or update of status on public.order_requests
for each row execute function public.record_request_status_history('order');

insert into public.request_status_history (
  request_id,
  request_type,
  from_status,
  to_status,
  status_version,
  changed_at
)
select id, 'discussion', null, status, status_version, status_updated_at
from public.project_discussions
on conflict (request_type, request_id, status_version) do nothing;

insert into public.request_status_history (
  request_id,
  request_type,
  from_status,
  to_status,
  status_version,
  changed_at
)
select id, 'quote', null, status, status_version, status_updated_at
from public.quote_requests
on conflict (request_type, request_id, status_version) do nothing;

insert into public.request_status_history (
  request_id,
  request_type,
  from_status,
  to_status,
  status_version,
  changed_at
)
select id, 'order', null, status, status_version, status_updated_at
from public.order_requests
on conflict (request_type, request_id, status_version) do nothing;
