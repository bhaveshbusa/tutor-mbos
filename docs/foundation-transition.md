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
- Hosted acceptance, mail, authorization, and the run-specific cleanup workflow and scripts.
- `TUTOR_MBOS_APP_DATABASE_URL` as a request credential. An existing copy can stay; the app does not read it.

## Forward database change

`20261017220000_user_scoped_access.sql` grants `authenticated` the privileges the third applied file revoked, and adds the public functions the Data API calls. It does not drop roles, tables, or rows. `anon` still has no access to `app`. If the hosted Data API is later pointed at `app`, the same policies still hide other tenants and revoked grants.

CI proves this on an empty database and on a database that already has a business row. It does not connect to the hosted project.
