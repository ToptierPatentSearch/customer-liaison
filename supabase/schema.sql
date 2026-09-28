-- Run this in the SQL Editor for project:
-- https://syshvcymwktnkrkrvwtk.supabase.co

create extension if not exists pgcrypto;

create table if not exists public.order_requests (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete set null,
  order_reference text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_name text not null,
  organization text,
  email text not null,
  country text not null,
  billing_organization text,
  search_service text not null,
  technical_subject text not null,
  search_objective text not null,
  relevant_jurisdictions text not null,
  relevant_dates text,
  known_patent_documents text,
  known_competitors_or_assignees text,
  requested_completion_date date,
  preferred_deliverable text not null,
  additional_instructions text,
  supporting_documents jsonb not null default '[]'::jsonb,
  scope_review_acknowledged boolean not null default false,
  source text not null default 'place-an-order-section-4',
  status text not null default 'submitted'
);

alter table public.order_requests
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.order_requests
  add column if not exists updated_at timestamptz;

update public.order_requests
set updated_at = created_at
where updated_at is null;

alter table public.order_requests
  alter column updated_at set default now();

alter table public.order_requests
  alter column updated_at set not null;

create index if not exists order_requests_user_id_idx
  on public.order_requests (user_id);

alter table public.order_requests enable row level security;

-- Orders are written only by the authenticated Edge Function through its admin client.
drop policy if exists "anon can submit order requests" on public.order_requests;
revoke insert, select, update, delete on table public.order_requests from anon;
revoke insert, select, update, delete on table public.order_requests from authenticated;

-- Private administrator allowlist. Browser users cannot read or modify it directly.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

revoke all on table public.admin_users from anon;
revoke all on table public.admin_users from authenticated;

-- Threaded request conversations for discussions, quotations, and search requests.
-- Browser clients do not access this table directly; authenticated Edge Functions
-- validate ownership/administrator access and use the server-side admin client.
create table if not exists public.request_replies (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  request_type text not null check (request_type in ('discussion', 'quote', 'order')),
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_role text not null check (sender_role in ('admin', 'client')),
  message text not null check (char_length(btrim(message)) between 1 and 10000),
  is_draft boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.request_replies enable row level security;

revoke all on table public.request_replies from anon, authenticated;
grant all on table public.request_replies to service_role;

create index if not exists request_replies_request_idx
  on public.request_replies (request_type, request_id, created_at);

create index if not exists request_replies_recipient_unread_idx
  on public.request_replies (request_type, request_id, sender_role, read_at)
  where is_draft = false and read_at is null;

create unique index if not exists request_replies_admin_draft_unique
  on public.request_replies (request_type, request_id, sender_id)
  where is_draft = true and sender_role = 'admin';

-- Private bucket for sensitive supporting materials.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-supporting-documents',
  'order-supporting-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'image/png',
    'image/jpeg'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Only authenticated users may upload into their own top-level folder.
drop policy if exists "anon can upload order documents" on storage.objects;
drop policy if exists "authenticated users can upload order documents" on storage.objects;
create policy "authenticated users can upload order documents"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'order-supporting-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Authenticated project discussions are stored separately from formal search requests.
create table if not exists public.project_discussions (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete set null,
  discussion_reference text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_name text not null,
  organization text,
  email text not null,
  project_type text not null,
  objective text not null,
  technology_description text not null,
  timing text,
  known_patent_documents text,
  additional_information text,
  scope_review_acknowledged boolean not null default false,
  source text not null default 'discuss-a-project',
  status text not null default 'new'
);

create index if not exists project_discussions_user_id_idx
  on public.project_discussions (user_id);

create index if not exists project_discussions_created_at_idx
  on public.project_discussions (created_at desc);

alter table public.project_discussions enable row level security;

revoke insert, select, update, delete on table public.project_discussions from anon;
revoke insert, select, update, delete on table public.project_discussions from authenticated;

alter table public.order_requests
  add column if not exists discussion_id uuid references public.project_discussions(id) on delete set null;

create index if not exists order_requests_discussion_id_idx
  on public.order_requests (discussion_id);



-- Authenticated custom quotation requests are stored separately from discussions and formal search requests.
create table if not exists public.quote_requests (
  id uuid primary key,
  user_id uuid references auth.users(id) on delete set null,
  discussion_id uuid references public.project_discussions(id) on delete set null,
  quote_reference text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_name text not null,
  organization text,
  email text not null,
  country text not null,
  search_service text not null,
  technical_subject text not null,
  project_description text,
  search_objective text not null,
  relevant_jurisdictions text not null,
  relevant_dates text,
  known_patent_documents text,
  known_competitors_or_assignees text,
  desired_completion_date date,
  preferred_deliverable text not null,
  budget_considerations text,
  additional_information text,
  supporting_documents jsonb not null default '[]'::jsonb,
  quote_request_acknowledged boolean not null default false,
  source text not null default 'request-custom-quote',
  status text not null default 'submitted'
);

create index if not exists quote_requests_user_id_idx
  on public.quote_requests (user_id);

create index if not exists quote_requests_discussion_id_idx
  on public.quote_requests (discussion_id);

create index if not exists quote_requests_created_at_idx
  on public.quote_requests (created_at desc);

alter table public.quote_requests enable row level security;

revoke insert, select, update, delete on table public.quote_requests from anon;
revoke insert, select, update, delete on table public.quote_requests from authenticated;

alter table public.order_requests
  add column if not exists quote_id uuid references public.quote_requests(id) on delete set null;

create index if not exists order_requests_quote_id_idx
  on public.order_requests (quote_id);

-- Private bucket for quotation-request supporting materials.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quote-supporting-documents',
  'quote-supporting-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'image/png',
    'image/jpeg'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;


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

