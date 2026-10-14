# Application layer

Use cases shared by the admin UI, HTTP API and MCP adapters. Adapters translate transport input into these calls and map results back; they never reimplement business rules. Framework-free: no `next`, `react` or adapter imports (enforced by ESLint and `tests/architecture.test.ts`).
