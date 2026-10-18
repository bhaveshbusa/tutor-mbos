-- Forward transition to ordinary user-scoped access.
-- Earlier files stay as applied. This file does not drop roles, tables, or rows.
-- app_request remains for any existing session. app_runtime, if present, is not
-- altered and is no longer provisioned. Reads use security-invoker functions.
-- Writes are security definer, so the API role has no direct table writes.
-- Row level security from the earlier files still applies, including delegated grants.

grant usage on schema app to authenticated;
grant select on all tables in schema app to authenticated;
grant select on app.setup_report to authenticated;
revoke insert, update, delete, truncate on all tables in schema app from authenticated;
grant execute on function app.auth_uid() to authenticated;
grant execute on function app.auth_jwt() to authenticated;
grant execute on function app.permissions_allowed(text[]) to authenticated;
grant execute on function app.create_business(text, text) to authenticated;
grant execute on function app.record_client_consent(text, text[], text[], text, text, text) to authenticated;
grant execute on function app.revoke_client_grant(text) to authenticated;

-- Writes go through the reviewed functions. Direct table writes by the API
-- role would skip consent validation. The functions keep their auth.uid()
-- checks and run as the migration owner.
alter function app.create_business(text, text) security definer;
alter function app.record_client_consent(text, text[], text[], text, text, text) security definer;
alter function app.revoke_client_grant(text) security definer;

revoke all on schema app from anon;
revoke all on all tables in schema app from anon;
revoke all on all functions in schema app from anon;
revoke all on app.setup_report from anon;

create or replace function public.create_business(
  p_display_name text,
  p_idempotency_key text
)
returns table (
  id uuid,
  display_name text,
  owner_user_id uuid,
  created boolean
)
language sql
volatile
security invoker
set search_path = app, pg_temp
as $$
  select * from app.create_business(p_display_name, p_idempotency_key)
$$;

create or replace function public.read_business()
returns table (
  id uuid,
  display_name text,
  owner_user_id uuid
)
language sql
stable
security invoker
set search_path = app, pg_temp
as $$
  select id, display_name, owner_user_id from app.businesses
$$;

create or replace function public.read_setup_report()
returns table (
  business_id uuid,
  display_name text,
  owner_user_id uuid
)
language sql
stable
security invoker
set search_path = app, pg_temp
as $$
  select business_id, display_name, owner_user_id from app.setup_report
$$;

create or replace function public.read_client_grant(p_oauth_client_id text)
returns table (
  oauth_client_id text,
  permissions text[],
  revoked_at timestamptz
)
language sql
stable
security invoker
set search_path = app, pg_temp
as $$
  select g.oauth_client_id, g.permissions, g.revoked_at
  from app.client_grants g
  where g.oauth_client_id = p_oauth_client_id
$$;

create or replace function public.record_client_consent(
  p_oauth_client_id text,
  p_permissions text[],
  p_scopes text[],
  p_authorization_id text,
  p_decision text,
  p_redirect_uri text
)
returns void
language sql
volatile
security invoker
set search_path = app, pg_temp
as $$
  select app.record_client_consent(
    p_oauth_client_id,
    p_permissions,
    p_scopes,
    p_authorization_id,
    p_decision,
    p_redirect_uri
  )
$$;

create or replace function public.revoke_client_grant(p_oauth_client_id text)
returns boolean
language sql
volatile
security invoker
set search_path = app, pg_temp
as $$
  select app.revoke_client_grant(p_oauth_client_id)
$$;

create or replace function public.list_live_grant_redirects()
returns table (registered_redirect_uri text)
language sql
stable
security invoker
set search_path = app, pg_temp
as $$
  select g.registered_redirect_uri
  from app.client_grants g
  where g.revoked_at is null
    and g.registered_redirect_uri is not null
  order by g.registered_redirect_uri
$$;

revoke all on function public.create_business(text, text) from public, anon;
revoke all on function public.read_business() from public, anon;
revoke all on function public.read_setup_report() from public, anon;
revoke all on function public.read_client_grant(text) from public, anon;
revoke all on function public.record_client_consent(text, text[], text[], text, text, text) from public, anon;
revoke all on function public.revoke_client_grant(text) from public, anon;
revoke all on function public.list_live_grant_redirects() from public, anon;

grant execute on function public.create_business(text, text) to authenticated;
grant execute on function public.read_business() to authenticated;
grant execute on function public.read_setup_report() to authenticated;
grant execute on function public.read_client_grant(text) to authenticated;
grant execute on function public.record_client_consent(text, text[], text[], text, text, text) to authenticated;
grant execute on function public.revoke_client_grant(text) to authenticated;
grant execute on function public.list_live_grant_redirects() to authenticated;

do $$
begin
  if has_schema_privilege('anon', 'app', 'USAGE') then
    raise exception 'anon_has_app_usage';
  end if;
  if not has_schema_privilege('authenticated', 'app', 'USAGE') then
    raise exception 'authenticated_missing_app_usage';
  end if;
  if has_table_privilege('authenticated', 'app.client_grants', 'INSERT')
    or has_table_privilege('authenticated', 'app.client_grants', 'UPDATE')
    or has_table_privilege('authenticated', 'app.businesses', 'INSERT') then
    raise exception 'authenticated_can_write_app_tables';
  end if;
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'
      and c.relname = 'businesses'
      and c.relrowsecurity
      and c.relforcerowsecurity
  ) then
    raise exception 'businesses_rls_not_forced';
  end if;
end $$;
