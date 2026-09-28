-- Request conversation support for Customer Liaison
-- Adds threaded administrator/client replies associated with an existing request.

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
