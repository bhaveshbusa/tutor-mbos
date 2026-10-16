import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_ADMIN_KEY_SECRET,
  CLEANUP_PROJECT_REF,
  adminRequestHeaders,
  expectedCleanupEmail,
  expectedClientName,
  MANIFEST_MAX_BYTES,
  MANIFEST_OUTPUT_NAME,
  reviewCleanupManifest,
  writeManifestAtomic,
  writeManifestOutput,
  type CleanupIdentity,
  type CleanupManifest,
} from "@/server/application/acceptance-cleanup";
import {
  emptyHostedResources,
  formatCleanupExecution,
  readCleanupManifestText,
  runAcceptanceCleanup,
  withManifestReadDetail,
  writeHostedResourcesOutput,
} from "../scripts/hosted-acceptance-cleanup.ts";
import { runAcceptancePreflight } from "../scripts/hosted-acceptance-preflight.ts";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";
import { siteOriginFor } from "@/server/config/access";

const nonce = "ab".repeat(16);
const startedAt = "2026-10-15T20:00:00.000Z";
const nowMs = Date.parse(startedAt) + 1_000;
const identity: CleanupIdentity = {
  projectRef: CLEANUP_PROJECT_REF,
  commit: "a".repeat(40),
  runId: "4242",
  runAttempt: "1",
  runNonce: nonce,
  startedAt,
};
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const clientA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const foreignClient = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const victim = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secretKey = "sb_secret_ci";

function manifest(overrides: Partial<CleanupManifest> = {}): CleanupManifest {
  return {
    version: 1,
    environment: "development",
    projectRef: CLEANUP_PROJECT_REF,
    commit: identity.commit,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    users: [{ label: "tenant-a", id: userA }],
    clients: [{ label: "acceptance", id: clientA }],
    ...overrides,
  };
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

describe("cleanup manifest review", () => {
  it("accepts this development run and rejects untrusted shapes", () => {
    expect(CLEANUP_PROJECT_REF).toBe(
      ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
    );
    const reviewed = reviewCleanupManifest(manifest(), identity);
    expect(reviewed.ok).toBe(true);
    if (reviewed.ok) {
      expect(reviewed.complete).toBe(true);
      expect(reviewed.manifest).not.toHaveProperty("runNonce");
    }
    expect(
      reviewCleanupManifest(
        { ...manifest(), runNonce: "cd".repeat(16) },
        identity,
      ).ok,
    ).toBe(false);
    expect(
      reviewCleanupManifest(manifest(), { ...identity, runAttempt: "2" }).ok,
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
          clients: [{ label: "acceptance", id: "not-a-uuid" }],
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
    const unresolved = reviewCleanupManifest(
      manifest({ users: [{ label: "tenant-a" }] }),
      identity,
    );
    expect(unresolved.ok).toBe(true);
    if (unresolved.ok) expect(unresolved.complete).toBe(false);
  });

  it("writes a complete manifest without leaving a temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tos3-manifest-"));
    const file = join(dir, "acceptance-cleanup-manifest.json");
    const body = JSON.stringify(manifest());
    writeManifestAtomic(file, body);
    expect(readFileSync(file, "utf8")).toBe(body);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(body).not.toContain("@example.com");
    expect(body).not.toContain(nonce);
  });
});

describe("auth admin cleanup execution", () => {
  const supabaseUrl = "https://example.test";

  function adminDouble(options?: {
    email?: string;
    redirects?: string[];
    name?: string;
    createdAt?: string;
    userStatus?: number;
    clientDeleteStatus?: number;
    listUsers?: Record<string, unknown>[];
    listClients?: Record<string, unknown>[];
    userGets?: number;
  }) {
    const calls: string[] = [];
    const seen: Headers[] = [];
    let userGets = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      seen.push(headersOf(init));
      if (url.pathname === "/auth/v1/admin/users" && method === "GET") {
        return Response.json({ users: options?.listUsers ?? [] });
      }
      if (url.pathname === "/auth/v1/admin/oauth/clients" && method === "GET") {
        return Response.json({ clients: options?.listClients ?? [] });
      }
      if (
        url.pathname === `/auth/v1/admin/users/${userA}` &&
        method === "GET"
      ) {
        userGets += 1;
        if (
          (options?.userGets ?? 0) > 0 &&
          userGets <= (options?.userGets ?? 0)
        ) {
          return new Response(null, { status: options?.userStatus ?? 404 });
        }
        if (options?.userStatus === 404) {
          return new Response(null, { status: 404 });
        }
        if (options?.userStatus === 401) {
          return Response.json({ message: "unauthorized" }, { status: 401 });
        }
        return Response.json({
          id: userA,
          email: options?.email ?? expectedCleanupEmail("tenant-a", nonce),
          created_at: options?.createdAt ?? startedAt,
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
          client_name: options?.name ?? expectedClientName("acceptance", nonce),
          redirect_uris: options?.redirects ?? [
            "https://example.com/oauth/callback",
          ],
          created_at: options?.createdAt ?? startedAt,
        });
      }
      if (
        url.pathname === `/auth/v1/admin/oauth/clients/${clientA}` &&
        method === "DELETE"
      ) {
        return new Response(null, {
          status: options?.clientDeleteStatus ?? 204,
        });
      }
      if (
        url.pathname === `/auth/v1/admin/oauth/clients/${foreignClient}` &&
        method === "GET"
      ) {
        return Response.json({
          client_id: foreignClient,
          client_name: "tutor-mbos-generic-acceptance",
          redirect_uris: ["https://example.com/oauth/callback"],
          created_at: startedAt,
        });
      }
      return Response.json({ missing: url.pathname }, { status: 404 });
    };
    return { fetchImpl, calls, seen };
  }

  function run(
    text: string | null,
    doubled: ReturnType<typeof adminDouble>,
    key: string | null = secretKey,
  ) {
    return runAcceptanceCleanup({
      manifestText: text,
      adminKey: key,
      identity,
      supabaseUrl,
      fetchImpl: doubled.fetchImpl,
      nowMs,
    });
  }

  it("deletes only a user and client that match this run", async () => {
    const doubled = adminDouble();
    const result = await run(JSON.stringify(manifest()), doubled);
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
    expect(doubled.seen[0]?.get("apikey")).toBe(secretKey);
    expect(doubled.seen[0]?.get("authorization")).toBeNull();
    expect(formatCleanupExecution(result)).toContain(
      "sessions_removed_by_user_delete=true",
    );
    expect(formatCleanupExecution(result)).not.toContain("@example.com");
  });

  it("sends a bearer token only for a legacy service-role JWT", () => {
    const headers = adminRequestHeaders("eyJabc.eyJdef.sig");
    expect(headers?.authorization).toBe("Bearer eyJabc.eyJdef.sig");
    expect(headers?.apikey).toBe("eyJabc.eyJdef.sig");
    expect(adminRequestHeaders("admin-key")).toBeNull();
  });

  it("does not delete a user whose email is not this run", async () => {
    const doubled = adminDouble({ email: "other@example.com" });
    const result = await run(JSON.stringify(manifest()), doubled);
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
    const result = await run(JSON.stringify(manifest()), doubled);
    expect(result.clientsDeleted).toBe(0);
    expect(result.status).toBe("fail");
    expect(
      doubled.calls.some((call) =>
        call.startsWith("DELETE /auth/v1/admin/oauth"),
      ),
    ).toBe(false);
  });

  it("leaves a matching public name or an older client from another run", async () => {
    const foreign = adminDouble();
    const named = await run(
      JSON.stringify(
        manifest({
          users: [],
          clients: [{ label: "acceptance", id: foreignClient }],
        }),
      ),
      foreign,
    );
    expect(named.clientsDeleted).toBe(0);
    expect(foreign.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    const older = adminDouble({ createdAt: "2020-01-01T00:00:00.000Z" });
    const stale = await run(JSON.stringify(manifest()), older);
    expect(stale.clientsDeleted).toBe(0);
    expect(stale.usersDeleted).toBe(0);
    expect(older.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("retries after a partial deletion without calling DELETE for a user that is already gone", async () => {
    const first = adminDouble({ clientDeleteStatus: 500 });
    const partial = await run(JSON.stringify(manifest()), first);
    expect(partial).toMatchObject({
      status: "fail",
      usersDeleted: 1,
      clientsDeleted: 0,
    });
    const second = adminDouble({ userStatus: 404, listUsers: [] });
    const retried = await run(JSON.stringify(manifest()), second);
    expect(retried.status).toBe("pass");
    expect(retried.usersDeleted).toBe(1);
    expect(retried.clientsDeleted).toBe(1);
    expect(
      second.calls.filter((call) =>
        call.startsWith("DELETE /auth/v1/admin/users"),
      ),
    ).toEqual([]);
  });

  it("fails a lost response instead of treating recovery as a pass", async () => {
    const doubled = adminDouble({
      listUsers: [
        {
          id: userA,
          email: expectedCleanupEmail("tenant-a", nonce),
          created_at: startedAt,
        },
      ],
    });
    const result = await run(
      JSON.stringify(manifest({ users: [{ label: "tenant-a" }] })),
      doubled,
    );
    expect(result.status).toBe("fail");
    expect(result.usersDeleted).toBe(1);
    expect(result.detail).toContain("response_lost");
    expect(result.detail).not.toContain("@example.com");
  });

  it("does not pass when the manifest is missing, truncated, or the admin key is unusable", async () => {
    const missingDouble = adminDouble();
    const missing = await run(null, missingDouble);
    expect(missing.status).toBe("fail");
    expect(missing.usersDeleted).toBe(0);
    expect(missing.clientsDeleted).toBe(0);
    expect(missing.detail.startsWith("manifest_absent")).toBe(true);
    expect(missingDouble.calls.some((call) => call.startsWith("DELETE"))).toBe(
      false,
    );

    const truncated = await run('{"version":1', adminDouble());
    expect(truncated.detail.startsWith("manifest_invalid")).toBe(true);
    expect(truncated.usersDeleted).toBe(0);
    expect(truncated.clientsDeleted).toBe(0);

    const unkeyed = await run(JSON.stringify(manifest()), adminDouble(), null);
    expect(unkeyed.detail).toContain(`secret_absent:${AUTH_ADMIN_KEY_SECRET}`);
    const wrongType = await run(
      JSON.stringify(manifest()),
      adminDouble(),
      "admin-key",
    );
    expect(wrongType.detail).toBe("admin_key_type");
    expect(wrongType.usersDeleted).toBe(0);

    const unauthorized = adminDouble({ userStatus: 401 });
    const denied = await run(JSON.stringify(manifest()), unauthorized);
    expect(denied.status).toBe("fail");
    expect(denied.usersDeleted).toBe(0);
    expect(
      unauthorized.calls.some((call) =>
        call.startsWith("DELETE /auth/v1/admin/users"),
      ),
    ).toBe(false);
  });

  it("does not delete a foreign client returned beside this run during recovery", async () => {
    const doubled = adminDouble({
      listClients: [
        {
          client_id: foreignClient,
          client_name: "tutor-mbos-generic-acceptance",
          redirect_uris: ["https://example.com/oauth/callback"],
          created_at: startedAt,
        },
        {
          client_id: clientA,
          client_name: expectedClientName("acceptance", nonce),
          redirect_uris: ["https://example.com/oauth/callback"],
          created_at: startedAt,
        },
      ],
    });
    const result = await run(null, doubled);
    expect(result.status).toBe("fail");
    expect(result.detail.startsWith("manifest_absent")).toBe(true);
    expect(
      doubled.calls.some(
        (call) => call.includes(foreignClient) && call.startsWith("DELETE"),
      ),
    ).toBe(false);
    expect(
      doubled.calls.some(
        (call) => call === `DELETE /auth/v1/admin/oauth/clients/${clientA}`,
      ),
    ).toBe(true);
  });

  it("records an empty manifest and does not record a deleted user", async () => {
    const doubled = adminDouble();
    const result = await run(
      JSON.stringify(manifest({ users: [], clients: [] })),
      doubled,
    );
    expect(result).toMatchObject({
      status: "pass",
      usersDeleted: 0,
      clientsDeleted: 0,
      detail: "verified_run_resources_removed",
    });
    expect(emptyHostedResources(result)).toBe(true);
    expect(
      doubled.calls.filter((call) =>
        call.startsWith("GET /auth/v1/admin/users"),
      ),
    ).toHaveLength(2);
    expect(
      doubled.calls.filter(
        (call) => call === "GET /auth/v1/admin/oauth/clients",
      ),
    ).toHaveLength(3);
    expect(doubled.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    const removed = {
      status: "pass" as const,
      usersDeleted: 1,
      clientsDeleted: 0,
      detail: "verified_run_resources_removed",
    };
    expect(emptyHostedResources(removed)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "hosted-resources-"));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    try {
      writeHostedResourcesOutput(result, output);
      writeHostedResourcesOutput(removed, output);
      writeHostedResourcesOutput(result, undefined);
      expect(readFileSync(output, "utf8")).toBe("hosted_resources=none\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not prove an empty manifest while a nonce user still exists", async () => {
    const doubled = adminDouble({
      listUsers: [
        {
          id: userA,
          email: expectedCleanupEmail("tenant-a", nonce),
          created_at: startedAt,
        },
      ],
    });
    const result = await run(
      JSON.stringify(manifest({ users: [], clients: [] })),
      doubled,
    );
    expect(result.status).toBe("fail");
    expect(result.usersDeleted).toBe(1);
    expect(result.clientsDeleted).toBe(0);
    expect(emptyHostedResources(result)).toBe(false);
    expect(result.detail).toContain("empty_manifest_not_absent");
    expect(formatCleanupExecution(result)).not.toContain("@example.com");
    const dir = mkdtempSync(join(tmpdir(), "hosted-resources-present-"));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    try {
      writeHostedResourcesOutput(result, output);
      expect(readFileSync(output, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(
      doubled.calls.some(
        (call) => call === `DELETE /auth/v1/admin/users/${userA}`,
      ),
    ).toBe(true);
  });

  it("does not prove an empty manifest when a nonce lookup fails", async () => {
    const doubled = adminDouble();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/auth/v1/admin/users") {
        return Response.json({ message: "unavailable" }, { status: 500 });
      }
      return doubled.fetchImpl(input, init);
    };
    const result = await runAcceptanceCleanup({
      manifestText: JSON.stringify(manifest({ users: [], clients: [] })),
      adminKey: secretKey,
      identity,
      supabaseUrl,
      fetchImpl,
      nowMs,
    });
    expect(result.status).toBe("fail");
    expect(result.usersDeleted).toBe(0);
    expect(result.clientsDeleted).toBe(0);
    expect(emptyHostedResources(result)).toBe(false);
    expect(result.detail).toContain("user_get_failed:tenant-a");
    expect(result.detail).not.toContain("@example.com");
  });

  it("accepts a regular manifest job output and deletes only the verified ids", async () => {
    const doubled = adminDouble();
    const read = readCleanupManifestText(JSON.stringify(manifest()));
    expect(read).toEqual({ ok: true, text: JSON.stringify(manifest()) });
    const result = await run(read.ok ? read.text : null, doubled);
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("verified_run_resources_removed");
    expect(formatCleanupExecution(result)).not.toContain(secretKey);
  });

  it("fails closed when the job output is absent", async () => {
    expect(readCleanupManifestText(undefined)).toEqual({
      ok: false,
      reason: "manifest_absent",
    });
    expect(readCleanupManifestText("")).toEqual({
      ok: false,
      reason: "manifest_absent",
    });
    const doubled = adminDouble();
    const missing = await run(null, doubled);
    expect(missing.status).toBe("fail");
    expect(missing.detail.startsWith("manifest_absent")).toBe(true);
    expect(doubled.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("rejects a foreign run identity from the job output and does not delete that id", async () => {
    const doubled = adminDouble();
    const text = JSON.stringify(
      manifest({
        runId: "9999",
        users: [{ label: "tenant-a", id: victim }],
      }),
    );
    const read = readCleanupManifestText(text);
    expect(read.ok).toBe(true);
    const result = await run(read.ok ? read.text : null, doubled);
    expect(result.status).toBe("fail");
    expect(result.detail.startsWith("manifest_run")).toBe(true);
    expect(doubled.calls.some((call) => call.includes(victim))).toBe(false);
    expect(doubled.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });
});

describe("admin capability preflight", () => {
  it("mints a nonce only after a read-only 200 and sends secret keys without a bearer", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({
        url,
        authorization: headersOf(init).get("authorization"),
      });
      if (url.includes("/auth/v1/admin/users")) {
        return Response.json({ users: [{ email: "hidden@example.com" }] });
      }
      if (url.endsWith("/config/auth")) {
        return Response.json({
          oauth_server_enabled: true,
          oauth_server_allow_dynamic_registration: true,
          oauth_server_authorization_path: "/oauth/consent",
          site_url: siteOriginFor("development"),
          uri_allow_list: `${siteOriginFor("development")}/auth/callback`,
          security_update_password_require_reauthentication: false,
          jwt_secret: "hidden-secret",
        });
      }
      if (url.endsWith("/postgrest")) {
        return Response.json({ db_schema: "public,graphql_public" });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runAcceptancePreflight({
      adminKey: secretKey,
      managementToken: "management-token",
      supabaseUrl: "https://example.test",
      site: siteOriginFor("development"),
      projectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
      fetchImpl,
      randomBytes: (size) => Buffer.alloc(size, 4),
      now: () => new Date(startedAt),
    });
    expect(result.ok).toBe(true);
    expect(result.nonce).toBe("04".repeat(16));
    expect(result.startedAt).toBe(startedAt);
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[0]?.url).toContain("per_page=1");
    expect(JSON.stringify(result.cases)).not.toContain("jwt_secret");
    expect(JSON.stringify(result)).not.toContain("hidden@example.com");
  });

  it("does not mint a nonce when the admin key is the wrong type or admin returns 401", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json({ message: "unauthorized" }, { status: 401 });
    };
    const wrong = await runAcceptancePreflight({
      adminKey: "admin-key",
      managementToken: null,
      supabaseUrl: "https://example.test",
      site: siteOriginFor("development"),
      projectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
      fetchImpl,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe("admin_key_type");
    expect(wrong.nonce).toBeNull();
    expect(called).toBe(false);
    const denied = await runAcceptancePreflight({
      adminKey: secretKey,
      managementToken: null,
      supabaseUrl: "https://example.test",
      site: siteOriginFor("development"),
      projectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
      fetchImpl,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("admin_capability_http_401");
    expect(denied.nonce).toBeNull();
  });
});

function parseGithubOutput(content: string): Map<string, string> {
  const lines = content.split("\n");
  const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = /^(.*?)<<(.*)$/.exec(line);
    if (!marker) {
      const eq = line.indexOf("=");
      if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
      continue;
    }
    const name = marker[1] ?? "";
    const delimiter = marker[2] ?? "";
    const collected: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      collected.push(lines[index] ?? "");
      index += 1;
    }
    values.set(name, collected.join("\n"));
  }
  return values;
}

describe("cleanup manifest job output", () => {
  const trustedPackage =
    '{"name":"trusted","scripts":{"accept:development:cleanup":"tsx scripts/hosted-acceptance-cleanup.ts"}}\n';
  const trustedScript = "export const trusted = true;\n";
  const dummyKey = "sb_secret_ci";

  function trustedCheckout(): { root: string; checkout: string } {
    const root = mkdtempSync(join(tmpdir(), "acceptance-output-"));
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), trustedPackage);
    writeFileSync(
      join(checkout, "scripts", "hosted-acceptance-cleanup.ts"),
      trustedScript,
    );
    return { root, checkout };
  }

  it("serializes one manifest output without a shell, including newlines", () => {
    const dir = mkdtempSync(join(tmpdir(), "acceptance-output-file-"));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const body = `${JSON.stringify(manifest())}\nother=injected\n$(id)\n`;
    try {
      writeManifestOutput(body, output);
      const parsed = parseGithubOutput(readFileSync(output, "utf8"));
      expect([...parsed.keys()]).toEqual([MANIFEST_OUTPUT_NAME]);
      expect(parsed.get(MANIFEST_OUTPUT_NAME)).toBe(body);
      expect(readFileSync(output, "utf8")).toContain(
        `${MANIFEST_OUTPUT_NAME}<<`,
      );
      expect(readFileSync(output, "utf8")).not.toContain("::add-mask::");
      expect(body).not.toContain("@example.com");
      expect(body).not.toContain(nonce);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to skip the output file inside Actions", () => {
    const previous = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    try {
      expect(() => writeManifestOutput("{}", undefined)).toThrow(
        /manifest_output_absent/,
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
    }
  });

  it("does not write an oversized manifest output", () => {
    const dir = mkdtempSync(join(tmpdir(), "acceptance-output-size-"));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    try {
      expect(() => writeManifestOutput("x".repeat(4097), output)).toThrow(
        /manifest_oversize/,
      );
      expect(readFileSync(output, "utf8")).toBe("");
      expect(MANIFEST_MAX_BYTES).toBe(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized job output before parsing or returning it", async () => {
    const body = `OVERSIZE-SENTINEL${"x".repeat(MANIFEST_MAX_BYTES)}`;
    const read = readCleanupManifestText(body);
    expect(read).toEqual({ ok: false, reason: "manifest_oversize" });
    expect(JSON.stringify(read)).not.toContain("OVERSIZE-SENTINEL");
    const doubled = {
      calls: [] as string[],
    };
    const execution = await runAcceptanceCleanup({
      manifestText: null,
      adminKey: dummyKey,
      identity,
      supabaseUrl: "https://example.test",
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        doubled.calls.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({ users: [], clients: [] });
      },
      nowMs,
    });
    const reported = withManifestReadDetail(read, execution);
    const text = formatCleanupExecution(reported);
    expect(reported.status).toBe("fail");
    expect(text).toContain("manifest_oversize");
    expect(text).not.toContain("OVERSIZE-SENTINEL");
    expect(text).not.toContain(dummyKey);
  });

  it("does not execute a multiline injection payload or change the trusted checkout", async () => {
    const { root, checkout } = trustedCheckout();
    const marker = join(root, "planted-ran");
    const previous = process.env.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY;
    process.env.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY = dummyKey;
    const payload = [
      '{"version":1',
      "package.json",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY)`,
      "$(node -e 'process.exit(1)')",
      "manifest<<EOF",
      "rm -rf .",
    ].join("\n");
    try {
      const read = readCleanupManifestText(payload);
      expect(read.ok).toBe(true);
      const execution = await runAcceptanceCleanup({
        manifestText: read.ok ? read.text : null,
        adminKey: dummyKey,
        identity,
        supabaseUrl: "https://example.test",
        fetchImpl: async () => Response.json({ users: [], clients: [] }),
        nowMs,
      });
      const reported = withManifestReadDetail(read, execution);
      const text = formatCleanupExecution(reported);
      expect(reported.status).toBe("fail");
      expect(reported.detail.startsWith("manifest_invalid")).toBe(true);
      expect(text).not.toContain(dummyKey);
      expect(text).not.toContain("package.json");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(checkout, "package.json"), "utf8")).toBe(
        trustedPackage,
      );
      expect(
        readFileSync(
          join(checkout, "scripts", "hosted-acceptance-cleanup.ts"),
          "utf8",
        ),
      ).toBe(trustedScript);
    } finally {
      if (previous === undefined) {
        delete process.env.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY;
      } else {
        process.env.SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a rejected read as a failed cleanup without doubling an absent manifest", () => {
    const absent = {
      status: "fail" as const,
      usersDeleted: 0,
      clientsDeleted: 0,
      detail: "manifest_absent recovered_users=0 recovered_clients=0",
    };
    expect(
      withManifestReadDetail({ ok: false, reason: "manifest_absent" }, absent)
        .detail,
    ).toBe(absent.detail);
    expect(
      withManifestReadDetail({ ok: false, reason: "manifest_oversize" }, absent)
        .detail,
    ).toBe(`manifest_oversize ${absent.detail}`);
    expect(withManifestReadDetail({ ok: true, text: "{}" }, absent)).toEqual(
      absent,
    );
  });
});
