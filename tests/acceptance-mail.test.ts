import { describe, expect, it } from "vitest";
import { expectedCleanupEmail } from "@/server/application/acceptance-cleanup";
import {
  ACCEPTANCE_SENDING_DOMAIN,
  collectReceivedActions,
  matchListedRecipient,
  selectVerifyLink,
  type ListedReceivedEmail,
} from "@/server/application/acceptance-mail";
import { siteOriginFor } from "@/server/config/access";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "@/server/config/environments";

const site = siteOriginFor("development");
const supabase = supabaseUrlFor(
  ENVIRONMENT_BINDINGS.development.supabaseProjectRef,
);
const nonce = "ab".repeat(16);
const recipient = expectedCleanupEmail("tenant-a", nonce);
const startedAt = "2026-10-16T18:00:00.000Z";
const nowMs = Date.parse("2026-10-16T18:05:00.000Z");
const token = "verify-token-do-not-leak";
const bodySecret = "body-secret-do-not-leak";
const code = "callback-code-ok";

function message(
  id: string,
  to: string[],
  from: string,
  createdAt: string,
): ListedReceivedEmail {
  return { id, to, from, createdAt };
}

function verifyUrl(type: "signup" | "recovery" = "signup"): string {
  const url = new URL("/auth/v1/verify", supabase);
  url.searchParams.set("token", token);
  url.searchParams.set("type", type);
  url.searchParams.set(
    "redirect_to",
    type === "signup" ? `${site}/auth/callback` : `${site}/auth/recovery`,
  );
  return url.toString();
}

describe("receiving mail selection", () => {
  it("matches one in-window message from the sending domain", () => {
    const match = matchListedRecipient(
      [
        message(
          "11111111-1111-4111-8111-111111111111",
          [recipient],
          `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          "2026-10-16T18:01:00.000Z",
        ),
      ],
      recipient,
      startedAt,
      nowMs,
    );
    expect(match).toEqual({
      kind: "match",
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not match another recipient, an old message, or another sender", () => {
    const foreign = matchListedRecipient(
      [
        message(
          "11111111-1111-4111-8111-111111111111",
          ["other@weeveo.resend.app"],
          `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          "2026-10-16T18:01:00.000Z",
        ),
      ],
      recipient,
      startedAt,
      nowMs,
    );
    expect(foreign.kind).toBe("none");
    const stale = matchListedRecipient(
      [
        message(
          "11111111-1111-4111-8111-111111111111",
          [recipient],
          `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          "2026-10-16T12:00:00.000Z",
        ),
      ],
      recipient,
      startedAt,
      nowMs,
    );
    expect(stale.kind).toBe("none");
    const sender = matchListedRecipient(
      [
        message(
          "11111111-1111-4111-8111-111111111111",
          [recipient],
          "person@example.net",
          "2026-10-16T18:01:00.000Z",
        ),
      ],
      recipient,
      startedAt,
      nowMs,
    );
    expect(sender.kind).toBe("sender_domain_mismatch");
  });

  it("rejects a verify link for another host or redirect", () => {
    expect(
      selectVerifyLink(`https://evil.example/auth/v1/verify?token=${token}`, {
        supabaseOrigin: supabase,
        siteOrigin: site,
        purpose: "confirmation",
      }),
    ).toBeNull();
    const wrongRedirect = new URL(verifyUrl());
    wrongRedirect.searchParams.set(
      "redirect_to",
      "https://evil.example/auth/callback",
    );
    expect(
      selectVerifyLink(wrongRedirect.toString(), {
        supabaseOrigin: supabase,
        siteOrigin: site,
        purpose: "confirmation",
      }),
    ).toBeNull();
    const implicit = `${verifyUrl()}#access_token=secret-token`;
    expect(
      selectVerifyLink(implicit, {
        supabaseOrigin: supabase,
        siteOrigin: site,
        purpose: "confirmation",
      }),
    ).toBeNull();
  });

  it("accepts one verify link when text and HTML repeat it, including amp entities", () => {
    const link = verifyUrl();
    const encoded = link.replaceAll("&", "&amp;");
    const numeric = link.replaceAll("&", "&#38;");
    const input = {
      supabaseOrigin: supabase,
      siteOrigin: site,
      purpose: "confirmation" as const,
    };
    const selected = selectVerifyLink(
      `${link}\n<p>${bodySecret}</p><a href="${encoded}">Confirm</a>`,
      input,
    );
    expect(selected?.href).toBe(new URL(link).href);
    expect(
      selectVerifyLink(`<a href="${numeric}">Confirm</a>`, input)?.href,
    ).toBe(new URL(link).href);
    const other = new URL(link);
    other.searchParams.set("token", "another-valid-token");
    expect(selectVerifyLink(`${link}\n${other.toString()}`, input)).toBeNull();
  });

  it("fetches only the matched body and does not return the token or body", async () => {
    const calls: { url: string; authorization: string }[] = [];
    const matched = "22222222-2222-4222-8222-222222222222";
    const foreign = "33333333-3333-4333-8333-333333333333";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push({
        url: url.toString(),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (url.pathname === "/emails/receiving") {
        return Response.json({
          has_more: false,
          data: [
            {
              id: foreign,
              to: ["other@weeveo.resend.app"],
              from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
              created_at: "2026-10-16T18:01:00.000Z",
            },
            {
              id: matched,
              to: [recipient],
              from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
              created_at: "2026-10-16T18:01:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === `/emails/receiving/${matched}`) {
        return Response.json({
          to: [recipient],
          from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          created_at: "2026-10-16T18:01:00.000Z",
          html: `<p>${bodySecret}</p><a href="${verifyUrl()}">Confirm</a><a href="https://evil.example/phish">no</a>`,
          text: "",
        });
      }
      if (url.origin === new URL(supabase).origin) {
        return new Response(null, {
          status: 303,
          headers: { location: `${site}/auth/callback?code=${code}` },
        });
      }
      return new Response("no", { status: 500 });
    };
    const result = await collectReceivedActions({
      fetchImpl,
      apiKey: "re_test_key",
      recipients: [{ label: "tenant-a", email: recipient }],
      purpose: "confirmation",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
      attempts: 1,
    });
    expect(result.status).toBe("ready");
    expect(result.actions).toEqual([
      { label: "tenant-a", path: "/auth/callback", code },
    ]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/emails/receiving",
      `/emails/receiving/${matched}`,
      "/auth/v1/verify",
    ]);
    expect(calls[0]?.authorization).toBe("Bearer re_test_key");
    expect(calls[1]?.authorization).toBe("Bearer re_test_key");
    expect(calls[2]?.authorization).toBe("");
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(bodySecret);
    expect(JSON.stringify(result)).not.toContain("re_test_key");
  });

  it("does not fetch a body when the key is absent or the sender does not match", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response(null, { status: 500 });
    };
    const absent = await collectReceivedActions({
      fetchImpl,
      apiKey: "",
      recipients: [{ label: "tenant-a", email: recipient }],
      purpose: "confirmation",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
      attempts: 1,
    });
    expect(absent.status).toBe("secret_absent");
    expect(called).toBe(false);
    const mismatch = await collectReceivedActions({
      fetchImpl: async () =>
        Response.json({
          has_more: false,
          data: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              to: [recipient],
              from: "person@example.net",
              created_at: "2026-10-16T18:01:00.000Z",
            },
          ],
        }),
      apiKey: "re_test_key",
      recipients: [{ label: "tenant-a", email: recipient }],
      purpose: "confirmation",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
      attempts: 1,
    });
    expect(mismatch.status).toBe("sender_domain_mismatch");
    expect(mismatch.actions).toEqual([]);
  });

  it("excludes the confirmation message when matching the later recovery mail", async () => {
    const confirmationId = "11111111-1111-4111-8111-111111111111";
    const recoveryId = "44444444-4444-4444-8444-444444444444";
    const recoveryStarted = "2026-10-16T18:02:00.000Z";
    const listed = {
      has_more: false,
      data: [
        {
          id: recoveryId,
          to: [recipient],
          from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          created_at: "2026-10-16T18:02:05.000Z",
        },
        {
          id: confirmationId,
          to: [recipient],
          from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          created_at: "2026-10-16T18:01:00.000Z",
        },
      ],
    };
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/emails/receiving") return Response.json(listed);
      if (url.pathname === `/emails/receiving/${recoveryId}`) {
        return Response.json({
          to: [recipient],
          from: `Auth <noreply@${ACCEPTANCE_SENDING_DOMAIN}>`,
          created_at: "2026-10-16T18:02:05.000Z",
          text: verifyUrl("recovery"),
          html: `<a href="${verifyUrl("recovery").replaceAll("&", "&amp;")}">Reset</a>`,
        });
      }
      if (url.origin === new URL(supabase).origin) {
        return new Response(null, {
          status: 303,
          headers: { location: `${site}/auth/recovery?code=${code}` },
        });
      }
      return new Response("no", { status: 500 });
    };
    const shared = {
      fetchImpl,
      apiKey: "re_test_key",
      recipients: [{ label: "tenant-a" as const, email: recipient }],
      purpose: "recovery" as const,
      startedAt: recoveryStarted,
      nowMs: Date.parse("2026-10-16T18:03:00.000Z"),
      supabaseOrigin: supabase,
      siteOrigin: site,
      attempts: 1,
    };
    const ambiguous = await collectReceivedActions(shared);
    expect(ambiguous.status).toBe("ambiguous");
    expect(paths).toEqual(["/emails/receiving"]);
    paths.length = 0;
    const matched = await collectReceivedActions({
      ...shared,
      excludeMessageIds: [confirmationId],
    });
    expect(matched.status).toBe("ready");
    expect(matched.messageIds).toEqual([recoveryId]);
    expect(matched.actions).toEqual([
      { label: "tenant-a", path: "/auth/recovery", code },
    ]);
    expect(paths).toEqual([
      "/emails/receiving",
      `/emails/receiving/${recoveryId}`,
      "/auth/v1/verify",
    ]);
    expect(JSON.stringify(matched)).not.toContain(token);
  });
});
