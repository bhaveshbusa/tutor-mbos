# HTTP adapter

Versioned HTTP API (`/api/v1/...`). Route files under `src/app/api/v1` stay thin and delegate here; handlers call the application layer. Health is public. Session, business, setup report and grant revocation use the shared access contract.
