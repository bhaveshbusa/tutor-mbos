import { describe, expect, it } from "vitest";
import {
  AUTH_ADMIN_KEY_SECRET,
  CLEANUP_PROJECT_REF,
  expectedCleanupEmail,
  reviewCleanupManifest,
  type CleanupIdentity,
  type CleanupManifest,
} from "@/server/application/acceptance-cleanup";
import {
  formatCleanupExecution,
  runAcceptanceCleanup,
} from "../scripts/hosted-acceptance-cleanup.ts";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

const nonce = "ab".repeat(16);
const identity: CleanupIdentity = {
  projectRef: CLEANUP_PROJECT_REF,
  commit: "a".repeat(40),
  runId: "4242",
  runNonce: nonce,
};
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const clientA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const victim = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";

function manifest(overrides: Partial<CleanupManifest> = {}): CleanupManifest {
  return {
    version: 1,
    environment: "development",
    projectRef: CLEANUP_PROJECT_REF,
    commit: identity.commit,
    runId: identity.runId,
    runNonce: nonce,
    users: [{ label: "tenant-a", id: userA }],
    clients: [{ name: "tutor-mbos-generic-acceptance", id: clientA }],
    ...overrides,
  };
}

describe("cleanup manifest review", () => {
  it("accepts only this development run's bounded resources", () => {
    expect(CLEANUP_PROJECT_REF).toBe(
      ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
    );
    expect(reviewCleanupManifest(manifest(), identity).ok).toBe(true);
    expect(
      reviewCleanupManifest(manifest(), {
        ...identity,
        runNonce: "cd".repeat(16),
      }).ok,
    ).toBe(false);
    expect(
      reviewCleanupManifest(
        manifest({
          users: [
            { label: "tenant-a", id: userA },
            { label: "tenant-b", id: userB },
            { label: "tenant-a", id: victim },
          ],
        }),
        identity,
      ).ok,
    ).toBe(false);
    expect(
      reviewCleanupManifest(
        manifest({
          clients: [{ name: "other-product", id: clientA } as never],
        }),
        identity,
      ).ok,
    ).toBe(false);
    expect(
      reviewCleanupManifest(
        manifest({ projectRef: "vblwjqfpcmegbugmufif" }),
        identity,
      ).ok,
    ).toBe(false);
  });
});

describe("auth admin cleanup execution", () => {
  const supabaseUrl = "https://example.test";

  function adminDouble(options?: {
    email?: string;
    redirects?: string[];
    name?: string;
  }) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (
        url.pathname === `/auth/v1/admin/users/${userA}` &&
        method === "GET"
      ) {
        return Response.json({
          id: userA,
          email: options?.email ?? expectedCleanupEmail("tenant-a", nonce),
        });
      }
      if (
        url.pathname === `/auth/v1/admin/users/${userA}` &&
        method === "DELETE"
      ) {
        return new Response(null, { status: 200 });
      }
      if (
        url.pathname === `/auth/v1/admin/oauth/clients/${clientA}` &&
        method === "GET"
      ) {
        return Response.json({
          client_id: clientA,
          client_name: options?.name ?? "tutor-mbos-generic-acceptance",
          redirect_uris: options?.redirects ?? [
            "https://example.com/oauth/callback",
          ],
        });
      }
      if (
        url.pathname === `/auth/v1/admin/oauth/clients/${clientA}` &&
        method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      return Response.json({ missing: url.pathname }, { status: 404 });
    };
    return { fetchImpl, calls };
  }

  it("deletes only a user and client that match this run", async () => {
    const doubled = adminDouble();
    const result = await runAcceptanceCleanup({
      manifestText: JSON.stringify(manifest()),
      adminKey: "admin-key",
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
    });
    expect(result).toMatchObject({
      status: "pass",
      usersDeleted: 1,
      clientsDeleted: 1,
    });
    expect(doubled.calls).toEqual([
      `GET /auth/v1/admin/users/${userA}`,
      `DELETE /auth/v1/admin/users/${userA}`,
      `GET /auth/v1/admin/oauth/clients/${clientA}`,
      `DELETE /auth/v1/admin/oauth/clients/${clientA}`,
    ]);
    expect(formatCleanupExecution(result)).toContain(
      "sessions_removed_by_user_delete=true",
    );
    expect(formatCleanupExecution(result)).not.toContain("@example.com");
  });

  it("does not delete a user whose email is not this run", async () => {
    const doubled = adminDouble({ email: "other@example.com" });
    const result = await runAcceptanceCleanup({
      manifestText: JSON.stringify(manifest()),
      adminKey: "admin-key",
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
    });
    expect(result.status).toBe("fail");
    expect(result.usersDeleted).toBe(0);
    expect(
      doubled.calls.some((call) =>
        call.startsWith("DELETE /auth/v1/admin/users"),
      ),
    ).toBe(false);
  });

  it("does not delete a client whose redirect differs", async () => {
    const doubled = adminDouble({
      redirects: [
        "https://example.com/oauth/callback",
        "https://evil.example/cb",
      ],
    });
    const result = await runAcceptanceCleanup({
      manifestText: JSON.stringify(manifest()),
      adminKey: "admin-key",
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
    });
    expect(result.clientsDeleted).toBe(0);
    expect(result.status).toBe("fail");
    expect(
      doubled.calls.some((call) =>
        call.startsWith("DELETE /auth/v1/admin/oauth"),
      ),
    ).toBe(false);
  });

  it("deletes nothing when the manifest is missing or the admin key is absent", async () => {
    const doubled = adminDouble();
    const missing = await runAcceptanceCleanup({
      manifestText: null,
      adminKey: "admin-key",
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
    });
    expect(missing).toMatchObject({
      status: "fail",
      usersDeleted: 0,
      clientsDeleted: 0,
      detail: "manifest_absent",
    });
    const unkeyed = await runAcceptanceCleanup({
      manifestText: JSON.stringify(manifest()),
      adminKey: null,
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
    });
    expect(unkeyed.detail).toContain(`secret_absent:${AUTH_ADMIN_KEY_SECRET}`);
    expect(doubled.calls).toEqual([]);
  });
});
