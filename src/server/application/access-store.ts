import type { VerifiedActor } from "@/server/domain/access-decision";
import type { Sql, SqlConnection } from "./sql";

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
}

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
  listLiveGrantClientIds(actor: VerifiedActor): Promise<string[]>;
}

function claimsFor(actor: VerifiedActor): string {
  const claims: Record<string, string> = {
    sub: actor.userId,
    role: "authenticated",
    aud: "authenticated",
  };
  if (actor.clientId) claims.client_id = actor.clientId;
  return JSON.stringify(claims);
}

async function withActor<T>(
  db: SqlConnection,
  actor: VerifiedActor,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        claimsFor(actor),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        actor.userId,
      ]);
      await tx.exec("set local role app_request");
      return fn(tx);
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

function mapStoreError(error: unknown): AccessStoreError {
  if (error instanceof AccessStoreError) return error;
  const record = typeof error === "object" && error !== null ? error : {};
  const code = "code" in record ? String(record.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid_name"))
    return new AccessStoreError("invalid_name");
  if (message.includes("invalid_idempotency_key")) {
    return new AccessStoreError("invalid_idempotency_key");
  }
  if (message.includes("invalid_permissions")) {
    return new AccessStoreError("invalid_permissions");
  }
  if (message.includes("invalid_client"))
    return new AccessStoreError("invalid_client");
  if (message.includes("invalid_decision")) {
    return new AccessStoreError("invalid_decision");
  }
  if (message.includes("rate_limited"))
    return new AccessStoreError("rate_limited");
  if (
    code === "42501" ||
    message.includes("row-level security") ||
    message.includes("permission denied") ||
    message.includes("permission_denied")
  ) {
    return new AccessStoreError("forbidden");
  }
  return new AccessStoreError("unavailable");
}

function business(row: {
  id?: string;
  business_id?: string;
  display_name: string;
  owner_user_id: string;
}): BusinessRecord {
  const id = row.id ?? row.business_id;
  if (!id) throw new AccessStoreError("unavailable");
  return { id, displayName: row.display_name, ownerUserId: row.owner_user_id };
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function createPgAccessStore(db: SqlConnection): AccessStore {
  return {
    async createBusiness(actor, input) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{
          id: string;
          display_name: string;
          owner_user_id: string;
          created: boolean;
        }>("select * from app.create_business($1, $2)", [
          input.displayName,
          input.idempotencyKey,
        ]),
      );
      const row = result.rows[0];
      if (!row) throw new AccessStoreError("unavailable");
      return { business: business(row), created: row.created === true };
    },
    async readBusiness(actor) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{ id: string; display_name: string; owner_user_id: string }>(
          "select id, display_name, owner_user_id from app.businesses",
        ),
      );
      if (result.rows.length > 1) throw new AccessStoreError("unavailable");
      const row = result.rows[0];
      return row ? business(row) : null;
    },
    async readSetupReport(actor) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{
          business_id: string;
          display_name: string;
          owner_user_id: string;
        }>(
          "select business_id, display_name, owner_user_id from app.setup_report",
        ),
      );
      if (result.rows.length > 1) throw new AccessStoreError("unavailable");
      const row = result.rows[0];
      return row ? business(row) : null;
    },
    async readGrant(actor, clientId) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{
          oauth_client_id: string;
          permissions: string[];
          revoked_at: unknown;
        }>(
          `select oauth_client_id, permissions, revoked_at
           from app.client_grants where oauth_client_id = $1`,
          [clientId],
        ),
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        oauthClientId: row.oauth_client_id,
        permissions: row.permissions ?? [],
        revokedAt: timestamp(row.revoked_at),
      };
    },
    async recordConsent(actor, input) {
      await withActor(db, actor, (tx) =>
        tx.query(
          "select app.record_client_consent($1, $2::text[], $3::text[], $4, $5)",
          [
            input.oauthClientId,
            input.permissions,
            input.scopes,
            input.authorizationId,
            input.decision,
          ],
        ),
      );
    },
    async revokeGrant(actor, clientId) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{ revoke_client_grant: boolean }>(
          "select app.revoke_client_grant($1) as revoke_client_grant",
          [clientId],
        ),
      );
      return result.rows[0]?.revoke_client_grant === true;
    },
    async listLiveGrantClientIds(actor) {
      const result = await withActor(db, actor, (tx) =>
        tx.query<{ oauth_client_id: string }>(
          `select oauth_client_id
           from app.client_grants
           where revoked_at is null
           order by oauth_client_id`,
        ),
      );
      return result.rows.map((row) => row.oauth_client_id);
    },
  };
}
