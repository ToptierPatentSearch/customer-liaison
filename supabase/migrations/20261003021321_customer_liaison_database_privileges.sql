-- Customer Liaison reads and writes these tables only through authenticated
-- Edge Functions. Browser roles have no direct database responsibilities.
-- REVOKE ALL also removes TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN privileges
-- left behind by older migrations that revoked only row-level CRUD privileges.
revoke all on table
  public.order_requests,
  public.project_discussions,
  public.quote_requests,
  public.admin_users,
  public.request_replies,
  public.request_status_history,
  public.request_status_views,
  public.request_documents,
  public.app_rate_limits
from public, anon, authenticated;

-- Explicit server grants also support projects without automatic Data API grants.
-- Existing service-role privileges are preserved; no client policy is introduced.
grant select, insert, update, delete on table
  public.order_requests,
  public.project_discussions,
  public.quote_requests,
  public.admin_users,
  public.request_replies,
  public.request_status_history,
  public.request_status_views,
  public.request_documents,
  public.app_rate_limits
to service_role;

alter table public.order_requests enable row level security;
alter table public.project_discussions enable row level security;
alter table public.quote_requests enable row level security;
alter table public.admin_users enable row level security;
alter table public.request_replies enable row level security;
alter table public.request_status_history enable row level security;
alter table public.request_status_views enable row level security;
alter table public.request_documents enable row level security;
alter table public.app_rate_limits enable row level security;

-- The existing project-maintenance table is operated from the SQL Editor/server,
-- not the browser. It is optional in fresh installations of Customer Liaison.
do $$
begin
  if to_regclass('public.project_maintenance') is not null then
    revoke all on table public.project_maintenance from public, anon, authenticated;
    grant select, insert, update, delete on table public.project_maintenance to service_role;
    alter table public.project_maintenance enable row level security;
  end if;
  if to_regclass('public.project_maintenance_id_seq') is not null then
    revoke all on sequence public.project_maintenance_id_seq from public, anon, authenticated;
    grant usage, select on sequence public.project_maintenance_id_seq to service_role;
  end if;
end;
$$;

-- Stop automatic browser grants on future public tables/sequences created by
-- postgres, the owner of all current application tables and our migration role.
-- Other schemas and other creators' defaults are outside this migration's scope.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
