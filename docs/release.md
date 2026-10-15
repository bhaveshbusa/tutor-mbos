# Release and migration policy

This is the continuing delivery policy confirmed on 15 October 2026. It applies to every change after the initial release as well as to this one. Plan approval is not production approval.

## Production releases

Every production release requires the user's explicit sign-off on the specific candidate and its migration set. That includes future features, fixes, dependency updates and database changes. Completing the initial release does not authorize later production releases.

The user chooses sign-off testing. Routine tests, review and deployment execution stay automated. Coding agents must not deploy production or set `PRODUCTION_RELEASES_ENABLED`.

A candidate reaches production only through `.github/workflows/release-production.yml`: it must already be on `main`, have passed development deployment, pass CI, be approved on the protected `production` GitHub environment, and have `PRODUCTION_RELEASES_ENABLED=true`. Application rollback does not reverse database changes.

## Database migrations

- Migrations live in `supabase/migrations` and are checksummed in `supabase/migrations/manifest.json`.
- Apply the same reviewed files to development before any production consideration. A push to `main` runs CI, then those migrations and privilege checks, then development deploy, smoke and promotion. *Migrate development* is only a manual recovery entry and shares the `development-delivery` concurrency group with that sequence. Both refuse a production database URL and the `app_runtime` login. Pull requests do not receive migration or deploy secrets.
- Fresh-install and populated-upgrade tests, a failed-migration rollback test, and a target/drift check run in CI without secrets.
- Never edit a migration that has been applied. Add a corrective migration.
- The runner takes a session advisory lock, checks the recorded ledger against the reviewed files, and only then applies each pending file in its own transaction, in manifest order. A recorded version that is not in the reviewed set, a checksum or name that does not match the file, or a history that skips an earlier version stops the run before any pending SQL.
- Destructive changes need a reviewed recovery plan and verified backup coverage. Emergency fixes do not skip these gates unless the user explicitly authorizes the exception.

Development migration credentials are GitHub environment secrets, not repository files and not agent workspace variables:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_MIGRATION_DATABASE_URL` | Development DDL login (`postgres` or `supabase_admin` on `idvzjqrkgnihvxoswuxu` only) |
| `APP_RUNTIME_PASSWORD` | Password for the non-superuser `app_runtime` role |

The running app uses `TUTOR_MBOS_APP_DATABASE_URL` on the Vercel development project. The username must be `app_runtime`. It is not a `NEXT_PUBLIC_` variable and it is not the migration URL. Requests set the database role to `app_request`, which cannot bypass row level security. The service role is not a business-request client. The migration URL must be a direct or session-mode connection. Port 6543, the transaction pooler, is rejected because the migration lock is session-scoped. The migration login is the documented `postgres` or `supabase_admin` role. It must already be able to execute `auth.uid()` and `auth.jwt()`. The migration does not grant on schema `auth` and does not need a platform superuser or a manual grant from the `auth` owner. `app_request` calls `app.auth_uid()` and `app.auth_jwt()`, security-definer functions owned by the migration login. Development apply checks `has_schema_privilege('authenticated', 'app', 'USAGE')` is false, then in one transaction grants the migration login `SET` on `app_request` by quoting `format('%I', current_user)`, runs `set local role app_request; select app.auth_uid()`, and rolls that grant back. The current_user, current_role, and session_user keywords are not GRANT role specifications: on supabase/postgres 17.6.1.011 that form crashes the backend. A hosted `postgres` login on Postgres 16+ can administer `app_request` without already being allowed to assume it. The call fails, and the original database error is kept, when `app_request` cannot execute `app.auth_uid()`. The migration set does not revoke `authenticated` from schema `auth`, because hosted RLS, Storage and Realtime use those grants.

## Development setup and acceptance

Names only. Do not copy secret values into the repository, a pull request, or an agent workspace.

| Name | Location | Evidence on 15 October 2026 |
| --- | --- | --- |
| `TUTOR_MBOS_ENV` | Vercel project `tutor-mbos-dev` → Settings → Environment Variables → Production | Present. Metadata-only read. |
| `NEXT_PUBLIC_SUPABASE_URL` | Same Vercel location | Present. Metadata-only read. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same Vercel location | Absent. Promotion fails until it is set. |
| `TUTOR_MBOS_APP_DATABASE_URL` | Same Vercel location | Absent. Username must be `app_runtime`. Promotion fails until it is set. |
| `SUPABASE_MIGRATION_DATABASE_URL` | GitHub → Settings → Environments → `development` → Secrets | Availability unverified. The migration step fails before promotion if it is absent. |
| `APP_RUNTIME_PASSWORD` | Same GitHub secrets location | Availability unverified. The migration step fails before promotion if it is absent. |
| `VERCEL_TOKEN` | Same GitHub secrets location | Required by the existing development deploy. Not re-read for this note. |

Supabase Auth settings still to record on development project `idvzjqrkgnihvxoswuxu`: OAuth server enabled, exact site and redirect URLs, and the secure password change setting. Hosted acceptance still open: development migration apply, a hosted MCP token audience sample, a live ChatGPT handshake, a second MCP client handshake, and positive and negative checks for two synthetic tenants. Review handoffs stay on Linear and the pull request.

## What this increment does not claim

Hosted development migration, Supabase OAuth server enablement, and live ChatGPT / second MCP client sessions are not evidenced until those platform steps have run. Automated tests cover the contract, tokens, RLS and client paths. The hosted check that issued MCP tokens use audience `authenticated` rather than the resource URL is still outstanding. The hosted check must also record the Supabase Auth secure password change setting, because password update accepts any current UI session. TOS-3 stays open until independent review and hosted positive and negative evidence are recorded. Neither green CI nor an automated review authorizes production.
