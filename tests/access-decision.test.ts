import { describe, expect, it } from "vitest";
import {
  ACCESS_CONTRACT_VERSION,
  BUSINESS_PERMISSIONS,
  CLIENT_PROFILES,
  OIDC_SCOPES,
  REVOCATION_LATENCY,
} from "@/server/domain/access-contract";
import { permissionsFor } from "@/server/domain/access-decision";
import {
  CHATGPT_CLIENT,
  GENERIC_MCP_CLIENT,
  TENANT_A,
  TENANT_B,
} from "./helpers/tokens";

describe("access decision", () => {
  it("gives the UI session owner permissions and ignores editable claims", () => {
    expect(
      permissionsFor({
        actor: { path: "ui-session", userId: TENANT_A.userId, clientId: null },
        grant: null,
        requestedTenantId: TENANT_B.userId,
        editableClaims: { tenant_id: TENANT_B.userId, role: "service_role" },
        oidcScopes: [...OIDC_SCOPES, "business.onboard"],
      }),
    ).toEqual([...BUSINESS_PERMISSIONS]);
  });

  it("limits a delegated client to its unrevoked server grant", () => {
    expect(
      permissionsFor({
        actor: {
          path: "delegated-oauth",
          userId: TENANT_A.userId,
          clientId: CHATGPT_CLIENT,
        },
        grant: {
          oauthClientId: CHATGPT_CLIENT,
          permissions: ["reports.read", "service_role"],
          revokedAt: null,
        },
        requestedTenantId: TENANT_B.userId,
        oidcScopes: ["openid", "business.onboard"],
      }),
    ).toEqual(["reports.read"]);
    expect(
      permissionsFor({
        actor: {
          path: "delegated-oauth",
          userId: TENANT_A.userId,
          clientId: CHATGPT_CLIENT,
        },
        grant: {
          oauthClientId: CHATGPT_CLIENT,
          permissions: ["reports.read"],
          revokedAt: "2026-10-15T00:00:00.000Z",
        },
      }),
    ).toEqual([]);
    expect(
      permissionsFor({
        actor: {
          path: "delegated-oauth",
          userId: TENANT_A.userId,
          clientId: CHATGPT_CLIENT,
        },
        grant: {
          oauthClientId: GENERIC_MCP_CLIENT,
          permissions: ["business.read"],
          revokedAt: null,
        },
      }),
    ).toEqual([]);
  });

  it("does not treat a delegated token as a UI session", () => {
    expect(
      permissionsFor({
        actor: {
          path: "ui-session",
          userId: TENANT_A.userId,
          clientId: CHATGPT_CLIENT,
        },
        grant: null,
      }),
    ).toEqual([]);
  });

  it("records the client profiles and revocation latency in the contract", () => {
    expect(ACCESS_CONTRACT_VERSION).toBe("2026-10-15");
    expect(REVOCATION_LATENCY).toBe("next-request");
    expect(CLIENT_PROFILES.chatgpt.registration).toBe("dynamic");
    expect(CLIENT_PROFILES["generic-mcp"].registration).toBe(
      "pre-registered-or-dynamic",
    );
    expect(CLIENT_PROFILES["http-api"].pkce).toBe("S256");
    expect(CLIENT_PROFILES["admin-ui"].transport).toBe("cookie");
  });
});
