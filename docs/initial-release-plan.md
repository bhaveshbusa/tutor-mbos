# Tutor MBOS: proposed initial-release plan

Status: approved by the user on 14 October 2026. Supabase projects tutor-mbos and tutor-mbos-dev created by user report; configuration verification pending.
Repository: https://github.com/bhaveshbusa/tutor-mbos
Delivery: https://linear.app/lets-play-match/project/tutor-mbos-initial-release-9973c3f2fd65

## Product and authority

Build a fresh configurable, multi-tenant tutoring system. ChatGPT and the tutor admin UI are primary clients; documented APIs and standard MCP support other compatible clients. Each business has one owner/user, with no staff roles or invitation hierarchy. Teaching staff may be reference records without login accounts. Initial assumption: one business per account; a separate demo account owns a separate demo business.

This plan supersedes the predecessor project's single-business, MCP-only and workbook-first assumptions for this new repository. The old workbook is neither the specification nor an acceptance gate. Do not copy private records, extracts, secrets or Git history. No migration or Excel reconciliation is required. Existing systems/data are preserved pending a separately scoped retirement decision; stopping development does not delete production.

User responsibilities: approve this plan, create the requested Supabase projects and complete unavoidable account authorization, then choose and perform final sign-off testing. Agents and automation own implementation, automated testing, review, integration, release preparation and operational evidence. No manual SQL execution, routine test runs, spreadsheet reconciliation or per-ticket approval is assigned to the user.

## Lessons retained

- Separate student identity, payer/household, programme, subject, teaching format, batch, membership, assessment participation and billing period.
- Name-only registration is valid; same names do not imply the same student. Persist unresolved questions and resume them across sessions.
- Unknown, zero and not applicable are distinct. Missing setup blocks only the affected action and is visible in reports.
- Keep receipts separate from allocations. Preserve overpayments, early payments, split payments and corrections from the first release.
- Version configuration and agreements by effective date. Save issued financial facts; later defaults must not recalculate history.
- Use idempotent mutations, transactional financial operations, optimistic concurrency and durable audit history.
- Share business behavior and query definitions across all clients. Avoid separate UI and MCP implementations.
- Prove hosted authentication, tenant isolation and recovery, rather than equating unit tests or operator statements with release evidence.

## Initial-release functional scope

| Area | Required behavior |
| --- | --- |
| Business setup | Business name, timezone, currency, academic calendar, terminology, venues and optional instructor reference records. One currency per business initially; no foreign-exchange conversion. |
| Students and payers | Name-only entry, optional contacts/year/custom tags, distinct same-name students, households/payers covering multiple students, search, archive and correction history. |
| Teaching | Configurable programmes/subjects/levels, group/individual/paired formats, batches, recurring timetable and session exceptions, effective-dated enrolments, transfers and leaving dates. |
| Attendance | Basic session attendance and cancellations; billing effects apply only under configured policy. |
| Assessments | Independent lesson/assessment participation, assessment events, configurable grading scales, results and progress reports. Recording scores is included; automated marking and question banks are deferred. |
| Fees | Monthly, term/half-term, per-session and ad hoc periods; planned-session or attendance-based quantities; fixed/per-session charges; effective-dated agreed rates; batch/student overrides; explicit adjustments and discounts; configurable due dates and rounding. |
| Financial lifecycle | Saved draft/review/issue, immutable issued versions, replacement/correction history, independent receipts, optional actual receipt date, split allocations, unallocated money, allocation reversals, receipt correction/voiding, recorded refunds and explicit credit use. No bank transfer execution. |
| Everyday work | Incomplete-setup queue, student/batch detail, bulk previews, saved work, safe retries, fee-message drafts and understandable activity/audit history. |
| Portability | Documented structured/CSV import with preview, duplicate detection and unresolved matches; exports. No predecessor-specific importer or forced historical migration. |
| Clients | Full tutor workflows in admin UI and MCP; versioned API with OpenAPI documentation. No feature depends on hidden ChatGPT memory. |

Configuration uses validated typed policy options, not arbitrary executable scripts. Example precedence: explicit period override, effective student/arrangement agreement, batch/programme default, business default. Show the resolved policy before issuing charges. Initial supported policy catalogue includes cancellation charging, attendance basis, proration (off or documented session-based calculation), discounts and due dates. Policies must be explicit; unsupported requests return an explanation. Automated late penalties, bank feeds, outbound messaging, parent portals, employee roles, tax filing and SaaS subscription billing are outside the initial release.

Financial correctness is invariant even where policy is configurable: exact monetary arithmetic, preserved actual receipts, no double-counted replacements, allocation caps, audit trail and balanced corrections. Proposed refund/credit workflows require confirmation of amount and affected allocations in the same operation and keep money returned distinct from a voided erroneous receipt.

## Reporting and queries: launch requirements

A shared reporting service powers UI reports, API queries and MCP. Include student rosters, active memberships, batch/session schedules, attendance, assessment results/progress, fees issued, receipts, outstanding balances, overdue ageing where due dates exist, unallocated receipts, discounts/corrections and unresolved setup. Distinguish billed amounts from cash received; do not label either as accounting revenue without an agreed definition.

Provide filters, sorting, pagination, grouping, totals, date ranges, saved report definitions and CSV export. Configurable dimensions include student, payer, batch, programme, subject, period and status. Assessments with incompatible scales must not be averaged together.

Support ad hoc questions through a documented semantic query model: an allowlisted catalogue of datasets, fields, measures, relationships and operators. MCP clients translate ordinary questions into this structured model; the admin UI offers a query builder. Never expose arbitrary SQL or unrestricted database access. Return interpreted filters, metric definitions, as-of time, currency/timezone, drill-down identifiers, completeness warnings and pagination/export limits. Unsupported queries are explicit, not invented answers.

Example requests: Who owes fees for this term? Show receipts last month separately from bills issued. Which students have incomplete fee agreements? Compare assessment progress by batch. Show attendance by programme. Save this report and export its underlying rows.

Prevent cross-tenant leaks through joins, aggregate counts, charts, caches, saved reports, export jobs, filenames and signed download links. Query budgets, row limits and timeouts are required. Include tests against a second tenant with deliberately similar identifiers/names.

## Architecture and secure access

Proposed stack: TypeScript, Next.js admin UI and HTTP adapters on Vercel, Supabase Auth/Postgres, a shared application/domain/query layer, and an MCP adapter. Use a modular monolith initially. Long-running exports/imports use durable cloud jobs when synchronous limits are exceeded.

Supabase owns identity and OAuth authorization/token issuance. The app supplies login/consent UX, resource discovery, permission enforcement and business onboarding. UI sessions and delegated OAuth access tokens have separate documented validation paths. Use authorization-code flow with PKCE for delegated clients; no homemade authorization server or shared master API token.

Validate signature, issuer, expiry, intended resource/audience and client/session binding as appropriate to each access path. Verify immutable authenticated owner identity against server-controlled tenant ownership. Never authorize from a request-supplied tenant ID or editable user metadata. Client grants (for example reporting-only access) do not introduce business staff roles. Enforce grants at every reachable access surface, including database paths; Supabase OIDC identity scopes alone do not provide business permissions.

Tenant-scoped RLS and integrity constraints protect all business records and relationships. Business requests use user-scoped database access; privileged deployment credentials never serve routine user requests. Restrict raw Data API access so it cannot bypass application rules or client grants. Report/view/function/storage paths require the same isolation. Explicitly test direct database/API bypass attempts.

Include secure session storage, CSRF protection for browser mutations, strict redirects, client consent/revocation, refresh/reconnection, account recovery, rate limits, input validation, redacted diagnostics and audit trails. Document revocation latency and test it. Authentication must be proved with the admin UI, a standards-based API client, ChatGPT and at least one other MCP client. Client-specific discovery/registration differences must be tested, not assumed.

## MCP onboarding and discoverability

Authentication and consent happen through a secure browser flow; no passwords or secrets in chat. Once authenticated, a new account with no business can call onboarding operations. Tenant creation is atomic and idempotent and cannot attach an account to someone else's tenant.

Provide resumable setup status, business creation, configuration preview/save, starter templates, student/batch setup and readiness checks through MCP as well as the UI. Templates are editable examples, not hard-coded business rules.

Expose a stable help/capabilities tool listing supported actions, required inputs, examples, permissions and missing setup. Add contextual next actions to responses. Provide MCP resources/prompts where supported, with help-tool fallback for clients that do not display them. Version capability metadata alongside executable schemas; test examples in CI to prevent stale help.

Examples: Help me set up my tutoring business; What can I do here?; Show the commands for recording payments; What reports can I run?; Continue my setup. Mutation previews and explicit confirmation are reserved for consequential actions such as issuing fees, bulk changes and financial corrections, rather than every read or routine field edit.

## Environments and Supabase setup

Recommended:
- tutor-mbos: production; real businesses and an ordinary isolated demo tenant.
- tutor-mbos-dev: hosted development/staging; synthetic data only, stable OAuth callbacks and integration rehearsals.
- Disposable databases in cloud CI or managed preview branches for isolated PR testing.

A separate hosted development project is recommended, not a fundamental Supabase requirement: a persistent isolated Supabase branch can substitute. A demo tenant cannot isolate schema migrations, Auth configuration, resource exhaustion or destructive tests from other production tenants. No separate demo deployment is needed.

User setup:
1. Create both empty Supabase projects in the same chosen region (London is the proposed default), with distinct generated database passwords stored in the platform secret manager.
2. Keep schemas empty; cloud pipelines apply versioned migrations. Do not copy the old database.
3. Once cloud deployment URLs exist, enable Supabase OAuth server and configure exact environment-specific site, consent and redirect URLs. Register/enable client onboarding only through the tested flow. Configure a supported login method and production email delivery before launch.
4. Store deployment credentials in protected GitHub environments and Vercel settings; scoped management tokens must be restricted to the intended project and necessary permissions. Production secrets must not reach coding agents or untrusted PR jobs. Share only project references/URLs in planning discussions.
5. Before production launch, configure backups appropriate to the selected plan and an automated isolated restore drill. Verify Auth/config/storage recovery as applicable, not just SQL rows.

Paid resources and plan selection are not provisioned by this document. The cloud foundation issue produces exact settings and secret names after runtime choices are frozen.

## Cloud-only delivery and ownership

No application development, dependency installation, builds, test runs or database execution on the user's machine. Planning reads of the predecessor and remote repository/project administration are allowed. All source editing is in Cursor/Devin cloud workspaces; tests run there and in GitHub-hosted CI.

Linear is the delivery source of truth. Each issue has scope, exclusions, acceptance tests, dependencies, one accountable implementation owner and linked PR/evidence. Cursor and Devin are interchangeable; one owns a shared migration/auth/API contract at a time. The other implements a separate surface against that contract or reviews it. Owner changes are recorded before work, not concurrent edits to the same contract. Codex coordinates planning, review and release through cloud tools.

CI gates: formatting/lint/typecheck/build, domain tests, database/RLS isolation tests, API/MCP contract tests, browser end-to-end tests, policy-calculation fixtures, concurrency/idempotency tests, fresh and populated migration tests, secret/dependency scans and report-total checks. Lock dependencies and runner/tool versions. Security-critical skips block readiness. Public/fork PR workflows run without deployment secrets; avoid executing untrusted code in privileged workflows.

Every PR includes automated tests relevant to its behavior. Agent review and required CI gate integration. Promote the tested commit and migration set through development/staging, run hosted smoke tests, then prepare the same candidate for the user's final sign-off. Production release is automated after that sign-off; migrations are serialized, backward compatibility checked, backups verified and recovery/forward-fix instructions recorded. Final sign-off testing is entirely the user's choice; no Excel exercise is imposed.

## Delivery increments and acceptance

1. Plan approval and cloud foundation: public repository, rules, agent workspace setup, CI and deployment environments.
2. Secure walking skeleton: real UI/API/MCP authentication, two isolated tenants, onboarding, discovery, token lifecycle and denial cases. Must pass before financial implementation is enabled.
3. Configurable operations: business settings, students/payers, teaching, enrolments, sessions/attendance and assessments with reports delivered alongside each area.
4. Financial operations: complete fee and receipt/correction workflows, configurable policy calculations and shared financial reports.
5. Query/discovery completeness: report builder, saved queries/exports, MCP onboarding/help and cross-client parity.
6. Release qualification: cloud security/regression/performance/restore checks, usable demo account, automatic evidence pack and optional user-chosen sign-off scenarios.

Reporting is part of each increment's definition of done, not a post-launch phase. The user has approved the plan; implementation can proceed through the cloud-only workflow. No dates or estimates are promised until agents assess the approved contracts.

## Documentation verification

Consulted 14 October 2026:
- https://supabase.com/docs/guides/deployment/managing-environments
- https://supabase.com/docs/guides/deployment/branching
- https://supabase.com/docs/guides/auth/oauth-server
- https://supabase.com/docs/guides/auth/oauth-server/token-security
- https://supabase.com/docs/guides/auth/oauth-server/getting-started

These establish current environment and auth capabilities; they do not establish that this project's integration has been implemented or passed.
