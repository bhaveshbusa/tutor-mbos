/**
 * Development-only cleanup for acceptance run 38954838195.
 * The ids are the accept-job manifest printed in cleanup job 117156025989.
 * That manifest has no business id. This module does not open connections,
 * read credentials, or accept a caller-supplied owner or client id.
 */
import {
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
  users: [
    { label: "tenant-a", id: "bfb76b40-67f2-4be2-b002-9a4b7a0d7108" },
    { label: "tenant-b", id: "30328585-f1fa-4d1a-b80b-2dcd0dd2132a" },
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
  outcome: "removed" | "aborted_visibility" | "aborted_count" | "partial";
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
 * Reads both manifest owners before any delete. Each must see exactly one
 * business, and the two ids must differ. `businesses_one_owner` makes a
 * second business for the same owner impossible. `auth.uid()` is the JWT
 * `sub` claim, so the already-deleted Auth users do not block the read and
 * do not cascade into app rows. An uncertain read returns before
 * `probeDirectTenants`. That probe still re-reads both owners, rolls a bad
 * row count back, and does not start the second owner after the first aborts.
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
  const ready =
    first?.visible === 1 &&
    second?.visible === 1 &&
    first.businessId !== null &&
    second.businessId !== null &&
    first.businessId !== second.businessId;
  if (!ready || !first?.businessId || !second?.businessId) {
    return {
      runId: CLEANUP_RUN_38954838195.runId,
      phase: "read",
      owners,
      probes: [],
      outcome: "aborted_visibility",
    };
  }
  const userA = CLEANUP_RUN_38954838195.users[0];
  const userB = CLEANUP_RUN_38954838195.users[1];
  const probes = await probeDirectTenants(db, [
    {
      userId: userA.id,
      ownBusinessId: first.businessId,
      otherBusinessId: second.businessId,
      clientIds: CLEANUP_RUN_38954838195.clientIds,
    },
    {
      userId: userB.id,
      ownBusinessId: second.businessId,
      otherBusinessId: first.businessId,
      clientIds: CLEANUP_RUN_38954838195.clientIds,
    },
  ]);
  const deleted = probes.length > 0 && probes.every((probe) => probe.deleted);
  const anyDeleted = probes.some((probe) => probe.deleted);
  const outcome = deleted
    ? "removed"
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
    `historical_app_rows run=${report.runId} outcome=${report.outcome}`,
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
    lines.push(
      `probe=${label} deleted=${probe.deleted} abort=${probe.abortReason ?? "none"} other_visible=${probe.otherVisible}`,
    );
  });
  return lines.join("\n");
}
