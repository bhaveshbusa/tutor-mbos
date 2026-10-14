# MCP adapter

Will expose the shared application and query layers as MCP tools, resources and prompts over Streamable HTTP. In this increment `/api/mcp` fails closed (HTTP 503) for every method: there is no transport, no tool list and no authentication. TOS-3 owns the OAuth protected-resource metadata, token validation and transport.
