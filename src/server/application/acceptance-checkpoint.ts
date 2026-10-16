/**
 * Same-runner handoff between acceptance steps. The mail steps do not
 * read the session file. Sharing a runner is not filesystem isolation:
 * any step in the job can read this directory. The receiving key stays
 * out of the other steps' environments, and that does not narrow it.
 * Job outputs are not used for verifiers, codes, or tokens.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedCleanupEmail,
  type CleanupUserLabel,
} from "./acceptance-cleanup.ts";
import type {
  MailAction,
  MailPurpose,
  MailReadResult,
} from "./acceptance-mail.ts";
import type { AcceptanceCase } from "./hosted-acceptance.ts";

const CODE = /^[A-Za-z0-9_-]{8,512}$/;
const MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_LIMIT = 128_000;
const MAIL_LIMIT = 8_192;

export type AcceptanceStage = "blocked" | "signed_up" | "recovery_requested";

export interface CheckpointTenant {
  label: CleanupUserLabel;
  email: string;
  password: string;
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  businessId: string | null;
  delegatedToken: string | null;
  responseLost: boolean;
  confirmed: boolean;
  verifier: string;
  jar: [string, string][];
}

export interface AcceptanceCheckpoint {
  version: 1;
  stage: AcceptanceStage;
  deployedCommit: string;
  results: AcceptanceCase[];
  mailerAutoconfirmFalse: boolean;
  metadataPass: boolean;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  registrationEndpoint: string | null;
  recoveryRequestedAt: string | null;
  recoveryJar: [string, string][];
  tenants: CheckpointTenant[];
}

export function acceptanceStateDir(root: string): string {
  return join(root, "tos3-acceptance");
}

function sessionPath(dir: string): string {
  return join(dir, "session.json");
}

function mailPath(dir: string, purpose: MailPurpose): string {
  return join(dir, `${purpose}.json`);
}

function windowPath(dir: string): string {
  return join(dir, "recovery-requested-at");
}

function writePrivate(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path);
  } catch {
    // The first write has no file to replace.
  }
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
}

function readBounded(path: string, limit: number): string | null {
  try {
    const body = readFileSync(path, "utf8");
    if (Buffer.byteLength(body, "utf8") > limit) return null;
    return body;
  } catch {
    return null;
  }
}

function isLabel(value: unknown): value is CleanupUserLabel {
  return value === "tenant-a" || value === "tenant-b";
}

function isCase(value: unknown): value is AcceptanceCase {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    row.id.length < 120 &&
    !/[\r\n]/.test(row.id) &&
    (row.status === "pass" || row.status === "fail" || row.status === "gap") &&
    typeof row.detail === "string" &&
    row.detail.length < 500 &&
    !/[\r\n]/.test(row.detail)
  );
}

function cookiePairs(value: unknown): [string, string][] | null {
  if (!Array.isArray(value)) return null;
  const pairs: [string, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, cookie] = entry;
    if (typeof name !== "string" || typeof cookie !== "string") return null;
    if (!name || /[\r\n;=]/.test(name) || /[\r\n]/.test(cookie)) return null;
    pairs.push([name, cookie]);
  }
  return pairs;
}

export function writeCheckpoint(
  dir: string,
  checkpoint: AcceptanceCheckpoint,
): void {
  writePrivate(sessionPath(dir), JSON.stringify(checkpoint));
}

export function readCheckpoint(
  dir: string,
  nonce: string,
): AcceptanceCheckpoint | null {
  const body = readBounded(sessionPath(dir), SESSION_LIMIT);
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) return null;
  if (
    row.stage !== "blocked" &&
    row.stage !== "signed_up" &&
    row.stage !== "recovery_requested"
  ) {
    return null;
  }
  if (typeof row.deployedCommit !== "string") return null;
  if (!Array.isArray(row.results) || row.results.length > 200) return null;
  if (!row.results.every((entry) => isCase(entry))) return null;
  if (typeof row.mailerAutoconfirmFalse !== "boolean") return null;
  if (typeof row.metadataPass !== "boolean") return null;
  if (!endpoint(row.authorizationEndpoint)) return null;
  if (!endpoint(row.tokenEndpoint)) return null;
  if (!endpoint(row.registrationEndpoint)) return null;
  if (
    row.recoveryRequestedAt !== null &&
    (typeof row.recoveryRequestedAt !== "string" ||
      !Number.isFinite(Date.parse(row.recoveryRequestedAt)))
  ) {
    return null;
  }
  const recoveryJar = cookiePairs(row.recoveryJar);
  if (!recoveryJar || !Array.isArray(row.tenants) || row.tenants.length !== 2) {
    return null;
  }
  const tenants: CheckpointTenant[] = [];
  for (const entry of row.tenants) {
    const tenant = tenantOf(entry, nonce);
    if (!tenant) return null;
    tenants.push(tenant);
  }
  if (tenants[0]?.label !== "tenant-a" || tenants[1]?.label !== "tenant-b") {
    return null;
  }
  return {
    version: 1,
    stage: row.stage,
    deployedCommit: row.deployedCommit,
    results: row.results as AcceptanceCase[],
    mailerAutoconfirmFalse: row.mailerAutoconfirmFalse,
    metadataPass: row.metadataPass,
    authorizationEndpoint: row.authorizationEndpoint as string | null,
    tokenEndpoint: row.tokenEndpoint as string | null,
    registrationEndpoint: row.registrationEndpoint as string | null,
    recoveryRequestedAt: row.recoveryRequestedAt as string | null,
    recoveryJar,
    tenants,
  };
}

function endpoint(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.startsWith("https://"))
  );
}

function tenantOf(value: unknown, nonce: string): CheckpointTenant | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!isLabel(row.label)) return null;
  if (row.email !== expectedCleanupEmail(row.label, nonce)) return null;
  if (typeof row.password !== "string" || typeof row.verifier !== "string") {
    return null;
  }
  if (/[\r\n]/.test(row.password) || /[\r\n]/.test(row.verifier)) return null;
  const jar = cookiePairs(row.jar);
  if (!jar) return null;
  const optional = (field: unknown): string | null | undefined => {
    if (field === null) return null;
    if (typeof field === "string" && !/[\r\n]/.test(field)) return field;
    return undefined;
  };
  const userId = optional(row.userId);
  const accessToken = optional(row.accessToken);
  const refreshToken = optional(row.refreshToken);
  const businessId = optional(row.businessId);
  const delegatedToken = optional(row.delegatedToken);
  if (
    userId === undefined ||
    accessToken === undefined ||
    refreshToken === undefined ||
    businessId === undefined ||
    delegatedToken === undefined ||
    typeof row.responseLost !== "boolean" ||
    typeof row.confirmed !== "boolean"
  ) {
    return null;
  }
  return {
    label: row.label,
    email: row.email,
    password: row.password,
    userId,
    accessToken,
    refreshToken,
    businessId,
    delegatedToken,
    responseLost: row.responseLost,
    confirmed: row.confirmed,
    verifier: row.verifier,
    jar,
  };
}

export function writeMailResult(dir: string, mail: MailReadResult): void {
  const actions = mail.actions.map((action) => ({
    label: action.label,
    path: action.path,
    code: action.code,
  }));
  const messageIds = (mail.messageIds ?? []).filter((id) =>
    MESSAGE_ID.test(id),
  );
  writePrivate(
    mailPath(dir, mail.purpose),
    JSON.stringify({
      version: 1,
      purpose: mail.purpose,
      status: mail.status,
      ...(mail.httpStatus === undefined ? {} : { httpStatus: mail.httpStatus }),
      ...(messageIds.length > 0 ? { messageIds } : {}),
      actions,
    }),
  );
}

export function readMailResult(
  dir: string,
  purpose: MailPurpose,
): MailReadResult | null {
  const body = readBounded(mailPath(dir, purpose), MAIL_LIMIT);
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1 || row.purpose !== purpose) return null;
  if (typeof row.status !== "string") return null;
  if (!Array.isArray(row.actions) || row.actions.length > 2) return null;
  const actions: MailAction[] = [];
  for (const entry of row.actions) {
    if (typeof entry !== "object" || entry === null) return null;
    const action = entry as Record<string, unknown>;
    if (!isLabel(action.label)) return null;
    if (action.path !== "/auth/callback" && action.path !== "/auth/recovery") {
      return null;
    }
    if (purpose === "confirmation" && action.path !== "/auth/callback")
      return null;
    if (purpose === "recovery" && action.path !== "/auth/recovery") return null;
    if (typeof action.code !== "string" || !CODE.test(action.code)) return null;
    actions.push({
      label: action.label,
      path: action.path,
      code: action.code,
    });
  }
  const httpStatus =
    typeof row.httpStatus === "number" && Number.isInteger(row.httpStatus)
      ? row.httpStatus
      : undefined;
  const messageIds = messageIdsOf(row.messageIds);
  if (!messageIds) return null;
  return {
    version: 1,
    purpose,
    status: row.status as MailReadResult["status"],
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(messageIds.length > 0 ? { messageIds } : {}),
    actions,
  };
}

function messageIdsOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !MESSAGE_ID.test(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

export function writeRecoveryWindow(dir: string, startedAt: string): void {
  writePrivate(windowPath(dir), startedAt);
}

export function readRecoveryWindow(dir: string): string | null {
  const body = readBounded(windowPath(dir), 80);
  if (!body) return null;
  const value = body.trim();
  if (!Number.isFinite(Date.parse(value))) return null;
  return value;
}
