/**
 * One bounded Resend receiving read for a development check.
 * The key is sent only to https://api.resend.com. List metadata is matched
 * to one recipient and the run window before the body is read. The body is
 * used to choose one Supabase verify link and is not returned.
 */

export const RECEIVING_API_ORIGIN = "https://api.resend.com";
export const RECEIVING_DOMAIN = "weeveo.resend.app";
export const SENDING_DOMAIN = "tutor.wonderkidz.co.uk";
export const RECEIVING_KEY_NAME = "RESEND_DEVELOPMENT_RECEIVING_API_KEY";

const LIST_LIMIT = 20;
const LIST_PAGE_CAP = 5;
const WINDOW_SKEW_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_TEXT = /https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
const AMPERSAND_ENTITY = /&(?:amp|#0*38|#x0*26);/gi;

export type MailPurpose = "confirmation" | "recovery";

export type MailReadStatus =
  | "ready"
  | "secret_absent"
  | "not_received"
  | "ambiguous"
  | "sender_domain_mismatch"
  | "link_rejected"
  | "body_mismatch"
  | "receiving_http"
  | "receiving_unreachable"
  | "receiving_list_bounded"
  | "window_absent";

export interface ListedReceivedEmail {
  id: string;
  to: readonly string[];
  from: string;
  createdAt: string;
}

export interface ReceivedVerifyLink {
  status: MailReadStatus;
  httpStatus?: number;
  messageId?: string;
  verifyUrl?: URL;
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

function exactRecipient(to: readonly string[], recipient: string): boolean {
  if (to.length === 0) return false;
  const expected = recipient.trim().toLowerCase();
  return to.every((entry) => emailAddress(entry) === expected);
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
    created >= started - WINDOW_SKEW_MS && created <= nowMs + WINDOW_SKEW_MS
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
    return Number.isFinite(created) && created < started - WINDOW_SKEW_MS;
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
    (message) => emailDomain(message.from) === SENDING_DOMAIN,
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

function allowedRedirect(siteOrigin: string, purpose: MailPurpose): string {
  return purpose === "confirmation"
    ? `${siteOrigin}/auth/callback`
    : `${siteOrigin}/auth/recovery`;
}

function decodeAmpersands(value: string): string {
  return value.replace(AMPERSAND_ENTITY, "&");
}

export function selectVerifyLink(
  content: string,
  input: { supabaseOrigin: string; siteOrigin: string; purpose: MailPurpose },
): URL | null {
  const found = decodeAmpersands(content).match(URL_TEXT) ?? [];
  const accepted = new Map<string, URL>();
  for (const raw of found) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[),.;]+$/g, ""));
    } catch {
      continue;
    }
    if (url.username || url.password || url.protocol !== "https:") continue;
    if (url.origin !== input.supabaseOrigin) continue;
    if (url.pathname !== "/auth/v1/verify") continue;
    if (
      url.hash.includes("access_token") ||
      url.searchParams.has("access_token")
    ) {
      continue;
    }
    const expectedType =
      input.purpose === "confirmation" ? "signup" : "recovery";
    if (url.searchParams.get("type") !== expectedType) continue;
    if (
      url.searchParams.get("redirect_to") !==
      allowedRedirect(input.siteOrigin, input.purpose)
    ) {
      continue;
    }
    const token =
      url.searchParams.get("token") ?? url.searchParams.get("token_hash");
    if (!token) continue;
    accepted.set(url.href, url);
  }
  if (accepted.size !== 1) return null;
  return [...accepted.values()][0] ?? null;
}

function listedFrom(value: unknown): ListedReceivedEmail[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ListedReceivedEmail[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.from !== "string" ||
      typeof record.created_at !== "string" ||
      !Array.isArray(record.to)
    ) {
      return null;
    }
    const to = record.to.filter(
      (entry): entry is string => typeof entry === "string",
    );
    messages.push({
      id: record.id,
      to,
      from: record.from,
      createdAt: record.created_at,
    });
  }
  return messages;
}

type GetResult =
  { status: number; body: unknown } | "unreachable" | "redirected";

async function resendGet(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: URL,
): Promise<GetResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
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
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export async function readReceivedVerifyLink(input: {
  fetchImpl: typeof fetch;
  apiKey: string;
  recipient: string;
  purpose: MailPurpose;
  startedAt: string;
  nowMs: number;
  supabaseOrigin: string;
  siteOrigin: string;
  excludeMessageIds?: readonly string[];
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ReceivedVerifyLink> {
  if (!input.apiKey || /[\r\n]/.test(input.apiKey)) {
    return { status: "secret_absent" };
  }
  if (emailDomain(input.recipient) !== RECEIVING_DOMAIN) {
    return { status: "link_rejected" };
  }
  if (!Number.isFinite(Date.parse(input.startedAt))) {
    return { status: "window_absent" };
  }
  const attempts = input.attempts ?? 1;
  const delayMs = input.delayMs ?? 0;
  const sleep = input.sleep ?? (async () => undefined);
  let last: ReceivedVerifyLink = { status: "not_received" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    const listed = await listMatch(input);
    if (listed.status !== "ready" || !listed.messageId) {
      last = listed;
      if (listed.status === "not_received") continue;
      return listed;
    }
    const url = new URL(
      `/emails/receiving/${listed.messageId}`,
      RECEIVING_API_ORIGIN,
    );
    const reply = await resendGet(input.fetchImpl, input.apiKey, url);
    if (reply === "unreachable")
      return { status: "receiving_unreachable", messageId: listed.messageId };
    if (reply === "redirected") {
      return {
        status: "receiving_http",
        httpStatus: 302,
        messageId: listed.messageId,
      };
    }
    if (reply.status !== 200) {
      return {
        status: "receiving_http",
        httpStatus: reply.status,
        messageId: listed.messageId,
      };
    }
    const content = bodyStillMatches(reply.body, input);
    if (!content)
      return { status: "body_mismatch", messageId: listed.messageId };
    const verifyUrl = selectVerifyLink(content, input);
    if (!verifyUrl)
      return { status: "link_rejected", messageId: listed.messageId };
    return { status: "ready", messageId: listed.messageId, verifyUrl };
  }
  return last;
}

async function listMatch(input: {
  fetchImpl: typeof fetch;
  apiKey: string;
  recipient: string;
  startedAt: string;
  nowMs: number;
  excludeMessageIds?: readonly string[];
}): Promise<ReceivedVerifyLink> {
  const collected: ListedReceivedEmail[] = [];
  let after = "";
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const url = new URL("/emails/receiving", RECEIVING_API_ORIGIN);
    url.searchParams.set("limit", String(LIST_LIMIT));
    if (after) url.searchParams.set("after", after);
    const reply = await resendGet(input.fetchImpl, input.apiKey, url);
    if (reply === "unreachable") return { status: "receiving_unreachable" };
    if (reply === "redirected")
      return { status: "receiving_http", httpStatus: 302 };
    if (reply.status !== 200 || !reply.body || typeof reply.body !== "object") {
      return { status: "receiving_http", httpStatus: reply.status };
    }
    const record = reply.body as { data?: unknown; has_more?: unknown };
    const messages = listedFrom(record.data);
    if (!messages)
      return { status: "receiving_http", httpStatus: reply.status };
    collected.push(...messages);
    const decision = matchListedRecipient(
      collected,
      input.recipient,
      input.startedAt,
      input.nowMs,
      input.excludeMessageIds ?? [],
    );
    if (decision.kind === "ambiguous") return { status: "ambiguous" };
    const exhausted =
      record.has_more !== true || pageIsBeforeWindow(messages, input.startedAt);
    if (!exhausted) {
      const last = messages.at(-1);
      if (!last || !UUID.test(last.id))
        return { status: "receiving_list_bounded" };
      after = last.id;
      continue;
    }
    if (decision.kind === "sender_domain_mismatch")
      return { status: "sender_domain_mismatch" };
    if (decision.kind !== "match") return { status: "not_received" };
    return { status: "ready", messageId: decision.id };
  }
  return { status: "receiving_list_bounded" };
}

function bodyStillMatches(
  body: unknown,
  input: { recipient: string; startedAt: string; nowMs: number },
): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.to) || typeof record.from !== "string") return null;
  if (typeof record.created_at !== "string") return null;
  const to = record.to.filter(
    (item): item is string => typeof item === "string",
  );
  if (!exactRecipient(to, input.recipient)) return null;
  if (emailDomain(record.from) !== SENDING_DOMAIN) return null;
  if (!inReceivingWindow(record.created_at, input.startedAt, input.nowMs))
    return null;
  const html = typeof record.html === "string" ? record.html : "";
  const text = typeof record.text === "string" ? record.text : "";
  return `${text}\n${html}`;
}
