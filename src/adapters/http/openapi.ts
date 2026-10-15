import {
  ACCESS_CONTRACT_VERSION,
  BUSINESS_PERMISSIONS,
} from "@/server/domain/access-contract";
import { siteOriginFor } from "@/server/config/access";
import {
  loadRuntimeConfig,
  type EnvSource,
} from "@/server/config/environments";
import { API_VERSION, jsonResponse } from "./problem";

export function openApiDocument(siteOrigin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tutor MBOS API",
      version: API_VERSION,
      description: `Access contract ${ACCESS_CONTRACT_VERSION}. Business permissions: ${BUSINESS_PERMISSIONS.join(", ")}. OIDC scopes do not grant them.`,
    },
    servers: [{ url: siteOrigin }],
    components: {
      securitySchemes: {
        delegated: { type: "http", scheme: "bearer" },
        uiSession: { type: "apiKey", in: "cookie", name: "sb-access-token" },
      },
    },
    paths: {
      "/api/v1/health": { get: { summary: "Public health" } },
      "/api/v1/session": {
        get: { summary: "Verified caller and server-derived permissions" },
      },
      "/api/v1/business": {
        get: { summary: "Business owned by the verified user" },
        post: { summary: "Idempotent first-business creation" },
      },
      "/api/v1/reports/setup": {
        get: { summary: "Tenant-scoped setup report" },
      },
      "/api/v1/grants/revoke": {
        post: { summary: "Revoke a delegated client grant" },
      },
      "/api/mcp": { post: { summary: "MCP JSON-RPC for a delegated token" } },
    },
  };
}

export function openApiResponse(env: EnvSource): Response {
  const runtime = loadRuntimeConfig(env);
  const origin = runtime.ok
    ? siteOriginFor(runtime.config.environment)
    : "https://tutor-mbos-dev-lets-play-game.vercel.app";
  return jsonResponse(200, openApiDocument(origin));
}
