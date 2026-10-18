# Access contract 2026-10-17

Implementation owner: Cursor, for TOS-3. One owner changes this contract. UI, API and MCP call the same application functions and the same database policies.

Executable copy: `src/server/domain/access-contract.ts` and `src/server/domain/access-decision.ts`. Schema: `supabase/migrations`.

## Identity

Supabase Auth issues sessions and OAuth 2.1 access tokens (authorization code with PKCE). This service does not issue tokens and does not hold a JWT secret or service-role key. Verification uses `supabase.auth.getClaims()` and then `getUser()`.

| Path | Presentation | Validation |
| --- | --- | --- |
| UI session | Supabase auth cookie | `getClaims()` checks the signature and expiry. The app then requires issuer, audience, `role=authenticated`, and no `client_id`. `getUser()` confirms the subject |
| Delegated OAuth | `Authorization: Bearer` | The same checks, with `client_id` required, then the server grant |

A bearer token is never upgraded by a cookie. A token that has `client_id` is never an owner session. Audience must be `authenticated` or this deployment's MCP resource URL, and every audience value must be on that list. Supabase currently issues OAuth access tokens with audience `authenticated`. Accepting that audience on `/api/mcp` is a known deviation from RFC 8707 resource indicators. Delegated MCP calls still require `client_id` and a live grant. A hosted check must record whether issued tokens include the MCP resource audience; once they do, a later contract version requires that audience for MCP.

## Permissions

Business permissions are `business.read`, `business.onboard` and `reports.read`. OIDC scopes `openid`, `email`, `profile` and `phone` do not grant them. Neither does `user_metadata`, `app_metadata`, or a tenant id supplied in a header, query or body.

The UI session has all three permissions because it is the account owner. There are no staff roles. A delegated client receives only the permissions stored in `app.client_grants` for that owner and client. Revocation is checked on the next request. There is no permission cache.

## Tenancy

One business per owner. Creation is idempotent: a later call returns the existing business and does not rename it or attach the account to a business id from the request. Similar names are distinct rows. Row level security, forced even for the table owner, ties every row to `app.auth_uid()`, a security-definer read of `auth.uid()` owned by the migration login. Delegated reads also require a live grant. The Data API exposes `public` only (`supabase/config.toml`). The app calls security-invoker functions there, which run as `authenticated` under the existing policies. `anon` has no privilege on `app` or those functions. A JWT whose role claim is not `authenticated` sees no rows. Hosted project settings must keep `app` out of the exposed schemas; if that changes, the same policies still apply.

## Clients

| Profile | Registration | Transport |
| --- | --- | --- |
| Admin UI | First party | Cookie, origin must be the environment site |
| HTTP API | Pre-registered public client, PKCE S256 | Bearer |
| A dynamically registered client | Dynamic registration at Supabase | Bearer, protected-resource discovery |
| Another MCP client | Pre-registered or dynamic | Bearer, same discovery document |

Consent is an explicit form. The stored client id comes from Supabase's authorization details, not from the form. Checked permissions are stored; unchecked and unknown values are not. The browser is redirected only to the HTTPS URL Supabase returns.

## Revocation and recovery

Grant revocation is a UI-session action. It first deletes the Supabase OAuth grant (`DELETE /auth/v1/user/oauth/grants?client_id=`). A 204 and a 404 whose `error_code` is `oauth_consent_not_found` both mean no Supabase grant remains, including a first denial and a retry after a partial success. Any other 404, including `feature_disabled`, any other status, or a network error returns 502 and leaves the app grant unchanged. The app grant is then marked revoked. A later denial of that client also revokes the app grant. Revocation takes effect on the next request, even if the access token has not expired. Auth-server session revocation fails `GET /user` on the next request, which this app returns as HTTP 401. An app grant without `business.read` is HTTP 403. The hosted revocation case passes only when revoke returned 200 and that next bearer read is 401 or 403 with no business id. Account recovery uses Supabase email recovery to the allowlisted `/auth/recovery` only, then `/auth/update-password` sets the new password for the current UI session. It does not require a recovery AMR. The hosted check must record the project's secure password change setting. This app does not accept a caller-supplied recovery redirect. Route handlers write rotated cookies when a UI access token is inside the refresh window. Server-rendered pages read the stored cookie and do not refresh, so a render cannot rotate the refresh token and drop the new cookies. Within 90 seconds of access-token expiry, `/business` and `/oauth/consent` therefore show the signed-out or consent form until a route handler refreshes the session. That is the behaviour for this increment. Approval stores the client's registered redirect. An already-consented redirect is followed only when its origin and path match exactly one live grant. A `client_id` query parameter is not a match.

## Out of scope for this contract version

Financial data, full reporting catalogues, and production OAuth enablement. The setup report is the isolation check for `reports.read`.
