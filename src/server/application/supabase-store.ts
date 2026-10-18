import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VerifiedActor } from "@/server/domain/access-decision";
import {
  AccessStoreError,
  type AccessStore,
  type BusinessRecord,
  type ConsentInput,
  type GrantRecord,
} from "./access-store";

export function createUserSupabaseClient(input: {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): SupabaseClient {
  return createClient(input.supabaseUrl, input.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: input.fetchImpl ?? fetch,
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  });
}

function mapRpcError(error: {
  message?: string;
  code?: string;
}): AccessStoreError {
  const message = error.message ?? "";
  const code = error.code ?? "";
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

function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") return [data as T];
  return [];
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
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

/**
 * User-scoped Data API store. The client sends the caller's access token.
 * Postgres runs the public security-invoker functions as `authenticated`,
 * so the existing row level security policies apply. No service role is used.
 */
export function createSupabaseAccessStore(client: SupabaseClient): AccessStore {
  async function rpc<T>(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw mapRpcError(error);
    return data as T;
  }

  return {
    async createBusiness(actor, input) {
      void actor;
      const data = await rpc<unknown>("create_business", {
        p_display_name: input.displayName,
        p_idempotency_key: input.idempotencyKey,
      });
      const row = rowsOf<{
        id: string;
        display_name: string;
        owner_user_id: string;
        created: boolean;
      }>(data)[0];
      if (!row) throw new AccessStoreError("unavailable");
      return { business: business(row), created: row.created === true };
    },
    async readBusiness(actor) {
      void actor;
      const data = await rpc<unknown>("read_business");
      const rows = rowsOf<{
        id: string;
        display_name: string;
        owner_user_id: string;
      }>(data);
      if (rows.length > 1) throw new AccessStoreError("unavailable");
      const row = rows[0];
      return row ? business(row) : null;
    },
    async readSetupReport(actor) {
      void actor;
      const data = await rpc<unknown>("read_setup_report");
      const rows = rowsOf<{
        business_id: string;
        display_name: string;
        owner_user_id: string;
      }>(data);
      if (rows.length > 1) throw new AccessStoreError("unavailable");
      const row = rows[0];
      return row ? business(row) : null;
    },
    async readGrant(actor, clientId): Promise<GrantRecord | null> {
      void actor;
      const data = await rpc<unknown>("read_client_grant", {
        p_oauth_client_id: clientId,
      });
      const row = rowsOf<{
        oauth_client_id: string;
        permissions: string[] | null;
        revoked_at: unknown;
      }>(data)[0];
      if (!row) return null;
      return {
        oauthClientId: row.oauth_client_id,
        permissions: row.permissions ?? [],
        revokedAt: timestamp(row.revoked_at),
      };
    },
    async recordConsent(actor: VerifiedActor, input: ConsentInput) {
      void actor;
      await rpc("record_client_consent", {
        p_oauth_client_id: input.oauthClientId,
        p_permissions: input.permissions,
        p_scopes: input.scopes,
        p_authorization_id: input.authorizationId,
        p_decision: input.decision,
        p_redirect_uri: input.redirectUri ?? null,
      });
    },
    async revokeGrant(actor, clientId) {
      void actor;
      const data = await rpc<unknown>("revoke_client_grant", {
        p_oauth_client_id: clientId,
      });
      return data === true;
    },
    async listLiveGrantRedirects(actor) {
      void actor;
      const data = await rpc<unknown>("list_live_grant_redirects");
      return rowsOf<{ registered_redirect_uri: string | null }>(data).flatMap(
        (row) =>
          row.registered_redirect_uri ? [row.registered_redirect_uri] : [],
      );
    },
  };
}
