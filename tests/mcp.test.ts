import { describe, expect, it } from "vitest";
import * as mcpRoute from "@/app/api/mcp/route";

describe("/api/mcp before authentication exists", () => {
  it.each(["GET", "POST", "DELETE"] as const)(
    "%s fails closed with 503 and exposes no MCP capabilities",
    async (method) => {
      const response = mcpRoute[method]();
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("mcp-session-id")).toBeNull();
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        status: 503,
        title: "MCP service not available",
      });
      expect(body).not.toMatch(/"(tools|resources|prompts|result|jsonrpc)"/);
    },
  );

  it("exports no other HTTP methods", () => {
    const methods = Object.keys(mcpRoute).filter((key) => /^[A-Z]+$/.test(key));
    expect(methods.sort()).toEqual(["DELETE", "GET", "POST"]);
  });
});
