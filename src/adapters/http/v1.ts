import {
  getServiceStatus,
  type BuildInfo,
} from "@/server/application/service-status";
import type { EnvSource } from "@/server/config/environments";
import { API_VERSION, jsonResponse, problemResponse } from "./problem";

export function healthResponse(env: EnvSource, build: BuildInfo): Response {
  const status = getServiceStatus(env, build);
  return jsonResponse(status.status === "ok" ? 200 : 503, {
    apiVersion: API_VERSION,
    ...status,
  });
}

export function unknownRouteResponse(): Response {
  return problemResponse(
    404,
    "Not found",
    `No ${API_VERSION} API route matches this path.`,
  );
}
