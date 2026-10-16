import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ACCEPT_JOB_NAME,
  ACCEPTANCE_ACTOR_ID,
  ACCEPTANCE_ACTOR_LOGIN,
  ACCEPTANCE_REPOSITORY,
  ACCEPTANCE_RUN_RESULT_BOUND,
  AUTHORIZE_JOB_NAME,
  PREFLIGHT_JOB_NAME,
  reviewAcceptanceComment,
  type AcceptanceCommentRequest,
  type AcceptanceJobSnapshot,
  type AcceptanceRunList,
  type AcceptanceRunSnapshot,
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
    runAttempt: "1",
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

function job(
  name: string,
  status: string,
  conclusion: string | null,
): AcceptanceJobSnapshot {
  return { name, status, conclusion };
}

function acceptanceRun(
  overrides: Partial<AcceptanceRunSnapshot> = {},
): AcceptanceRunSnapshot {
  return {
    id: "9",
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "issue_comment",
    actorId: ACCEPTANCE_ACTOR_ID,
    actorLogin: ACCEPTANCE_ACTOR_LOGIN,
    jobs: [job(AUTHORIZE_JOB_NAME, "completed", "success")],
    jobsComplete: true,
    ...overrides,
  };
}

function acceptance(
  runs: AcceptanceRunSnapshot[] = [
    acceptanceRun({
      id: "100",
      status: "in_progress",
      conclusion: null,
      jobs: [],
      jobsComplete: false,
    }),
  ],
): AcceptanceRunList {
  return { complete: true, runs };
}

function review(
  overrides: Partial<AcceptanceCommentRequest> = {},
  evidence: {
    pullRequest?: PullRequestSnapshot | null;
    delivery?: WorkflowRunList | null;
    acceptance?: AcceptanceRunList | null;
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

  it("counts an earlier authorized run and ignores noise", () => {
    expect(
      review(
        { runId: "200" },
        {
          acceptance: acceptance([
            acceptanceRun({
              id: "100",
              jobs: [
                job(AUTHORIZE_JOB_NAME, "completed", "success"),
                job(AUTHORIZE_JOB_NAME, "completed", "skipped"),
              ],
            }),
          ]),
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(
      review(
        { runId: "200" },
        {
          acceptance: acceptance([
            acceptanceRun({
              id: "100",
              event: "workflow_dispatch",
              actorId: null,
              actorLogin: null,
              jobs: [
                job(PREFLIGHT_JOB_NAME, "completed", "success"),
                job(PREFLIGHT_JOB_NAME, "completed", "skipped"),
                job(ACCEPT_JOB_NAME, "completed", "success"),
                job(ACCEPT_JOB_NAME, "completed", "skipped"),
              ],
            }),
          ]),
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              status: "in_progress",
              conclusion: null,
              jobs: [job(AUTHORIZE_JOB_NAME, "in_progress", null)],
            }),
          ]),
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              event: "workflow_dispatch",
              actorId: null,
              actorLogin: null,
              jobs: [job(PREFLIGHT_JOB_NAME, "completed", "success")],
            }),
          ]),
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate_request" });
    expect(review().ok).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              conclusion: "success",
              status: "completed",
              jobs: [
                job(AUTHORIZE_JOB_NAME, "completed", "skipped"),
                job(AUTHORIZE_JOB_NAME, "completed", "skipped"),
                job(PREFLIGHT_JOB_NAME, "completed", "skipped"),
                job(ACCEPT_JOB_NAME, "completed", "skipped"),
              ],
            }),
          ]),
        },
      ).ok,
    ).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              id: "90",
              actorId: "1",
              actorLogin: "someone",
              status: "queued",
              conclusion: null,
              jobs: [],
              jobsComplete: false,
            }),
          ]),
        },
      ).ok,
    ).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              id: "250",
              status: "pending",
              conclusion: null,
              jobs: [job(AUTHORIZE_JOB_NAME, "completed", "success")],
            }),
          ]),
        },
      ).ok,
    ).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              id: "80",
              status: "queued",
              conclusion: null,
              jobs: [],
              jobsComplete: true,
            }),
          ]),
        },
      ).ok,
    ).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({
              event: "workflow_dispatch",
              jobs: [
                job(PREFLIGHT_JOB_NAME, "completed", "failure"),
                job(ACCEPT_JOB_NAME, "completed", "skipped"),
              ],
            }),
          ]),
        },
      ).ok,
    ).toBe(true);
    expect(
      review(
        {},
        {
          acceptance: acceptance([
            acceptanceRun({ jobsComplete: false, jobs: [] }),
          ]),
        },
      ),
    ).toEqual({ ok: false, reason: "acceptance_evidence_unknown" });
    expect(review({ runAttempt: "2" })).toEqual({
      ok: false,
      reason: "rerun",
    });
    expect(review({}, { delivery: { complete: true, runs: [] } })).toEqual({
      ok: false,
      reason: "delivery_absent",
    });
    expect(review({}, { delivery: { complete: false, runs: [] } })).toEqual({
      ok: false,
      reason: "delivery_lookup_truncated",
    });
    expect(
      review(
        {},
        { acceptance: { complete: false, runs: [], totalCount: 1001 } },
      ),
    ).toEqual({ ok: false, reason: "acceptance_lookup_truncated" });
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
        if (url.includes("event=workflow_dispatch")) {
          return Response.json({ total_count: 0, workflow_runs: [] });
        }
        return Response.json({
          total_count: 1,
          workflow_runs: [
            {
              id: 100,
              head_sha: sha,
              event: "issue_comment",
              status: "in_progress",
              conclusion: null,
              actor: {
                id: Number(ACCEPTANCE_ACTOR_ID),
                login: ACCEPTANCE_ACTOR_LOGIN,
              },
            },
          ],
        });
      },
    });
    expect(decision).toEqual({ ok: true, candidate: sha });
    expect(JSON.stringify(decision)).not.toContain("ci-token");
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/pulls/8`,
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/deploy-development.yml/runs?head_sha=${sha}&per_page=100&page=1`,
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/accept-development.yml/runs?head_sha=${sha}&event=issue_comment&actor=${ACCEPTANCE_ACTOR_LOGIN}&per_page=100&page=1`,
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/accept-development.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100&page=1`,
    ]);
    expect(
      calls.every((call) => call.authorization === "Bearer ci-token"),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(calls.some((call) => call.url.includes(other))).toBe(false);
  });

  it("rejects a comment rerun before any lookup", async () => {
    const calls: string[] = [];
    const decision = await authorizeAcceptanceComment({
      env: env({ ACCEPTANCE_RUN_ATTEMPT: "2" }),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("nope", { status: 500 });
      },
    });
    expect(decision).toEqual({ ok: false, reason: "rerun" });
    expect(calls).toEqual([]);
  });

  it("pages past noise and still sees an earlier authorization", async () => {
    const calls: string[] = [];
    const decision = await authorizeAcceptanceComment({
      env: env({ ACCEPTANCE_RUN_ID: "500" }),
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/pulls/8")) return pullResponse();
        if (url.includes("/workflows/deploy-development.yml/")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [deliveryRun()],
          });
        }
        if (url.includes("event=workflow_dispatch")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [
              githubRun({
                id: 40,
                event: "workflow_dispatch",
                status: "completed",
                conclusion: "failure",
              }),
            ],
          });
        }
        if (url.includes("/jobs?")) {
          const runId = /\/runs\/(\d+)\/jobs/.exec(url)?.[1];
          if (runId === "40") {
            return Response.json({
              total_count: 2,
              jobs: [
                {
                  id: 1,
                  name: PREFLIGHT_JOB_NAME,
                  status: "completed",
                  conclusion: "failure",
                },
                {
                  id: 2,
                  name: ACCEPT_JOB_NAME,
                  status: "completed",
                  conclusion: "skipped",
                },
              ],
            });
          }
          if (runId === "120") {
            return Response.json({
              total_count: 1,
              jobs: [
                {
                  id: 3,
                  name: AUTHORIZE_JOB_NAME,
                  status: "completed",
                  conclusion: "success",
                },
              ],
            });
          }
          return Response.json({
            total_count: 1,
            jobs: [
              {
                id: 4,
                name: AUTHORIZE_JOB_NAME,
                status: "completed",
                conclusion: "skipped",
              },
            ],
          });
        }
        const page = /[?&]page=(\d+)/.exec(url)?.[1];
        if (page === "1") {
          return Response.json({
            total_count: 130,
            workflow_runs: Array.from({ length: 100 }, (_, index) =>
              githubRun({ id: index + 1 }),
            ),
          });
        }
        return Response.json({
          total_count: 130,
          workflow_runs: [
            ...Array.from({ length: 29 }, (_, index) =>
              githubRun({ id: index + 101 }),
            ),
            githubRun({ id: 900, status: "pending", conclusion: null }),
          ],
        });
      },
    });
    expect(decision).toEqual({ ok: false, reason: "duplicate_request" });
    expect(
      calls.some(
        (url) => url.includes("event=issue_comment") && url.includes("page=2"),
      ),
    ).toBe(true);
    expect(calls.some((url) => url.includes("/runs/120/jobs?"))).toBe(true);
    expect(calls.some((url) => url.includes("filter=all"))).toBe(true);
    expect(calls.some((url) => url.includes("/runs/900/jobs"))).toBe(false);
    expect(calls.some((url) => url.includes("actor=someone"))).toBe(false);
  });

  it("does not deny a candidate when only noise fills more than one page", async () => {
    const decision = await authorizeAcceptanceComment({
      env: env({ ACCEPTANCE_RUN_ID: "500" }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/pulls/8")) return pullResponse();
        if (url.includes("/workflows/deploy-development.yml/")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [deliveryRun()],
          });
        }
        if (url.includes("event=workflow_dispatch")) {
          return Response.json({ total_count: 0, workflow_runs: [] });
        }
        if (url.includes("/jobs?")) {
          return Response.json({
            total_count: 3,
            jobs: [
              {
                id: 1,
                name: AUTHORIZE_JOB_NAME,
                status: "completed",
                conclusion: "skipped",
              },
              {
                id: 2,
                name: PREFLIGHT_JOB_NAME,
                status: "completed",
                conclusion: "skipped",
              },
              {
                id: 3,
                name: ACCEPT_JOB_NAME,
                status: "completed",
                conclusion: "skipped",
              },
            ],
          });
        }
        const page = /[?&]page=(\d+)/.exec(url)?.[1];
        const start = page === "2" ? 101 : 1;
        const length = page === "2" ? 20 : 100;
        return Response.json({
          total_count: 120,
          workflow_runs: Array.from({ length }, (_, index) =>
            githubRun({
              id: start + index,
              status: "completed",
              conclusion: "success",
            }),
          ),
        });
      },
    });
    expect(decision).toEqual({ ok: true, candidate: sha });
  });

  it("fails closed when the documented run search bound is exceeded", async () => {
    const decision = await authorizeAcceptanceComment({
      env: env({}),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/pulls/8")) return pullResponse();
        if (url.includes("/workflows/deploy-development.yml/")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [deliveryRun()],
          });
        }
        return Response.json({
          total_count: ACCEPTANCE_RUN_RESULT_BOUND + 1,
          workflow_runs: [githubRun({ id: 1 })],
        });
      },
    });
    expect(decision).toEqual({
      ok: false,
      reason: "acceptance_lookup_truncated",
      detail: `bound=${ACCEPTANCE_RUN_RESULT_BOUND} total=${ACCEPTANCE_RUN_RESULT_BOUND + 1}`,
    });
  });

  it("keeps an earlier attempt when a later attempt is skipped", async () => {
    const calls: string[] = [];
    const decision = await authorizeAcceptanceComment({
      env: env({ ACCEPTANCE_RUN_ID: "200" }),
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/pulls/8")) return pullResponse();
        if (url.includes("/workflows/deploy-development.yml/")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [deliveryRun()],
          });
        }
        if (url.includes("event=workflow_dispatch")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [
              githubRun({
                id: 50,
                event: "workflow_dispatch",
                status: "completed",
                conclusion: "success",
              }),
            ],
          });
        }
        if (url.includes("event=issue_comment")) {
          return Response.json({
            total_count: 1,
            workflow_runs: [
              githubRun({
                id: 100,
                status: "completed",
                conclusion: "success",
              }),
            ],
          });
        }
        const runId = /\/runs\/(\d+)\/jobs/.exec(url)?.[1];
        const page = /[?&]page=(\d+)/.exec(url)?.[1];
        if (runId === "100" && page === "1") {
          return Response.json({
            total_count: 101,
            jobs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              name: "Clean acceptance Auth resources",
              status: "completed",
              conclusion: "skipped",
            })),
          });
        }
        if (runId === "100") {
          return Response.json({
            total_count: 101,
            jobs: [
              {
                id: 101,
                name: AUTHORIZE_JOB_NAME,
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        }
        return Response.json({
          total_count: 4,
          jobs: [
            {
              id: 201,
              name: PREFLIGHT_JOB_NAME,
              status: "completed",
              conclusion: "success",
            },
            {
              id: 202,
              name: PREFLIGHT_JOB_NAME,
              status: "completed",
              conclusion: "skipped",
            },
            {
              id: 203,
              name: ACCEPT_JOB_NAME,
              status: "completed",
              conclusion: "success",
            },
            {
              id: 204,
              name: ACCEPT_JOB_NAME,
              status: "completed",
              conclusion: "skipped",
            },
          ],
        });
      },
    });
    expect(decision).toEqual({ ok: false, reason: "duplicate_request" });
    expect(calls).toContain(
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/runs/100/jobs?filter=all&per_page=100&page=1`,
    );
    expect(calls).toContain(
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/runs/100/jobs?filter=all&per_page=100&page=2`,
    );
    expect(calls).toContain(
      `https://api.github.com/repos/${ACCEPTANCE_REPOSITORY}/actions/runs/50/jobs?filter=all&per_page=100&page=1`,
    );
    expect(
      calls.some(
        (url) => url.includes("/jobs?") && !url.includes("filter=all"),
      ),
    ).toBe(false);
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
    expect(
      execFileSync("node", ["scripts/assert-acceptance-attempt.mjs"], {
        env: {
          ...process.env,
          ACCEPTANCE_EVENT_NAME: "issue_comment",
          ACCEPTANCE_RUN_ATTEMPT: "1",
        },
      }).toString(),
    ).toBe("");
    expect(
      execFileSync("node", ["scripts/assert-acceptance-attempt.mjs"], {
        env: {
          ...process.env,
          ACCEPTANCE_EVENT_NAME: "workflow_dispatch",
          ACCEPTANCE_RUN_ATTEMPT: "2",
        },
      }).toString(),
    ).toBe("");
    expect(() =>
      execFileSync("node", ["scripts/assert-acceptance-attempt.mjs"], {
        env: {
          ...process.env,
          ACCEPTANCE_EVENT_NAME: "issue_comment",
          ACCEPTANCE_RUN_ATTEMPT: "2",
        },
      }),
    ).toThrow(/rerun/);
  });
});

function pullResponse(): Response {
  return Response.json({
    number: 8,
    merged: true,
    merge_commit_sha: sha,
    base: { ref: "main", repo: { full_name: ACCEPTANCE_REPOSITORY } },
    head: { sha: other, ref: "feature" },
  });
}

function deliveryRun(): Record<string, unknown> {
  return {
    id: 7,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
}

function githubRun(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    head_sha: sha,
    event: "issue_comment",
    status: "completed",
    conclusion: "skipped",
    actor: { id: Number(ACCEPTANCE_ACTOR_ID), login: ACCEPTANCE_ACTOR_LOGIN },
    ...overrides,
  };
}

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
    ACCEPTANCE_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "ci-token",
    ...overrides,
  };
}
