/**
 * Executable access contract for UI, API and MCP.
 * Versioned here so adapters cannot drift from the rules they enforce.
 * Human-readable copy: docs/contracts/access-v1.md.
 */
export const ACCESS_CONTRACT_VERSION = "2026-10-15";

/** Business permissions. These are not OAuth/OIDC scopes. */
export const BUSINESS_PERMISSIONS = [
  "business.read",
  "business.onboard",
  "reports.read",
] as const;

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

/**
 * Scopes Supabase Auth puts on identity tokens. They identify the user and
 * never grant business permissions.
 */
export const OIDC_SCOPES = ["openid", "email", "profile", "phone"] as const;

export const UI_SESSION_PERMISSIONS: readonly BusinessPermission[] = [
  "business.read",
  "business.onboard",
  "reports.read",
];

/** Clock skew accepted when checking access-token expiry. */
export const ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 5;

/**
 * Grant and session revocation is read on every request. There is no
 * permission cache, so a revoked grant or Auth session fails on the next call.
 */
export const REVOCATION_LATENCY = "next-request";

export const CLIENT_PROFILES = {
  "admin-ui": {
    accessPath: "ui-session",
    registration: "first-party",
    pkce: "not-used",
    transport: "cookie",
  },
  "http-api": {
    accessPath: "delegated-oauth",
    registration: "pre-registered-public",
    pkce: "S256",
    transport: "bearer",
  },
  chatgpt: {
    accessPath: "delegated-oauth",
    registration: "dynamic",
    pkce: "S256",
    transport: "bearer",
    discovery: "oauth-protected-resource",
  },
  "generic-mcp": {
    accessPath: "delegated-oauth",
    registration: "pre-registered-or-dynamic",
    pkce: "S256",
    transport: "bearer",
    discovery: "oauth-protected-resource",
  },
} as const;

export type ClientProfileName = keyof typeof CLIENT_PROFILES;

export const ACCEPTED_TOKEN_ALGORITHMS = ["ES256", "RS256"] as const;

export function isBusinessPermission(
  value: string,
): value is BusinessPermission {
  return (BUSINESS_PERMISSIONS as readonly string[]).includes(value);
}

/** Drops anything outside the catalogue, including claims a client invented. */
export function knownPermissions(
  values: readonly string[],
): BusinessPermission[] {
  const seen = new Set<BusinessPermission>();
  for (const value of values) {
    if (isBusinessPermission(value)) seen.add(value);
  }
  return [...seen];
}
