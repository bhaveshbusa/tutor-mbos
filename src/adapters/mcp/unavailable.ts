import { problemResponse } from "@/adapters/http/problem";

/**
 * The MCP endpoint fails closed until Supabase-backed OAuth lands (TOS-3).
 * It exposes no tools, resources or prompts and accepts no session.
 */
export function mcpUnavailableResponse(): Response {
  return problemResponse(
    503,
    "MCP service not available",
    "The MCP adapter is not enabled. Authenticated MCP access is delivered by TOS-3.",
  );
}
