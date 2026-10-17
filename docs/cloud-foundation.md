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
| `src/adapters/mcp/` | MCP translation. The custom TOS-3 foundation is superseded; replacement is TOS-29 after delivery reset |
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
| GitHub → Settings → Environments → `development` → Secrets | `VERCEL_AUTOMATION_BYPASS_SECRET` | Owner. Required by the acceptance business job. Copy the project's existing Protection Bypass for Automation value. Do not generate a new secret. |
| GitHub environment variables (optional) | `SMOKE_ALIAS_URL` | Stable alias (e.g. `https://<project>.vercel.app`) re-checked after promotion |
| GitHub → Settings → Environments → `production` → Variables | `PRODUCTION_RELEASES_ENABLED=true` | Owner, only after final sign-off |

Agent workspaces, pull request workflows and the repository never hold these values.

`VERCEL_TOKEN` is never passed on a command line; the Vercel CLI reads it from the step environment. Only the pull, deploy, smoke and promote steps receive it. The build step does not.

**Smoke tests and Deployment Protection.** Keep Deployment Protection enabled. `scripts/smoke-health.ts` reads the project's existing *Protection Bypass for Automation* through the Vercel API with `VERCEL_TOKEN`, in-process, and sends it only as the `x-vercel-protection-bypass` request header (masked in logs). It never creates or changes a bypass. `VERCEL_AUTOMATION_BYPASS_SECRET` is the smoke-test fallback when that lookup is unavailable. The acceptance business job does not receive `VERCEL_TOKEN`, so it requires the same existing value in the GitHub `development` environment. Neither value is an application token; they grant no API or MCP access. Unprotected aliases are not used for smoke tests. See https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation.

## One-time platform setup

The Vercel projects and Supabase projects already exist. Do not recreate them.

1. **Vercel token.** Create a token scoped to team `lets-play-game` (`team_2QehRm248FPmHJTzKS0rvS6b`) at Vercel → Account Settings → Tokens. Prefer separate tokens for the `development` and `production` GitHub environments so either can be revoked alone. Vercel tokens are team-scoped, not project-scoped; the workflows pin the project IDs and verify the linked project before deploying.
2. **GitHub environment `development`.** It exists and is limited to selected branches. Deployment uses `VERCEL_TOKEN`, `SUPABASE_MIGRATION_DATABASE_URL` and `APP_RUNTIME_PASSWORD`. Do not add acceptance-only secrets for ordinary delivery. See `docs/release.md`.
3. **GitHub environment `production`.** It is not created yet. Leave it that way until the user signs off a specific candidate. Do not set `PRODUCTION_RELEASES_ENABLED` before that sign-off. When it is created, restrict it to `main`, require the owner as a reviewer, and enable *Prevent self-review*.
4. **Vercel runtime variables.** Add the variables in the table above to each project's Production environment.
5. **Vercel project settings.** For both projects: Framework Preset *Next.js*, Node.js version *24.x*. A Git connection is optional; `vercel.json` disables Git-triggered deployments so only the workflows deploy.
6. **Deployment Protection.** Keep it enabled on both projects. The deploy smoke test reads the existing *Protection Bypass for Automation* with `VERCEL_TOKEN`. Do not generate a replacement secret from CI, and do not disable protection or smoke test through an unprotected alias.
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

## Retained acceptance workflows

`.github/workflows/accept-development.yml` and `.github/workflows/cleanup-run-38954838195.yml` are still in the repository. They are not how a change reaches development. Do not dispatch them, post a `/tutor-mbos` comment, or edit them as part of delivery. Behavior that remains is in those files. Do not create new secrets for them.

## Unattended delivery

Observed on 17 October 2026 from Cursor session [bc-7f9763bf-b962-4d6d-b7b5-fc2bc6f1ae06](https://cursor.com/agents/bc-7f9763bf-b962-4d6d-b7b5-fc2bc6f1ae06), started by a Linear delegation on TOS-28. No user message was sent between that delegation and this session. This is the implementation owner for this milestone. The independent reviewer is Devin through the existing GitHub app `devin-ai-integration`, which has submitted reviews on this repository. Codex remains the transition coordinator and the only review dispatcher until one review of this milestone's pull request is observed without a second dispatch. Ownership of later issues transfers only after that loop finishes.

| Step | What is supported | Limit |
| --- | --- | --- |
| Implementation | Linear's agent delegation starts an authenticated Cursor cloud session on this repository. | Linear's tools expose no webhook discovery, automation trigger, or session-control call. A saved prompt or an assignment without a running session is not execution. |
| CI | `.github/workflows/ci.yml` runs on every pull request with a read-only token and no deployment secrets. `main` requires Format and lint, Typecheck, Tests and repository hygiene, Production build, and Dependency audit, enforced for everyone. | This session's token cannot edit branch protection. The rules API returned no extra rules. |
| Review | Devin's GitHub app has reviewed pull requests in this repository, including approvals on pull requests 16 and 19. | This session cannot start Devin or another Cursor session. It does not open a review issue or mention the reviewer, so only one dispatcher fires. |
| Fixes | The same Cursor session can continue when GitHub reports CI or review activity on its pull request. | There is no separate fix scheduler. |
| Development | A push to `main` runs *Deploy development*: CI, name-only preflight, migrations, smoke, then promotion. Run [39021652199](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39021652199) succeeded for merge `74737aa`. | Pull requests do not deploy. This milestone does not bypass protection or merge an unapproved or draft pull request. |
| Production | `.github/workflows/release-production.yml` is manual `workflow_dispatch` only. | The GitHub `production` environment was absent on 17 October 2026. Do not create it or set `PRODUCTION_RELEASES_ENABLED`. |
| Fallback | No schedule exists in this repository. This environment listed no automation-sourced cloud agent. | Do not add an hourly job. An existing external hourly monitor must not dispatch work this owner already has. |

The missing native piece, if Devin does not review this pull request on its own, is a provider trigger from a ready pull request to that one reviewer. The setup action is to use the installed Devin GitHub app's own pull-request review on this repository. Do not add a relay, a paid service, or a second scheduler to fill that gap.

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
