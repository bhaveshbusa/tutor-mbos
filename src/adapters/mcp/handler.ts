import { createAccessHandlers, type AccessDeps } from "@/adapters/http/access";
import {
  ACCESS_CONTRACT_VERSION,
  CLIENT_PROFILES,
  negotiateMcpProtocol,
} from "@/server/domain/access-contract";
import { SETUP_REPORT } from "@/server/query/setup-report";
import { problemResponse } from "@/adapters/http/problem";

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
  };
}

const TOOLS = [
  {
    name: "capabilities",
    description:
      "Supported actions, permissions and the access contract version.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "setup_status",
    description: "Setup report for the authenticated owner's business.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_business",
    description: "Create the caller's first business. Idempotent per owner.",
    inputSchema: {
      type: "object",
      properties: {
        displayName: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["displayName", "idempotencyKey"],
      additionalProperties: false,
    },
  },
];

function rpc(id: unknown, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: { "cache-control": "no-store" } },
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { headers: { "cache-control": "no-store" } },
  );
}

export function createMcpHandler(deps: AccessDeps) {
  const http = createAccessHandlers(deps);
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      const response = problemResponse(
        405,
        "Method not allowed",
        "MCP uses POST.",
      );
      return new Response(response.body, {
        status: 405,
        headers: { ...Object.fromEntries(response.headers), allow: "POST" },
      });
    }
    let message: RpcRequest;
    try {
      message = (await request.json()) as RpcRequest;
    } catch {
      return rpcError(null, -32700, "parse_error");
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message.id, -32600, "invalid_request");
    }
    const probe = await http.session(request);
    if (probe.status === 401 || probe.status === 503) return probe;
    if (probe.status !== 200) return probe;
    const session = (await probe.json()) as {
      permissions: string[];
      path: string;
    };

    if (message.method === "initialize") {
      return rpc(message.id, {
        protocolVersion: negotiateMcpProtocol(message.params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "tutor-mbos", version: ACCESS_CONTRACT_VERSION },
      });
    }
    if (message.method === "tools/list") {
      return rpc(message.id, { tools: TOOLS });
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === "capabilities") {
        return rpc(message.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                contractVersion: ACCESS_CONTRACT_VERSION,
                permissions: session.permissions,
                profiles: CLIENT_PROFILES,
                report: SETUP_REPORT,
                path: session.path,
              }),
            },
          ],
        });
      }
      if (name === "setup_status") {
        const report = await http.setupReport(request);
        const body = await report.json();
        return rpc(message.id, {
          isError: report.status !== 200,
          content: [{ type: "text", text: JSON.stringify(body) }],
        });
      }
      if (name === "create_business") {
        const created = await http.postBusiness(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify({
              displayName: args.displayName,
              idempotencyKey: args.idempotencyKey,
              tenantId: args.tenantId,
            }),
          }),
        );
        const body = await created.json();
        return rpc(message.id, {
          isError: created.status >= 400,
          content: [{ type: "text", text: JSON.stringify(body) }],
        });
      }
      return rpcError(message.id, -32602, "unknown_tool");
    }
    if (message.method === "ping") return rpc(message.id, {});
    return rpcError(message.id, -32601, "method_not_found");
  };
}
