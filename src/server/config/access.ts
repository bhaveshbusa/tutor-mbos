import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
  type DeploymentEnvironment,
} from "./environments";

export const SITE_ORIGINS: Record<DeploymentEnvironment, string> = {
  development: "https://tutor-mbos-dev-lets-play-game.vercel.app",
  production: "https://tutor-mbos-lets-play-game.vercel.app",
};

const PRIVILEGED_DB_USERS = new Set([
  "postgres",
  "supabase_admin",
  "service_role",
  "authenticator",
  "supabase_auth_admin",
  "supabase_storage_admin",
]);

export type DatabaseUrlIssue =
  "invalid" | "privileged_user" | "binding_mismatch" | "not_app_runtime";

export function authIssuer(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1`;
}

export function jwksUrl(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
}

export function resourceUrl(siteOrigin: string): string {
  return `${siteOrigin}/api/mcp`;
}

export function protectedResourceMetadataUrl(siteOrigin: string): string {
  return `${siteOrigin}/.well-known/oauth-protected-resource`;
}

export function acceptedAudiences(siteOrigin: string): readonly string[] {
  return ["authenticated", resourceUrl(siteOrigin)];
}

/** Where this app may send the browser after its own sign-in or recovery. */
export function allowedAppRedirects(siteOrigin: string): readonly string[] {
  return [`${siteOrigin}/auth/callback`];
}

export function allowedBrowserNextPaths(): readonly string[] {
  return ["/", "/onboarding", "/business", "/oauth/consent"];
}

export function isAllowedBrowserNext(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }
  const path = value.split("?")[0] ?? "";
  return allowedBrowserNextPaths().includes(path);
}

interface ParsedDatabaseUrl {
  username: string;
  hostname: string;
  password: string;
  href: string;
}

function parseDatabaseUrl(value: string): ParsedDatabaseUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return null;
  }
  const username = decodeURIComponent(parsed.username);
  if (!username || !parsed.password || !parsed.hostname) return null;
  return {
    username,
    hostname: parsed.hostname,
    password: parsed.password,
    href: parsed.href,
  };
}

function projectRefOf(environment: DeploymentEnvironment): string {
  return ENVIRONMENT_BINDINGS[environment].supabaseProjectRef;
}

function mentionsProject(
  parsed: ParsedDatabaseUrl,
  projectRef: string,
): boolean {
  return (
    parsed.hostname.includes(projectRef) ||
    parsed.username.endsWith(`.${projectRef}`)
  );
}

/**
 * Runtime business connections must be the non-superuser app_runtime role
 * for this environment. Privileged migration URLs are rejected here.
 */
export function inspectAppDatabaseUrl(
  value: string,
  environment: DeploymentEnvironment,
): { ok: true } | { ok: false; code: DatabaseUrlIssue } {
  const parsed = parseDatabaseUrl(value);
  if (!parsed) return { ok: false, code: "invalid" };
  const ownRef = projectRefOf(environment);
  const otherRef = projectRefOf(
    environment === "development" ? "production" : "development",
  );
  if (mentionsProject(parsed, otherRef) || !mentionsProject(parsed, ownRef)) {
    return { ok: false, code: "binding_mismatch" };
  }
  const bareUser = parsed.username.split(".")[0] ?? "";
  if (
    PRIVILEGED_DB_USERS.has(bareUser) ||
    PRIVILEGED_DB_USERS.has(parsed.username)
  ) {
    return { ok: false, code: "privileged_user" };
  }
  if (bareUser !== "app_runtime") return { ok: false, code: "not_app_runtime" };
  return { ok: true };
}

/**
 * Migration workflow only. Development project, DDL-capable login, never the
 * request role and never the production project.
 */
export function inspectMigrationDatabaseUrl(
  value: string,
): { ok: true } | { ok: false; code: DatabaseUrlIssue | "app_runtime" } {
  const parsed = parseDatabaseUrl(value);
  if (!parsed) return { ok: false, code: "invalid" };
  const devRef = projectRefOf("development");
  const prodRef = projectRefOf("production");
  if (mentionsProject(parsed, prodRef) || !mentionsProject(parsed, devRef)) {
    return { ok: false, code: "binding_mismatch" };
  }
  const bareUser = parsed.username.split(".")[0] ?? "";
  if (bareUser === "app_runtime") return { ok: false, code: "app_runtime" };
  if (bareUser !== "postgres" && bareUser !== "supabase_admin") {
    return { ok: false, code: "privileged_user" };
  }
  return { ok: true };
}

export function siteOriginFor(environment: DeploymentEnvironment): string {
  return SITE_ORIGINS[environment];
}

export { supabaseUrlFor };
