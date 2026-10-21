# Release and migration policy

This policy applies to every change, including the initial release and everything after it. Plan approval is not production approval. Ordinary delivery is a pull request, required CI, one independent review, and a merge to `main` by the implementation owner after that review approves. The merge runs development deployment. Production stays on the manual gate below.

Development delivery runs migrations only when reviewed migration inputs changed since the last successful development delivery. Those inputs are the `src` tree, the `scripts` tree, `supabase/migrations`, `.github/workflows/apply-development-migrations.yml`, `.github/actions/setup`, `package.json`, `pnpm-lock.yaml`, and `.nvmrc`. Covering the whole source and scripts trees is deliberate: a later change anywhere in those trees takes the migration path. That keeps package, lockfile, Node, and setup changes on the migration path without a dependency checker. A push with no change in that set still deploys and smoke-tests the commit, and it skips the migration job. Manual *Deploy development* or *Migrate development* runs migrations. Pull request 20 is closed and unmerged. The user closed it. Its branch `cursor/tos3-runtime-credential-7a24` and its history stay. Do not reopen it, merge it, or clean it up.

`main` requires the five CI checks for everyone. Pull request 22 was `REVIEW_REQUIRED` and `BLOCKED` until review [5560048624](https://github.com/bhaveshbusa/tutor-mbos/pull/22#pullrequestreview-5560048624) approved `eb0945a3d6d274c800a329e2f64b3e1258d39777`, after which GitHub reported `APPROVED` and `CLEAN`. The token available to implementation sessions still cannot read the full protection rule: `GET /branches/main/protection` returns 403. Stale-review dismissal has not been tested. The implementation owner merges only after that independent approval and green required CI.

The implementation owner records the pull request, HEAD, CI and deployment links on the Linear issue. One component dispatches the review. Do not add a coordinator, webhook relay or second scheduler.

## Production releases

Every production release requires the user's explicit sign-off on the specific candidate and its migration set. That includes future features, fixes, dependency updates and database changes. Completing the initial release does not authorize later production releases.

The user chooses sign-off testing. Routine tests, review and deployment execution stay automated. Coding agents must not deploy production or set `PRODUCTION_RELEASES_ENABLED`.

A candidate reaches production only through `.github/workflows/release-production.yml`: it must already be on `main`, have passed development deployment, pass CI, be approved on the protected `production` GitHub environment, have `PRODUCTION_RELEASES_ENABLED=true`, and have `PRODUCTION_SIGNED_OFF_SHA` equal to that candidate. The user sets the SHA when signing off that commit and its migration set. Coding agents must not set either value. The release checks the Vercel token and project binding before any SQL, then applies the reviewed files, then builds. Application rollback does not reverse database changes.

## Database migrations

- Migrations live in `supabase/migrations`. Already-applied files are immutable. Add a new file for a change.
- Hosted development applies them with `node scripts/migration-url.ts --push`. That runs `supabase db push --yes --skip-vault`. CLI 2.121.0 accepts the connection string only as `--db-url` and does not read `SUPABASE_DB_URL`, so the script passes a URL with no password and puts the password in `PGPASSWORD`. The CLI records versions in `supabase_migrations.schema_migrations` and skips versions already present. It does not edit or delete unknown rows.
- Apply the same reviewed files to development before any production consideration. A push to `main` runs CI, then a name-only check of the development Vercel configuration, then those migrations when the inputs above changed, then development deploy, smoke and promotion. A missing publishable key stops the run before hosted SQL and before promotion. *Migrate development* is only a manual recovery entry. It shares the `development-delivery` concurrency group with `queue: max` and `cancel-in-progress: false`.
- Fresh-install and populated-upgrade tests run in CI without secrets, by applying the SQL files in order on an empty database. A failed statement in a transaction leaves the earlier version recorded.
- The workflow inspects the migration URL before the CLI connects. Development refuses a production project, a request role, and port 6543. It then compares the recorded ledger with the reviewed files and refuses an unknown version, a checksum mismatch, a renamed file, or a gap. It prints a reason code and does not print the URL or SQL. The manual production release uses the same comparison against the production project, after release enablement and before deploy.
- Destructive changes need a reviewed recovery plan and verified backup coverage. Emergency fixes do not skip these gates unless the user explicitly authorizes the exception.

Business requests do not use a database password. The signed-in user's Supabase access token calls security-invoker functions in `public`, and row level security runs as `authenticated`. The service role is not a business-request client. `app_request` and any existing `app_runtime` role are left in place by the forward migration and are not provisioned.

| Secret | Purpose |
| --- | --- |
| `SUPABASE_MIGRATION_DATABASE_URL` | Development DDL login (`postgres` or `supabase_admin` on `idvzjqrkgnihvxoswuxu` only). Direct or session-mode connection, not port 6543. |

## Development secret names

Names only. Do not copy secret values into the repository, a pull request, or an agent workspace.

| Name | Location |
| --- | --- |
| `TUTOR_MBOS_ENV` | Vercel project `tutor-mbos-dev` → Settings → Environment Variables → Production |
| `NEXT_PUBLIC_SUPABASE_URL` | Same Vercel location |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same Vercel location. The preflight stops before migrations and promotion until it is set. |
| `SUPABASE_MIGRATION_DATABASE_URL` | GitHub → Settings → Environments → `development` → Secrets. The migration step stops before SQL until it is set. |
| `VERCEL_TOKEN` | Same GitHub secrets location. The preflight stops before migrations and promotion until it is set. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | GitHub environment `development`. Deploy smoke reads the project's existing Protection Bypass for Automation with `VERCEL_TOKEN` when that token is present, and uses this name as the fallback. Do not generate a new secret. It grants no API or MCP access. |

`APP_RUNTIME_PASSWORD` and `TUTOR_MBOS_APP_DATABASE_URL` are no longer read. Leave any existing copies where they are. Do not create `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY` or `RESEND_DEVELOPMENT_RECEIVING_API_KEY`. An existing `RESEND_DEVELOPMENT_RECEIVING_API_KEY` in the `development` environment is the synthetic-only Resend receiving key. `.github/workflows/foundation-hosted-check.yml` is the only workflow that reads it, and only inside that protected job. Do not create a replacement, and do not copy the value into a workspace, log, issue, or artifact.

Pull request 20 is closed and unmerged. Do not reopen or merge it, and do not clean up its branch or history. Already-applied migrations stay immutable. Neither required CI nor an independent review authorizes production.
