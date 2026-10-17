import type { VerifiedActor } from "@/server/domain/access-decision";

export interface BusinessRecord {
  id: string;
  ownerUserId: string;
  displayName: string;
}

export interface GrantRecord {
  oauthClientId: string;
  permissions: string[];
  revokedAt: string | null;
}

export type StoreErrorCode =
  | "forbidden"
  | "invalid_name"
  | "invalid_idempotency_key"
  | "invalid_permissions"
  | "invalid_client"
  | "invalid_decision"
  | "rate_limited"
  | "unavailable";

export class AccessStoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode) {
    super(code);
    this.name = "AccessStoreError";
    this.code = code;
  }
}

export interface ConsentInput {
  oauthClientId: string;
  permissions: readonly string[];
  scopes: readonly string[];
  authorizationId: string;
  decision: "approved" | "denied";
  redirectUri?: string | null;
}

/**
 * Shared business store. The hosted implementation calls Supabase as the
 * signed-in user. Tests open a SQL session as the same `authenticated` role.
 */
export interface AccessStore {
  createBusiness(
    actor: VerifiedActor,
    input: { displayName: string; idempotencyKey: string },
  ): Promise<{ business: BusinessRecord; created: boolean }>;
  readBusiness(actor: VerifiedActor): Promise<BusinessRecord | null>;
  readSetupReport(actor: VerifiedActor): Promise<BusinessRecord | null>;
  readGrant(
    actor: VerifiedActor,
    clientId: string,
  ): Promise<GrantRecord | null>;
  recordConsent(actor: VerifiedActor, input: ConsentInput): Promise<void>;
  revokeGrant(actor: VerifiedActor, clientId: string): Promise<boolean>;
  listLiveGrantRedirects(actor: VerifiedActor): Promise<string[]>;
}
