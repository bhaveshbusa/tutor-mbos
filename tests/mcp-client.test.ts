import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createMcpHandler } from "@/adapters/mcp/handler";
import type { AccessDeps } from "@/adapters/http/access";
import { verifySupabaseAccessToken } from "@/server/application/verify-supabase-token";
import {
  acceptedAudiences,
  protectedResourceMetadataUrl,
} from "@/server/config/access";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";
import { migratedDatabase } from "./helpers/database";
import {
  CHATGPT_CLIENT,
  DEV_ORIGIN,
  ISSUER,
  TENANT_A,
  sessionClaims,
  signToken,
  signingKey,
} from "./helpers/tokens";

const supabaseUrl = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const publishableKey = `sb_${"publishable"}_ci`;

async function listen(handle: (request: Request) => Promise<Response>) {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value !== undefined) headers.set(key, value);
      }
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handle(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/api/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("official MCP client", () => {
  it("discovers tools, creates a business, and loses it after revocation", async () => {
    const keys = await signingKey();
    const { store } = await migratedDatabase();
    const users = new Map<string, string>();
    const deps: AccessDeps = {
      siteOrigin: DEV_ORIGIN,
      resourceMetadataUrl: protectedResourceMetadataUrl(DEV_ORIGIN),
      now: () => new Date(),
      storeFor: () => store,
      verify: (presented) =>
        verifySupabaseAccessToken({
          token: presented,
          supabaseUrl,
          publishableKey,
          issuer: ISSUER,
          audiences: acceptedAudiences(DEV_ORIGIN),
          jwks: { keys: [keys.jwk] },
        }),
      authServer: {
        async getUser(token) {
          const userId = users.get(token);
          return userId ? { userId } : null;
        },
      },
      sessionToken: () => null,
    };
    await store.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: CHATGPT_CLIENT,
        permissions: ["business.onboard", "business.read", "reports.read"],
        scopes: ["openid"],
        authorizationId: "sdk",
        decision: "approved",
      },
    );
    const token = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId, { client_id: CHATGPT_CLIENT }),
    );
    users.set(token, TENANT_A.userId);
    const endpoint = await listen(createMcpHandler(deps));
    const client = new Client({ name: "tutor-mbos-sdk-smoke", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "capabilities",
        "create_business",
        "setup_status",
      ]);
      const created = await client.callTool({
        name: "create_business",
        arguments: {
          displayName: TENANT_A.name,
          idempotencyKey: "sdk-once",
        },
      });
      expect(created.isError).toBe(false);
      expect(JSON.stringify(created.content)).toContain(TENANT_A.name);
      const again = await client.callTool({
        name: "create_business",
        arguments: {
          displayName: "A different name",
          idempotencyKey: "sdk-again",
        },
      });
      expect(JSON.stringify(again.content)).toContain(TENANT_A.name);
      expect(JSON.stringify(again.content)).not.toContain("A different name");
      await store.revokeGrant(
        { path: "ui-session", userId: TENANT_A.userId, clientId: null },
        CHATGPT_CLIENT,
      );
      const revoked = await client.callTool({
        name: "setup_status",
        arguments: {},
      });
      expect(revoked.isError).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await endpoint.close();
    }
  });
});
