# Tutor MBOS

A configurable multi-tenant tutoring system for students, batches, fees, assessments and reporting, available through an admin UI, API and MCP.

**Status: plan approved on 14 October 2026; cloud foundation (TOS-2) in progress. Authentication is not implemented yet.**

- [Proposed initial-release plan](docs/initial-release-plan.md)
- [Linear project](https://linear.app/lets-play-match/project/tutor-mbos-initial-release-9973c3f2fd65)
- [Plan approval](https://linear.app/lets-play-match/issue/TOS-1/approve-initial-release-plan)
- [Cloud development rules](AGENTS.md)
- [Cloud foundation and delivery](docs/cloud-foundation.md): layout, checks, environment variables, deployment

One owner per business. Cloud-only development with Cursor and Devin; automated tests and releases. A separate demo account uses the production system as an isolated tenant. Development/staging stays separate from production.

The repository contains the Next.js foundation, CI and deployment workflows. There are no business features, authentication or tenant data yet; the MCP endpoint is disabled. No predecessor data or history is included.
