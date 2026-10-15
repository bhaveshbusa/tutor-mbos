import { z } from "zod";

/**
 * Reviewed deployment bindings. Each environment is pinned to exactly one
 * Vercel project and one Supabase project; runtime and deploy-time checks
 * reject any other combination. Identifiers here are public references,
 * never credentials.
 */
export const ENVIRONMENT_BINDINGS = {
  development: {
    vercelTeamId: "team_2QehRm248FPmHJTzKS0rvS6b",
    vercelProjectId: "prj_ysIJHdIKYk2MQwvOKermUvIMuGVa",
    vercelProjectName: "tutor-mbos-dev",
    supabaseProjectRef: "idvzjqrkgnihvxoswuxu",
    syntheticDataOnly: true,
  },
  production: {
    vercelTeamId: "team_2QehRm248FPmHJTzKS0rvS6b",
    vercelProjectId: "prj_Ibov9zZm4KOvga3pWUQ83pInPJfQ",
    vercelProjectName: "tutor-mbos",
    supabaseProjectRef: "vblwjqfpcmegbugmufif",
    syntheticDataOnly: false,
  },
} as const;

export type DeploymentEnvironment = keyof typeof ENVIRONMENT_BINDINGS;

export const DEPLOYMENT_ENVIRONMENTS = Object.keys(
  ENVIRONMENT_BINDINGS,
) as DeploymentEnvironment[];

export type ConfigIssueCode =
  "missing" | "invalid" | "binding_mismatch" | "secret_in_public_variable";

export interface ConfigIssue {
  variable: string;
  code: ConfigIssueCode;
}

export interface RuntimeConfig {
  environment: DeploymentEnvironment;
  supabaseProjectRef: string;
  supabaseUrl: string;
  supabasePublishableKeyConfigured: boolean;
  syntheticDataOnly: boolean;
}

export type RuntimeConfigResult =
  { ok: true; config: RuntimeConfig } | { ok: false; issues: ConfigIssue[] };

export type EnvSource = Readonly<Record<string, string | undefined>>;

const environmentSchema = z.enum(
  DEPLOYMENT_ENVIRONMENTS as [
    DeploymentEnvironment,
    ...DeploymentEnvironment[],
  ],
);
const supabaseUrlSchema = z
  .string()
  .regex(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/);
const publishableKeySchema = z
  .string()
  .regex(/^sb_publishable_[A-Za-z0-9_-]+$/);

export function supabaseUrlFor(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}

/** True for values that must never be exposed through a NEXT_PUBLIC_ variable. */
export function looksLikeSecret(value: string): boolean {
  if (value.startsWith("sb_secret_")) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  const jwt = value.split(".");
  if (jwt.length === 3 && jwt[0]?.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(
        Buffer.from(jwt[1] ?? "", "base64url").toString("utf8"),
      ) as { role?: unknown };
      return payload.role !== "anon";
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Validates runtime configuration against the reviewed bindings. Issues name
 * the variable and a code only; values are never echoed.
 */
export function loadRuntimeConfig(env: EnvSource): RuntimeConfigResult {
  const issues: ConfigIssue[] = [];

  for (const [variable, value] of Object.entries(env)) {
    if (
      variable.startsWith("NEXT_PUBLIC_") &&
      value &&
      looksLikeSecret(value)
    ) {
      issues.push({ variable, code: "secret_in_public_variable" });
    }
  }

  const rawEnvironment = env.TUTOR_MBOS_ENV;
  const environment = environmentSchema.safeParse(rawEnvironment);
  if (!rawEnvironment) {
    issues.push({ variable: "TUTOR_MBOS_ENV", code: "missing" });
  } else if (!environment.success) {
    issues.push({ variable: "TUTOR_MBOS_ENV", code: "invalid" });
  }

  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const url = supabaseUrlSchema.safeParse(rawUrl);
  if (!rawUrl) {
    issues.push({ variable: "NEXT_PUBLIC_SUPABASE_URL", code: "missing" });
  } else if (!url.success) {
    issues.push({ variable: "NEXT_PUBLIC_SUPABASE_URL", code: "invalid" });
  } else if (
    environment.success &&
    url.data !==
      supabaseUrlFor(ENVIRONMENT_BINDINGS[environment.data].supabaseProjectRef)
  ) {
    issues.push({
      variable: "NEXT_PUBLIC_SUPABASE_URL",
      code: "binding_mismatch",
    });
  }

  const rawKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (
    rawKey &&
    !looksLikeSecret(rawKey) &&
    !publishableKeySchema.safeParse(rawKey).success
  ) {
    issues.push({
      variable: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      code: "invalid",
    });
  }

  if (issues.length > 0 || !environment.success || !url.success) {
    return { ok: false, issues };
  }

  const binding = ENVIRONMENT_BINDINGS[environment.data];
  return {
    ok: true,
    config: {
      environment: environment.data,
      supabaseProjectRef: binding.supabaseProjectRef,
      supabaseUrl: url.data,
      supabasePublishableKeyConfigured: Boolean(rawKey),
      syntheticDataOnly: binding.syntheticDataOnly,
    },
  };
}
