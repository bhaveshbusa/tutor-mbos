import { ACCESS_CONTRACT_VERSION } from "@/server/domain/access-contract";
import {
  loadRuntimeConfig,
  type ConfigIssue,
  type DeploymentEnvironment,
  type EnvSource,
} from "@/server/config/environments";

export const SERVICE_NAME = "tutor-mbos";

export interface BuildInfo {
  commit: string;
}

interface StatusBase {
  service: typeof SERVICE_NAME;
  commit: string | null;
  /** Business routes require a verified Supabase session or delegated token. */
  authentication: "enforced";
  accessContract: typeof ACCESS_CONTRACT_VERSION;
}

export type ServiceStatus =
  | (StatusBase & {
      status: "ok";
      environment: DeploymentEnvironment;
      supabaseProjectRef: string;
      syntheticDataOnly: boolean;
    })
  | (StatusBase & { status: "misconfigured"; issues: ConfigIssue[] });

export function getServiceStatus(
  env: EnvSource,
  build: BuildInfo,
): ServiceStatus {
  const base: StatusBase = {
    service: SERVICE_NAME,
    commit: /^[0-9a-f]{40}$/.test(build.commit) ? build.commit : null,
    authentication: "enforced",
    accessContract: ACCESS_CONTRACT_VERSION,
  };
  const result = loadRuntimeConfig(env);
  if (!result.ok) {
    return { ...base, status: "misconfigured", issues: result.issues };
  }
  return {
    ...base,
    status: "ok",
    environment: result.config.environment,
    supabaseProjectRef: result.config.supabaseProjectRef,
    syntheticDataOnly: result.config.syntheticDataOnly,
  };
}
