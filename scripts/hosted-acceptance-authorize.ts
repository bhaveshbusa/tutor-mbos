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
  ACCEPTANCE_ACTOR_ID,
  ACCEPTANCE_ACTOR_LOGIN,
  ACCEPTANCE_REPOSITORY,
  ACCEPTANCE_RUN_PAGE_SIZE,
  ACCEPTANCE_RUN_RESULT_BOUND,
  DEPLOY_WORKFLOW_FILE,
  reviewAcceptanceComment,
  type AcceptanceCommentRequest,
  type AcceptanceJobSnapshot,
  type AcceptanceRequestReason,
  type AcceptanceRunList,
  type AcceptanceRunSnapshot,
  type PullRequestSnapshot,
  type WorkflowRunList,
  type WorkflowRunSnapshot,
} from "../src/server/application/acceptance-request.ts";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1_000_000;
const JOB_FETCH_LIMIT = 8;

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
  "run_attempt",
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
  "acceptance_evidence_unknown",
  "duplicate_request",
  "rerun",
]);

export async function authorizeAcceptanceComment(input: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; candidate: string }
  | { ok: false; reason: string; detail?: string }
> {
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
  const delivery = await getDeliveryRuns(fetchImpl, token, local.candidate);
  if (!delivery.ok) return { ok: false, reason: "delivery_lookup" };
  if (!delivery.list.complete) {
    return {
      ok: false,
      reason: "delivery_lookup_truncated",
      detail: boundDetail(delivery.list.totalCount),
    };
  }
  const acceptance = await getAcceptanceRuns(
    fetchImpl,
    token,
    local.candidate,
    request.runId,
  );
  if (!acceptance.ok) return { ok: false, reason: "acceptance_lookup" };
  if (!acceptance.list.complete) {
    return {
      ok: false,
      reason: "acceptance_lookup_truncated",
      detail: boundDetail(acceptance.list.totalCount),
    };
  }
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
    runAttempt: env.ACCEPTANCE_RUN_ATTEMPT ?? "",
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

function boundDetail(totalCount: number | undefined): string | undefined {
  return typeof totalCount === "number"
    ? `bound=${ACCEPTANCE_RUN_RESULT_BOUND} total=${totalCount}`
    : `bound=${ACCEPTANCE_RUN_RESULT_BOUND}`;
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

async function getDeliveryRuns(
  fetchImpl: typeof fetch,
  token: string,
  headSha: string,
): Promise<{ ok: true; list: WorkflowRunList } | { ok: false }> {
  return listRuns(fetchImpl, token, {
    workflow: DEPLOY_WORKFLOW_FILE,
    headSha,
    parse: parseDeliveryPage,
  });
}

async function getAcceptanceRuns(
  fetchImpl: typeof fetch,
  token: string,
  headSha: string,
  currentRunId: string,
): Promise<{ ok: true; list: AcceptanceRunList } | { ok: false }> {
  const comments = await listRuns(fetchImpl, token, {
    workflow: ACCEPT_WORKFLOW_FILE,
    headSha,
    event: "issue_comment",
    actor: ACCEPTANCE_ACTOR_LOGIN,
    parse: parseAcceptancePage,
  });
  if (!comments.ok) return { ok: false };
  const dispatches = await listRuns(fetchImpl, token, {
    workflow: ACCEPT_WORKFLOW_FILE,
    headSha,
    event: "workflow_dispatch",
    parse: parseAcceptancePage,
  });
  if (!dispatches.ok) return { ok: false };
  const runs = [...comments.list.runs, ...dispatches.list.runs];
  const totalCount =
    (comments.list.totalCount ?? 0) + (dispatches.list.totalCount ?? 0);
  if (!comments.list.complete || !dispatches.list.complete) {
    const totals = [comments.list, dispatches.list]
      .filter((list) => !list.complete)
      .map((list) => list.totalCount ?? 0);
    return {
      ok: true,
      list: {
        complete: false,
        runs: [],
        totalCount: totals.length > 0 ? Math.max(...totals) : undefined,
      },
    };
  }
  const evidence = runs.filter((run) =>
    needsJobEvidence(run, currentRunId, headSha),
  );
  const loaded = await mapPool(evidence, JOB_FETCH_LIMIT, (run) =>
    getJobs(fetchImpl, token, run.id),
  );
  const jobsById = new Map<string, AcceptanceJobSnapshot[]>();
  for (const entry of loaded) {
    if (!entry.ok) return { ok: false };
    jobsById.set(entry.runId, entry.jobs);
  }
  return {
    ok: true,
    list: {
      complete: true,
      totalCount,
      runs: runs.map((run) => {
        const jobs = jobsById.get(run.id);
        return jobs ? { ...run, jobs, jobsComplete: true } : run;
      }),
    },
  };
}

function needsJobEvidence(
  run: AcceptanceRunSnapshot,
  currentRunId: string,
  candidate: string,
): boolean {
  if (run.headSha !== candidate) return false;
  if (!/^[0-9]+$/.test(run.id) || !/^[0-9]+$/.test(currentRunId)) return false;
  if (BigInt(run.id) >= BigInt(currentRunId)) return false;
  if (run.event === "workflow_dispatch") return true;
  return (
    run.event === "issue_comment" &&
    run.actorId === ACCEPTANCE_ACTOR_ID &&
    run.actorLogin === ACCEPTANCE_ACTOR_LOGIN
  );
}

async function listRuns<T extends WorkflowRunSnapshot>(
  fetchImpl: typeof fetch,
  token: string,
  input: {
    workflow: string;
    headSha: string;
    event?: string;
    actor?: string;
    parse: (body: unknown) => { totalCount: number; runs: T[] } | null;
  },
): Promise<
  | { ok: true; list: { complete: boolean; runs: T[]; totalCount?: number } }
  | { ok: false }
> {
  if (
    !/^[0-9a-f]{40}$/.test(input.headSha) ||
    (input.workflow !== DEPLOY_WORKFLOW_FILE &&
      input.workflow !== ACCEPT_WORKFLOW_FILE)
  ) {
    return { ok: false };
  }
  if (
    input.event !== undefined &&
    input.event !== "issue_comment" &&
    input.event !== "workflow_dispatch"
  ) {
    return { ok: false };
  }
  if (input.actor !== undefined && input.actor !== ACCEPTANCE_ACTOR_LOGIN) {
    return { ok: false };
  }
  const runs: T[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  const pageCount = ACCEPTANCE_RUN_RESULT_BOUND / ACCEPTANCE_RUN_PAGE_SIZE;
  for (let page = 1; page <= pageCount; page += 1) {
    const query = new URLSearchParams();
    query.set("head_sha", input.headSha);
    if (input.event) query.set("event", input.event);
    if (input.actor) query.set("actor", input.actor);
    query.set("per_page", String(ACCEPTANCE_RUN_PAGE_SIZE));
    query.set("page", String(page));
    const loaded = await getJson(
      fetchImpl,
      token,
      `${API_BASE}/repos/${ACCEPTANCE_REPOSITORY}/actions/workflows/${input.workflow}/runs?${query}`,
    );
    if (!loaded.ok || loaded.status !== 200) return { ok: false };
    const parsed = input.parse(loaded.body);
    if (!parsed) return { ok: false };
    totalCount = parsed.totalCount;
    if (totalCount > ACCEPTANCE_RUN_RESULT_BOUND) {
      return { ok: true, list: { complete: false, runs: [], totalCount } };
    }
    for (const run of parsed.runs) {
      if (run.headSha !== input.headSha || seen.has(run.id))
        return { ok: false };
      if (input.event && "event" in run && run.event !== input.event) {
        return { ok: false };
      }
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length > totalCount) return { ok: false };
    if (runs.length >= totalCount || parsed.runs.length === 0) break;
  }
  return {
    ok: true,
    list: { complete: runs.length === totalCount, runs, totalCount },
  };
}

async function getJobs(
  fetchImpl: typeof fetch,
  token: string,
  runId: string,
): Promise<
  { ok: true; runId: string; jobs: AcceptanceJobSnapshot[] } | { ok: false }
> {
  if (!/^[0-9]+$/.test(runId)) return { ok: false };
  const jobs: AcceptanceJobSnapshot[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  const pageCount = ACCEPTANCE_RUN_RESULT_BOUND / ACCEPTANCE_RUN_PAGE_SIZE;
  for (let page = 1; page <= pageCount; page += 1) {
    const query = new URLSearchParams({
      filter: "all",
      per_page: String(ACCEPTANCE_RUN_PAGE_SIZE),
      page: String(page),
    });
    const loaded = await getJson(
      fetchImpl,
      token,
      `${API_BASE}/repos/${ACCEPTANCE_REPOSITORY}/actions/runs/${runId}/jobs?${query}`,
    );
    if (!loaded.ok || loaded.status !== 200) return { ok: false };
    const parsed = parseJobs(loaded.body);
    if (!parsed) return { ok: false };
    totalCount = parsed.totalCount;
    if (totalCount > ACCEPTANCE_RUN_RESULT_BOUND) return { ok: false };
    for (const job of parsed.jobs) {
      if (seen.has(job.id)) return { ok: false };
      seen.add(job.id);
      jobs.push(job);
    }
    if (jobs.length > totalCount) return { ok: false };
    if (jobs.length >= totalCount || parsed.jobs.length === 0) break;
  }
  if (jobs.length !== totalCount) return { ok: false };
  return { ok: true, runId, jobs };
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
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

function parseDeliveryPage(
  body: unknown,
): { totalCount: number; runs: WorkflowRunSnapshot[] } | null {
  const page = parseRunPage(body, false);
  if (!page) return null;
  return { totalCount: page.totalCount, runs: page.runs };
}

function parseAcceptancePage(
  body: unknown,
): { totalCount: number; runs: AcceptanceRunSnapshot[] } | null {
  const page = parseRunPage(body, true);
  if (!page) return null;
  return { totalCount: page.totalCount, runs: page.runs };
}

function parseRunPage(
  body: unknown,
  acceptance: true,
): { totalCount: number; runs: AcceptanceRunSnapshot[] } | null;
function parseRunPage(
  body: unknown,
  acceptance: false,
): { totalCount: number; runs: WorkflowRunSnapshot[] } | null;
function parseRunPage(
  body: unknown,
  acceptance: boolean,
): { totalCount: number; runs: AcceptanceRunSnapshot[] } | null {
  const record = asRecord(body);
  if (!record || !Number.isSafeInteger(record.total_count)) return null;
  const totalCount = record.total_count as number;
  if (totalCount < 0) return null;
  if (!Array.isArray(record.workflow_runs)) return null;
  if (record.workflow_runs.length > ACCEPTANCE_RUN_PAGE_SIZE) return null;
  const runs: AcceptanceRunSnapshot[] = [];
  for (const entry of record.workflow_runs) {
    const run = asRecord(entry);
    if (
      !run ||
      !Number.isSafeInteger(run.id) ||
      typeof run.head_sha !== "string" ||
      typeof run.status !== "string"
    ) {
      return null;
    }
    if (run.conclusion !== null && typeof run.conclusion !== "string") {
      return null;
    }
    const snapshot: AcceptanceRunSnapshot = {
      id: String(run.id),
      headSha: run.head_sha,
      status: run.status,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      event: "",
      actorId: null,
      actorLogin: null,
      jobs: [],
      jobsComplete: false,
    };
    if (acceptance) {
      if (typeof run.event !== "string" || run.event.length === 0) return null;
      const actor = asRecord(run.actor);
      snapshot.event = run.event;
      if (actor) {
        if (
          !Number.isSafeInteger(actor.id) ||
          typeof actor.login !== "string"
        ) {
          return null;
        }
        snapshot.actorId = String(actor.id);
        snapshot.actorLogin = actor.login;
      }
    }
    runs.push(snapshot);
  }
  return { totalCount, runs };
}

function parseJobs(body: unknown): {
  totalCount: number;
  jobs: (AcceptanceJobSnapshot & { id: string })[];
} | null {
  const record = asRecord(body);
  if (!record || !Number.isSafeInteger(record.total_count)) return null;
  const totalCount = record.total_count as number;
  if (totalCount < 0 || !Array.isArray(record.jobs)) return null;
  if (record.jobs.length > ACCEPTANCE_RUN_PAGE_SIZE) return null;
  const jobs: (AcceptanceJobSnapshot & { id: string })[] = [];
  for (const entry of record.jobs) {
    const job = asRecord(entry);
    if (
      !job ||
      !Number.isSafeInteger(job.id) ||
      typeof job.name !== "string" ||
      typeof job.status !== "string"
    ) {
      return null;
    }
    if (job.conclusion !== null && typeof job.conclusion !== "string")
      return null;
    jobs.push({
      id: String(job.id),
      name: job.name,
      status: job.status,
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
    });
  }
  return { totalCount, jobs };
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
    const detail = decision.detail ? ` ${decision.detail}` : "";
    console.error(`::error::${safeReason(decision.reason)}${detail}`);
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
