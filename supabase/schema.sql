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
