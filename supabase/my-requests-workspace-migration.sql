-- My Requests client-workspace enhancements for Customer Liaison
-- Adds private per-request workspace documents used after initial submission.
-- Browser clients do not read this table directly; Edge Functions verify ownership.

-- Follow-up hardening from PR #14: future status timestamps may be unknown.
alter table public.project_discussions
  alter column status_updated_at drop not null;

alter table public.quote_requests
  alter column status_updated_at drop not null;

alter table public.order_requests
  alter column status_updated_at drop not null;

alter table public.request_status_history
  alter column changed_at drop not null;

create table if not exists public.request_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  request_type text not null check (request_type in ('discussion', 'quote', 'order')),
  uploader_id uuid references auth.users(id) on delete set null,
  uploader_role text not null check (uploader_role in ('admin', 'client')),
  category text not null default 'client_attachment'
    check (category in ('client_attachment', 'deliverable', 'quote', 'report', 'other')),
  original_name text not null check (char_length(btrim(original_name)) between 1 and 255),
  storage_path text not null unique,
  content_type text,
  size_bytes bigint not null check (size_bytes between 0 and 10485760),
  visible_to_client boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.request_documents enable row level security;

revoke all on table public.request_documents from anon, authenticated;
grant all on table public.request_documents to service_role;

create index if not exists request_documents_request_idx
  on public.request_documents (request_type, request_id, created_at);

create index if not exists request_documents_uploader_id_idx
  on public.request_documents (uploader_id);

create index if not exists request_documents_client_visible_idx
  on public.request_documents (request_type, request_id, visible_to_client)
  where visible_to_client = true;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'request-workspace-documents',
  'request-workspace-documents',
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
