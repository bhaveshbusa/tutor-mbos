# Tutor MBOS

Implementation is blocked until the user approves the initial-release plan in Linear (TOS-1).
Read docs/initial-release-plan.md before working. Linear owns scope, delivery state, dependencies and acceptance evidence; GitHub owns code and versioned contracts.

This is a new configurable multi-tenant system with one owner/user per business, no business roles, and admin UI, API and MCP clients. Reporting is a launch requirement across those clients. The predecessor's workbook and single-tutor identity are not this project's authority. Never copy its private data, exports, secrets or history.

All development and testing occur in Cursor/Devin cloud workspaces and cloud CI. No local development or testing on the user's machine. Synthetic data only in agent/test environments. Production credentials stay in protected deployment environments.

One accountable implementation owner per issue and per shared authentication/schema/API contract. Cursor and Devin are interchangeable; record assignment before starting. Include relevant automated tests with every implementation. Codex coordinates review/integration/releases through cloud tools.

Use Supabase-managed authentication/OAuth, explicit client authorization, user-scoped business data access and tenant RLS. No token bypass, user-editable authorization claims or privileged business-request clients. Test isolation through direct API/database paths, reports, exports and caches.

Keep business logic and reporting definitions shared across UI/API/MCP. Version configurable policies; preserve financial history and unknown values. Mutations require safe retries and concurrency handling. Never expose arbitrary SQL as a query tool.

Public repository: no personal data, real fixtures, secret-bearing logs, tokens, private inputs or sensitive CI artifacts. No production secrets for untrusted PR workflows.

Cloud CI gates include tests, typecheck, build, security/isolation, migrations and cross-client acceptance. Skipped security gates are not passes. Record exact source/schema/environment evidence. Promote tested candidates through development/staging before production.

User approves the plan and chooses final sign-off testing. Do not require manual SQL, routine test execution, Excel reconciliation or per-ticket implementation approvals. Account authorization and project creation are the only unavoidable setup handoffs. Do not deploy the initial production release before final sign-off.
