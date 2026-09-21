-- Apply this once to the existing Supabase project before deploying the authenticated Edge Functions.

alter table public.order_requests
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists order_requests_user_id_idx
  on public.order_requests (user_id);

alter table public.order_requests enable row level security;

drop policy if exists "anon can submit order requests" on public.order_requests;
revoke insert, select, update, delete on table public.order_requests from anon;
revoke insert, select, update, delete on table public.order_requests from authenticated;

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
