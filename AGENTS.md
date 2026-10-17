# Tutor MBOS

The user approved the product plan on 14 October 2026 (TOS-1). How that plan is delivered follows the 17 October 2026 direction reset: https://linear.app/lets-play-match/document/project-direction-reset-standard-tooling-and-unattended-delivery-e6794b5a055f

Read docs/initial-release-plan.md before working. Linear owns scope, delivery state, dependencies and acceptance evidence. GitHub owns source and versioned contracts.

This is a new configurable multi-tenant system with one owner/user per business, no business roles, and admin UI, API and MCP clients. Reporting is a launch requirement across those clients. Users may connect compatible AI clients through standard MCP and OAuth discovery, consent and permissions. A named product is an example, not a privileged client. Registration is not authorization. The predecessor's workbook and single-tutor identity are not this project's authority. Never copy its private data, exports, secrets or history.

All development and testing occur in cloud agent workspaces and GitHub Actions. No local development or testing on the user's machine. Synthetic data only in agent and test environments. Production credentials stay in protected deployment environments.

## Delivery

One accountable implementation owner per issue, and one independent reviewer. Select the owner by demonstrated ability to receive work, follow review and CI, and finish delivery. Cursor and Devin are alternatives. Codex coordinates this transition until a working ownership transfer is recorded. Only one component dispatches each review.

The implementation owner posts the pull request URL, exact HEAD, scope and CI evidence on the Linear issue. That post does not mention a reviewer, open a review issue, or add a review label. Follow-up fixes stay in the same implementation session. Do not start a second review while one is active.

Use the installed Linear and GitHub integrations and GitHub Actions. Do not add a coordinator, webhook relay, paid service or second scheduler. An existing hourly fallback may notice stalled work. It must not dispatch work the owner already has.

Every pull request answers five questions: the current product need; the standard feature or package considered; the smallest change and what was deferred or removed; the observable behavior covered by tests; the operating burden, including secrets, services, configuration and recovery. Custom cryptography, protocol engines, migration engines or orchestration state machines require a documented platform gap before coding.

TOS-3 is superseded. Do not resume its cloud session, auth or schema work, hosted acceptance, historical cleanup, or pull request 20. The replacement foundation starts only after this delivery milestone, on its own branch.

Include automated tests that would catch a meaningful product or security regression. A policy or template change does not add a checker that freezes the template text.

Use Supabase-managed authentication and supported SDK verification, explicit client authorization, user-scoped business data access and tenant RLS. No token bypass, user-editable authorization claims or privileged business-request clients. Test isolation on direct API and database paths, reports, exports and caches.

Keep business logic and reporting definitions shared across UI, API and MCP. Version configurable policies. Preserve financial history and unknown values. Mutations require safe retries and concurrency handling. Never expose arbitrary SQL as a query tool.

Public repository: no personal data, real fixtures, secret-bearing logs, tokens, private inputs or sensitive CI artifacts. No production secrets for untrusted pull request workflows.

Cloud CI covers format, lint, types, build, relevant behavioral tests and security or dependency checks. Skipped security gates are not passes. Record the pull request, check and deployment links. Promote a tested commit through development before it can be a production candidate.

The user explicitly signs off every production candidate and its migration set. Account authorization and project creation are the only routine user setup. Do not ask the user to run tests, relay status, or approve ordinary implementation. Notify only for a finished result, a blocker only the user can remove, or sign-off readiness.

## Continuing delivery and migrations

This policy applies to every production release, including all future features, fixes, dependency updates and database changes. The user must explicitly sign off the specific candidate and its migration set. Plan approval and a finished initial release do not authorize later production releases. The user chooses sign-off testing. Routine tests and development deployment stay automated.

Database changes use versioned migrations, fresh-install and populated-upgrade tests, separate environment credentials, serialized execution, target and drift checks, and recorded recovery evidence. Apply the same reviewed files to development before production. Never edit an applied migration; add a corrective migration. Application rollback does not reverse database changes. Destructive changes need a reviewed recovery plan and verified backup coverage. An emergency fix does not skip these gates unless the user explicitly authorizes that exception.

Details and the development migration workflow are in `docs/release.md`. Observed trigger limits are in `docs/cloud-foundation.md`. Coding agents must not deploy production or enable production releases.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
