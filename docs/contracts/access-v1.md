# Access contract 2026-10-15

Implementation owner: Cursor, for TOS-3. One owner changes this contract. UI, API and MCP call the same application functions and the same database policies.

Executable copy: `src/server/domain/access-contract.ts` and `src/server/domain/access-decision.ts`. Schema: `supabase/migrations`.

## Identity

Supabase Auth issues sessions and OAuth 2.1 access tokens (authorization code with PKCE). This service does not issue tokens and does not hold a JWT secret or service-role key.

| Path | Presentation | Validation |
| --- | --- | --- |
| UI session | Supabase auth cookie | Asymmetric signature, issuer, audience, expiry, `role=authenticated`, no `client_id`, then Auth `GET /user` confirms the subject |
| Delegated OAuth | `Authorization: Bearer` | Same signature checks, `client_id` required, then Auth `GET /user`, then the server grant |

A bearer token is never upgraded by a cookie. A token that has `client_id` is never an owner session. Audience must be `authenticated` or this deployment's MCP resource URL, and every audience value must be on that list. Accepted algorithms are ES256 and RS256. HS256 and `none` are rejected. Clock skew is 5 seconds.

## Permissions

Business permissions are `business.read`, `business.onboard` and `reports.read`. OIDC scopes `openid`, `email`, `profile` and `phone` do not grant them. Neither does `user_metadata`, `app_metadata`, or a tenant id supplied in a header, query or body.

The UI session has all three permissions because it is the account owner. There are no staff roles. A delegated client receives only the permissions stored in `app.client_grants` for that owner and client. Revocation is checked on the next request. There is no permission cache.

## Tenancy

One business per owner. Creation is idempotent: a later call returns the existing business and does not rename it or attach the account to a business id from the request. Similar names are distinct rows. Row level security, forced even for the table owner, ties every row to `auth.uid()`. Delegated reads also require a live grant. The `app` schema is not exposed to the Data API (`supabase/config.toml` publishes only `public`). `anon` has no access. A JWT whose role claim is not `authenticated` sees no rows.

## Clients

| Profile | Registration | Transport |
| --- | --- | --- |
| Admin UI | First party | Cookie, origin must be the environment site |
| HTTP API | Pre-registered public client, PKCE S256 | Bearer |
| ChatGPT | Dynamic registration at Supabase | Bearer, protected-resource discovery |
| Another MCP client | Pre-registered or dynamic | Bearer, same discovery document |

Consent is an explicit form. The stored client id comes from Supabase's authorization details, not from the form. Checked permissions are stored; unchecked and unknown values are not. The browser is redirected only to the HTTPS URL Supabase returns.

## Revocation and recovery

Grant revocation is a UI-session action and takes effect on the next request, even if the access token has not expired. Auth-server session revocation fails `GET /user` on the next request. Account recovery uses Supabase email recovery to the allowlisted `/auth/callback` only. This app does not accept a caller-supplied recovery redirect.

## Out of scope for this contract version

Financial data, full reporting catalogues, and production OAuth enablement. The setup report is the isolation check for `reports.read`.
