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
| `src/adapters/mcp/` | MCP translation through the official SDK |
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
| `pnpm test:browser` | Playwright, Chromium |
| `pnpm hygiene` | Rejects tracked/untracked private files, credentials and real data |
| `pnpm build` | Production `next build` |
| `pnpm hygiene --artifact .next` | Secret scan of the build output |
| `pnpm audit --prod --audit-level=high` | Production dependency audit |

`.github/workflows/ci.yml` runs these on every pull request with a read-only token and no secrets. The deployment workflows call it before deploying. The browser job is part of that workflow. Branch protection, as last observed, still requires the previous five checks. This change does not edit that protection.

## Runtime environment variables

Set these on each **Vercel project** under *Settings → Environment Variables*, environment **Production** (both projects deploy their main target; see below). Never put them in the repository. `.env.example` lists the names with placeholders only.

| Variable | `tutor-mbos-dev` | `tutor-mbos` | Notes |
| --- | --- | --- | --- |
| `TUTOR_MBOS_ENV` | `development` | `production` | Required |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://idvzjqrkgnihvxoswuxu.supabase.co` | `https://vblwjqfpcmegbugmufif.supabase.co` | Required; must match `TUTOR_MBOS_ENV` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_<dev placeholder>` | `sb_publishable_<prod placeholder>` | Publishable key from Supabase *Project Settings → API Keys*. Required for sign-in and token checks. |

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
| GitHub → Settings → Environments → `development` → Secrets | `VERCEL_AUTOMATION_BYPASS_SECRET` | Owner. Smoke-test fallback when the Vercel API lookup is unavailable. Copy the project's existing Protection Bypass for Automation value. Do not generate a new secret. |
| GitHub environment variables (optional) | `SMOKE_ALIAS_URL` | Stable alias (e.g. `https://<project>.vercel.app`) re-checked after promotion |
| GitHub → Settings → Environments → `production` → Variables | `PRODUCTION_RELEASES_ENABLED=true` | Owner, only after final sign-off |

Agent workspaces, pull request workflows and the repository never hold these values.

`VERCEL_TOKEN` is never passed on a command line; the Vercel CLI reads it from the step environment. Only the pull, deploy, smoke and promote steps receive it. The build step does not.

**Smoke tests and Deployment Protection.** Keep Deployment Protection enabled. `scripts/smoke-health.ts` reads the project's existing *Protection Bypass for Automation* through the Vercel API with `VERCEL_TOKEN`, in-process, and sends it only as the `x-vercel-protection-bypass` request header (masked in logs). It never creates or changes a bypass. `VERCEL_AUTOMATION_BYPASS_SECRET` is the smoke-test fallback when that lookup is unavailable. Neither value is an application token; they grant no API or MCP access. Unprotected aliases are not used for smoke tests. See https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation.

## One-time platform setup

The Vercel projects and Supabase projects already exist. Do not recreate them.

1. **Vercel token.** Create a token scoped to team `lets-play-game` (`team_2QehRm248FPmHJTzKS0rvS6b`) at Vercel → Account Settings → Tokens. Prefer separate tokens for the `development` and `production` GitHub environments so either can be revoked alone. Vercel tokens are team-scoped, not project-scoped; the workflows pin the project IDs and verify the linked project before deploying.
2. **GitHub environment `development`.** It exists and is limited to selected branches. Deployment uses `VERCEL_TOKEN` and `SUPABASE_MIGRATION_DATABASE_URL`. See `docs/release.md`.
3. **GitHub environment `production`.** It is not created yet. Leave it that way until the user signs off a specific candidate. Do not set `PRODUCTION_RELEASES_ENABLED` before that sign-off. When it is created, restrict it to `main`, require the owner as a reviewer, and enable *Prevent self-review*.
4. **Vercel runtime variables.** Add the variables in the table above to each project's Production environment.
5. **Vercel project settings.** For both projects: Framework Preset *Next.js*, Node.js version *24.x*. A Git connection is optional; `vercel.json` disables Git-triggered deployments so only the workflows deploy.
6. **Deployment Protection.** Keep it enabled on both projects. The deploy smoke test reads the existing *Protection Bypass for Automation* with `VERCEL_TOKEN`. Do not generate a replacement secret from CI, and do not disable protection or smoke test through an unprotected alias.
7. **Stable alias (optional).** Set `SMOKE_ALIAS_URL` on a GitHub environment to re-check the promoted alias after each promotion.

## Development deployment

`.github/workflows/deploy-development.yml` runs on every push to `main` and on manual dispatch from `main`. It does not run on pull requests. The sequence is serialized with manual migration recovery by the concurrency group `development-delivery`, with `cancel-in-progress: false` and `queue: max`. A recovery dispatch does not cancel a delivery that is already queued.

1. Reusable CI (all checks above).
2. Name-only preflight on project `prj_ysIJHdIKYk2MQwvOKermUvIMuGVa`: require `VERCEL_TOKEN`, `vercel pull`, then `scripts/assert-deploy-target.ts development`. The linked team and project must match the development binding, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` must be present by name. If the token or the key is absent, the workflow stops before migrations, build, deploy and promotion and names the setup location.
3. A read-only check compares migration inputs with the last successful *Deploy development* commit. The inputs and the fail-closed cases are in `docs/release.md`. Manual dispatch always runs migrations. The check uses the workflow token and no deployment environment.
4. Development migrations, only when that check requests them, through `.github/workflows/apply-development-migrations.yml`. The caller passes `SUPABASE_MIGRATION_DATABASE_URL` by name. The job stops before SQL when it is absent. A URL check runs before `supabase db push`. A failed migration does not deploy.
5. `vercel pull` again, then the same target check, so the build uses the reviewed project settings.
6. `vercel build --prod` in CI (no `VERCEL_TOKEN`), then a secret scan of `.vercel/output`.
7. `vercel deploy --prebuilt --prod --skip-domain` to `tutor-mbos-dev`. This creates the deployment without moving traffic. Development uses that project's main target because the project only ever holds synthetic data.
8. `scripts/smoke-health.ts` against that deployment URL: `/api/v1/health` must return `200`, `environment: development`, the development Supabase project ref and the deployed commit.
9. `vercel promote` only after the smoke test passes.
10. If `SMOKE_ALIAS_URL` is set, the promoted alias is smoke tested again.

*Migrate development* (`.github/workflows/migrate-development.yml`) remains a manual recovery entry for the same migration job. It uses the same concurrency group and queue, so it waits for an in-progress development delivery instead of overlapping it, and it does not cancel a delivery that is already pending. Routine pushes do not need that dispatch. Recovery does not run the Vercel preflight; it applies reviewed SQL only.

To rerun the whole sequence: GitHub → Actions → *Deploy development* → *Run workflow* on `main`.

## What was removed

Hosted acceptance workflows and the custom runtime-role provisioner are gone. See `docs/foundation-transition.md`. Do not add them back.

## Unattended delivery

Cursor session [bc-7f9763bf-b962-4d6d-b7b5-fc2bc6f1ae06](https://cursor.com/agents/bc-7f9763bf-b962-4d6d-b7b5-fc2bc6f1ae06) is the implementation owner for this milestone. Codex coordinates and posts through the Linear account `albeit.thalen` and the GitHub account `bhaveshbusa`. Devin, through `devin-ai-integration` and retained session `7a8360fa8c454e8e848b0a03d524a168`, is the independent reviewer. A native Devin Review comment is advisory. Only a regular approving review is the formal decision.

Configured, and not yet observed on a live pull request: automation [auto-8e10e68c2ebe420c88bc5995c5869eec](https://app.devin.ai/automations/8e10e68c2ebe420c88bc5995c5869eec) is enabled for `pull_request` `opened`, `synchronize`, and `ready_for_review` on `bhaveshbusa/tutor-mbos`. The pull request must be non-draft and unmerged, target `main`, and use a head branch that starts with `cursor/`. It messages that same reviewer session, which waits up to 45 minutes for the five CI checks. It skips a superseded head, a head that already has a review, a fork, an out-of-scope event, and a manual run. One run proceeds at a time, up to three wait, and the cap is six runs an hour. The previous review-submitted trigger was removed. The last recorded invocation is a manual test. A live trigger and a formal approval from that trigger are not yet observed, so this does not make the whole delivery loop unattended.

| Step | What was observed | Limit |
| --- | --- | --- |
| Implementation | Linear delegation started this Cursor session. | Linear's tools expose no webhook discovery, automation trigger, or session-control call. A saved prompt or an assignment without a running session is not execution. |
| CI | `.github/workflows/ci.yml` runs on every pull request with a read-only token and no deployment secrets. `main` requires the five CI checks for everyone. | This session's token cannot edit branch protection. `GET /branches/main/protection` returns 403, so the full protection document is unread. The rules API returned no rulesets. Pull request 22 showed `REVIEW_REQUIRED` and `BLOCKED`, then `APPROVED` and `CLEAN` after review 5560048624, while the five CI checks stayed required. Stale-review dismissal was not tested. |
| Review | Observed: pull requests 16, 19, and 21 were reviewed after a Linear delegation. Pull request 22 received a native `COMMENTED` review, then formal approval 5560048624. Pull request 23 received a native `COMMENTED` review, then fallback approval 5560223790, which was recorded as not triggered by the automation. | The pull-request automation above has no observed live invocation. This session does not open a second dispatch. |
| Fixes | Devin review [5558933972](https://github.com/bhaveshbusa/tutor-mbos/pull/21#pullrequestreview-5558933972) arrived as a GitHub notification and this session continued on the same branch. | There is no separate fix scheduler. |
| Development | Observed on pull request 21: merge `3fb12810a727ccf2f7d257015cf96fe5536ab905` and [run 39054039678](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39054039678) skipped migrations, smoke-tested that commit, and promoted it. Observed on pull request 23: merge `734ba5042913d0c356dc641ee06509413cdd3290` and [run 39071971070](https://github.com/bhaveshbusa/tutor-mbos/actions/runs/39071971070) did the same. | Pull requests do not deploy. The promoted-alias smoke step did not run on either run. The input set is in `docs/release.md`. *Migrate development* remains the manual recovery entry and always applies. |
| Production | `.github/workflows/release-production.yml` is manual `workflow_dispatch` only. | The GitHub `production` environment was absent on 17 October 2026. Do not create it or set `PRODUCTION_RELEASES_ENABLED`. |
| Fallback | No schedule exists in this repository. This environment listed no automation-sourced cloud agent. | Do not add an hourly job. An existing external hourly monitor must not dispatch work this owner already has. |

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
pnpm exec playwright install chromium
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
