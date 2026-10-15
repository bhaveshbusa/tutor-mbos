# HTTP adapter

Versioned HTTP API (`/api/v1/...`). Route files under `src/app/api/v1` stay thin and delegate here; handlers call the application layer. Only `/api/v1/health` exists in this increment and it serves no business data. Authenticated business routes and the OpenAPI document arrive with TOS-3 and later increments.
