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
  | "invalid"
  | "privileged_user"
  | "binding_mismatch"
  | "not_app_runtime"
  | "transaction_pooler";

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

/**
 * Supabase OAuth access tokens currently use the audience `authenticated`.
 * The MCP resource URL is also accepted when a token is resource-bound.
 * Accepting `authenticated` on `/api/mcp` is a known deviation from RFC 8707
 * until hosted tokens include this deployment's resource audience. A later
 * contract version must require that audience for MCP once a hosted token
 * sample shows it. Delegated calls still require `client_id` and a live grant.
 */
export function acceptedAudiences(siteOrigin: string): readonly string[] {
  return ["authenticated", resourceUrl(siteOrigin)];
}

/** Where this app may send the browser after its own sign-in or recovery. */
export function allowedAppRedirects(siteOrigin: string): readonly string[] {
  return [`${siteOrigin}/auth/callback`, `${siteOrigin}/auth/recovery`];
}

export function recoveryRedirect(siteOrigin: string): string {
  return `${siteOrigin}/auth/recovery`;
}

export function allowedBrowserNextPaths(): readonly string[] {
  return [
    "/",
    "/onboarding",
    "/business",
    "/oauth/consent",
    "/auth/update-password",
  ];
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
  port: string;
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
    port: parsed.port,
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

export const APP_RUNTIME_PASSWORD_ENV = "APP_RUNTIME_PASSWORD";
export const APP_DATABASE_HOST_ENV = "TUTOR_MBOS_APP_DATABASE_HOST";
export const APP_DATABASE_PORT_ENV = "TUTOR_MBOS_APP_DATABASE_PORT";

export type AppDatabaseSource = "password" | "url";

export type AppDatabaseResolution =
  | { ok: true; url: string; source: AppDatabaseSource }
  | { ok: false; code: string };

/**
 * Builds the app_runtime URL from the one password and the non-secret
 * host and port. The username is app_runtime plus the reviewed project
 * ref. The password is encoded. The result is accepted only when it
 * passes the runtime URL guard. Failures return a code and not the
 * password, host, or URL.
 */
export function appRuntimeDatabaseUrl(input: {
  environment: DeploymentEnvironment;
  password: string;
  host: string;
  port: string;
}): AppDatabaseResolution {
  if (!input.password.trim() || /[\r\n]/.test(input.password)) {
    return { ok: false, code: "password_absent" };
  }
  if (!/^[A-Za-z0-9.-]+$/.test(input.host) || input.host.includes("..")) {
    return { ok: false, code: "host_invalid" };
  }
  if (!/^[0-9]{2,5}$/.test(input.port)) {
    return { ok: false, code: "port_invalid" };
  }
  const url = new URL("postgresql://localhost/postgres");
  url.username = `app_runtime.${projectRefOf(input.environment)}`;
  url.password = input.password;
  url.hostname = input.host;
  url.port = input.port;
  const inspected = inspectAppDatabaseUrl(url.href, input.environment);
  if (!inspected.ok) return inspected;
  return { ok: true, url: url.href, source: "password" };
}

/**
 * Password, host, and port together are the runtime credential. A partial
 * set does not fall back to a stored URL. The stored URL is used only when
 * none of those three names is set, so a current deployment keeps working
 * until the operator switches it.
 */
export function resolveAppDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  environment: DeploymentEnvironment,
): AppDatabaseResolution {
  const password = env[APP_RUNTIME_PASSWORD_ENV];
  const host = env[APP_DATABASE_HOST_ENV]?.trim();
  const port = env[APP_DATABASE_PORT_ENV]?.trim();
  if (password !== undefined || host || port) {
    return appRuntimeDatabaseUrl({
      environment,
      password: password ?? "",
      host: host ?? "",
      port: port ?? "",
    });
  }
  const legacy = env.TUTOR_MBOS_APP_DATABASE_URL;
  if (!legacy) return { ok: false, code: "absent" };
  const inspected = inspectAppDatabaseUrl(legacy, environment);
  if (!inspected.ok) return inspected;
  return { ok: true, url: legacy, source: "url" };
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
  if (parsed.port === "6543") return { ok: false, code: "transaction_pooler" };
  return { ok: true };
}

export function siteOriginFor(environment: DeploymentEnvironment): string {
  return SITE_ORIGINS[environment];
}

export { supabaseUrlFor };
