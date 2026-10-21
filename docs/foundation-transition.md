# Foundation transition (TOS-29)

Compared with current `main` and the pre-TOS-3 tree `df683429b49d29e570bec9daa70b35b17764203b`.

## Keep

- The pre-TOS-3 layout: Next.js UI and HTTP adapters, shared application and domain layers, environment bindings, CI, and the development/production deploy workflows.
- Application authorization: business permissions, server-side grants, consent, revocation, and idempotent business creation.
- The three applied SQL files and their row level security. They are not edited.
- Supabase Auth for sign-in, recovery, and the OAuth consent redirect. Cookie sessions stay on `@supabase/ssr`.
- Protected secrets in GitHub environments and Vercel. Pull requests still receive none.

## Replace

- Token checks use `supabase.auth.getClaims()` for the signature and `getUser()` for a revoked Auth session. Issuer, audience, role, and subject are read from those verified claims.
- Business reads and writes use the user's access token through the Supabase client. Postgres runs security-invoker functions as `authenticated`.
- MCP uses `@modelcontextprotocol/sdk` streamable HTTP. One smoke test uses that SDK's client. Named products are not special clients. Further product checks belong to TOS-7.
- Hosted migrations use `supabase db push`. The CLI skips versions already in `supabase_migrations.schema_migrations`.

## Remove

- The custom JWT parser, SCRAM password builder, `app_runtime` provisioning, and the migration runner.
- Hosted acceptance, mail, authorization, and the run-specific cleanup workflow and scripts. The manual `foundation-hosted-check` workflow is not that harness. It reuses the existing development environment, the existing receiving key, and the official MCP SDK. It does not restore the acceptance orchestrator, cleanup state, or admin key.
- `TUTOR_MBOS_APP_DATABASE_URL` as a request credential. An existing copy can stay; the app does not read it.

## Forward database change

`20261017220000_user_scoped_access.sql` grants `authenticated` the privileges the third applied file revoked, and adds the public functions the Data API calls. It does not drop roles, tables, or rows. `anon` still has no access to `app`. If the hosted Data API is later pointed at `app`, the same policies still hide other tenants and revoked grants.

CI proves this on an empty database and on a database that already has a business row. It does not connect to the hosted project.

## Hosted history and what is not proved yet

The last development migration job that ran is [Deploy development run 39021652199](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39021652199), commit `74737aad42d4b8c71da4221d8df5dfecce6d3917`, on 17 October 2026. Its log says the migrations were already applied and prints the ledger:

- `20261015120000` `tenant_security` `6c2b8d5fd737be6ae8e692544fde72ddc74c22d1392c1751982840a55e269eff`
- `20261015121000` `restrict_delegated_access` `1dac10609dd055ef2dacad846e6431a7d2ef67125d28761f9a0c484489fa14e7`
- `20261015122000` `review_access_fixes` `4a038b61668e97332c1983d950f6464ff9b4af06bbb589539fd6e3c171346355`

Those checksums match the files in git. The old runner wrote `supabase_migrations.schema_migrations` (`version`, `statements`, `name`), which is the table `supabase db push` reads. Later development deploys [39054039678](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39054039678), [39068821624](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39068821624), [39071971070](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39071971070), and [39072594740](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39072594740) skipped the migration job. No manual *Migrate development* run is recorded. [Deploy development run 39106750935](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39106750935) at `71913653949e17baf87a1cd18843d71f5c3ec2ba` saw a matching prefix and applied `20261017220000_user_scoped_access.sql` with `supabase db push`. CLI 2.121.0 records that file as trimmed statements, not as the raw file bytes. [Deploy development run 39694123444](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39694123444) at `e50f5b1eec9040c64f8c6c5c79cd163b268775ed` then failed closed with `checksum_mismatch` and applied no SQL, so the deploy was skipped. The three earlier files stay immutable. The ledger now accepts either the raw file bytes or that CLI statement list.

CI run [39076405972](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39076405972) and the workspace `pnpm check` prove fail-closed browser forms, PGlite isolation and migration tests, and an official MCP SDK client against a local HTTP server. That client is the SDK, not a ChatGPT, Claude, or other named product connection. Named-product checks stay on TOS-7.

Not proved, and not claimed: a successful development sign-in, recovery, or onboarding; a hosted Data API call under row level security; a delegated permission check on the hosted project; a hosted MCP connection. This workspace has no publishable key, migration URL, or Vercel token. Reading the `development` environment secrets returns 403, and the development alias is behind deployment protection. Those credentials stay in the protected environment. The post-merge development workflow is the path that applies the forward migration and smoke-tests the deployment.

## Consent calls that stay

`@supabase/auth-js` 2.117.3 covers the session, `getClaims`, and `getUser`. It has no method for the OAuth authorization-server resource. Supabase Auth remains that server (`authorization_url_path = /oauth/consent`). The app calls Auth's HTTP API: `GET` and `POST /auth/v1/oauth/authorizations/:id` and `DELETE /auth/v1/user/oauth/grants`. Business permissions are rows in `app.client_grants`, not OAuth scopes, so the consent form writes the grant and then posts Auth's approve or deny. Issuer, audience, role, and `client_id` checks sit on the verified claims. Cookie writes require the site origin. Loopback may use `localhost` or `127.0.0.1` on the same port, because Next rewrites the request URL. `Origin: null` is refused. None of this is a second token parser, password hasher, or protocol engine.

Before `supabase db push`, the workflow reads `supabase_migrations.schema_migrations` and refuses an unknown version, a checksum mismatch, a name mismatch, or a gap. Statements match the reviewed file when they concatenate to its bytes or when they equal the CLI 2.121.0 `splitAndTrim` list. The CLI still applies only pending files. The password is not a process argument: CLI 2.121.0 has no connection-string environment variable, and `PGPASSWORD` is the supported way to keep it off `--db-url`. The manual production release checks `PRODUCTION_RELEASES_ENABLED=true` and `PRODUCTION_SIGNED_OFF_SHA` for that candidate, checks the Vercel token and project binding, then applies the same files, then builds. This session does not set either value and does not dispatch production.
