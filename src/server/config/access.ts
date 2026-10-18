import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
  type DeploymentEnvironment,
} from "./environments";

export const SITE_ORIGINS: Record<DeploymentEnvironment, string> = {
  development: "https://tutor-mbos-dev-lets-play-game.vercel.app",
  production: "https://tutor-mbos-lets-play-game.vercel.app",
};

export type DatabaseUrlIssue =
  | "invalid"
  | "privileged_user"
  | "binding_mismatch"
  | "app_runtime"
  | "transaction_pooler";

export function authIssuer(supabaseUrl: string): string {
  return `${supabaseUrl}/auth/v1`;
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

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Cookie mutations accept the deployment site origin. A loopback browser may
 * use `localhost` or `127.0.0.1` on the same port and protocol, because Next
 * dev rewrites `request.url` to `localhost`. An opaque `Origin: null` is
 * refused, including on the hosted site.
 */
export function browserRequestAllowed(
  request: Request,
  siteOrigin: string,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  if (origin === siteOrigin) return true;
  let originUrl: URL;
  let requestUrl: URL;
  try {
    originUrl = new URL(origin);
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  return (
    loopbackHost(originUrl.hostname) &&
    loopbackHost(requestUrl.hostname) &&
    originUrl.protocol === requestUrl.protocol &&
    originUrl.port === requestUrl.port
  );
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
 * Migration workflow only. Development project, DDL-capable login, never a
 * request role and never the production project. Business requests do not use
 * a database password.
 */
export function inspectMigrationDatabaseUrl(
  value: string,
  target: DeploymentEnvironment = "development",
): { ok: true } | { ok: false; code: DatabaseUrlIssue | "app_runtime" } {
  const parsed = parseDatabaseUrl(value);
  if (!parsed) return { ok: false, code: "invalid" };
  const expected = projectRefOf(target);
  const other = projectRefOf(
    target === "development" ? "production" : "development",
  );
  if (mentionsProject(parsed, other) || !mentionsProject(parsed, expected)) {
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
