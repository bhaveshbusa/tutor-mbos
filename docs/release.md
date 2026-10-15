# Release and migration policy

This is the continuing delivery policy confirmed on 15 October 2026. It applies to every change after the initial release as well as to this one. Plan approval is not production approval.

## Production releases

Every production release requires the user's explicit sign-off on the specific candidate and its migration set. That includes future features, fixes, dependency updates and database changes. Completing the initial release does not authorize later production releases.

The user chooses sign-off testing. Routine tests, review and deployment execution stay automated. Coding agents must not deploy production or set `PRODUCTION_RELEASES_ENABLED`.

A candidate reaches production only through `.github/workflows/release-production.yml`: it must already be on `main`, have passed development deployment, pass CI, be approved on the protected `production` GitHub environment, and have `PRODUCTION_RELEASES_ENABLED=true`. Application rollback does not reverse database changes.

## Database migrations

- Migrations live in `supabase/migrations` and are checksummed in `supabase/migrations/manifest.json`.
- Apply the same reviewed files to development before any production consideration. A push to `main` runs CI, then a name-only check of the development Vercel configuration, then those migrations and privilege checks, then development deploy, smoke and promotion. A missing publishable key or `TUTOR_MBOS_APP_DATABASE_URL` stops the run before hosted SQL and before promotion. *Migrate development* is only a manual recovery entry. It shares the `development-delivery` concurrency group with `queue: max` and `cancel-in-progress: false`, so a recovery dispatch waits behind an in-progress delivery and does not cancel a delivery that is already queued. Both refuse a production database URL and the `app_runtime` login. Pull requests do not receive migration or deploy secrets.
- Fresh-install and populated-upgrade tests, a failed-migration rollback test, and a target/drift check run in CI without secrets.
- Never edit a migration that has been applied. Add a corrective migration.
- The runner takes a session advisory lock, checks the recorded ledger against the reviewed files, and only then applies each pending file in its own transaction, in manifest order. A recorded version that is not in the reviewed set, a checksum or name that does not match the file, or a history that skips an earlier version stops the run before any pending SQL.
- Destructive changes need a reviewed recovery plan and verified backup coverage. Emergency fixes do not skip these gates unless the user explicitly authorizes the exception.

Development migration credentials are GitHub environment secrets, not repository files and not agent workspace variables. The development deploy and the manual recovery workflow pass these two names into the reusable migration workflow. GitHub leaves an environment secret empty in a reusable workflow unless the caller passes it. The called job keeps `environment: development`, so the passed name resolves to that environment. Before any SQL, the workflow reports each secret as present or absent and does not print the value. When the migration URL is present but is not the development migration login, the apply script stops before opening a connection and prints one reason code (`invalid`, `binding_mismatch`, `app_runtime`, `privileged_user`, or `transaction_pooler`) with setup guidance. It does not print the value, host, username, password, length, hash, or parser error. A missing URL is reported separately and does not use those codes.

| Secret | Purpose |
| --- | --- |
| `SUPABASE_MIGRATION_DATABASE_URL` | Development DDL login (`postgres` or `supabase_admin` on `idvzjqrkgnihvxoswuxu` only) |
| `APP_RUNTIME_PASSWORD` | Password for the non-superuser `app_runtime` role |

The running app uses `TUTOR_MBOS_APP_DATABASE_URL` on the Vercel development project. The username must be `app_runtime`. It is not a `NEXT_PUBLIC_` variable and it is not the migration URL. Requests set the database role to `app_request`, which cannot bypass row level security. The service role is not a business-request client. The migration URL must be a direct or session-mode connection. Port 6543, the transaction pooler, is rejected because the migration lock is session-scoped. The migration login is the documented `postgres` or `supabase_admin` role. It must already be able to execute `auth.uid()` and `auth.jwt()`. The migration does not grant on schema `auth` and does not need a platform superuser or a manual grant from the `auth` owner. `app_request` calls `app.auth_uid()` and `app.auth_jwt()`, security-definer functions owned by the migration login. Development apply checks `has_schema_privilege('authenticated', 'app', 'USAGE')` is false, then in one transaction grants the migration login `SET` on `app_request` by quoting `format('%I', current_user)`, runs `set local role app_request; select app.auth_uid()`, and rolls that grant back. The current_user, current_role, and session_user keywords are not GRANT role specifications: on supabase/postgres 17.6.1.011 that form crashes the backend. A hosted `postgres` login on Postgres 16+ can administer `app_request` without already being allowed to assume it. The call fails, and the original database error is kept, when `app_request` cannot execute `app.auth_uid()`. The migration set does not revoke `authenticated` from schema `auth`, because hosted RLS, Storage and Realtime use those grants.

Development apply then provisions `app_runtime` for the ordinary `postgres` login. It sends neither `NOSUPERUSER` nor `NOBYPASSRLS`. Postgres 16 and later reject a non-superuser changing the SUPERUSER attribute; that detail says only a superuser may change the attribute. The detail that only a superuser may alter roles with the SUPERUSER attribute means the target role has `rolsuper`, and core Postgres uses it even when the statement only sets `LOGIN`. Changing the BYPASSRLS attribute has the matching detail. The apply reads `pg_roles`, membership options, effective memberships, the `app_request` flags, and shared dependencies. A missing role is created with `LOGIN NOINHERIT` only. An existing safe role may be given `LOGIN` and `NOINHERIT`. `app_request` is granted with `INHERIT FALSE, SET TRUE`, and only its ADMIN option is revoked. The password is a client-computed `SCRAM-SHA-256` verifier and is omitted from the log. Before that verifier is sent and before `app_runtime` is reported ready, the run stops when `app_runtime` has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, or `REPLICATION`; when its direct membership is not exactly one `app_request` row with admin false, inherit false, and set true; when `pg_has_role('app_runtime', oid, 'MEMBER')` is not exactly `app_runtime` and `app_request`; when `app_request` can log in or has those restricted attributes; or when `pg_shdepend` has an owner or ACL row for `app_runtime`. Restricted attributes stay unchanged. The role is not dropped or recreated. A database failure appends only an SQLSTATE of five letters or digits and omits the server message. The log prints each reviewed ledger version, name, and sha256, checks those lines against the reviewed migration set, then prints the role flags, membership options, effective memberships, `app_request` flags, and the owner or ACL count. Already-applied migration files stay unchanged.

## Development setup and acceptance

Names only. Do not copy secret values into the repository, a pull request, or an agent workspace.

| Name | Location |
| --- | --- |
| `TUTOR_MBOS_ENV` | Vercel project `tutor-mbos-dev` → Settings → Environment Variables → Production |
| `NEXT_PUBLIC_SUPABASE_URL` | Same Vercel location |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same Vercel location. The preflight stops before migrations and promotion until it is set. |
| `TUTOR_MBOS_APP_DATABASE_URL` | Same Vercel location. Username must be `app_runtime`. The preflight stops before migrations and promotion until the name is set. Vercel writes `[SENSITIVE]` for a Secret-type value, so the check confirms the name only. |
| `SUPABASE_MIGRATION_DATABASE_URL` | GitHub → Settings → Environments → `development` → Secrets. The migration step stops before SQL until it is set. |
| `APP_RUNTIME_PASSWORD` | Same GitHub secrets location. The migration step stops before SQL until it is set. |
| `VERCEL_TOKEN` | Same GitHub secrets location. The preflight stops before migrations and promotion until it is set. |

Supabase Auth settings still to record on development project `idvzjqrkgnihvxoswuxu`: OAuth server enabled, exact site and redirect URLs, and the secure password change setting. Hosted acceptance still open: development migration apply, a hosted MCP token audience sample, a live ChatGPT handshake, a second MCP client handshake, and positive and negative checks for two synthetic tenants. Review handoffs stay on Linear and the pull request.

## What this increment does not claim

Hosted development migration, Supabase OAuth server enablement, and live ChatGPT / second MCP client sessions are not evidenced until those platform steps have run. Automated tests cover the contract, tokens, RLS and client paths. The hosted check that issued MCP tokens use audience `authenticated` rather than the resource URL is still outstanding. The hosted check must also record the Supabase Auth secure password change setting, because password update accepts any current UI session. TOS-3 stays open until independent review and hosted positive and negative evidence are recorded. Neither green CI nor an automated review authorizes production.
