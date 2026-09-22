-- Administrator-only order dashboard support.
-- Run this once in the Supabase SQL Editor for the existing project.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

revoke all on table public.admin_users from anon;
revoke all on table public.admin_users from authenticated;

-- IMPORTANT: after the administrator has a Supabase Auth account,
-- add that account by replacing ADMIN_EMAIL_HERE and running:
--
-- insert into public.admin_users (user_id)
-- select id
-- from auth.users
-- where lower(email) = lower('ADMIN_EMAIL_HERE')
-- on conflict (user_id) do nothing;
