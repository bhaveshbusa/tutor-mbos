-- Corrective migration. Denial revokes the previous grant. Approval stores
-- the client's registered redirect so reconnection can match it. The
-- authenticated API role loses direct access to schema app. The request
-- path remains app_request. This file does not change grants on schema
-- auth: authenticated keeps auth.uid() and auth.jwt() for platform RLS,
-- and app_request already receives those grants in 20261015120000.
-- Not applied to a hosted database. Revised in place before any apply.

alter table app.client_grants
  add column registered_redirect_uri text;

drop function app.record_client_consent(text, text[], text[], text, text);

create function app.record_client_consent(
  p_oauth_client_id text,
  p_permissions text[],
  p_scopes text[],
  p_authorization_id text,
  p_decision text,
  p_redirect_uri text
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
      permissions,
      registered_redirect_uri
    )
    values (
      auth.uid(),
      (select b.id from app.businesses b where b.owner_user_id = auth.uid()),
      p_oauth_client_id,
      p_permissions,
      p_redirect_uri
    )
    on conflict (owner_user_id, oauth_client_id) do update
    set permissions = excluded.permissions,
        revoked_at = null,
        granted_at = now(),
        business_id = coalesce(client_grants.business_id, excluded.business_id),
        registered_redirect_uri = excluded.registered_redirect_uri;
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
revoke all on function app.record_client_consent(text, text[], text[], text, text, text) from public, anon;
grant execute on function app.create_business(text, text) to app_request;
grant execute on function app.record_client_consent(text, text[], text[], text, text, text) to app_request;
grant execute on function app.revoke_client_grant(text) to app_request;
grant execute on function app.permissions_allowed(text[]) to app_request;
