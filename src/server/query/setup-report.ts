import { ACCESS_CONTRACT_VERSION } from "@/server/domain/access-contract";

/** Allowlisted setup report. Callers cannot add fields or SQL. */
export const SETUP_REPORT = {
  dataset: "setup",
  contractVersion: ACCESS_CONTRACT_VERSION,
  fields: ["businessId", "displayName", "ready"],
  permission: "reports.read",
} as const;
