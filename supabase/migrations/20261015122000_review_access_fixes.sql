-- Corrective migration. Denial revokes the previous grant, and the
-- authenticated API role loses direct access to schema app. The request
-- path remains app_request. Hosted development apply must still confirm
-- that the migration role can grant execute on auth.uid() to app_request;
-- this file does not change that grant.

create or replace function app.record_client_consent(
  p_oauth_client_id text,
  p_permissions text[],
  p_scopes text[],
  p_authorization_id text,
  p_decision text
)
returns void
language plpgsql
security invoker
set search_path = app, pg_temp
as $$
declare
  recent integer;
begin
  if auth.uid() is null or (auth.jwt() ->> 'client_id') is not null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'denied') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  if p_oauth_client_id is null or char_length(p_oauth_client_id) < 1 then
    raise exception 'invalid_client' using errcode = 'P0001';
  end if;
  if not app.permissions_allowed(p_permissions) then
    raise exception 'invalid_permissions' using errcode = 'P0001';
  end if;
  select count(*)
  into recent
  from app.oauth_consents c
  where c.owner_user_id = auth.uid()
    and c.decided_at > now() - interval '1 hour';
  if recent >= 20 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into app.oauth_consents (
    owner_user_id,
    oauth_client_id,
    authorization_id,
    decision,
    scopes,
    permissions
  )
  values (
    auth.uid(),
    p_oauth_client_id,
    p_authorization_id,
    p_decision,
    coalesce(p_scopes, array[]::text[]),
    p_permissions
  );

  if p_decision = 'approved' then
    insert into app.client_grants (
      owner_user_id,
      business_id,
      oauth_client_id,
      permissions
    )
    values (
      auth.uid(),
      (select b.id from app.businesses b where b.owner_user_id = auth.uid()),
      p_oauth_client_id,
      p_permissions
    )
    on conflict (owner_user_id, oauth_client_id) do update
    set permissions = excluded.permissions,
        revoked_at = null,
        granted_at = now(),
        business_id = coalesce(client_grants.business_id, excluded.business_id);
  else
    update app.client_grants
    set revoked_at = now(),
        permissions = array[]::text[]
    where owner_user_id = auth.uid()
      and oauth_client_id = p_oauth_client_id
      and revoked_at is null;
  end if;
end;
$$;

revoke all on schema app from authenticated;
revoke all on all tables in schema app from authenticated;
revoke all on all sequences in schema app from authenticated;
revoke all on all functions in schema app from authenticated;
revoke all on app.setup_report from authenticated;
grant execute on function app.create_business(text, text) to app_request;
grant execute on function app.record_client_consent(text, text[], text[], text, text) to app_request;
grant execute on function app.revoke_client_grant(text) to app_request;
grant execute on function app.permissions_allowed(text[]) to app_request;
revoke execute on function auth.uid() from authenticated;
revoke execute on function auth.jwt() from authenticated;
revoke usage on schema auth from authenticated;
