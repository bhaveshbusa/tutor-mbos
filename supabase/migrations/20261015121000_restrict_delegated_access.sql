-- Corrective migration for access contract 2026-10-15.
-- Adds the setup report and rejects tokens whose role claim is not
-- authenticated. Does not rewrite 20261015120000_tenant_security.sql.
-- Existing business rows stay in place.

revoke all on schema app from public, anon;
revoke all on all tables in schema app from public, anon;
revoke all on all functions in schema app from public, anon;

create policy businesses_authenticated_role on app.businesses
  as restrictive for all
  to app_request, authenticated
  using ((app.auth_jwt() ->> 'role') = 'authenticated')
  with check ((app.auth_jwt() ->> 'role') = 'authenticated');

create policy grants_authenticated_role on app.client_grants
  as restrictive for all
  to app_request, authenticated
  using ((app.auth_jwt() ->> 'role') = 'authenticated')
  with check ((app.auth_jwt() ->> 'role') = 'authenticated');

create policy consents_authenticated_role on app.oauth_consents
  as restrictive for all
  to app_request, authenticated
  using ((app.auth_jwt() ->> 'role') = 'authenticated')
  with check ((app.auth_jwt() ->> 'role') = 'authenticated');

create policy creation_keys_authenticated_role on app.business_creation_keys
  as restrictive for all
  to app_request, authenticated
  using ((app.auth_jwt() ->> 'role') = 'authenticated')
  with check ((app.auth_jwt() ->> 'role') = 'authenticated');

create policy audit_authenticated_role on app.access_audit
  as restrictive for all
  to app_request, authenticated
  using ((app.auth_jwt() ->> 'role') = 'authenticated')
  with check ((app.auth_jwt() ->> 'role') = 'authenticated');

create view app.setup_report
with (security_invoker = true) as
select id as business_id, display_name, owner_user_id
from app.businesses;

revoke all on app.setup_report from public, anon;
grant select on app.setup_report to app_request, authenticated;
grant execute on all functions in schema app to app_request, authenticated;
