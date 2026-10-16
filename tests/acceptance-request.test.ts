import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_ACTOR_ID,
  ACCEPTANCE_ACTOR_LOGIN,
  ACCEPTANCE_REPOSITORY,
  reviewAcceptanceComment,
  type AcceptanceCommentRequest,
  type PullRequestSnapshot,
  type WorkflowRunList,
} from "@/server/application/acceptance-request";
import { authorizeAcceptanceComment } from "../scripts/hosted-acceptance-authorize.ts";

const sha = "a".repeat(40);
const other = "b".repeat(40);

function request(
  overrides: Partial<AcceptanceCommentRequest> = {},
): AcceptanceCommentRequest {
  return {
    eventName: "issue_comment",
    eventAction: "created",
    repository: ACCEPTANCE_REPOSITORY,
    actorId: ACCEPTANCE_ACTOR_ID,
    actorLogin: ACCEPTANCE_ACTOR_LOGIN,
    commentBody: `/tutor-mbos accept-development ${sha}`,
    githubSha: sha,
    issueNumber: "8",
    pullRequestPresent: true,
    commentId: "42",
    runId: "100",
    ...overrides,
  };
}

function pull(
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    number: "8",
    merged: true,
    baseRef: "main",
    baseRepository: ACCEPTANCE_REPOSITORY,
    mergeCommitSha: sha,
    ...overrides,
  };
}

function delivery(): WorkflowRunList {
  return {
    complete: true,
    runs: [
      {
        id: "7",
        headSha: sha,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
}

function acceptance(): WorkflowRunList {
  return {
    complete: true,
    runs: [
      {
        id: "100",
        headSha: sha,
        status: "in_progress",
        conclusion: null,
      },
    ],
  };
}

function review(
  overrides: Partial<AcceptanceCommentRequest> = {},
  evidence: {
    pullRequest?: PullRequestSnapshot | null;
    delivery?: WorkflowRunList | null;
    acceptance?: WorkflowRunList | null;
  } = {},
) {
  return reviewAcceptanceComment({
    request: request(overrides),
    pullRequest:
      evidence.pullRequest === undefined ? pull() : evidence.pullRequest,
    delivery: evidence.delivery === undefined ? delivery() : evidence.delivery,
    acceptance:
      evidence.acceptance === undefined ? acceptance() : evidence.acceptance,
  });
}

describe("acceptance comment authorization", () => {
  it("accepts the exact command for the merged main head after delivery", () => {
    expect(review().ok).toBe(true);
    expect(
      review({ commentBody: `/tutor-mbos accept-development ${sha}\n` }),
    ).toEqual({
      ok: true,
      candidate: sha,
    });
  });

  it("rejects the wrong actor, repository, and non-command events", () => {
    expect(review({ actorId: "1" })).toEqual({ ok: false, reason: "actor" });
    expect(review({ actorLogin: "someone" })).toEqual({
      ok: false,
      reason: "actor",
    });
    expect(review({ repository: "other/tutor-mbos" })).toEqual({
      ok: false,
      reason: "repository",
    });
    expect(review({ eventAction: "edited" })).toEqual({
      ok: false,
      reason: "event",
    });
    expect(review({ eventName: "push", eventAction: "" })).toEqual({
      ok: false,
      reason: "event",
    });
    expect(review({ eventName: "workflow_dispatch", eventAction: "" })).toEqual(
      {
        ok: false,
        reason: "event",
      },
    );
    expect(
      review({ pullRequestPresent: false }, { pullRequest: null }),
    ).toEqual({
      ok: false,
      reason: "not_pull_request",
    });
  });

  it("rejects an unmerged pull request and a stale or foreign sha", () => {
    expect(review({}, { pullRequest: pull({ merged: false }) })).toEqual({
      ok: false,
      reason: "pull_request_unmerged",
    });
    expect(review({ githubSha: other })).toEqual({
      ok: false,
      reason: "candidate_not_head",
    });
    expect(
      review({}, { pullRequest: pull({ mergeCommitSha: other }) }),
    ).toEqual({ ok: false, reason: "candidate_not_merge" });
    expect(
      review({}, { pullRequest: pull({ baseRepository: "other/tutor-mbos" }) }),
    ).toEqual({ ok: false, reason: "pull_request_base" });
  });

  it("rejects malformed and shell-looking comments before any lookup", async () => {
    const bodies = [
      `/tutor-mbos accept-development ${sha}; rm -rf .`,
      `/tutor-mbos accept-development $(echo ${sha})`,
      `/tutor-mbos accept-development \`${sha}\``,
      `/tutor-mbos accept-development ${sha}\nls`,
      `please /tutor-mbos accept-development ${sha}`,
      `/tutor-mbos accept-development ${sha.toUpperCase()}`,
      `/tutor-mbos accept-development ${sha} `,
    ];
    for (const commentBody of bodies) {
      const reviewed = review({ commentBody });
      expect(reviewed.ok).toBe(false);
      if (!reviewed.ok) expect(reviewed.reason).toBe("command");
      const calls: string[] = [];
      const decision = await authorizeAcceptanceComment({
        env: env({ ACCEPTANCE_COMMENT_BODY: commentBody }),
        fetchImpl: async (input) => {
          calls.push(String(input));
          return new Response("nope", { status: 500 });
        },
      });
      expect(decision).toEqual({ ok: false, reason: "command" });
      expect(calls).toEqual([]);
    }
  });

  it("rejects a duplicate or active acceptance run and allows the current run", () => {
    expect(
      review(
        {},
        {
          acceptance: {
            complete: true,
            runs: [
              {
                id: "9",
                headSha: sha,
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(
      review(
        {},
        {
          acceptance: {
            complete: true,
            runs: [
              {
                id: "9",
                headSha: sha,
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(review().ok).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: {
            complete: true,
            runs: [
              {
                id: "9",
                headSha: sha,
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
        },
      ).ok,
    ).toBe(true);
    expect(review({}, { delivery: { complete: true, runs: [] } })).toEqual({
      ok: false,
      reason: "delivery_absent",
    });
    expect(review({}, { delivery: { complete: false, runs: [] } })).toEqual({
      ok: false,
      reason: "delivery_lookup_truncated",
    });
  });

  it("fetches only this repository and ignores an event-supplied url", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const decision = await authorizeAcceptanceComment({
      env: env({
        ACCEPTANCE_PULL_REQUEST_URL:
          "https://evil.example/repos/evil/evil/pulls/8",
        GITHUB_TOKEN: "ci-token",
      }),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, authorization: headers.get("authorization") });
        if (url.endsWith("/pulls/8")) {
          return Response.json({
            number: 8,
            merged: true,
            merge_commit_sha: sha,
            base: { ref: "main", repo: { full_name: ACCEPTANCE_REPOSITORY } },
            head: { sha: other, ref: "feature" },
          });
        }
        if (url.includes("/workflows/deploy-development.yml/")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [
              {
                id: 7,
                head_sha: sha,
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        }
        return Response.json({
          total_count: 1,
          workflow_runs: [
            {
              id: 100,
              head_sha: sha,
              status: "in_progress",
              conclusion: null,
            },
          ],
        });
      },
    });
    expect(decision).toEqual({ ok: true, candidate: sha });
    expect(JSON.stringify(decision)).not.toContain("ci-token");
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/pulls/8`,
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/deploy-development.yml/runs?head_sha=${sha}&per_page=100`,
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/accept-development.yml/runs?head_sha=${sha}&per_page=100`,
    ]);
    expect(
      calls.every((call) => call.authorization === "Bearer ci-token"),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(calls.some((call) => call.url.includes(other))).toBe(false);
  });

  it("checks the authorized candidate without executing it", () => {
    expect(
      execFileSync("node", ["scripts/assert-acceptance-candidate.mjs"], {
        env: { ...process.env, ACCEPTANCE_CANDIDATE: sha, GITHUB_SHA: sha },
      }).toString(),
    ).toBe("");
    expect(() =>
      execFileSync("node", ["scripts/assert-acceptance-candidate.mjs"], {
        env: {
          ...process.env,
          ACCEPTANCE_CANDIDATE: `$(id)${sha}`,
          GITHUB_SHA: sha,
        },
      }),
    ).toThrow(/candidate_not_head/);
  });
});

function env(
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ACCEPTANCE_EVENT_NAME: "issue_comment",
    ACCEPTANCE_EVENT_ACTION: "created",
    ACCEPTANCE_REPOSITORY: ACCEPTANCE_REPOSITORY,
    ACCEPTANCE_ACTOR_ID: ACCEPTANCE_ACTOR_ID,
    ACCEPTANCE_ACTOR_LOGIN: ACCEPTANCE_ACTOR_LOGIN,
    ACCEPTANCE_COMMENT_BODY: `/tutor-mbos accept-development ${sha}`,
    ACCEPTANCE_COMMENT_ID: "42",
    ACCEPTANCE_ISSUE_NUMBER: "8",
    ACCEPTANCE_PULL_REQUEST_URL:
      "https://api.github.com/repos/bhaveshbusa/tutor-mbos/pulls/8",
    ACCEPTANCE_GITHUB_SHA: sha,
    ACCEPTANCE_RUN_ID: "100",
    GITHUB_TOKEN: "ci-token",
    ...overrides,
  };
}
