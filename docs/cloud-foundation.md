# Cloud foundation and delivery

This document covers TOS-2: repository layout, checks, environment configuration and the development/production delivery workflows. All commands run in cloud agent workspaces or GitHub Actions. Nothing here requires the owner's machine.

`/api/v1/health` stays public. Business, report and MCP routes require the access contract in `docs/contracts/access-v1.md`. Without Supabase Auth configuration those routes fail closed. MCP no longer answers anonymously.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/app/` | Next.js App Router: admin UI pages and thin route handlers |
| `src/app/api/v1/` | Versioned HTTP API routes; delegate to `src/adapters/http` |
| `src/app/api/mcp/` | MCP endpoint; delegates to `src/adapters/mcp` |
| `src/adapters/http/` | HTTP translation (JSON and RFC 9457 problem responses) |
| `src/adapters/mcp/` | MCP translation; disabled until TOS-3 |
| `src/server/application/` | Shared use cases called by every client (UI, API, MCP) |
| `src/server/domain/` | Pure business rules; no framework, I/O or adapter imports |
| `src/server/query/` | Allowlisted semantic queries and report definitions; never arbitrary SQL |
| `src/server/config/` | Reviewed environment bindings and runtime configuration validation |
| `scripts/` | Repository hygiene scan, deployment binding check, smoke test |
| `tests/` | Vitest suites (synthetic values only) |

ESLint and `tests/architecture.test.ts` enforce the dependency direction: `app → adapters → application → domain/query/config`. Server layers cannot import Next.js, React or adapters.

## Checks

`pnpm check` runs the same gates as CI except the audit:

| Command | Gate |
| --- | --- |
| `pnpm format:check` | Prettier |
| `pnpm lint` | ESLint (zero warnings), including layer boundaries |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm test` | Vitest |
| `pnpm hygiene` | Rejects tracked/untracked private files, credentials and real data |
| `pnpm build` | Production `next build` |
| `pnpm hygiene --artifact .next` | Secret scan of the build output |
| `pnpm audit --prod --audit-level=high` | Production dependency audit |

`.github/workflows/ci.yml` runs these on every pull request with a read-only token and no secrets. The deployment workflows call it before deploying.

## Runtime environment variables

Set these on each **Vercel project** under *Settings → Environment Variables*, environment **Production** (both projects deploy their main target; see below). Never put them in the repository. `.env.example` lists the names with placeholders only.

| Variable | `tutor-mbos-dev` | `tutor-mbos` | Notes |
| --- | --- | --- | --- |
| `TUTOR_MBOS_ENV` | `development` | `production` | Required |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://idvzjqrkgnihvxoswuxu.supabase.co` | `https://vblwjqfpcmegbugmufif.supabase.co` | Required; must match `TUTOR_MBOS_ENV` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_<dev placeholder>` | `sb_publishable_<prod placeholder>` | Publishable key from Supabase *Project Settings → API Keys*. Required for sign-in and token checks. |
| `TUTOR_MBOS_APP_DATABASE_URL` | `postgresql://app_runtime.<dev ref>:<password>@<pooler>:6543/postgres` | set only at a signed-off release | Server-only. Username must be `app_runtime` for that project. Not a service-role or migration URL. |

Rules enforced by `src/server/config/environments.ts` and the deployment workflows:

- A development deployment must point at the development Supabase project, and production at production. Swapped values fail the health check and block the deployment.
- `NEXT_PUBLIC_*` values are shipped to browsers. Secret keys (`sb_secret_…`), service-role JWTs and other credentials are rejected there.
- No Supabase secret key or service-role key is used by this increment. Do not add one to either Vercel project.

`TUTOR_MBOS_BUILD_COMMIT` is set by the workflows at build time so the health endpoint reports the deployed commit. It is not configured anywhere else.

## Secure configuration locations

| Where | What | Who sets it |
| --- | --- | --- |
| Vercel project `tutor-mbos-dev` → Environment Variables (Production) | Runtime variables above, development values | Owner or Codex |
| Vercel project `tutor-mbos` → Environment Variables (Production) | Runtime variables above, production values | Owner or Codex, at release time |
| GitHub → Settings → Environments → `development` → Secrets | `VERCEL_TOKEN` | Owner or Codex |
| GitHub → Settings → Environments → `production` → Secrets | `VERCEL_TOKEN` | Owner or Codex, at release time |
| GitHub environment secrets (optional fallback) | `VERCEL_AUTOMATION_BYPASS_SECRET` | Only if the smoke test cannot read the project's automation bypass with `VERCEL_TOKEN` |
| GitHub environment variables (optional) | `SMOKE_ALIAS_URL` | Stable alias (e.g. `https://<project>.vercel.app`) re-checked after promotion |
| GitHub → Settings → Environments → `production` → Variables | `PRODUCTION_RELEASES_ENABLED=true` | Owner, only after final sign-off |

Agent workspaces, pull request workflows and the repository never hold these values.

`VERCEL_TOKEN` is never passed on a command line; the Vercel CLI reads it from the step environment. Only the pull, deploy, smoke and promote steps receive it. The build step does not.

**Smoke tests and Deployment Protection.** Keep Deployment Protection enabled. `scripts/smoke-health.ts` reads the project's existing *Protection Bypass for Automation* through the Vercel API with `VERCEL_TOKEN`, in-process, and sends it only as a request header (masked in logs). It never creates or changes a bypass. `VERCEL_AUTOMATION_BYPASS_SECRET` is a fallback only. Neither value is an application token; they grant no API or MCP access. Unprotected aliases are not used for smoke tests.

## One-time platform setup

The Vercel projects and Supabase projects already exist. Do not recreate them.

1. **Vercel token.** Create a token scoped to team `lets-play-game` (`team_2QehRm248FPmHJTzKS0rvS6b`) at Vercel → Account Settings → Tokens. Prefer separate tokens for the `development` and `production` GitHub environments so either can be revoked alone. Vercel tokens are team-scoped, not project-scoped; the workflows pin the project IDs and verify the linked project before deploying.
2. **GitHub environment `development`.** Create it at GitHub → Settings → Environments. Restrict deployment branches to `main`. Add secrets `VERCEL_TOKEN`, `SUPABASE_MIGRATION_DATABASE_URL` and `APP_RUNTIME_PASSWORD`. Acceptance also needs `SUPABASE_DEVELOPMENT_ACCESS_TOKEN` (`auth_config_read` and `data_api_config_read` only) and `TUTOR_MBOS_APP_DATABASE_URL` (the development `app_runtime` connection, not the migration URL). A separate protected cleanup step needs `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY`. See `docs/release.md`. That admin name is recorded for review; do not create the secret until the cleanup design is accepted.
3. **GitHub environment `production`.** Create it. Restrict deployment branches to `main`. Add required reviewers (the owner) and enable *Prevent self-review*. Add secret `VERCEL_TOKEN`. Do not add `PRODUCTION_RELEASES_ENABLED` until final sign-off.
4. **Vercel runtime variables.** Add the variables in the table above to each project's Production environment.
5. **Vercel project settings.** For both projects: Framework Preset *Next.js*, Node.js version *24.x*. A Git connection is optional; `vercel.json` disables Git-triggered deployments so only the workflows deploy.
6. **Deployment Protection.** Keep it enabled on both projects. If it is enabled, enable *Protection Bypass for Automation* once in Vercel → project → Settings → Deployment Protection; the smoke test reads it with `VERCEL_TOKEN`, so no GitHub copy is needed. Store it as `VERCEL_AUTOMATION_BYPASS_SECRET` in the GitHub environment only if that lookup is not possible. Do not disable protection or smoke test through an unprotected alias.
7. **Stable alias (optional).** Set `SMOKE_ALIAS_URL` on a GitHub environment to re-check the promoted alias after each promotion.

## Development deployment

`.github/workflows/deploy-development.yml` runs on every push to `main` and on manual dispatch from `main`. It does not run on pull requests. The sequence is serialized with manual migration recovery and development acceptance by the concurrency group `development-delivery`, with `cancel-in-progress: false` and `queue: max`. A recovery or acceptance dispatch does not cancel a delivery that is already queued.

1. Reusable CI (all checks above).
2. Name-only preflight on project `prj_ysIJHdIKYk2MQwvOKermUvIMuGVa`: require `VERCEL_TOKEN`, `vercel pull`, then `scripts/assert-deploy-target.ts development`. The linked team and project must match the development binding, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `TUTOR_MBOS_APP_DATABASE_URL` must be present by name. A Secret-type value is pulled as `[SENSITIVE]`, so this step does not read the database username. If the token or either name is absent, the workflow stops before migrations, build, deploy and promotion and names the setup location.
3. Development migrations through `.github/workflows/apply-development-migrations.yml`: ledger drift check, privilege check, then pending SQL. The caller passes `SUPABASE_MIGRATION_DATABASE_URL` and `APP_RUNTIME_PASSWORD` by name from GitHub → Settings → Environments → `development` → Secrets. The migration job reports each secret as present or absent. If either is absent, the workflow stops before SQL and does not promote.
4. `vercel pull` again, then the same target check, so the build uses the reviewed project settings.
5. `vercel build --prod` in CI (no `VERCEL_TOKEN`), then a secret scan of `.vercel/output`.
6. `vercel deploy --prebuilt --prod --skip-domain` to `tutor-mbos-dev`. This creates the deployment without moving traffic. Development uses that project's main target because the project only ever holds synthetic data.
7. `scripts/smoke-health.ts` against that deployment URL: `/api/v1/health` must return `200`, `environment: development`, the development Supabase project ref and the deployed commit.
8. `vercel promote` only after the smoke test passes.
9. If `SMOKE_ALIAS_URL` is set, the promoted alias is smoke tested again.

*Migrate development* (`.github/workflows/migrate-development.yml`) remains a manual recovery entry for the same migration job. It uses the same concurrency group and queue, so it waits for an in-progress development delivery instead of overlapping it, and it does not cancel a delivery that is already pending. Routine pushes do not need that dispatch. Recovery does not run the Vercel preflight; it applies reviewed SQL only.

To rerun the whole sequence: GitHub → Actions → *Deploy development* → *Run workflow* on `main`.

## Development acceptance

`.github/workflows/accept-development.yml` runs only on manual dispatch from `main`. It uses the `development` environment and the concurrency group `development-delivery`, with `cancel-in-progress: false` and `queue: max`. An acceptance run waits behind an in-progress development delivery, and a later delivery waits behind acceptance. Neither cancels the other. Before signup it reads `/api/v1/health` and stops without creating users, consents, or database rows when the status, environment, project ref, or commit does not match the workflow SHA. It reads health again at the end and fails if that commit changed, so one report cannot mix two promotions.

The business-test step runs `scripts/hosted-acceptance.ts`. It uses Auth signup, rendered HTML for `/login`, `/business`, and `/oauth/consent`, the API, and MCP routes, OAuth discovery, and dynamic registration. It reads Auth and PostgREST settings with `GET` requests only. Direct database checks use `app_runtime` and `SET LOCAL ROLE app_request`, and every cleanup statement names the synthetic owner's business, user, and client ids. A visible set other than that one business aborts before any write. The step does not receive `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY` and does not call Auth admin routes. `DELETE /auth/v1/user` is not a supported route and is not used. Dynamic registration does not return a registration client URI or registration access token.

Auth user and OAuth client removal is a later step in the same job, `scripts/hosted-acceptance-cleanup.ts`, with `if: always()`. It alone receives `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY`. It does not receive the app database URL or the Management API token. The manifest written by the business step is untrusted. The cleanup step deletes a user only after `GET /auth/v1/admin/users/{id}` shows the email `tos3-{tenant-a|tenant-b}-{run nonce}@example.com`, and a client only after `GET /auth/v1/admin/oauth/clients/{client_id}` shows an allowlisted name and the redirect `https://example.com/oauth/callback`. Deletion is `DELETE` on those same admin paths. Hard delete is the documented session removal. There is no admin logout or admin grant route; the business step revokes grants with the user's token. At most two users and three clients are eligible. A missing or mismatched manifest deletes nothing. The admin credential is absent from preflight, so the job stops before signup rather than leaving fixtures behind.

That credential is the development project's Auth admin key. It can administer every Auth user on `idvzjqrkgnihvxoswuxu`. No narrower official token exists for these routes. Isolation is the separate step plus the manifest checks, not a scoped token. The read-only Management API token is not given delete permission. The secret name and location are prepared for review. Do not create the value until that review accepts this design.

Missing acceptance secrets are reported by name and the corresponding cases fail. Recorded gaps stay gaps: ChatGPT product consent, a second real MCP product's consent, recovery email callback, recovery completion, browser-driven form interaction, and UI cookie rotation outside the 90-second refresh window. Fetching rendered HTML is not a browser session, and cookie API calls are not rendered UI acceptance. A generic client is not ChatGPT and not the second MCP product. GitHub Actions and the Management API cannot authorize those products (https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication). The workflow prints sanitized pass, fail, and gap lines. It does not print tokens, messages, or connection values, and it does not change production.

Dispatch it after the development promotion for the commit under test: GitHub → Actions → *Accept development* → *Run workflow* on `main`.

## Production release

`.github/workflows/release-production.yml` never runs on push. It requires all of:

1. Manual dispatch from `main` with `candidate_sha` (full 40-character SHA).
2. The candidate is on `main` and has a successful *Deploy development* run.
3. Reusable CI passes for the candidate.
4. Approval on the protected `production` GitHub environment.
5. `PRODUCTION_RELEASES_ENABLED=true` on that environment.
6. Linked project is `tutor-mbos` (`prj_Ibov9zZm4KOvga3pWUQ83pInPJfQ`) and runtime variables match the production binding.
7. Artifact secret scan, then `vercel deploy --prebuilt --prod --skip-domain` (no traffic moved).
8. Smoke test of that deployment expecting `environment: production`, then `vercel promote`, then an optional re-check of `SMOKE_ALIAS_URL`. A failed smoke test leaves the current production deployment serving traffic.

The initial production release waits for final sign-off (see `AGENTS.md`).

## Cloud agent setup

Agents (Cursor, Devin) need no secrets for this repository:

```bash
corepack enable
corepack prepare pnpm@10.34.6 --activate
pnpm install --frozen-lockfile
pnpm check
```

Node.js 24 (`.nvmrc`) is required; `engine-strict` rejects other versions. To run the app in a workspace, use synthetic configuration that matches a binding, for example:

```bash
TUTOR_MBOS_ENV=development \
NEXT_PUBLIC_SUPABASE_URL=https://idvzjqrkgnihvxoswuxu.supabase.co \
pnpm dev
```

Do not run `vercel link`, `vercel env pull` or deployments from agent workspaces. Deployment credentials live only in the GitHub environments.

## What is excluded from Git and deployments

`.gitignore`, `.vercelignore` and `scripts/check-repo-hygiene.ts` exclude or reject: `.env*` files except `.env.example`, `.vercel/` state, key and certificate files, `private/`, `data/`, `exports/` directories, database files and dumps, spreadsheets outside synthetic fixtures, logs, and content resembling private keys, Supabase secret keys, GitHub tokens, database URLs with passwords and JWTs. CI and the deployment workflows run the scan before any artifact is uploaded.
