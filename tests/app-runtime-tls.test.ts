import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  pgAppRuntimeConnection,
  pgConnection,
  type ClosableConnection,
} from "@/server/application/pg-connection";
import {
  SUPABASE_PROD_CA_2021,
  appRuntimeTls,
} from "@/server/config/supabase-prod-ca";

const POOLER_HOST = "aws-0-eu-west-2.pooler.supabase.com";
const ROOT_FINGERPRINT =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

function poolerUrl(sslmode?: string): string {
  const url = new URL("postgresql://localhost/postgres");
  url.username = "dummy";
  url.password = "dummy";
  url.hostname = POOLER_HOST;
  url.port = "6543";
  if (sslmode) url.searchParams.set("sslmode", sslmode);
  return url.href;
}

async function startupFailure(
  connection: ClosableConnection,
): Promise<{ code: string; message: string }> {
  try {
    await connection.query("select 1");
    return { code: "connected", message: "connected" };
  } catch (error) {
    const caught = error as { code?: unknown; message?: unknown };
    return {
      code: typeof caught.code === "string" ? caught.code : "",
      message: typeof caught.message === "string" ? caught.message : "",
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

describe("constructed app runtime TLS", () => {
  it("trusts the bundled Supabase Root 2021 CA for the public pooler", async () => {
    const cert = new X509Certificate(SUPABASE_PROD_CA_2021);
    expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.fingerprint256).toBe(ROOT_FINGERPRINT);
    expect(appRuntimeTls()).toEqual({
      ca: SUPABASE_PROD_CA_2021,
      rejectUnauthorized: true,
    });

    const trusted = await startupFailure(pgAppRuntimeConnection(poolerUrl()));
    expect(trusted.code).toBe("XX000");
    expect(trusted.message).toContain("no tenant identifier");

    const defaultTrust = await startupFailure(
      pgConnection(poolerUrl("verify-full")),
    );
    expect(defaultTrust.code).toBe("SELF_SIGNED_CERT_IN_CHAIN");
  });
});
