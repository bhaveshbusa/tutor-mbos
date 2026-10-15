import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFirstBusiness,
  readSetupReport,
} from "@/server/application/business-access";
import {
  AccessStoreError,
  type AccessStore,
} from "@/server/application/access-store";
import type { VerifiedActor } from "@/server/domain/access-decision";
import { migratedDatabase } from "./helpers/database";
import {
  API_CLIENT,
  CHATGPT_CLIENT,
  GENERIC_MCP_CLIENT,
  TENANT_A,
  TENANT_B,
} from "./helpers/tokens";

const ui = (userId: string): VerifiedActor => ({
  path: "ui-session",
  userId,
  clientId: null,
});
const delegated = (userId: string, clientId: string): VerifiedActor => ({
  path: "delegated-oauth",
  userId,
  clientId,
});

async function seed() {
  const { connection, store } = await migratedDatabase();
  await store.recordConsent(ui(TENANT_A.userId), {
    oauthClientId: CHATGPT_CLIENT,
    permissions: ["business.onboard", "business.read", "reports.read"],
    scopes: ["openid", "email", "business.onboard"],
    authorizationId: "authz-a",
    decision: "approved",
  });
  await store.recordConsent(ui(TENANT_B.userId), {
    oauthClientId: GENERIC_MCP_CLIENT,
    permissions: ["reports.read"],
    scopes: ["openid"],
    authorizationId: "authz-b",
    decision: "approved",
  });
  await store.recordConsent(ui(TENANT_A.userId), {
    oauthClientId: API_CLIENT,
    permissions: ["business.read"],
    scopes: ["openid"],
    authorizationId: "authz-api",
    decision: "approved",
  });
  const createdA = await store.createBusiness(
    delegated(TENANT_A.userId, CHATGPT_CLIENT),
    {
      displayName: TENANT_A.name,
      idempotencyKey: "a-1",
    },
  );
  const createdB = await store.createBusiness(ui(TENANT_B.userId), {
    displayName: TENANT_B.name,
    idempotencyKey: "b-1",
  });
  return { connection, store, createdA, createdB };
}

describe("tenant isolation", () => {
  it("keeps two similarly named businesses apart, including aggregates and the report", async () => {
    const { connection, store, createdA, createdB } = await seed();
    expect(createdA.business.displayName).toBe(TENANT_A.name);
    expect(createdB.business.displayName).toBe(TENANT_B.name);
    expect(createdA.business.id).not.toBe(createdB.business.id);

    const again = await store.createBusiness(
      delegated(TENANT_A.userId, CHATGPT_CLIENT),
      {
        displayName: "Renamed by a retry",
        idempotencyKey: "a-2",
      },
    );
    expect(again.created).toBe(false);
    expect(again.business).toMatchObject({
      id: createdA.business.id,
      displayName: TENANT_A.name,
      ownerUserId: TENANT_A.userId,
    });

    const report = await store.readSetupReport(
      delegated(TENANT_A.userId, CHATGPT_CLIENT),
    );
    expect(report).toEqual(createdA.business);
    const count = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({
          sub: TENANT_A.userId,
          role: "authenticated",
          client_id: CHATGPT_CLIENT,
          user_metadata: { tenant_id: TENANT_B.userId },
        }),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        TENANT_A.userId,
      ]);
      await tx.exec("set local role authenticated");
      return tx.query(
        "select count(*)::int as n from app.businesses where owner_user_id = $1 or id = $2",
        [TENANT_B.userId, createdB.business.id],
      );
    });
    expect(count.rows).toEqual([{ n: 0 }]);
  });

  it("blocks direct database paths that are not the caller's rows", async () => {
    const { connection, store, createdB } = await seed();
    await expect(
      connection.transaction(async (tx) => {
        await tx.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: TENANT_A.userId, role: "authenticated" }),
        ]);
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
          TENANT_A.userId,
        ]);
        await tx.exec("set local role authenticated");
        await tx.query(
          "insert into app.businesses (owner_user_id, display_name) values ($1, 'stolen')",
          [TENANT_B.userId],
        );
      }),
    ).rejects.toThrow(/row-level security/);

    await expect(
      store.createBusiness(delegated(TENANT_B.userId, GENERIC_MCP_CLIENT), {
        displayName: "Nope",
        idempotencyKey: "b-new",
      }),
    ).rejects.toBeInstanceOf(AccessStoreError);

    await store.revokeGrant(ui(TENANT_A.userId), CHATGPT_CLIENT);
    expect(
      await store.readBusiness(delegated(TENANT_A.userId, CHATGPT_CLIENT)),
    ).toBeNull();
    expect((await store.readBusiness(ui(TENANT_A.userId)))?.id).not.toBe(
      createdB.business.id,
    );

    const serviceClaim = await connection.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: TENANT_A.userId, role: "service_role" }),
      ]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [
        TENANT_A.userId,
      ]);
      await tx.exec("set local role app_request");
      return tx.query("select id from app.businesses");
    });
    expect(serviceClaim.rows).toEqual([]);

    await expect(
      connection.transaction(async (tx) => {
        await tx.exec("set local role anon");
        await tx.query("select * from app.businesses");
      }),
    ).rejects.toThrow(/permission denied/);

    const privileged = await connection.query(
      "select count(*)::int as n from app.businesses",
    );
    expect(privileged.rows).toEqual([{ n: 2 }]);
    const source = readFileSync(
      "src/server/application/access-store.ts",
      "utf8",
    );
    expect(source).toContain("set local role app_request");
  });

  it("rejects a store that returns another owner's business", async () => {
    const evil: AccessStore = {
      async createBusiness() {
        return {
          created: true,
          business: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            ownerUserId: TENANT_B.userId,
            displayName: TENANT_B.name,
          },
        };
      },
      async readBusiness() {
        return null;
      },
      async readSetupReport() {
        return {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
          ownerUserId: TENANT_B.userId,
          displayName: TENANT_B.name,
        };
      },
      async readGrant() {
        return null;
      },
      async recordConsent() {
        return undefined;
      },
      async revokeGrant() {
        return false;
      },
    };
    const context = {
      actor: ui(TENANT_A.userId),
      grant: null,
      requestedTenantId: TENANT_B.userId,
    };
    const created = await createFirstBusiness(evil, context, {
      displayName: TENANT_A.name,
      idempotencyKey: "once",
    });
    const report = await readSetupReport(evil, context);
    expect(created.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});
