import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeDevelopmentHealth } from "../scripts/probe-development-health.ts";
import { siteOriginFor } from "@/server/config/access";
import { ENVIRONMENT_BINDINGS } from "@/server/config/environments";

const commit = "a".repeat(40);
const other = "b".repeat(40);
const secret = "synthetic-bypass-do-not-print";
const site = siteOriginFor("development");

function healthDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: "v1",
    service: "tutor-mbos",
    status: "ok",
    commit,
    authentication: "enforced",
    accessContract: "2026-10-15",
    environment: "development",
    supabaseProjectRef: ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
    syntheticDataOnly: true,
    ...overrides,
  });
}

function response(status: number, body: string, type = "basic"): Response {
  return {
    status,
    type,
    text: async () => body,
  } as unknown as Response;
}

describe("probeDevelopmentHealth", () => {
  it("records 401 HTML as an absent commit and does not leak the bypass", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const result = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init ?? {} });
        return response(
          401,
          "<!DOCTYPE html><html><body>Authentication Required</body></html>",
        );
      },
    });
    expect(result).toEqual({ ok: false, detail: "http_401 commit=absent" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-vercel-protection-bypass")).toBe(secret);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.origin).toBe(site);
    expect(calls[0]?.url.pathname).toBe("/api/v1/health");
    expect(calls[0]?.url.origin).not.toBe(siteOriginFor("production"));
  });

  it("accepts a 200 health document for this commit, environment, and project", async () => {
    const result = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () => response(200, healthDocument()),
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a different project and a different SHA", async () => {
    const project = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () =>
        response(
          200,
          healthDocument({
            supabaseProjectRef:
              ENVIRONMENT_BINDINGS.production.supabaseProjectRef,
          }),
        ),
    });
    expect(project).toEqual({ ok: false, detail: "project_mismatch" });
    const environment = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () =>
        response(200, healthDocument({ environment: "production" })),
    });
    expect(environment).toEqual({ ok: false, detail: "environment_mismatch" });
    const sha = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () => response(200, healthDocument({ commit: other })),
    });
    expect(sha).toEqual({ ok: false, detail: "http_200 commit=mismatch" });
    expect(JSON.stringify(sha)).not.toContain(secret);
  });

  it("does not fetch when the bypass is missing and does not trim a present value", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return response(401, "<html></html>");
    };
    expect(
      await probeDevelopmentHealth({ commit, bypass: undefined, fetchImpl }),
    ).toEqual({ ok: false, detail: "protection_bypass_absent" });
    expect(
      await probeDevelopmentHealth({ commit, bypass: "", fetchImpl }),
    ).toEqual({ ok: false, detail: "protection_bypass_absent" });
    expect(called).toBe(false);
    const whitespace = await probeDevelopmentHealth({
      commit,
      bypass: " ",
      fetchImpl,
    });
    expect(called).toBe(true);
    expect(whitespace.ok).toBe(false);
  });

  it("stops on a manual redirect without reading the body", async () => {
    const calls: number[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(1);
      expect(init?.redirect).toBe("manual");
      return {
        status: 302,
        type: "basic",
        text: async () => {
          throw new Error(secret);
        },
      } as unknown as Response;
    };
    expect(
      await probeDevelopmentHealth({ commit, bypass: secret, fetchImpl }),
    ).toEqual({ ok: false, detail: "http_302 redirect" });
    const opaque = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () =>
        ({
          status: 0,
          type: "opaqueredirect",
          text: async () => {
            throw new Error(secret);
          },
        }) as unknown as Response,
    });
    expect(opaque).toEqual({ ok: false, detail: "http_0 redirect" });
    expect(JSON.stringify(opaque)).not.toContain(secret);
    expect(calls).toHaveLength(1);
  });

  it("times out without copying the error message", async () => {
    const timedOut = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error(`aborted ${secret}`));
          });
        }),
    });
    expect(timedOut).toEqual({ ok: false, detail: "request_timeout" });
    const failed = await probeDevelopmentHealth({
      commit,
      bypass: secret,
      fetchImpl: async () => {
        throw new TypeError(`connect ${secret}`);
      },
    });
    expect(failed).toEqual({ ok: false, detail: "TypeError" });
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
});

describe("development health command", () => {
  it("does not print the bypass and does not call the site for a missing commit", () => {
    const source = readFileSync("scripts/probe-development-health.ts", "utf8");
    expect(source).not.toContain(".trim(");
    expect(source).toContain("::add-mask::");
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/probe-development-health.ts"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          GITHUB_SHA: "not-a-sha",
          VERCEL_AUTOMATION_BYPASS_SECRET: secret,
          NODE_USE_ENV_PROXY: "1",
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::commit_absent");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    const masked = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/probe-development-health.ts"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: "not-a-sha",
          VERCEL_AUTOMATION_BYPASS_SECRET: secret,
          NODE_USE_ENV_PROXY: "1",
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    expect(masked.status).toBe(1);
    expect(masked.stdout).toContain(`::add-mask::${secret}`);
    expect(masked.stdout.replace(`::add-mask::${secret}`, "")).not.toContain(
      secret,
    );
    expect(masked.stderr).toContain("::error::commit_absent");
    expect(masked.stderr).not.toContain(secret);
    const absent = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/probe-development-health.ts"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          GITHUB_SHA: commit,
          VERCEL_AUTOMATION_BYPASS_SECRET: "",
          NODE_USE_ENV_PROXY: "1",
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("::error::protection_bypass_absent");
    expect(absent.stdout).not.toContain("::add-mask::");
  }, 60_000);
});
