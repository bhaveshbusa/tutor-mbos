import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  CLEANUP_RUN_38954838195,
  cleanupRun38954838195,
  cleanupRunGuard,
  formatHistoricalAppRowReport,
} from "@/server/application/cleanup-run-38954838195";
import { migratedDatabase } from "./helpers/database";

const userC = "12121212-1212-4121-8121-121212121212";

async function asRuntime(connection: {
  exec: (text: string) => Promise<void>;
}): Promise<void> {
  await connection.exec("create role app_runtime login noinherit");
  await connection.exec(
    "grant app_request to app_runtime with inherit false, set true",
  );
  await connection.exec("set session authorization app_runtime");
}

async function addCreationKeys(
  connection: {
    query: (text: string, params: readonly unknown[]) => Promise<unknown>;
  },
  ownerUserId: string,
  businessId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await connection.query(
      `insert into app.business_creation_keys (owner_user_id, idempotency_key, business_id)
       values ($1::uuid, $2, $3::uuid)`,
      [ownerUserId, `extra-${ownerUserId.slice(0, 8)}-${index}`, businessId],
    );
  }
}

describe("run 38954838195 app-row cleanup", () => {
  it("pins the manifest printed by cleanup job 117156025989", () => {
    expect(CLEANUP_RUN_38954838195).toEqual({
      runId: "38954838195",
      runAttempt: "1",
      commit: "cb889c4ab3108d004ff6a434ef6982bc0a1fc98d",
      projectRef: "idvzjqrkgnihvxoswuxu",
      manifestSource: "actions job 117156025989 ACCEPTANCE_MANIFEST",
      users: [
        { label: "tenant-a", id: "bfb76b40-67f2-4be2-b002-9a4b7a0d7108" },
        { label: "tenant-b", id: "30328585-f1fa-4d1a-b80b-2dcd0dd2132a" },
      ],
      clientIds: [
        "01306e08-f3b8-438e-801b-ff261a831aaf",
        "cebf9982-4990-4902-b9b0-2d73f73716b2",
        "061d3c5e-5004-4a3b-8383-3f7be3196140",
      ],
    });
    const script = readFileSync("scripts/cleanup-run-38954838195.ts", "utf8");
    expect(script).not.toContain("ACCEPTANCE_MANIFEST");
    expect(script).not.toContain("SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY");
    expect(script).not.toContain("delete from");
  });

  it("refuses to run outside the protected development workflow", () => {
    expect(cleanupRunGuard({})).toContain("protected development workflow");
    expect(
      cleanupRunGuard({
        TUTOR_MBOS_ACCEPTANCE: "development",
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/feature",
      }),
    ).toContain("main only");
    expect(
      cleanupRunGuard({
        TUTOR_MBOS_ACCEPTANCE: "development",
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
      }),
    ).toBeNull();
  });

  it("deletes only the two manifest owners when each has one business", async () => {
    const { db, connection, store } = await migratedDatabase();
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const [userA, userB] = CLEANUP_RUN_38954838195.users;
    const createdA = await store.createBusiness(actor(userA.id), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB.id), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    const createdC = await store.createBusiness(actor(userC), {
      displayName: "Synthetic C",
      idempotencyKey: "tos3-c",
    });
    await addCreationKeys(connection, userA.id, createdA.business.id, 2);
    await addCreationKeys(connection, userB.id, createdB.business.id, 3);
    await asRuntime(connection);
    const report = await cleanupRun38954838195(connection);
    expect(report.outcome).toBe("removed");
    expect(report.owners.map((owner) => owner.visible)).toEqual([1, 1]);
    expect(report.probes.every((probe) => probe.deleted)).toBe(true);
    const text = formatHistoricalAppRowReport(report);
    expect(text).toContain(`business=${createdA.business.id}`);
    expect(text).toContain(`business=${createdB.business.id}`);
    expect(text).not.toContain("Synthetic");
    await connection.exec("reset session authorization");
    expect(await store.readBusiness(actor(userA.id))).toBeNull();
    expect(await store.readBusiness(actor(userB.id))).toBeNull();
    expect((await store.readBusiness(actor(userC)))?.id).toBe(
      createdC.business.id,
    );
    await db.close();
  });

  it("aborts before any delete when one manifest owner has no business", async () => {
    const { db, connection, store } = await migratedDatabase();
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const userB = CLEANUP_RUN_38954838195.users[1];
    const createdB = await store.createBusiness(actor(userB.id), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    await asRuntime(connection);
    const report = await cleanupRun38954838195(connection);
    expect(report.outcome).toBe("aborted_visibility");
    expect(report.phase).toBe("read");
    expect(report.probes).toEqual([]);
    expect(formatHistoricalAppRowReport(report)).toContain(
      "owner=tenant-a visible=0",
    );
    expect(formatHistoricalAppRowReport(report)).not.toContain(
      "owner=tenant-a visible=0 business=",
    );
    await connection.exec("reset session authorization");
    expect((await store.readBusiness(actor(userB.id)))?.id).toBe(
      createdB.business.id,
    );
    await db.close();
  });

  it("does not delete the second owner when the first creation-key count is above four", async () => {
    const { db, connection, store } = await migratedDatabase();
    const actor = (userId: string) => ({
      path: "ui-session" as const,
      userId,
      clientId: null,
    });
    const [userA, userB] = CLEANUP_RUN_38954838195.users;
    const createdA = await store.createBusiness(actor(userA.id), {
      displayName: "Synthetic A",
      idempotencyKey: "tos3-a",
    });
    const createdB = await store.createBusiness(actor(userB.id), {
      displayName: "Synthetic B",
      idempotencyKey: "tos3-b",
    });
    await addCreationKeys(connection, userA.id, createdA.business.id, 4);
    await asRuntime(connection);
    const report = await cleanupRun38954838195(connection);
    expect(report.outcome).toBe("aborted_count");
    expect(report.probes[0]?.deleted).toBe(false);
    expect(report.probes[1]?.deleted).toBe(false);
    await connection.exec("reset session authorization");
    expect((await store.readBusiness(actor(userA.id)))?.id).toBe(
      createdA.business.id,
    );
    expect((await store.readBusiness(actor(userB.id)))?.id).toBe(
      createdB.business.id,
    );
    await db.close();
  });

  it("binds the dispatch to the app runtime URL and the development queue", () => {
    const text = readFileSync(
      ".github/workflows/cleanup-run-38954838195.yml",
      "utf8",
    );
    const workflow = parse(text) as {
      on: Record<string, unknown>;
      concurrency: { group: string; queue: string };
      jobs: Record<
        string,
        {
          environment?: string;
          steps?: { run?: string; env?: Record<string, string> }[];
        }
      >;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency).toMatchObject({
      group: "development-delivery",
      queue: "max",
    });
    const job = workflow.jobs["cleanup-app-rows"];
    expect(job?.environment).toBe("development");
    expect(text).not.toContain("SUPABASE_DEVELOPMENT_AUTH_ADMIN_KEY");
    expect(text).not.toContain("SUPABASE_DEVELOPMENT_ACCESS_TOKEN");
    expect(text).not.toContain("VERCEL_TOKEN");
    expect(text).not.toContain("accept:development\n");
    expect(text).toContain("pnpm accept:development:cleanup-run-38954838195");
    const cleanup = job?.steps?.find((step) =>
      step.run?.includes("cleanup-run-38954838195"),
    );
    expect(cleanup?.env).toEqual({
      TUTOR_MBOS_APP_DATABASE_URL: "${{ secrets.TUTOR_MBOS_APP_DATABASE_URL }}",
    });
  });
});
