import { OIDC_SCOPES } from "@/server/domain/access-contract";
import { authIssuer, resourceUrl, siteOriginFor } from "@/server/config/access";
import {
  loadRuntimeConfig,
  type EnvSource,
} from "@/server/config/environments";
import { jsonResponse, problemResponse } from "./problem";

export function protectedResourceDocument(
  siteOrigin: string,
  supabaseUrl: string,
) {
  return {
    resource: resourceUrl(siteOrigin),
    authorization_servers: [authIssuer(supabaseUrl)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...OIDC_SCOPES],
    resource_documentation: `${siteOrigin}/api/v1/openapi.json`,
  };
}

export function protectedResourceResponse(env: EnvSource): Response {
  const runtime = loadRuntimeConfig(env);
  if (!runtime.ok) {
    return problemResponse(
      503,
      "Misconfigured",
      "The deployment binding is not valid.",
    );
  }
  return jsonResponse(
    200,
    protectedResourceDocument(
      siteOriginFor(runtime.config.environment),
      runtime.config.supabaseUrl,
    ),
  );
}
