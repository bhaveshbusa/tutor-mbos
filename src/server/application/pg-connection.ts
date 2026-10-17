import pg from "pg";
import { appRuntimeTls } from "@/server/config/supabase-prod-ca";
import type { Sql, SqlConnection } from "./sql";

export interface ClosableConnection extends SqlConnection {
  close(): Promise<void>;
}

type ClientTls = ReturnType<typeof appRuntimeTls>;

/** One non-pooled client. Connects on the first query and never logs the URL. */
export function pgConnection(
  connectionString: string,
  ssl?: ClientTls,
): ClosableConnection {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    ...(ssl ? { ssl } : {}),
  });
  let connecting: Promise<void> | null = null;
  const ready = () => {
    connecting ??= client.connect().then(() => undefined);
    return connecting;
  };
  const query: Sql["query"] = async (text, params) => {
    await ready();
    const result = await client.query(text, params ? [...params] : []);
    return { rows: result.rows };
  };
  const exec: Sql["exec"] = async (text) => {
    await query(text);
  };
  return {
    query,
    exec,
    async transaction(fn) {
      await ready();
      await client.query("begin");
      try {
        const value = await fn({ query, exec });
        await client.query("commit");
        return value;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    },
    async close() {
      if (connecting) await client.end();
    },
  };
}

/**
 * Constructed app_runtime connection. Trusts the bundled Supabase prod CA
 * and checks the hostname. Migration and stored-URL clients do not use this.
 */
export function pgAppRuntimeConnection(
  connectionString: string,
): ClosableConnection {
  return pgConnection(connectionString, appRuntimeTls());
}
