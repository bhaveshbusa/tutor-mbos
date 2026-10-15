import { describe, expect, it } from "vitest";
import { createMcpHandler } from "@/adapters/mcp/handler";
import { protectedResourceDocument } from "@/adapters/http/discovery";
import type { AccessDeps } from "@/adapters/http/access";
import { verifyAccessToken } from "@/server/application/access-token";
import { CLIENT_PROFILES } from "@/server/domain/access-contract";
import {
  acceptedAudiences,
  authIssuer,
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
  GENERIC_MCP_CLIENT,
  ISSUER,
  NOW,
  TENANT_A,
  TENANT_B,
  sessionClaims,
  signToken,
  signingKey,
} from "./helpers/tokens";

const supabaseUrl = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);

async function mcp() {
  const keys = await signingKey();
  const { store } = await migratedDatabase();
  const users = new Map<string, string>();
  const deps: AccessDeps = {
    siteOrigin: DEV_ORIGIN,
    resourceMetadataUrl: protectedResourceMetadataUrl(DEV_ORIGIN),
    now: () => NOW,
    store,
    verify: (token) =>
      verifyAccessToken(token, {
        jwks: [keys.jwk],
        issuer: ISSUER,
        audiences: acceptedAudiences(DEV_ORIGIN),
        now: NOW,
      }),
    authServer: {
      async getUser(token) {
        const userId = users.get(token);
        return userId ? { userId } : null;
      },
    },
    sessionToken: (request) => request.headers.get("x-test-session"),
  };
  async function mint(userId: string, clientId?: string) {
    const jwt = await signToken(
      keys.privateKey,
      sessionClaims(userId, clientId ? { client_id: clientId } : {}),
    );
    users.set(jwt, userId);
    return jwt;
  }
  return { store, mint, handle: createMcpHandler(deps) };
}

function rpc(method: string, token: string | null, params?: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://example.test/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("MCP clients", () => {
  it("publishes one protected resource for ChatGPT and another MCP client", () => {
    const document = protectedResourceDocument(DEV_ORIGIN, supabaseUrl);
    expect(document.authorization_servers).toEqual([authIssuer(supabaseUrl)]);
    expect(document.resource).toBe(`${DEV_ORIGIN}/api/mcp`);
    expect(document.scopes_supported).not.toContain("business.onboard");
    expect(CLIENT_PROFILES.chatgpt.discovery).toBe(
      CLIENT_PROFILES["generic-mcp"].discovery,
    );
    expect(CLIENT_PROFILES.chatgpt.registration).not.toBe(
      CLIENT_PROFILES["generic-mcp"].registration,
    );
  });

  it("fails closed without a token and then serves each client's own grant", async () => {
    const { handle, mint, store } = await mcp();
    const anonymous = await handle(rpc("initialize", null));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    expect(await anonymous.text()).not.toContain("create_business");

    await store.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: CHATGPT_CLIENT,
        permissions: ["business.onboard", "reports.read", "business.read"],
        scopes: ["openid"],
        authorizationId: "cg",
        decision: "approved",
      },
    );
    await store.recordConsent(
      { path: "ui-session", userId: TENANT_B.userId, clientId: null },
      {
        oauthClientId: GENERIC_MCP_CLIENT,
        permissions: ["reports.read"],
        scopes: ["openid"],
        authorizationId: "gm",
        decision: "approved",
      },
    );
    await store.createBusiness(
      { path: "ui-session", userId: TENANT_B.userId, clientId: null },
      { displayName: TENANT_B.name, idempotencyKey: "b" },
    );

    const chatgpt = await mint(TENANT_A.userId, CHATGPT_CLIENT);
    const created = await handle(
      rpc("tools/call", chatgpt, {
        name: "create_business",
        arguments: {
          displayName: TENANT_A.name,
          idempotencyKey: "a",
          tenantId: TENANT_B.userId,
        },
      }),
    );
    const createdBody = await created.json();
    expect(createdBody.result.isError).toBe(false);
    expect(createdBody.result.content[0].text).toContain(TENANT_A.name);
    expect(createdBody.result.content[0].text).not.toContain(TENANT_B.name);

    const generic = await mint(TENANT_B.userId, GENERIC_MCP_CLIENT);
    const denied = await handle(
      rpc("tools/call", generic, {
        name: "create_business",
        arguments: { displayName: "Nope", idempotencyKey: "nope" },
      }),
    );
    expect((await denied.json()).result.isError).toBe(true);
    const report = await handle(
      rpc("tools/call", generic, { name: "setup_status" }),
    );
    const reportText = (await report.json()).result.content[0].text as string;
    expect(reportText).toContain(TENANT_B.name);
    expect(reportText).not.toContain(TENANT_A.name);

    const swapped = await handle(
      rpc("tools/call", chatgpt, { name: "setup_status" }),
    );
    expect((await swapped.json()).result.content[0].text).not.toContain(
      TENANT_B.name,
    );
  });
});
