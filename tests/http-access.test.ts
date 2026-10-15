import { describe, expect, it } from "vitest";
import { createAccessHandlers, type AccessDeps } from "@/adapters/http/access";
import {
  handleConsentDecision,
  revokeSupabaseOauthGrant,
} from "@/adapters/http/consent";
import { authenticateMaterial } from "@/server/application/authenticate";
import { verifyAccessToken } from "@/server/application/access-token";
import {
  acceptedAudiences,
  protectedResourceMetadataUrl,
} from "@/server/config/access";
import { migratedDatabase } from "./helpers/database";
import {
  API_CLIENT,
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

async function world() {
  const keys = await signingKey();
  const { store } = await migratedDatabase();
  const users = new Map<string, string>();
  const deps: AccessDeps = {
    siteOrigin: DEV_ORIGIN,
    resourceMetadataUrl: protectedResourceMetadataUrl(DEV_ORIGIN),
    now: () => NOW,
    store,
    async verify(token) {
      return verifyAccessToken(token, {
        jwks: [keys.jwk],
        issuer: ISSUER,
        audiences: acceptedAudiences(DEV_ORIGIN),
        now: NOW,
      });
    },
    authServer: {
      async getUser(token) {
        const userId = users.get(token);
        return userId ? { userId } : null;
      },
    },
    sessionToken: (request) => request.headers.get("x-test-session"),
  };
  async function mint(userId: string, extra: Record<string, unknown> = {}) {
    const jwt = await signToken(keys.privateKey, sessionClaims(userId, extra));
    users.set(jwt, userId);
    return jwt;
  }
  return { deps, store, mint, handlers: createAccessHandlers(deps) };
}

function ui(url: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", DEV_ORIGIN);
  headers.set("x-test-session", token);
  return new Request(url, { ...init, headers });
}

describe("HTTP API access", () => {
  it("isolates two tenants and ignores a caller-supplied tenant id", async () => {
    const { handlers, mint } = await world();
    const tokenA = await mint(TENANT_A.userId);
    const tokenB = await mint(TENANT_B.userId);
    const createdA = await handlers.postBusiness(
      ui(
        "https://example.test/api/v1/business?tenantId=" + TENANT_B.userId,
        tokenA,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "create-a",
            "x-tenant-id": TENANT_B.userId,
          },
          body: JSON.stringify({
            displayName: TENANT_A.name,
            tenantId: TENANT_B.userId,
            businessId: TENANT_B.userId,
            ownerUserId: TENANT_B.userId,
          }),
        },
      ),
    );
    const createdB = await handlers.postBusiness(
      ui("https://example.test/api/v1/business", tokenB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-b",
        },
        body: JSON.stringify({ displayName: TENANT_B.name }),
      }),
    );
    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    const bodyA = await createdA.json();
    const bodyB = await createdB.json();
    expect(bodyA.business.displayName).toBe(TENANT_A.name);
    expect(bodyB.business.displayName).toBe(TENANT_B.name);
    expect(bodyA.business.id).not.toBe(bodyB.business.id);
    expect(JSON.stringify(bodyA)).not.toContain(TENANT_B.name);
    expect(JSON.stringify(bodyA)).not.toContain(bodyB.business.id);

    const retry = await handlers.postBusiness(
      ui("https://example.test/api/v1/business", tokenA, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-a-again",
        },
        body: JSON.stringify({ displayName: "Different name" }),
      }),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      created: false,
      business: { id: bodyA.business.id, displayName: TENANT_A.name },
    });

    const seen = await handlers.getBusiness(
      ui(
        "https://example.test/api/v1/business?tenantId=" + bodyB.business.id,
        tokenA,
      ),
    );
    expect(await seen.json()).toMatchObject({
      business: { id: bodyA.business.id, displayName: TENANT_A.name },
    });
    const withoutOrigin = await handlers.postBusiness(
      new Request("https://example.test/api/v1/business", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "no-origin",
          "x-test-session": tokenA,
        },
        body: JSON.stringify({ displayName: TENANT_A.name }),
      }),
    );
    expect(withoutOrigin.status).toBe(403);
  });

  it("enforces grants, expiry and revocation for a standards-based API client", async () => {
    const { handlers, mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    await handlers.postBusiness(
      ui("https://example.test/api/v1/business", owner, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "owner",
        },
        body: JSON.stringify({ displayName: TENANT_A.name }),
      }),
    );
    const consent = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-api",
          decision: "approve",
          permissions: "business.read",
        }),
      }),
      deps,
      {
        async details() {
          return {
            clientId: API_CLIENT,
            clientName: "API client",
            redirectUri: "https://api-client.example/callback",
            scopes: ["openid", "email", "business.onboard"],
          };
        },
        async decide() {
          return { redirectUrl: "https://api-client.example/callback?code=1" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(consent.status).toBe(303);
    const apiToken = await mint(TENANT_A.userId, { client_id: API_CLIENT });
    const read = await handlers.getBusiness(
      new Request("https://example.test/api/v1/business", {
        headers: { authorization: `Bearer ${apiToken}` },
      }),
    );
    expect(read.status).toBe(200);
    const reportDenied = await handlers.setupReport(
      new Request("https://example.test/api/v1/reports/setup", {
        headers: { authorization: `Bearer ${apiToken}` },
      }),
    );
    expect(reportDenied.status).toBe(403);
    const createDenied = await handlers.postBusiness(
      new Request("https://example.test/api/v1/business", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          "idempotency-key": "api-create",
        },
        body: JSON.stringify({
          displayName: "Other",
          tenantId: TENANT_B.userId,
        }),
      }),
    );
    expect(createDenied.status).toBe(403);

    const revoked = await handlers.revoke(
      ui("https://example.test/api/v1/grants/revoke", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: API_CLIENT }),
      }),
    );
    expect(await revoked.json()).toMatchObject({ revoked: true });
    const after = await handlers.getBusiness(
      new Request("https://example.test/api/v1/business", {
        headers: { authorization: `Bearer ${apiToken}` },
      }),
    );
    expect(after.status).toBe(403);

    const expiredToken = await mint(TENANT_A.userId, {
      exp: Math.floor(NOW.getTime() / 1000) - 120,
    });
    const stale = await handlers.getBusiness(
      ui("https://example.test/api/v1/business", expiredToken),
    );
    expect(stale.status).toBe(401);
  });

  it("stores only the checked permissions, not OIDC scopes or a form client id", async () => {
    const { deps, mint, handlers } = await world();
    const owner = await mint(TENANT_A.userId);
    const form = new URLSearchParams();
    form.set("authorization_id", "authz-chatgpt");
    form.set("decision", "approve");
    form.append("permissions", "reports.read");
    form.append("permissions", "service_role");
    form.set("client_id", GENERIC_MCP_CLIENT);
    const response = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: form,
      }),
      deps,
      {
        async details() {
          return {
            clientId: CHATGPT_CLIENT,
            clientName: "ChatGPT",
            redirectUri: "https://chatgpt.example/callback",
            scopes: ["openid", "email", "business.onboard"],
          };
        },
        async decide() {
          return { redirectUrl: "https://chatgpt.example/callback?code=1" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(response.headers.get("location")).toBe(
      "https://chatgpt.example/callback?code=1",
    );
    const token = await mint(TENANT_A.userId, { client_id: CHATGPT_CLIENT });
    const session = await handlers.session(
      new Request("https://example.test/api/v1/session", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(await session.json()).toMatchObject({
      path: "delegated-oauth",
      clientId: CHATGPT_CLIENT,
      permissions: ["reports.read"],
    });
    const evilRedirect = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-2",
          decision: "deny",
        }),
      }),
      deps,
      {
        async details() {
          return {
            clientId: GENERIC_MCP_CLIENT,
            clientName: "Generic",
            redirectUri: "https://generic.example/callback",
            scopes: ["openid"],
          };
        },
        async decide() {
          return { redirectUrl: "javascript:alert(1)" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(evilRedirect.status).toBe(502);
  });

  it("revokes a prior grant when consent is denied", async () => {
    const { handlers, mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    const gateway = {
      async details() {
        return {
          clientId: API_CLIENT,
          clientName: "API client",
          redirectUri: "https://api-client.example/callback",
          scopes: ["openid"],
        };
      },
      async decide() {
        return { redirectUrl: "https://api-client.example/callback?code=1" };
      },
      async revokeGrant() {
        return { ok: true as const };
      },
    };
    await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-approve",
          decision: "approve",
          permissions: "business.read",
        }),
      }),
      deps,
      gateway,
    );
    const token = await mint(TENANT_A.userId, { client_id: API_CLIENT });
    expect(
      (
        await handlers.getBusiness(
          new Request("https://example.test/api/v1/business", {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(200);
    const denied = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-deny",
          decision: "deny",
        }),
      }),
      deps,
      gateway,
    );
    expect(denied.status).toBe(303);
    expect(
      (
        await handlers.getBusiness(
          new Request("https://example.test/api/v1/business", {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("reconnects only when one live grant matches the already-consented redirect", async () => {
    const { mint, deps, store } = await world();
    const owner = await mint(TENANT_A.userId);
    await store.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: API_CLIENT,
        permissions: ["business.read"],
        scopes: ["openid"],
        authorizationId: "earlier",
        decision: "approved",
        redirectUri: "https://api-client.example/callback",
      },
    );
    await store.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: CHATGPT_CLIENT,
        permissions: ["reports.read"],
        scopes: ["openid"],
        authorizationId: "chatgpt",
        decision: "approved",
        redirectUri: "https://chatgpt.example/callback",
      },
    );
    const response = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-again",
          decision: "approve",
        }),
      }),
      deps,
      {
        async details() {
          return {
            redirectUrl: "https://api-client.example/callback?code=1&state=abc",
          };
        },
        async decide() {
          return { redirectUrl: "https://api-client.example/callback?code=1" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://api-client.example/callback?code=1&state=abc",
    );
    const spoofed = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-spoof",
          decision: "approve",
        }),
      }),
      deps,
      {
        async details() {
          return {
            redirectUrl: `https://evil.example/callback?code=1&client_id=${API_CLIENT}`,
          };
        },
        async decide() {
          return { redirectUrl: "https://evil.example/callback?code=1" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(spoofed.status).toBe(409);
    await store.revokeGrant(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      API_CLIENT,
    );
    const again = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-revoked",
          decision: "approve",
        }),
      }),
      deps,
      {
        async details() {
          return {
            redirectUrl: "https://api-client.example/callback?code=2",
          };
        },
        async decide() {
          return { redirectUrl: "https://api-client.example/callback?code=2" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(again.status).toBe(409);
    const chatgpt = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-chatgpt-back",
          decision: "approve",
        }),
      }),
      deps,
      {
        async details() {
          return {
            redirectUrl: "https://chatgpt.example/callback/?code=9",
          };
        },
        async decide() {
          return { redirectUrl: "https://chatgpt.example/callback/?code=9" };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(chatgpt.status).toBe(303);
  });

  it("does not reconnect when two live grants share one redirect", async () => {
    const { mint, deps, store } = await world();
    const owner = await mint(TENANT_A.userId);
    const shared = "https://shared.example/callback";
    for (const clientId of [API_CLIENT, CHATGPT_CLIENT]) {
      await store.recordConsent(
        { path: "ui-session", userId: TENANT_A.userId, clientId: null },
        {
          oauthClientId: clientId,
          permissions: ["business.read"],
          scopes: ["openid"],
          authorizationId: clientId,
          decision: "approved",
          redirectUri: shared,
        },
      );
    }
    const response = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-shared",
          decision: "approve",
        }),
      }),
      deps,
      {
        async details() {
          return { redirectUrl: `${shared}?code=1` };
        },
        async decide() {
          return { redirectUrl: `${shared}?code=1` };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(response.status).toBe(409);
  });

  it("denies a new client when Supabase has no grant to delete", async () => {
    const { mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    let decided = false;
    const denied = await handleConsentDecision(
      ui("https://example.test/api/oauth/decision", owner, {
        method: "POST",
        body: new URLSearchParams({
          authorization_id: "authz-first-deny",
          decision: "deny",
        }),
      }),
      deps,
      {
        async details() {
          return {
            clientId: API_CLIENT,
            clientName: "API client",
            redirectUri: "https://api-client.example/callback",
            scopes: ["openid"],
          };
        },
        async decide() {
          decided = true;
          return {
            redirectUrl:
              "https://api-client.example/callback?error=access_denied",
          };
        },
        async revokeGrant() {
          return { ok: true };
        },
      },
    );
    expect(decided).toBe(true);
    expect(denied.status).toBe(303);
  });

  it("revokes the app grant when Supabase already has no OAuth grant", async () => {
    const { handlers, mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    await deps.store!.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: API_CLIENT,
        permissions: ["business.read"],
        scopes: ["openid"],
        authorizationId: "retry",
        decision: "approved",
        redirectUri: "https://api-client.example/callback",
      },
    );
    deps.revokeAuthGrant = async () => "ok";
    const revoked = await handlers.revoke(
      ui("https://example.test/api/v1/grants/revoke", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: API_CLIENT }),
      }),
    );
    expect(revoked.status).toBe(200);
    const token = await mint(TENANT_A.userId, { client_id: API_CLIENT });
    expect(
      (
        await handlers.getBusiness(
          new Request("https://example.test/api/v1/business", {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("leaves the app grant when Supabase reports the OAuth server disabled", async () => {
    const { handlers, mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    await deps.store!.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: API_CLIENT,
        permissions: ["business.read"],
        scopes: ["openid"],
        authorizationId: "disabled",
        decision: "approved",
        redirectUri: "https://api-client.example/callback",
      },
    );
    deps.revokeAuthGrant = async (sessionToken, clientId) => {
      const result = await revokeSupabaseOauthGrant(
        "https://idvzjqrkgnihvxoswuxu.supabase.co",
        `sb_${"publishable"}_disabled`,
        sessionToken,
        clientId,
        async () =>
          Response.json({ error_code: "feature_disabled" }, { status: 404 }),
      );
      return result === "gone" ? "ok" : "failed";
    };
    const revoked = await handlers.revoke(
      ui("https://example.test/api/v1/grants/revoke", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: API_CLIENT }),
      }),
    );
    expect(revoked.status).toBe(502);
    const token = await mint(TENANT_A.userId, { client_id: API_CLIENT });
    expect(
      (
        await handlers.getBusiness(
          new Request("https://example.test/api/v1/business", {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it("does not revoke the app grant when the authentication server refuses", async () => {
    const { handlers, mint, deps } = await world();
    const owner = await mint(TENANT_A.userId);
    await deps.store!.recordConsent(
      { path: "ui-session", userId: TENANT_A.userId, clientId: null },
      {
        oauthClientId: API_CLIENT,
        permissions: ["business.read"],
        scopes: ["openid"],
        authorizationId: "keep",
        decision: "approved",
      },
    );
    deps.revokeAuthGrant = async () => "failed";
    const revoked = await handlers.revoke(
      ui("https://example.test/api/v1/grants/revoke", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: API_CLIENT }),
      }),
    );
    expect(revoked.status).toBe(502);
    const token = await mint(TENANT_A.userId, { client_id: API_CLIENT });
    expect(
      (
        await handlers.getBusiness(
          new Request("https://example.test/api/v1/business", {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("authenticateMaterial", () => {
  it("keeps bearer and cookie paths separate", async () => {
    const keys = await signingKey();
    const delegated = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId, { client_id: API_CLIENT }),
    );
    const session = await signToken(
      keys.privateKey,
      sessionClaims(TENANT_A.userId),
    );
    const verify = (token: string) =>
      verifyAccessToken(token, {
        jwks: [keys.jwk],
        issuer: ISSUER,
        audiences: acceptedAudiences(DEV_ORIGIN),
        now: NOW,
      });
    const authServer = {
      async getUser(token: string) {
        return token === delegated || token === session
          ? { userId: TENANT_A.userId }
          : null;
      },
    };
    expect(
      await authenticateMaterial({
        bearerToken: delegated,
        sessionToken: session,
        verify,
        authServer,
      }),
    ).toMatchObject({
      ok: true,
      presented: "bearer",
      actor: { path: "delegated-oauth", clientId: API_CLIENT },
    });
    expect(
      await authenticateMaterial({
        bearerToken: null,
        sessionToken: delegated,
        verify,
        authServer,
      }),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await authenticateMaterial({
        bearerToken: null,
        sessionToken: null,
        verify,
        authServer,
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
