# MCP adapter

MCP JSON-RPC over POST. Unauthenticated calls return 401 with protected-resource metadata, or 503 when Auth is not configured. Tools call the shared application layer and do not grant access from OIDC scopes.
