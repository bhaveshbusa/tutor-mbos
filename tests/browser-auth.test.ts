import { describe, expect, it } from "vitest";
import {
  handleCallback,
  handleLogin,
  handlePasswordUpdate,
  handleRecovery,
  handleRecoveryCallback,
} from "@/adapters/http/browser-auth";
import {
  authorizationConsentUrl,
  authorizationDetailsUrl,
  authorizationRequest,
  redirectOriginPath,
  revokeSupabaseOauthGrant,
  safeClientRedirect,
} from "@/adapters/http/consent";
import { recoveryRedirect } from "@/server/config/access";
import { DEV_ORIGIN } from "./helpers/tokens";

const auth = {
  async signIn() {
    return "ok" as const;
  },
  async recover() {
    return "ok" as const;
  },
  async exchange() {
    return "ok" as const;
  },
  async updatePassword() {
    return "ok" as const;
  },
};

describe("browser authentication", () => {
  it("uses the allowlisted recovery redirect and rejects an open redirect", async () => {
    let seen = "";
    const response = await handleRecovery(
      new Request("https://example.test/api/auth/recover", {
        method: "POST",
        headers: { origin: DEV_ORIGIN },
        body: new URLSearchParams({
          email: "owner@example.test",
          redirectTo: "https://evil.example/phish",
        }),
      }),
      {
        async signIn() {
          return "invalid";
        },
        async recover(_email, redirectTo) {
          seen = redirectTo;
          return "ok";
        },
        async exchange() {
          return "invalid";
        },
        async updatePassword() {
          return "invalid";
        },
      },
      DEV_ORIGIN,
    );
    expect(response.status).toBe(303);
    expect(seen).toBe(recoveryRedirect(DEV_ORIGIN));
    expect(seen).not.toContain("evil.example");
  });

  it("rejects a foreign origin and an off-allowlist callback next path", async () => {
    const login = await handleLogin(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: new URLSearchParams({
          email: "a@example.test",
          password: "secret",
        }),
      }),
      {
        async signIn() {
          return "ok";
        },
        async recover() {
          return "ok";
        },
        async exchange() {
          return "ok";
        },
        async updatePassword() {
          return "ok";
        },
      },
      DEV_ORIGIN,
    );
    expect(login.status).toBe(403);
    const callback = await handleCallback(
      new Request(
        "https://example.test/auth/callback?code=abc&next=https://evil.example",
      ),
      {
        async signIn() {
          return "ok";
        },
        async recover() {
          return "ok";
        },
        async exchange() {
          return "ok";
        },
        async updatePassword() {
          return "ok";
        },
      },
      DEV_ORIGIN,
    );
    expect(callback.headers.get("location")).toBe(`${DEV_ORIGIN}/business`);
    const recovery = await handleCallback(
      new Request("https://example.test/auth/callback?code=abc&type=recovery"),
      auth,
      DEV_ORIGIN,
    );
    expect(recovery.headers.get("location")).toBe(
      `${DEV_ORIGIN}/auth/update-password`,
    );
  });

  it("sends recovery through a password update and posts consent to /consent", async () => {
    const landed = await handleRecoveryCallback(
      new Request(`${DEV_ORIGIN}/auth/recovery?code=abc`),
      auth,
      DEV_ORIGIN,
    );
    expect(landed.headers.get("location")).toBe(
      `${DEV_ORIGIN}/auth/update-password`,
    );
    const updated = await handlePasswordUpdate(
      new Request(`${DEV_ORIGIN}/api/auth/password`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN },
        body: new URLSearchParams({ password: "new-password" }),
      }),
      auth,
      DEV_ORIGIN,
    );
    expect(updated.status).toBe(303);
    expect(updated.headers.get("location")).toBe(`${DEV_ORIGIN}/business`);
    const short = await handlePasswordUpdate(
      new Request(`${DEV_ORIGIN}/api/auth/password`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN },
        body: new URLSearchParams({ password: "short" }),
      }),
      auth,
      DEV_ORIGIN,
    );
    expect(short.status).toBe(400);
    const supabase = "https://idvzjqrkgnihvxoswuxu.supabase.co";
    expect(authorizationConsentUrl(supabase, "authz/1")).toBe(
      `${authorizationDetailsUrl(supabase, "authz/1")}/consent`,
    );
    expect(authorizationRequest(supabase, "authz/1", "deny")).toEqual({
      url: authorizationConsentUrl(supabase, "authz/1"),
      method: "POST",
      body: { action: "deny" },
    });
    expect(authorizationRequest(supabase, "authz/1", null).method).toBe("GET");
  });

  it("builds the Supabase consent URL without the admin API and rejects unsafe redirects", () => {
    const url = authorizationDetailsUrl(
      "https://idvzjqrkgnihvxoswuxu.supabase.co",
      "authz/1",
    );
    expect(url).toBe(
      "https://idvzjqrkgnihvxoswuxu.supabase.co/auth/v1/oauth/authorizations/authz%2F1",
    );
    expect(url).not.toContain("/admin/");
    expect(safeClientRedirect("https://chatgpt.example/callback")).toContain(
      "https://",
    );
    expect(safeClientRedirect("javascript:alert(1)")).toBeNull();
    expect(
      redirectOriginPath("https://api-client.example/callback/?code=1"),
    ).toBe("https://api-client.example/callback");
  });

  it("treats a missing Supabase OAuth grant as already revoked", async () => {
    const supabase = "https://idvzjqrkgnihvxoswuxu.supabase.co";
    const key = `sb_${"publishable"}_revoke_test`;
    const bodies = [
      { status: 404, error_code: "oauth_consent_not_found" },
      { status: 204, error_code: "" },
      { status: 404, error_code: "feature_disabled" },
      { status: 500, error_code: "unexpected" },
    ];
    const fetchImpl: typeof fetch = async () => {
      const next = bodies.shift();
      if (next?.status === 204) return new Response(null, { status: 204 });
      return Response.json(
        { error_code: next?.error_code },
        { status: next?.status ?? 500 },
      );
    };
    expect(
      await revokeSupabaseOauthGrant(
        supabase,
        key,
        "session",
        "client",
        fetchImpl,
      ),
    ).toBe("gone");
    expect(
      await revokeSupabaseOauthGrant(
        supabase,
        key,
        "session",
        "client",
        fetchImpl,
      ),
    ).toBe("gone");
    expect(
      await revokeSupabaseOauthGrant(
        supabase,
        key,
        "session",
        "client",
        fetchImpl,
      ),
    ).toBe("failed");
    expect(
      await revokeSupabaseOauthGrant(
        supabase,
        key,
        "session",
        "client",
        fetchImpl,
      ),
    ).toBe("failed");
    expect(
      await revokeSupabaseOauthGrant(
        supabase,
        key,
        "session",
        "client",
        async () => {
          throw new Error("offline");
        },
      ),
    ).toBe("failed");
  });
});
