/**
 * Bounded Resend receiving reads for one acceptance run.
 * The API key is sent only to https://api.resend.com. List metadata is
 * matched to the exact recipient and the run window before any body GET.
 * Bodies, links, and tokens stay in this process and are not returned.
 */
import {
  ACCEPTANCE_RECEIVING_DOMAIN,
  CLEANUP_TIME_SKEW_MS,
  type CleanupUserLabel,
} from "./acceptance-cleanup.ts";

export { ACCEPTANCE_RECEIVING_DOMAIN };

/** SMTP sender the development project uses. Not a secret. */
export const ACCEPTANCE_SENDING_DOMAIN = "tutor.wonderkidz.co.uk";

export const RECEIVING_API_ORIGIN = "https://api.resend.com";

export const RECEIVING_API_KEY_SECRET = "RESEND_DEVELOPMENT_RECEIVING_API_KEY";

/**
 * Least Resend permission that can read receiving is `full_access`.
 * That permission is account-wide: it can read every received message
 * on the team. `sending_access` cannot read receiving, and domain
 * restriction exists only for `sending_access`. Matching a recipient
 * here does not narrow the key, and neither does the mail-step
 * environment. Account-wide access is acceptable only because the
 * Resend team is synthetic-only. The secret name is design-only until
 * that scope and the isolated mail steps are reviewed. Do not create it.
 */
export const RECEIVING_KEY_CAPABILITY =
  "Resend full_access, account-wide, synthetic-only team. sending_access cannot call GET /emails/receiving. Domain restriction applies only to sending_access. Recipient filtering and the mail-step environment do not narrow the key. No recipient or receiving-domain scope exists.";

export const RECEIVING_LIST_LIMIT = 20;
export const RECEIVING_LIST_PAGE_CAP = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{8,512}$/;
const URL_TEXT = /https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
/** Ampersand entities only. Other entities can change the host or scheme. */
const AMPERSAND_ENTITY = /&(?:amp|#0*38|#x0*26);/gi;

export type MailPurpose = "confirmation" | "recovery";

export type MailReadStatus =
  | "ready"
  | "secret_absent"
  | "not_received"
  | "ambiguous"
  | "sender_domain_mismatch"
  | "link_rejected"
  | "verify_rejected"
  | "body_mismatch"
  | "receiving_http"
  | "receiving_unreachable"
  | "receiving_list_bounded"
  | "window_absent";

export interface MailAction {
  label: CleanupUserLabel;
  path: "/auth/callback" | "/auth/recovery";
  code: string;
}

export interface MailReadResult {
  version: 1;
  purpose: MailPurpose;
  status: MailReadStatus;
  httpStatus?: number;
  /** Receiving ids already selected for this purpose. Recovery excludes them. */
  messageIds?: readonly string[];
  actions: MailAction[];
}

export interface ListedReceivedEmail {
  id: string;
  to: readonly string[];
  from: string;
  createdAt: string;
}

export interface MailRecipient {
  label: CleanupUserLabel;
  email: string;
}

interface CollectInput {
  fetchImpl: typeof fetch;
  apiKey: string;
  recipients: readonly MailRecipient[];
  purpose: MailPurpose;
  startedAt: string;
  nowMs: number;
  supabaseOrigin: string;
  siteOrigin: string;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  /** Confirmation ids already consumed. They are not a second recovery match. */
  excludeMessageIds?: readonly string[];
}

export function emailAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const wrapped = /<([^<>]+)>\s*$/.exec(trimmed);
  const address = (wrapped?.[1] ?? trimmed).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;
  return address;
}

export function emailDomain(value: string): string | null {
  const address = emailAddress(value);
  if (!address) return null;
  return address.slice(address.lastIndexOf("@") + 1);
}

function sameRecipient(value: string, recipient: string): boolean {
  return emailAddress(value) === recipient.trim().toLowerCase();
}

function exactRecipient(to: readonly string[], recipient: string): boolean {
  if (to.length === 0) return false;
  return to.every((entry) => sameRecipient(entry, recipient));
}

export function inReceivingWindow(
  createdAt: string,
  startedAt: string,
  nowMs: number,
): boolean {
  const created = Date.parse(createdAt);
  const started = Date.parse(startedAt);
  if (!Number.isFinite(created) || !Number.isFinite(started)) return false;
  return (
    created >= started - CLEANUP_TIME_SKEW_MS &&
    created <= nowMs + CLEANUP_TIME_SKEW_MS
  );
}

export function pageIsBeforeWindow(
  messages: readonly ListedReceivedEmail[],
  startedAt: string,
): boolean {
  if (messages.length === 0) return false;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return false;
  return messages.every((message) => {
    const created = Date.parse(message.createdAt);
    return Number.isFinite(created) && created < started - CLEANUP_TIME_SKEW_MS;
  });
}

export type RecipientMatch =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "sender_domain_mismatch" };

export function matchListedRecipient(
  messages: readonly ListedReceivedEmail[],
  recipient: string,
  startedAt: string,
  nowMs: number,
  excludeIds: readonly string[] = [],
): RecipientMatch {
  const excluded = new Set(excludeIds);
  const inWindow = messages.filter(
    (message) =>
      !excluded.has(message.id) &&
      exactRecipient(message.to, recipient) &&
      inReceivingWindow(message.createdAt, startedAt, nowMs),
  );
  const accepted = inWindow.filter(
    (message) => emailDomain(message.from) === ACCEPTANCE_SENDING_DOMAIN,
  );
  if (accepted.length > 1) return { kind: "ambiguous" };
  if (accepted.length === 1) {
    const id = accepted[0]?.id;
    if (!id || !UUID.test(id)) return { kind: "ambiguous" };
    return { kind: "match", id };
  }
  if (inWindow.length > 0) return { kind: "sender_domain_mismatch" };
  return { kind: "none" };
}

function allowedAppUrl(siteOrigin: string, purpose: MailPurpose): string {
  return purpose === "confirmation"
    ? `${siteOrigin}/auth/callback`
    : `${siteOrigin}/auth/recovery`;
}

function allowedPath(purpose: MailPurpose): MailAction["path"] {
  return purpose === "confirmation" ? "/auth/callback" : "/auth/recovery";
}

function decodeAmpersandEntities(value: string): string {
  return value.replace(AMPERSAND_ENTITY, "&");
}

export function selectVerifyLink(
  content: string,
  input: { supabaseOrigin: string; siteOrigin: string; purpose: MailPurpose },
): URL | null {
  const found = decodeAmpersandEntities(content).match(URL_TEXT) ?? [];
  const accepted = new Map<string, URL>();
  for (const raw of found) {
    const trimmed = raw.replace(/[),.;]+$/g, "");
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (!verifyLinkAllowed(url, input)) continue;
    accepted.set(url.href, url);
  }
  if (accepted.size !== 1) return null;
  return [...accepted.values()][0] ?? null;
}

function verifyLinkAllowed(
  url: URL,
  input: { supabaseOrigin: string; siteOrigin: string; purpose: MailPurpose },
): boolean {
  if (url.username || url.password) return false;
  if (url.protocol !== "https:") return false;
  if (url.origin !== input.supabaseOrigin) return false;
  if (url.pathname !== "/auth/v1/verify") return false;
  if (
    url.hash.includes("access_token") ||
    url.searchParams.has("access_token")
  ) {
    return false;
  }
  const type = url.searchParams.get("type");
  const expectedType = input.purpose === "confirmation" ? "signup" : "recovery";
  if (type !== expectedType) return false;
  if (
    url.searchParams.get("redirect_to") !==
    allowedAppUrl(input.siteOrigin, input.purpose)
  ) {
    return false;
  }
  const token =
    url.searchParams.get("token") ?? url.searchParams.get("token_hash");
  return typeof token === "string" && token.length > 0;
}

export function codeFromAppLocation(
  location: string,
  base: string,
  input: { siteOrigin: string; purpose: MailPurpose },
): MailAction | null {
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:") return null;
  if (url.origin !== input.siteOrigin) return null;
  if (url.pathname !== allowedPath(input.purpose)) return null;
  if (
    url.hash.includes("access_token") ||
    url.searchParams.has("access_token")
  ) {
    return null;
  }
  const code = url.searchParams.get("code");
  if (!code || !CODE.test(code)) return null;
  return { label: "tenant-a", path: allowedPath(input.purpose), code };
}

function result(
  purpose: MailPurpose,
  status: MailReadStatus,
  actions: MailAction[] = [],
  httpStatus?: number,
  messageIds: string[] = [],
): MailReadResult {
  return {
    version: 1,
    purpose,
    status,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(messageIds.length > 0 ? { messageIds } : {}),
    actions,
  };
}

function listedFrom(value: unknown): ListedReceivedEmail[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ListedReceivedEmail[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !Array.isArray(row.to)) return null;
    if (typeof row.from !== "string" || typeof row.created_at !== "string") {
      return null;
    }
    const to = row.to.filter(
      (item): item is string => typeof item === "string",
    );
    if (to.length !== row.to.length) return null;
    messages.push({
      id: row.id,
      to,
      from: row.from,
      createdAt: row.created_at,
    });
  }
  return messages;
}

async function resendGet(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: URL,
): Promise<{ status: number; body: unknown } | "unreachable" | "redirected"> {
  if (url.origin !== RECEIVING_API_ORIGIN) return "unreachable";
  const allowed =
    url.pathname === "/emails/receiving" ||
    /^\/emails\/receiving\/[0-9a-f-]{36}$/i.test(url.pathname);
  if (!allowed) return "unreachable";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
  } catch {
    return "unreachable";
  }
  if (response.status >= 300 && response.status < 400) return "redirected";
  const text = await response.text();
  if (response.status !== 200)
    return { status: response.status, body: undefined };
  try {
    return { status: 200, body: JSON.parse(text) as unknown };
  } catch {
    return { status: 200, body: undefined };
  }
}

async function navigate(
  fetchImpl: typeof fetch,
  url: URL,
): Promise<{ status: number; location: string | null } | "unreachable"> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
  } catch {
    return "unreachable";
  }
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

async function followVerify(
  fetchImpl: typeof fetch,
  start: URL,
  input: { supabaseOrigin: string; siteOrigin: string; purpose: MailPurpose },
): Promise<MailAction | "verify_rejected"> {
  let current = start;
  for (let hop = 0; hop < 2; hop += 1) {
    const reply = await navigate(fetchImpl, current);
    if (reply === "unreachable" || !reply.location) return "verify_rejected";
    if (reply.status < 300 || reply.status >= 400) return "verify_rejected";
    const app = codeFromAppLocation(reply.location, current.toString(), input);
    if (app) return app;
    let next: URL;
    try {
      next = new URL(reply.location, current);
    } catch {
      return "verify_rejected";
    }
    if (!verifyLinkAllowed(next, input)) return "verify_rejected";
    current = next;
  }
  return "verify_rejected";
}

async function listMatches(
  fetchImpl: typeof fetch,
  apiKey: string,
  recipients: readonly MailRecipient[],
  startedAt: string,
  nowMs: number,
  excludeIds: readonly string[],
): Promise<
  | { kind: "matches"; ids: { label: CleanupUserLabel; id: string }[] }
  | { kind: MailReadStatus; httpStatus?: number }
> {
  const collected: ListedReceivedEmail[] = [];
  let after = "";
  for (let page = 0; page < RECEIVING_LIST_PAGE_CAP; page += 1) {
    const url = new URL("/emails/receiving", RECEIVING_API_ORIGIN);
    url.searchParams.set("limit", String(RECEIVING_LIST_LIMIT));
    if (after) url.searchParams.set("after", after);
    const reply = await resendGet(fetchImpl, apiKey, url);
    if (reply === "unreachable") return { kind: "receiving_unreachable" };
    if (reply === "redirected")
      return { kind: "receiving_http", httpStatus: 302 };
    if (reply.status !== 200 || !reply.body) {
      return { kind: "receiving_http", httpStatus: reply.status };
    }
    const record = reply.body as { data?: unknown; has_more?: unknown };
    const messages = listedFrom(record.data);
    if (!messages) return { kind: "receiving_http", httpStatus: reply.status };
    collected.push(...messages);
    const decisions = recipients.map((recipient) =>
      matchListedRecipient(
        collected,
        recipient.email,
        startedAt,
        nowMs,
        excludeIds,
      ),
    );
    if (decisions.some((decision) => decision.kind === "ambiguous")) {
      return { kind: "ambiguous" };
    }
    const hasMore = record.has_more === true;
    const exhausted = !hasMore || pageIsBeforeWindow(messages, startedAt);
    if (!exhausted) {
      const last = messages.at(-1);
      if (!last || !UUID.test(last.id))
        return { kind: "receiving_list_bounded" };
      after = last.id;
      continue;
    }
    if (
      decisions.some((decision) => decision.kind === "sender_domain_mismatch")
    ) {
      return { kind: "sender_domain_mismatch" };
    }
    if (!decisions.every((decision) => decision.kind === "match")) {
      return { kind: "not_received" };
    }
    const ids = recipients.flatMap((recipient, index) => {
      const decision = decisions[index];
      return decision?.kind === "match"
        ? [{ label: recipient.label, id: decision.id }]
        : [];
    });
    if (ids.length !== recipients.length) return { kind: "not_received" };
    return { kind: "matches", ids };
  }
  return { kind: "receiving_list_bounded" };
}

function bodyStillMatches(
  body: unknown,
  recipient: string,
  startedAt: string,
  nowMs: number,
): { html: string; text: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.to) || typeof record.from !== "string") return null;
  if (typeof record.created_at !== "string") return null;
  const to = record.to.filter(
    (item): item is string => typeof item === "string",
  );
  if (!exactRecipient(to, recipient)) return null;
  if (emailDomain(record.from) !== ACCEPTANCE_SENDING_DOMAIN) return null;
  if (!inReceivingWindow(record.created_at, startedAt, nowMs)) return null;
  const html = typeof record.html === "string" ? record.html : "";
  const text = typeof record.text === "string" ? record.text : "";
  return { html, text };
}

export async function collectReceivedActions(
  input: CollectInput,
): Promise<MailReadResult> {
  const purpose = input.purpose;
  if (!input.apiKey || /[\r\n]/.test(input.apiKey)) {
    return result(purpose, "secret_absent");
  }
  if (!Number.isFinite(Date.parse(input.startedAt))) {
    return result(purpose, "window_absent");
  }
  const attempts = input.attempts ?? 6;
  const delayMs = input.delayMs ?? 5_000;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last: MailReadResult = result(purpose, "not_received");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    const listed = await listMatches(
      input.fetchImpl,
      input.apiKey,
      input.recipients,
      input.startedAt,
      input.nowMs,
      input.excludeMessageIds ?? [],
    );
    if (listed.kind !== "matches") {
      last = result(purpose, listed.kind, [], listed.httpStatus);
      if (listed.kind === "not_received") continue;
      return last;
    }
    const messageIds = listed.ids.map((match) => match.id);
    const actions: MailAction[] = [];
    for (const match of listed.ids) {
      const recipient = input.recipients.find(
        (row) => row.label === match.label,
      );
      if (!recipient) {
        return result(purpose, "body_mismatch", [], undefined, messageIds);
      }
      const url = new URL(
        `/emails/receiving/${match.id}`,
        RECEIVING_API_ORIGIN,
      );
      const reply = await resendGet(input.fetchImpl, input.apiKey, url);
      if (reply === "unreachable") {
        return result(
          purpose,
          "receiving_unreachable",
          [],
          undefined,
          messageIds,
        );
      }
      if (reply === "redirected") {
        return result(purpose, "receiving_http", [], 302, messageIds);
      }
      if (reply.status !== 200) {
        return result(purpose, "receiving_http", [], reply.status, messageIds);
      }
      const content = bodyStillMatches(
        reply.body,
        recipient.email,
        input.startedAt,
        input.nowMs,
      );
      if (!content) {
        return result(purpose, "body_mismatch", [], undefined, messageIds);
      }
      const link = selectVerifyLink(`${content.text}\n${content.html}`, {
        supabaseOrigin: input.supabaseOrigin,
        siteOrigin: input.siteOrigin,
        purpose,
      });
      if (!link) {
        return result(purpose, "link_rejected", [], undefined, messageIds);
      }
      const followed = await followVerify(input.fetchImpl, link, {
        supabaseOrigin: input.supabaseOrigin,
        siteOrigin: input.siteOrigin,
        purpose,
      });
      if (followed === "verify_rejected") {
        return result(purpose, "verify_rejected", [], undefined, messageIds);
      }
      actions.push({ ...followed, label: match.label });
    }
    return result(purpose, "ready", actions, undefined, messageIds);
  }
  return last;
}

export function authStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

export function pkceVerifierCookie(
  storageKey: string,
  verifier: string,
): { name: string; value: string } {
  return {
    name: `${storageKey}-code-verifier`,
    value: `base64-${Buffer.from(JSON.stringify(verifier), "utf8").toString("base64url")}`,
  };
}

export function readSessionTokens(
  storageKey: string,
  cookies: Iterable<[string, string]>,
): { accessToken: string; refreshToken: string } | null {
  const jar = new Map(cookies);
  const direct = jar.get(storageKey) ?? "";
  const chunks = [...jar.entries()]
    .flatMap(([name, value]) => {
      if (!name.startsWith(`${storageKey}.`)) return [];
      const index = Number(name.slice(storageKey.length + 1));
      return Number.isInteger(index) && index >= 0 ? [{ index, value }] : [];
    })
    .sort((left, right) => left.index - right.index)
    .map((cookie) => cookie.value)
    .join("");
  const raw = direct || chunks;
  if (!raw.startsWith("base64-")) return null;
  try {
    const session = JSON.parse(
      Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8"),
    ) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof session.access_token !== "string" || !session.access_token) {
      return null;
    }
    if (typeof session.refresh_token !== "string" || !session.refresh_token) {
      return null;
    }
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  } catch {
    return null;
  }
}
