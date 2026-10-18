import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createAccessHandlers, type AccessDeps } from "@/adapters/http/access";
import {
  ACCESS_CONTRACT_VERSION,
  CLIENT_PROFILES,
} from "@/server/domain/access-contract";
import { SETUP_REPORT } from "@/server/query/setup-report";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * MCP over the official SDK's streamable HTTP transport. Tool bodies call the
 * same HTTP access handlers as the admin API. Stateless: each request builds
 * its own server. Protocol negotiation belongs to the SDK.
 */
export function createMcpHandler(deps: AccessDeps) {
  const http = createAccessHandlers(deps);
  return async function handle(request: Request): Promise<Response> {
    const probe = await http.session(request);
    if (probe.status !== 200) return probe;
    const session = (await probe.json()) as {
      permissions: string[];
      path: string;
    };
    const server = new McpServer({
      name: "tutor-mbos",
      version: ACCESS_CONTRACT_VERSION,
    });
    server.registerTool(
      "capabilities",
      {
        description:
          "Supported actions, permissions and the access contract version.",
        inputSchema: z.object({}),
      },
      async () =>
        text({
          contractVersion: ACCESS_CONTRACT_VERSION,
          permissions: session.permissions,
          profiles: CLIENT_PROFILES,
          report: SETUP_REPORT,
          path: session.path,
        }),
    );
    server.registerTool(
      "setup_status",
      {
        description: "Setup report for the authenticated owner's business.",
        inputSchema: z.object({}),
      },
      async () => {
        const report = await http.setupReport(request);
        const body = await report.json();
        return { ...text(body), isError: report.status !== 200 };
      },
    );
    server.registerTool(
      "create_business",
      {
        description:
          "Create the caller's first business. Idempotent per owner.",
        inputSchema: z.object({
          displayName: z.string(),
          idempotencyKey: z.string(),
        }),
      },
      async ({ displayName, idempotencyKey }) => {
        const created = await http.postBusiness(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify({ displayName, idempotencyKey }),
          }),
        );
        const body = await created.json();
        return { ...text(body), isError: created.status >= 400 };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
