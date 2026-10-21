import { describe, expect, it } from "vitest";
import {
  RECEIVING_API_ORIGIN,
  RECEIVING_DOMAIN,
  SENDING_DOMAIN,
  matchListedRecipient,
  readReceivedVerifyLink,
  selectVerifyLink,
} from "@/server/application/receiving-mail";

const startedAt = "2026-10-22T00:00:00.000Z";
const nowMs = Date.parse("2026-10-22T00:01:00.000Z");
const recipient = `tos29-1-a@${RECEIVING_DOMAIN}`;
const site = "https://tutor-mbos-dev-lets-play-game.vercel.app";
const supabase = "https://idvzjqrkgnihvxoswuxu.supabase.co";
const messageId = "11111111-1111-4111-8111-111111111111";

function listed(overrides: Record<string, unknown> = {}) {
  return {
    id: messageId,
    to: [recipient],
    from: `Tutor MBOS <no-reply@${SENDING_DOMAIN}>`,
    created_at: "2026-10-22T00:00:30.000Z",
    ...overrides,
  };
}

function verifyUrl(type: "signup" | "recovery"): string {
  const redirect =
    type === "signup" ? `${site}/auth/callback` : `${site}/auth/recovery`;
  return `${supabase}/auth/v1/verify?token=abc&type=${type}&redirect_to=${encodeURIComponent(redirect)}`;
}

describe("receiving mail", () => {
  it("matches one message for the recipient inside the window", () => {
    const match = matchListedRecipient(
      [
        {
          id: messageId,
          to: [recipient],
          from: `no-reply@${SENDING_DOMAIN}`,
          createdAt: "2026-10-22T00:00:30.000Z",
        },
      ],
      recipient,
      startedAt,
      nowMs,
    );
    expect(match).toEqual({ kind: "match", id: messageId });
  });

  it("rejects another recipient, a foreign sender, and two matches", () => {
    const message = {
      id: messageId,
      to: [`other@${RECEIVING_DOMAIN}`],
      from: `no-reply@${SENDING_DOMAIN}`,
      createdAt: "2026-10-22T00:00:30.000Z",
    };
    expect(
      matchListedRecipient([message], recipient, startedAt, nowMs).kind,
    ).toBe("none");
    expect(
      matchListedRecipient(
        [{ ...message, to: [recipient], from: "no-reply@example.com" }],
        recipient,
        startedAt,
        nowMs,
      ).kind,
    ).toBe("sender_domain_mismatch");
    expect(
      matchListedRecipient(
        [
          message,
          {
            id: "22222222-2222-4222-8222-222222222222",
            to: [recipient],
            from: `no-reply@${SENDING_DOMAIN}`,
            createdAt: "2026-10-22T00:00:40.000Z",
          },
          {
            id: messageId,
            to: [recipient],
            from: `no-reply@${SENDING_DOMAIN}`,
            createdAt: "2026-10-22T00:00:30.000Z",
          },
        ],
        recipient,
        startedAt,
        nowMs,
      ).kind,
    ).toBe("ambiguous");
  });

  it("accepts one signup verify link and rejects a token in the clear", () => {
    const link = selectVerifyLink(`Open ${verifyUrl("signup")}`, {
      supabaseOrigin: supabase,
      siteOrigin: site,
      purpose: "confirmation",
    });
    expect(link?.pathname).toBe("/auth/v1/verify");
    expect(link?.searchParams.get("type")).toBe("signup");
    expect(
      selectVerifyLink(`${verifyUrl("signup")}&access_token=hidden`, {
        supabaseOrigin: supabase,
        siteOrigin: site,
        purpose: "confirmation",
      }),
    ).toBeNull();
    expect(
      selectVerifyLink(verifyUrl("signup"), {
        supabaseOrigin: supabase,
        siteOrigin: site,
        purpose: "recovery",
      }),
    ).toBeNull();
  });

  it("reads the body only after the list matches, and does not return the body", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: URL) => {
      calls.push(input.pathname);
      if (input.pathname === "/emails/receiving") {
        return new Response(
          JSON.stringify({ data: [listed()], has_more: false }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ...listed(),
          html: `Confirm ${verifyUrl("signup")}`,
          text: "",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await readReceivedVerifyLink({
      fetchImpl,
      apiKey: "re_test",
      recipient,
      purpose: "confirmation",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
    });
    expect(calls).toEqual([
      "/emails/receiving",
      `/emails/receiving/${messageId}`,
    ]);
    expect(result.status).toBe("ready");
    expect(result.verifyUrl?.origin).toBe(supabase);
    expect(JSON.stringify(result)).not.toContain("Confirm");
    expect(RECEIVING_API_ORIGIN).toBe("https://api.resend.com");
  });

  it("waits before reading the list again", async () => {
    let lists = 0;
    const started = Date.now();
    const fetchImpl = (async (input: URL) => {
      if (input.pathname === "/emails/receiving") {
        lists += 1;
        const data = lists === 1 ? [] : [listed()];
        return new Response(JSON.stringify({ data, has_more: false }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ ...listed(), html: verifyUrl("signup"), text: "" }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await readReceivedVerifyLink({
      fetchImpl,
      apiKey: "re_test",
      recipient,
      purpose: "confirmation",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
      attempts: 2,
      delayMs: 50,
    });
    expect(result.status).toBe("ready");
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("does not call Resend when the key is absent", async () => {
    let called = false;
    const result = await readReceivedVerifyLink({
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(new Response(""));
      }) as typeof fetch,
      apiKey: "",
      recipient,
      purpose: "recovery",
      startedAt,
      nowMs,
      supabaseOrigin: supabase,
      siteOrigin: site,
    });
    expect(result.status).toBe("secret_absent");
    expect(called).toBe(false);
  });
});
