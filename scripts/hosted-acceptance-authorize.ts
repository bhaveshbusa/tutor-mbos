/**
 * Comment gate for development acceptance. It reads the event from the
 * environment and calls the fixed GitHub API for this repository. It does
 * not interpolate the comment into a shell command, a checkout ref, or a
 * request URL.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ACCEPT_WORKFLOW_FILE,
  ACCEPTANCE_REPOSITORY,
  DEPLOY_WORKFLOW_FILE,
  reviewAcceptanceComment,
  type AcceptanceCommentRequest,
  type AcceptanceRequestReason,
  type PullRequestSnapshot,
  type WorkflowRunList,
  type WorkflowRunSnapshot,
} from "../src/server/application/acceptance-request.ts";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1_000_000;

const SCRIPT_REASONS = new Set<string>([
  "token_absent",
  "pull_request_lookup",
  "delivery_lookup",
  "acceptance_lookup",
]);

const REASONS = new Set<AcceptanceRequestReason>([
  "event",
  "repository",
  "actor",
  "command",
  "comment_id",
  "run_id",
  "issue_number",
  "not_pull_request",
  "candidate_not_head",
  "pull_request_unmerged",
  "pull_request_base",
  "pull_request_number",
  "candidate_not_merge",
  "delivery_lookup_truncated",
  "delivery_absent",
  "acceptance_lookup_truncated",
  "duplicate_request",
]);

export async function authorizeAcceptanceComment(input: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; candidate: string } | { ok: false; reason: string }> {
  const request = requestFromEnv(input.env);
  const local = reviewAcceptanceComment({
    request,
    pullRequest: request.pullRequestPresent ? placeholderPull(request) : null,
    delivery: { complete: true, runs: delivered(request.githubSha) },
    acceptance: { complete: true, runs: [] },
  });
  if (!local.ok) return { ok: false, reason: safeReason(local.reason) };
  const token = input.env.GITHUB_TOKEN ?? "";
  if (!token) return { ok: false, reason: "token_absent" };
  const fetchImpl = input.fetchImpl ?? fetch;
  const pull = await getPull(fetchImpl, token, request.issueNumber);
  if (!pull.ok) return { ok: false, reason: "pull_request_lookup" };
  const delivery = await getRuns(
    fetchImpl,
    token,
    DEPLOY_WORKFLOW_FILE,
    local.candidate,
  );
  if (!delivery.ok) return { ok: false, reason: "delivery_lookup" };
  const acceptance = await getRuns(
    fetchImpl,
    token,
    ACCEPT_WORKFLOW_FILE,
    local.candidate,
  );
  if (!acceptance.ok) return { ok: false, reason: "acceptance_lookup" };
  const decision = reviewAcceptanceComment({
    request,
    pullRequest: pull.pullRequest,
    delivery: delivery.list,
    acceptance: acceptance.list,
  });
  if (!decision.ok) return { ok: false, reason: safeReason(decision.reason) };
  return decision;
}

function requestFromEnv(
  env: Record<string, string | undefined>,
): AcceptanceCommentRequest {
  return {
    eventName: env.ACCEPTANCE_EVENT_NAME ?? "",
    eventAction: env.ACCEPTANCE_EVENT_ACTION ?? "",
    repository: env.ACCEPTANCE_REPOSITORY ?? "",
    actorId: env.ACCEPTANCE_ACTOR_ID ?? "",
    actorLogin: env.ACCEPTANCE_ACTOR_LOGIN ?? "",
    commentBody: env.ACCEPTANCE_COMMENT_BODY ?? "",
    githubSha: env.ACCEPTANCE_GITHUB_SHA ?? "",
    issueNumber: env.ACCEPTANCE_ISSUE_NUMBER ?? "",
    pullRequestPresent: Boolean(env.ACCEPTANCE_PULL_REQUEST_URL),
    commentId: env.ACCEPTANCE_COMMENT_ID ?? "",
    runId: env.ACCEPTANCE_RUN_ID ?? "",
  };
}

function placeholderPull(
  request: AcceptanceCommentRequest,
): PullRequestSnapshot {
  return {
    number: request.issueNumber,
    merged: true,
    baseRef: "main",
    baseRepository: ACCEPTANCE_REPOSITORY,
    mergeCommitSha: request.githubSha,
  };
}

function delivered(headSha: string): WorkflowRunSnapshot[] {
  return [
    {
      id: "0",
      headSha,
      status: "completed",
      conclusion: "success",
    },
  ];
}

async function getPull(
  fetchImpl: typeof fetch,
  token: string,
  issueNumber: string,
): Promise<
  { ok: true; pullRequest: PullRequestSnapshot | null } | { ok: false }
> {
  if (!/^[0-9]+$/.test(issueNumber)) return { ok: false };
  const loaded = await getJson(
    fetchImpl,
    token,
    `${API_BASE}/repos/${ACCEPTANCE_REPOSITORY}/pulls/${issueNumber}`,
  );
  if (!loaded.ok) return { ok: false };
  if (loaded.status === 404) return { ok: true, pullRequest: null };
  if (loaded.status !== 200) return { ok: false };
  const pullRequest = parsePull(loaded.body);
  if (!pullRequest) return { ok: false };
  return { ok: true, pullRequest };
}

async function getRuns(
  fetchImpl: typeof fetch,
  token: string,
  workflow: string,
  headSha: string,
): Promise<{ ok: true; list: WorkflowRunList } | { ok: false }> {
  if (
    !/^[0-9a-f]{40}$/.test(headSha) ||
    (workflow !== DEPLOY_WORKFLOW_FILE && workflow !== ACCEPT_WORKFLOW_FILE)
  ) {
    return { ok: false };
  }
  const query = new URLSearchParams({ head_sha: headSha, per_page: "100" });
  const loaded = await getJson(
    fetchImpl,
    token,
    `${API_BASE}/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/${workflow}/runs?${query}`,
  );
  if (!loaded.ok || loaded.status !== 200) return { ok: false };
  const list = parseRuns(loaded.body);
  if (!list) return { ok: false };
  return { ok: true, list };
}

async function getJson(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== "api.github.com") {
    return { ok: false };
  }
  if (!parsed.pathname.startsWith(`/repos/${ACCEPTANCE_REPOSITORY}/`)) {
    return { ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "tutor-mbos-acceptance-authorize",
        "x-github-api-version": "2022-11-28",
      },
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES)
      return { ok: false };
    try {
      return {
        ok: true,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    } catch {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function parsePull(body: unknown): PullRequestSnapshot | null {
  const record = asRecord(body);
  const base = asRecord(record?.base);
  const repo = asRecord(base?.repo);
  if (!record || typeof record.number !== "number") return null;
  if (typeof base?.ref !== "string" || typeof repo?.full_name !== "string") {
    return null;
  }
  const mergeCommitSha = record.merge_commit_sha;
  if (mergeCommitSha !== null && typeof mergeCommitSha !== "string")
    return null;
  return {
    number: String(record.number),
    merged: record.merged === true,
    baseRef: base.ref,
    baseRepository: repo.full_name,
    mergeCommitSha,
  };
}

function parseRuns(body: unknown): WorkflowRunList | null {
  const record = asRecord(body);
  if (!record || typeof record.total_count !== "number") return null;
  if (!Array.isArray(record.workflow_runs)) return null;
  const runs: WorkflowRunSnapshot[] = [];
  for (const entry of record.workflow_runs) {
    const run = asRecord(entry);
    if (
      !run ||
      typeof run.id !== "number" ||
      typeof run.head_sha !== "string"
    ) {
      return null;
    }
    if (typeof run.status !== "string") return null;
    if (run.conclusion !== null && typeof run.conclusion !== "string")
      return null;
    runs.push({
      id: String(run.id),
      headSha: run.head_sha,
      status: run.status,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    });
  }
  return { complete: record.total_count <= runs.length, runs };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeReason(reason: string): string {
  return REASONS.has(reason as AcceptanceRequestReason) ||
    SCRIPT_REASONS.has(reason)
    ? reason
    : "rejected";
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output || value.includes("\n") || value.includes("\r")) return;
  appendFileSync(output, `${name}=${value}\n`);
}

async function main(): Promise<number> {
  const decision = await authorizeAcceptanceComment({ env: process.env });
  if (!decision.ok) {
    console.error(`::error::${safeReason(decision.reason)}`);
    return 1;
  }
  writeOutput("candidate", decision.candidate);
  console.log(
    `acceptance_request=authorized candidate=${decision.candidate} comment=${process.env.ACCEPTANCE_COMMENT_ID ?? ""} actor=${process.env.ACCEPTANCE_ACTOR_ID ?? ""} pull_request=${process.env.ACCEPTANCE_ISSUE_NUMBER ?? ""}`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
