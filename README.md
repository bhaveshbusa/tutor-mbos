# Tutor MBOS

A configurable multi-tenant tutoring system for students, batches, fees, assessments and reporting, available through an admin UI, API and MCP.

**Status: plan approved on 14 October 2026. Cloud foundation (TOS-2) is complete. Access contract 2026-10-15 enforces Supabase sessions, delegated tokens, tenant ownership and row level security. Hosted acceptance of that contract is still open.**

- [Proposed initial-release plan](docs/initial-release-plan.md)
- [Linear project](https://linear.app/lets-play-match/project/tutor-mbos-initial-release-9973c3f2fd65)
- [Plan approval](https://linear.app/lets-play-match/issue/TOS-1/approve-initial-release-plan)
- [Cloud development rules](AGENTS.md)
- [Cloud foundation and delivery](docs/cloud-foundation.md): layout, checks, environment variables, deployment
- [Access contract](docs/contracts/access-v1.md)
- [Release and migration policy](docs/release.md)

One owner per business. Cloud-only development with Cursor and Devin; automated tests and releases. A separate demo account uses the production system as an isolated tenant. Development/staging stays separate from production.

The repository contains the Next.js app, the versioned access contract, tenant migrations, and CI. Business routes require a verified Supabase session or delegated grant. MCP is enabled only after that check. No predecessor data or history is included. Production release remains gated on user sign-off.
