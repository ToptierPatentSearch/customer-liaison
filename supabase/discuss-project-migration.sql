-- Apply once to the existing Top-tier Patent Search Supabase project.
-- Adds the authenticated Discuss a Project workflow and links converted discussions to order requests.

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
