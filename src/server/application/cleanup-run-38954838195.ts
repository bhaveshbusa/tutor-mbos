/**
 * Development-only cleanup for acceptance run 38954838195.
 * Owner and client ids are the accept-job manifest from cleanup job
 * 117156025989. Business ids are the read from run 39019907233. This
 * module does not open connections, read credentials, or accept a
 * caller-supplied owner, client, or business id.
 */
import {
  databaseSqlState,
  probeDirectTenants,
  readVisibleBusinessIds,
  type DirectProbe,
} from "./hosted-acceptance";
import type { SqlConnection } from "./sql";

export const CLEANUP_RUN_38954838195 = {
  runId: "38954838195",
  runAttempt: "1",
  commit: "cb889c4ab3108d004ff6a434ef6982bc0a1fc98d",
  projectRef: "idvzjqrkgnihvxoswuxu",
  manifestSource: "actions job 117156025989 ACCEPTANCE_MANIFEST",
  readSource: "actions run 39019907233 job 117359487839",
  readCommit: "8fa09df59effb0cf03b1d9c7022ac28caa06bf62",
  users: [
    {
      label: "tenant-a",
      id: "bfb76b40-67f2-4be2-b002-9a4b7a0d7108",
      businessId: "9087ef87-7934-4e26-a514-fd057cefe3e0",
    },
    {
      label: "tenant-b",
      id: "30328585-f1fa-4d1a-b80b-2dcd0dd2132a",
      businessId: "e5ae56e0-6ccd-45dd-801d-930c4f780379",
    },
  ],
  clientIds: [
    "01306e08-f3b8-438e-801b-ff261a831aaf",
    "cebf9982-4990-4902-b9b0-2d73f73716b2",
    "061d3c5e-5004-4a3b-8383-3f7be3196140",
  ],
} as const;

export interface OwnerVisibility {
  label: "tenant-a" | "tenant-b";
  businessId: string | null;
  visible: number;
}

export interface HistoricalAppRowReport {
  runId: typeof CLEANUP_RUN_38954838195.runId;
  phase: "read" | "cleanup";
  owners: OwnerVisibility[];
  probes: DirectProbe[];
  outcome:
    | "removed"
    | "aborted_visibility"
    | "aborted_count"
    | "partial"
    | "uncertain";
}

export interface DiagnoseReport {
  runId: typeof CLEANUP_RUN_38954838195.runId;
  phase: "connect" | "owner_read";
  outcome: "read" | "failed";
  sqlstate: string;
  closeSqlstate: string | null;
  writes: "not_started";
  owners: OwnerVisibility[];
}

export function cleanupRunGuard(
  env: Record<string, string | undefined>,
): string | null {
  if (
    env.TUTOR_MBOS_ACCEPTANCE !== "development" ||
    env.GITHUB_ACTIONS !== "true"
  ) {
    return "Historical app-row cleanup runs only from the protected development workflow.";
  }
  if (env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") {
    return "Historical app-row cleanup runs from main only.";
  }
  return null;
}

/**
 * Read-only check for the two manifest owners. Workflow run 38992665029
 * failed before a report, so this function does not call `probeDirectTenants`
 * and does not delete. `select 1` is the connect phase. Each later read is
 * that owner's claims. A database error returns its allowlisted SQLSTATE.
 */
export async function diagnoseRun38954838195(
  db: SqlConnection,
): Promise<DiagnoseReport> {
  const base = {
    runId: CLEANUP_RUN_38954838195.runId,
    closeSqlstate: null,
    writes: "not_started" as const,
  };
  try {
    await db.query("select 1");
  } catch (error) {
    return {
      ...base,
      phase: "connect",
      outcome: "failed",
      sqlstate: databaseSqlState(error),
      owners: [],
    };
  }
  const owners: OwnerVisibility[] = [];
  for (const user of CLEANUP_RUN_38954838195.users) {
    try {
      const ids = await readVisibleBusinessIds(db, user.id);
      owners.push({
        label: user.label,
        businessId: ids.length === 1 ? (ids[0] ?? null) : null,
        visible: ids.length,
      });
    } catch (error) {
      return {
        ...base,
        phase: "owner_read",
        outcome: "failed",
        sqlstate: databaseSqlState(error),
        owners,
      };
    }
  }
  return {
    ...base,
    phase: "owner_read",
    outcome: "read",
    sqlstate: "absent",
    owners,
  };
}

export function formatDiagnoseReport(report: DiagnoseReport): string {
  const close =
    report.closeSqlstate === null
      ? ""
      : ` close_sqlstate=${report.closeSqlstate}`;
  const lines = [
    `historical_app_rows run=${report.runId} phase=${report.phase} outcome=${report.outcome} sqlstate=${report.sqlstate} writes=${report.writes}${close}`,
  ];
  for (const owner of report.owners) {
    lines.push(
      owner.businessId
        ? `owner=${owner.label} visible=${owner.visible} business=${owner.businessId}`
        : `owner=${owner.label} visible=${owner.visible}`,
    );
  }
  return lines.join("\n");
}

/**
 * Reads both manifest owners before any delete. Each must see exactly the
 * business id recorded by read 39019907233. Any other id, count, or
 * uncertainty returns before `probeDirectTenants`. `businesses_one_owner`
 * makes a second business for the same owner impossible. `auth.uid()` is
 * the JWT `sub` claim, so the already-deleted Auth users do not block the
 * read and do not cascade into app rows. The probe re-reads both owners,
 * rolls a bad row count back, and does not start the second owner after
 * the first aborts. A missing commit acknowledgment or a confirmation read
 * that throws is `uncertain`. `delete_committed=true` means the client
 * received the commit. `delete_committed=unknown` does not prove a rollback.
 */
export async function cleanupRun38954838195(
  db: SqlConnection,
): Promise<HistoricalAppRowReport> {
  const owners: OwnerVisibility[] = [];
  for (const user of CLEANUP_RUN_38954838195.users) {
    const ids = await readVisibleBusinessIds(db, user.id);
    owners.push({
      label: user.label,
      businessId: ids.length === 1 ? (ids[0] ?? null) : null,
      visible: ids.length,
    });
  }
  const [first, second] = owners;
  const [userA, userB] = CLEANUP_RUN_38954838195.users;
  const ready =
    first?.label === userA.label &&
    second?.label === userB.label &&
    first.visible === 1 &&
    second.visible === 1 &&
    first.businessId === userA.businessId &&
    second.businessId === userB.businessId;
  if (!ready) {
    return {
      runId: CLEANUP_RUN_38954838195.runId,
      phase: "read",
      owners,
      probes: [],
      outcome: "aborted_visibility",
    };
  }
  const probes = await probeDirectTenants(db, [
    {
      userId: userA.id,
      ownBusinessId: userA.businessId,
      otherBusinessId: userB.businessId,
      clientIds: CLEANUP_RUN_38954838195.clientIds,
    },
    {
      userId: userB.id,
      ownBusinessId: userB.businessId,
      otherBusinessId: userA.businessId,
      clientIds: CLEANUP_RUN_38954838195.clientIds,
    },
  ]);
  const deleted = probes.length > 0 && probes.every((probe) => probe.deleted);
  const anyDeleted = probes.some((probe) => probe.deleted);
  const confirm = probes.some((probe) => probe.abortReason === "confirm");
  const outcome = deleted
    ? "removed"
    : confirm
      ? "uncertain"
      : anyDeleted
        ? "partial"
        : probes.some((probe) => probe.abortReason === "count")
          ? "aborted_count"
          : "aborted_visibility";
  return {
    runId: CLEANUP_RUN_38954838195.runId,
    phase: "cleanup",
    owners,
    probes,
    outcome,
  };
}

export function formatHistoricalAppRowReport(
  report: HistoricalAppRowReport,
): string {
  const lines = [
    `historical_app_rows run=${report.runId} phase=${report.phase} outcome=${report.outcome}`,
  ];
  for (const owner of report.owners) {
    lines.push(
      owner.businessId
        ? `owner=${owner.label} visible=${owner.visible} business=${owner.businessId}`
        : `owner=${owner.label} visible=${owner.visible}`,
    );
  }
  report.probes.forEach((probe, index) => {
    const label = report.owners[index]?.label ?? "unknown";
    const confirm =
      probe.abortReason === "confirm"
        ? ` delete_committed=${probe.deleteCommitted === true ? "true" : "unknown"} confirm_sqlstate=${probe.confirmSqlstate ?? "absent"}`
        : "";
    lines.push(
      `probe=${label} deleted=${probe.deleted} abort=${probe.abortReason ?? "none"} other_visible=${probe.otherVisible}${confirm}`,
    );
  });
  return lines.join("\n");
}
