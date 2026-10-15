import { describe, expect, it } from "vitest";
import {
  authStorageKey,
  readUiSession,
  withAccess,
} from "@/adapters/http/production";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

const projectRef = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
const supabaseUrl = `https://${projectRef}.supabase.co`;
const publishableKey = `sb_${"publishable"}_session_test`;

function sessionCookie(name: string, session: Record<string, unknown>): string {
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  return `${name}=${encoded}`;
}

describe("UI session refresh", () => {
  it("writes rotated cookies when an expired access token still has a refresh token", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/token?grant_type=refresh_token")) {
        expect(String(init?.body)).toContain("refresh-old");
        return new Response(
          JSON.stringify({
            access_token: "access-new",
            refresh_token: "refresh-new",
            token_type: "bearer",
            expires_in: 3600,
            user: {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
              aud: "authenticated",
              role: "authenticated",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    };
    const storageKey = `sb-${projectRef}-auth-token`;
    const expired = sessionCookie(storageKey, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_at: Math.floor(Date.now() / 1000) - 120,
      token_type: "bearer",
    });
    const session = await readUiSession(
      new Request("https://example.test/api/v1/session", {
        headers: { cookie: expired },
      }),
      supabaseUrl,
      publishableKey,
      fetchImpl,
    );
    expect(calls.some((url) => url.includes("grant_type=refresh_token"))).toBe(
      true,
    );
    expect(session.accessToken).toBe("access-new");
    const rotated = session.setCookies.find((cookie) =>
      cookie.startsWith(`${storageKey}=`),
    );
    expect(rotated).toBeTruthy();
    const encoded = rotated!.slice(storageKey.length + 1).split(";")[0] ?? "";
    const decoded = JSON.parse(
      Buffer.from(encoded.slice("base64-".length), "base64url").toString(),
    ) as { access_token?: string; refresh_token?: string };
    expect(decoded.access_token).toBe("access-new");
    expect(decoded.refresh_token).toBe("refresh-new");
  });

  it("does not refresh while a page only reads the stored session", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    };
    const storageKey = authStorageKey(supabaseUrl);
    const env = {
      TUTOR_MBOS_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    };
    const expired = sessionCookie(storageKey, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_at: Math.floor(Date.now() / 1000) - 120,
      token_type: "bearer",
    });
    const response = await withAccess(
      new Request("https://example.test/oauth/consent", {
        headers: { cookie: expired },
      }),
      env,
      async (deps) => {
        const token = await deps.sessionToken(
          new Request("https://example.test/oauth/consent", {
            headers: { cookie: expired },
          }),
        );
        return Response.json({ token });
      },
      { fetch: fetchImpl, session: "stored" },
    );
    expect(await response.json()).toEqual({ token: null });
    expect(calls.some((url) => url.includes("grant_type=refresh_token"))).toBe(
      false,
    );
    const fresh = sessionCookie(storageKey, {
      access_token: "access-live",
      refresh_token: "refresh-live",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
    });
    const live = await withAccess(
      new Request("https://example.test/oauth/consent", {
        headers: { cookie: fresh },
      }),
      env,
      async (deps) =>
        Response.json({
          token: await deps.sessionToken(
            new Request("https://example.test/oauth/consent", {
              headers: { cookie: fresh },
            }),
          ),
        }),
      { fetch: fetchImpl, session: "stored" },
    );
    expect(await live.json()).toEqual({ token: "access-live" });
    expect(calls).toEqual([]);
  });
});
