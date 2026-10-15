# Tutor MBOS

The user approved the initial-release plan on 14 October 2026 (TOS-1 complete). Proceed through the approved cloud-only workflow. Initial production release still requires final sign-off.
Read docs/initial-release-plan.md before working. Linear owns scope, delivery state, dependencies and acceptance evidence; GitHub owns code and versioned contracts.

This is a new configurable multi-tenant system with one owner/user per business, no business roles, and admin UI, API and MCP clients. Reporting is a launch requirement across those clients. The predecessor's workbook and single-tutor identity are not this project's authority. Never copy its private data, exports, secrets or history.

All development and testing occur in Cursor/Devin cloud workspaces and cloud CI. No local development or testing on the user's machine. Synthetic data only in agent/test environments. Production credentials stay in protected deployment environments.

One accountable implementation owner per issue and per shared authentication/schema/API contract. Cursor and Devin are interchangeable; record assignment before starting. Include relevant automated tests with every implementation. Codex coordinates review/integration/releases through cloud tools.

Codex is the sole review dispatcher. The implementation owner posts review readiness on Linear with the full repository pull request URL, the exact HEAD, the scope, and CI evidence. The implementation owner does not mention the reviewer, delegate a review issue, add a review-trigger label, or retrigger a review from a status or comment. Codex prepares the review issue while it is undelegated, checks the pull request and SHA ledger, then delegates once. A delegation and a mention are two triggers; use one. Follow-ups stay in the retained session thread, without a mention, a second delegation, or a new issue. A new commit does not start a second review while one is active: finish or stop the active review and record the supersession first. CI, status, and stopped-session notices that do not change the verdict stay silent.

Use Supabase-managed authentication/OAuth, explicit client authorization, user-scoped business data access and tenant RLS. No token bypass, user-editable authorization claims or privileged business-request clients. Test isolation through direct API/database paths, reports, exports and caches.

Keep business logic and reporting definitions shared across UI/API/MCP. Version configurable policies; preserve financial history and unknown values. Mutations require safe retries and concurrency handling. Never expose arbitrary SQL as a query tool.

Public repository: no personal data, real fixtures, secret-bearing logs, tokens, private inputs or sensitive CI artifacts. No production secrets for untrusted PR workflows.

Cloud CI gates include tests, typecheck, build, security/isolation, migrations and cross-client acceptance. Skipped security gates are not passes. Record exact source/schema/environment evidence. Promote tested candidates through development/staging before production.

User approves the plan and chooses final sign-off testing. Do not require manual SQL, routine test execution, Excel reconciliation or per-ticket implementation approvals. Account authorization and project creation are the only unavoidable setup handoffs. Do not deploy the initial production release before final sign-off.

## Continuing delivery and migrations

This policy applies to every production release, including all future features, fixes, dependency updates and database changes. The user must explicitly sign off the specific candidate and its migration set. Plan approval and a finished initial release do not authorize later production releases. The user chooses sign-off testing; routine tests and deployment stay automated.

Database changes use versioned migrations, fresh-install and populated-upgrade tests, separate environment credentials, serialized execution, target and drift checks, and recorded recovery evidence. Apply the same reviewed files to development before production. Never edit an applied migration; add a corrective migration. Application rollback does not reverse database changes. Destructive changes need a reviewed recovery plan and verified backup coverage. An emergency fix does not skip these gates unless the user explicitly authorizes that exception.

Details and the development migration workflow are in `docs/release.md`. Coding agents must not deploy production or enable production releases.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
