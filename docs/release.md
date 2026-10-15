# Release and migration policy

This is the continuing delivery policy confirmed on 15 October 2026. It applies to every change after the initial release as well as to this one. Plan approval is not production approval.

## Production releases

Every production release requires the user's explicit sign-off on the specific candidate and its migration set. That includes future features, fixes, dependency updates and database changes. Completing the initial release does not authorize later production releases.

The user chooses sign-off testing. Routine tests, review and deployment execution stay automated. Coding agents must not deploy production or set `PRODUCTION_RELEASES_ENABLED`.

A candidate reaches production only through `.github/workflows/release-production.yml`: it must already be on `main`, have passed development deployment, pass CI, be approved on the protected `production` GitHub environment, and have `PRODUCTION_RELEASES_ENABLED=true`. Application rollback does not reverse database changes.

## Database migrations

- Migrations live in `supabase/migrations` and are checksummed in `supabase/migrations/manifest.json`.
- Apply the same reviewed files to development before any production consideration. The manual workflow is *Migrate development*. It refuses a production database URL and refuses the `app_runtime` login.
- Fresh-install and populated-upgrade tests, a failed-migration rollback test, and a target/drift check run in CI without secrets.
- Never edit a migration that has been applied. Add a corrective migration.
- The runner takes a session advisory lock and applies each file in its own transaction, in manifest order.
- Destructive changes need a reviewed recovery plan and verified backup coverage. Emergency fixes do not skip these gates unless the user explicitly authorizes the exception.

Development migration credentials are GitHub environment secrets, not repository files and not agent workspace variables:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_MIGRATION_DATABASE_URL` | Development DDL login (`postgres` or `supabase_admin` on `idvzjqrkgnihvxoswuxu` only) |
| `APP_RUNTIME_PASSWORD` | Password for the non-superuser `app_runtime` role |

The running app uses `TUTOR_MBOS_APP_DATABASE_URL` on the Vercel development project. The username must be `app_runtime`. It is not a `NEXT_PUBLIC_` variable and it is not the migration URL. Requests set the database role to `app_request`, which cannot bypass row level security. The service role is not a business-request client. The migration URL must be a direct or session-mode connection. Port 6543, the transaction pooler, is rejected because the migration lock is session-scoped. Development apply checks `has_schema_privilege('authenticated', 'app', 'USAGE')` is false, then in one transaction grants the migration login `SET` on `app_request`, runs `set local role app_request; select auth.uid()`, and rolls that grant back. A hosted `postgres` login on Postgres 16+ can administer `app_request` without already being allowed to assume it. The call fails, and the original database error is kept, when `app_request` lacks usage on schema `auth` or execute on the function. The migration set does not revoke `authenticated` from schema `auth`, because hosted RLS, Storage and Realtime use those grants. `auth.uid()` for `app_request` is granted in the first migration and must still succeed on the hosted project.

## What this increment does not claim

Hosted development migration, Supabase OAuth server enablement, and live ChatGPT / second MCP client sessions are not evidenced until those platform steps have run. Automated tests cover the contract, tokens, RLS and client paths. The hosted check that issued MCP tokens use audience `authenticated` rather than the resource URL is still outstanding. The hosted check must also record the Supabase Auth secure password change setting, because password update accepts any current UI session. TOS-3 stays open until independent review and hosted positive and negative evidence are recorded. Neither green CI nor an automated review authorizes production.
