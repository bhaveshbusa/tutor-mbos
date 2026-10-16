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
| GitHub → Settings → Environments → `development` → Secrets | `VERCEL_AUTOMATION_BYPASS_SECRET` | Owner. Required by the acceptance business job. Copy the project's existing Protection Bypass for Automation value. Do not generate a new secret. |
| GitHub environment variables (optional) | `SMOKE_ALIAS_URL` | Stable alias (e.g. `https://<project>.vercel.app`) re-checked after promotion |
| GitHub → Settings → Environments → `production` → Variables | `PRODUCTION_RELEASES_ENABLED=true` | Owner, only after final sign-off |

Agent workspaces, pull request workflows and the repository never hold these values.

`VERCEL_TOKEN` is never passed on a command line; the Vercel CLI reads it from the step environment. Only the pull, deploy, smoke and promote steps receive it. The build step does not.

**Smoke tests and Deployment Protection.** Keep Deployment Protection enabled. `scripts/smoke-health.ts` reads the project's existing *Protection Bypass for Automation* through the Vercel API with `VERCEL_TOKEN`, in-process, and sends it only as the `x-vercel-protection-bypass` request header (masked in logs). It never creates or changes a bypass. `VERCEL_AUTOMATION_BYPASS_SECRET` is the smoke-test fallback when that lookup is unavailable. The acceptance business job does not receive `VERCEL_TOKEN`, so it requires the same existing value in the GitHub `development` environment. Neither value is an application token; they grant no API or MCP access. Unprotected aliases are not used for smoke tests. See https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation.

## One-time platform setup

The Vercel projects and Supabase projects already exist. Do not recreate them.

1. **Vercel token.** Create a token scoped to team `lets-play-game` (`team_2QehRm248FPmHJTzKS0rvS6b`) at Vercel → Account Settings → Tokens. Prefer separate tokens for the `development` and `production` GitHub environments so either can be revoked alone. Vercel tokens are team-scoped, not project-scoped; the workflows pin the project IDs and verify the linked project before deploying.
2. **GitHub environment `development`.** Create it at GitHub → Settings → Environments. Restrict deployment branches to `main`. Add secrets `VERCEL_TOKEN`, `SUPABASE_MIGRATION_DATABASE_URL` and `APP_RUNTIME_PASSWORD`. Acceptance also needs `SUPABASE_DEVELOPMENT_ACCESS_TOKEN` (`auth_config_read` and `data_api_config_read` only; do not add delete or auth-write scopes) and `TUTOR_MBOS_APP_DATABASE_URL` (the development `app_runtime` connection, not the migration URL). The preflight and cleanup jobs need `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY`. See `docs/release.md`. That admin name is recorded for review; do not create the secret until the cleanup design is accepted.
3. **GitHub environment `production`.** Create it. Restrict deployment branches to `main`. Add required reviewers (the owner) and enable *Prevent self-review*. Add secret `VERCEL_TOKEN`. Do not add `PRODUCTION_RELEASES_ENABLED` until final sign-off.
4. **Vercel runtime variables.** Add the variables in the table above to each project's Production environment.
5. **Vercel project settings.** For both projects: Framework Preset *Next.js*, Node.js version *24.x*. A Git connection is optional; `vercel.json` disables Git-triggered deployments so only the workflows deploy.
6. **Deployment Protection.** Keep it enabled on both projects. Enable *Protection Bypass for Automation* once in Vercel → project → Settings → Deployment Protection. The deploy smoke test reads that existing secret with `VERCEL_TOKEN`. Copy the same value to GitHub → Settings → Environments → `development` → Secrets as `VERCEL_AUTOMATION_BYPASS_SECRET`. The acceptance business job sends it as `x-vercel-protection-bypass` and does not receive `VERCEL_TOKEN`. Do not generate a replacement secret from CI, and do not disable protection or smoke test through an unprotected alias.
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

`.github/workflows/accept-development.yml` runs on manual `workflow_dispatch` from `main`, and on one exact comment. The protected jobs use the `development` environment. The comment gate does not. `workflow_dispatch`, and a new comment from GitHub actor `3823973` (`bhaveshbusa`) whose body starts with `/tutor-mbos accept-development ` or `/tutor-mbos recover-development `, use the concurrency group `development-delivery`, with `cancel-in-progress: false` and `queue: max`. An authorized acceptance run waits behind an in-progress development delivery, and a later delivery waits behind that acceptance run. Neither cancels the other. An ordinary comment still creates a workflow run, including a comment from that same actor, and so does a comment from anyone else. Those runs do not match the command prefix, so they use a per-run group, skip the protected jobs, and are not acceptance evidence. A comment rerun uses that per-run group as well. The business job reads `/api/v1/health` on the development site and stops without creating users, consents, or database rows when the automation bypass is absent, or when the status, environment, project ref, or commit does not match the workflow SHA. An absent `VERCEL_AUTOMATION_BYPASS_SECRET` is `protection_bypass_absent` and does not call the site. A response with no health commit is `commit=absent`. A health commit for another SHA is `commit=mismatch`. When the bypass source is `fallback-secret` and the health case is `http_401 commit=absent`, the copied Protection Bypass for Automation value can be invalid or rotated; copy the project's current value again. It reads health again at the end and fails if that commit changed, so one report cannot mix two promotions.

Three jobs each check out that SHA and run `pnpm install --frozen-lockfile` with the shared pnpm cache turned off. The business job does not receive `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY`, `SUPABASE_DEVELOPMENT_ACCESS_TOKEN`, or `VERCEL_TOKEN`, and it does not run `vercel pull`. It receives the publishable key, `VERCEL_AUTOMATION_BYPASS_SECRET`, the `app_runtime` URL, and three preflight outputs: the run nonce, the start time, and the sanitized Auth and PostgREST cases. The nonce is a preflight job output. It is not written to `GITHUB_ENV` and it is not masked in the preflight job. Actions drops a job output whose value was masked there. The accept and cleanup jobs mask the nonce when they read it, so logs do not repeat it. The nonce is not a credential. The workflow token permission is `contents: read`. The comment gate job adds `pull-requests: read` and `actions: read` for this repository's pull request and workflow-run lookups. It uses the built-in workflow token. It does not add a new token, and it does not receive the development environment. The cleanup manifest is an accept job output, not an uploaded archive.

Before `Check admin capability and mint run identity`, `scripts/assert-business-acceptance-secrets.mjs` checks that `VERCEL_AUTOMATION_BYPASS_SECRET`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `TUTOR_MBOS_APP_DATABASE_URL` are present. It prints each name as present or absent. It does not print a value, length, or hash, and it does not write a job output. The capability step and the Vercel pull do not receive those names. If any name is absent, preflight fails, the capability step is skipped, no nonce is minted, and the business job does not start. That failure is the existing `/tutor-mbos recover-development` path. A run whose business job already started stays ineligible for that command. The business job still checks the same names at runtime.

`scripts/hosted-acceptance-preflight.ts` runs only in the preflight job, and it runs before `pnpm dlx vercel`. That package is outside the lockfile, so it must not be able to change the workspace or environment of a later step that holds the admin key or the Management API token. A supported admin key is either `sb_secret_…`, sent only on the `apikey` header, or a legacy service_role JWT, sent on `apikey` and `Authorization: Bearer`. Any other shape fails before a request. The job then calls `GET /auth/v1/admin/users?page=1&per_page=1` and continues only when that returns 200. The response body is discarded. Presence of the secret is not enough. The same job reads Auth and PostgREST settings with the existing read-only Management API token and passes only the classified cases onward. It does not create users. A failed capability check stops the workflow before signup. The Vercel pull and target check run after that step and receive only `VERCEL_TOKEN`.

The business job runs `scripts/hosted-acceptance.ts`. It uses Auth signup, rendered HTML for `/login`, `/business`, and `/oauth/consent`, the API, and MCP routes, OAuth discovery, and dynamic registration. Requests time out. A signup that ends without a response records `signup.response_lost` and does not invent a user id or continue to consent. Direct database checks use `app_runtime` and `SET LOCAL ROLE app_request`. Both synthetic tenants' visible businesses are read while both businesses still exist. If either tenant sees any other row, neither cleanup runs. Only after both views are exactly that tenant's own business does scoped cleanup delete creation keys, consents, and the business, one owner at a time. A row count other than that expectation rolls that transaction back and does not start the other owner's cleanup. The job does not call Auth admin routes. `DELETE /auth/v1/user` is not a supported route and is not used. Dynamic registration does not return a registration client URI or registration access token. OAuth client names are `tos3-{acceptance|denial|restricted}-{nonce}`. The manifest is that job's output. It stores labels and UUIDs only. It is not masked, because Actions drops a masked job output.

Auth user and OAuth client removal is `scripts/hosted-acceptance-cleanup.ts` in the cleanup job. The job runs when preflight succeeded, including after the business job fails or is cancelled. It checks out the SHA again. It alone, with preflight, receives `SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY`. It does not receive the app database URL, the Management API token, or `VERCEL_TOKEN`. The manifest is an accept job output. It has no emails or credentials. The accept step writes it with a multiline output delimiter before the step exits, including when that step fails, and it does not mask the value. Cleanup runs `pnpm accept:development:cleanup` from its own fresh checkout. The workflow binds the output to `ACCEPTANCE_MANIFEST` on that step and does not insert the value into the shell command. Cleanup treats the string as untrusted: it rejects a missing or oversized value before parsing, then applies the same JSON, schema, and run-identity checks. A missing, malformed, or oversized value stays a failed cleanup and uses the same bounded nonce lookup. Nothing from the business job is extracted onto the cleanup checkout. Cleanup deletes a user only after `GET /auth/v1/admin/users/{id}` shows the email derived from the trusted nonce and a `created_at` inside the run window. It deletes a client only after `GET /auth/v1/admin/oauth/clients/{client_id}` shows `client_name` equal to `tos3-{label}-{nonce}`, the redirect `https://example.com/oauth/callback`, and a `created_at` inside that window. A matching public name or an older `created_at` is left in place. `GET` 404 is treated as already gone only after an exact email or client-name lookup also finds nothing. A second exact match deletes nothing. Deletion is `DELETE` on those same admin paths. Hard delete is the documented session removal. A missing, truncated, or rejected manifest does not become a pass: cleanup looks up at most the two emails and three client names for this nonce and still reports failure. A lost signup response uses the same lookup and still fails. There is no admin logout or admin grant route; the business job revokes grants with the user's token.

App rows are not removed by Auth deletion. `app.client_grants` has no DELETE policy, so a matching grant can only have `business_id` set null. `app.access_audit` has no DELETE policy. If a probe aborts, the businesses, creation keys, and consents for both synthetic owners stay. Those three gaps are explicit. This workflow will not send a broad statement or an elevated business request to finish that cleanup. A reviewed follow-up would delete the remaining rows by primary key. Until that recovery exists, acceptance stays manual and is not repeated or scheduled. Any `direct.*` abort stops further acceptance runs until the visibility failure is investigated. Protected development acceptance is a limited manual dispatch, and only after review and integration gates have passed. One run at a time is the `development-delivery` queue.

Re-running only the cleanup job does not mint a nonce. If the manifest output is absent, cleanup uses the trusted nonce lookup, may remove that run's Auth users and clients, and still reports failure. Re-running only the accept job reuses the preflight nonce, so signup collides with any Auth users still present for that nonce. A new workflow dispatch is a new nonce. Neither retry is a new acceptance result.

That admin credential can administer every Auth user on `idvzjqrkgnihvxoswuxu`. No narrower official token exists for these routes. Isolation is the separate job, the fresh checkout, and the GET checks, not a scoped token. The read-only Management API token is not given delete permission. The secret name and location are prepared for review. Do not create the value until that review accepts this design.

Missing acceptance secrets are reported by name and the corresponding cases fail. Recorded gaps stay gaps: ChatGPT product consent, a second real MCP product's consent, recovery email callback, recovery completion, browser-driven form interaction, and UI cookie rotation outside the 90-second refresh window. Fetching rendered HTML is not a browser session, and cookie API calls are not rendered UI acceptance. A generic client is not ChatGPT and not the second MCP product. GitHub Actions and the Management API cannot authorize those products (https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication). The workflow prints sanitized pass, fail, and gap lines. It does not print tokens, messages, or connection values, and it does not change production.

The comment command is a public source request. On the merged pull request, the whole comment is `/tutor-mbos accept-development` and the 40-character lowercase SHA of that pull request's merge commit. One trailing line feed is accepted. Any other text, actor, repository, event, or edit is rejected before a lookup. The gate reads the comment only from the step environment. It does not put the comment in a shell command, and it does not check out the pull request head or a SHA named by the comment. The SHA must equal `github.sha` on protected `main` at that event, the pull request must be merged into `main` in this repository, and *Deploy development* must already have succeeded for that SHA. The duplicate check uses job evidence for earlier run ids only, across every attempt of that run. The jobs lookup sends the documented `filter=all` parameter and pages until the list is complete. The workflow-run search stops at GitHub's documented 1,000-result cap. The jobs list uses the same number as a self-imposed bound; the jobs API documents page size, not that cap. A short page or a total above either bound fails closed and records the bound. An earlier `issue_comment` run counts when any attempt of `Authorize acceptance comment` succeeded or is still running for this actor. A later skipped attempt does not hide that success. An earlier `workflow_dispatch` run counts when any attempt of `Preflight tutor-mbos-dev` succeeded or is still running, or when any attempt of `Accept tutor-mbos-dev` ran. A foreign actor, an ordinary or unrecognized comment, an all-skipped run, and a later queued run do not count, including a later owner comment waiting in `development-delivery`. A comment whose authorize job succeeded blocks another `/tutor-mbos accept-development` comment for that SHA even when preflight then failed. `/tutor-mbos recover-development` plus the same SHA is accepted only when every earlier authorized comment run is a proven pre-resource failure: some attempt of preflight completed with failure, the `Check admin capability and mint run identity` step is skipped, an earlier step failed, and every attempt of accept is skipped. Runner steps named `Set up job` and `Complete job` are the steps GitHub adds around the job. A `Post ` step is accepted after that boundary only when it names an action step that already ran before the boundary, including `Post Run ` followed by that earlier step name. Any other step after the boundary is not ignored: a workflow step defined after the capability step must be skipped, and an unrecognized step fails closed. A later skipped attempt does not erase that proof or an earlier success. If accept ran, preflight succeeded, the capability step ran, a dispatch already counts as acceptance, or the history is missing or ambiguous, the recover command is rejected. It uses the same actor, repository, merged `main`, delivery, attempt-1, and `development-delivery` gates, so two recoveries cannot run together. `workflow_dispatch` remains available and is not the coordinator path. A `direct.*` abort still stops both comment commands; the coordinator does not post either until that failure is investigated. GitHub evaluates `startsWith` without case, so an owner comment with the same prefix in another case enters `development-delivery` until authorize rejects the exact lowercase command. That rejection is not acceptance evidence. Run history is also filtered with the documented `event`, `actor`, and `head_sha` parameters. Missing or unrecognized job evidence fails closed. This is not scheduled. Ordinary comments, pushes, CI completions, and review notices create no protected acceptance. A comment request is accepted only on `github.run_attempt` 1, before preflight and again before the business job, so re-running all jobs or only the failed jobs cannot replay it. Cleanup still runs after a legitimate preflight, including when the business job fails or the run is cancelled. `workflow_dispatch` is not limited to attempt 1; it remains the manual path, and re-running its accept job still reuses that dispatch's nonce. A `direct.*` abort still stops further acceptance requests; the coordinator does not post the command again until that failure is investigated.

Merging this recovery gate moves `main` to a new commit. A recover comment is bound to `github.sha` at that event, so it cannot revive the earlier candidate `71bf50a3d8b1162f9d7c080ee25ccad897d71e80`. The first acceptance of the new merge is `/tutor-mbos accept-development` for that new SHA. This change does not run acceptance for the historical candidate.

`workflow_dispatch` from `main` remains available and does not require the comment. Dispatch it, or post the comment, only after the development promotion for the commit under test and after review and integration gates have passed: GitHub → Actions → *Accept development* → *Run workflow* on `main`.

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
