import { describe, expect, it } from "vitest";
import {
  handleCallback,
  handleLogin,
  handleRecovery,
} from "@/adapters/http/browser-auth";
import {
  authorizationDetailsUrl,
  safeClientRedirect,
} from "@/adapters/http/consent";
import { allowedAppRedirects } from "@/server/config/access";
import { DEV_ORIGIN } from "./helpers/tokens";

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
      },
      DEV_ORIGIN,
    );
    expect(response.status).toBe(303);
    expect(seen).toBe(allowedAppRedirects(DEV_ORIGIN)[0]);
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
      },
      DEV_ORIGIN,
    );
    expect(callback.headers.get("location")).toBe(`${DEV_ORIGIN}/business`);
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
  });
});
