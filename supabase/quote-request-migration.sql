-- Apply once to the existing Top-tier Patent Search Supabase project.
-- Adds the authenticated Request a Custom Quote workflow, private quote-document storage,
-- and links quote requests to discussions and later search requests.

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
