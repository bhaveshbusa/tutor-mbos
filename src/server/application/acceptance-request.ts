/**
 * Pure review of one manual acceptance comment. The comment and event
 * payload are untrusted. This module does not open connections, read
 * credentials, or check out a ref.
 */

export const ACCEPTANCE_REPOSITORY = "bhaveshbusa/tutor-mbos";
export const ACCEPTANCE_ACTOR_ID = "3823973";
export const ACCEPTANCE_ACTOR_LOGIN = "bhaveshbusa";
export const ACCEPTANCE_COMMAND_PREFIX = "/tutor-mbos accept-development ";
export const DEPLOY_WORKFLOW_FILE = "deploy-development.yml";
export const ACCEPT_WORKFLOW_FILE = "accept-development.yml";
export const AUTHORIZE_JOB_NAME = "Authorize acceptance comment";
export const PREFLIGHT_JOB_NAME = "Preflight tutor-mbos-dev";
export const ACCEPT_JOB_NAME = "Accept tutor-mbos-dev";
export const ACCEPTANCE_RUN_PAGE_SIZE = 100;
export const ACCEPTANCE_RUN_RESULT_BOUND = 1_000;

const COMMENT_MAX_BYTES = 256;
const SHA = /^[0-9a-f]{40}$/;
const DIGITS = /^[0-9]+$/;
const JOB_STATUS = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const JOB_CONCLUSION = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
]);
const ACCEPT_RAN = new Set(["failure", "cancelled", "timed_out"]);

export interface AcceptanceCommentRequest {
  eventName: string;
  eventAction: string;
  repository: string;
  actorId: string;
  actorLogin: string;
  commentBody: string;
  githubSha: string;
  issueNumber: string;
  pullRequestPresent: boolean;
  commentId: string;
  runId: string;
  runAttempt: string;
}

export interface PullRequestSnapshot {
  number: string;
  merged: boolean;
  baseRef: string;
  baseRepository: string;
  mergeCommitSha: string | null;
}

export interface WorkflowRunSnapshot {
  id: string;
  headSha: string;
  status: string;
  conclusion: string | null;
}

export interface AcceptanceJobSnapshot {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface AcceptanceRunSnapshot extends WorkflowRunSnapshot {
  event: string;
  actorId: string | null;
  actorLogin: string | null;
  jobs: readonly AcceptanceJobSnapshot[];
  jobsComplete: boolean;
}

export interface WorkflowRunList {
  complete: boolean;
  runs: readonly WorkflowRunSnapshot[];
  totalCount?: number;
}

export interface AcceptanceRunList {
  complete: boolean;
  runs: readonly AcceptanceRunSnapshot[];
  totalCount?: number;
}

export type AcceptanceRequestDecision =
  | { ok: true; candidate: string }
  | { ok: false; reason: AcceptanceRequestReason };

export type AcceptanceRequestReason =
  | "event"
  | "repository"
  | "actor"
  | "command"
  | "comment_id"
  | "run_id"
  | "run_attempt"
  | "issue_number"
  | "not_pull_request"
  | "candidate_not_head"
  | "pull_request_unmerged"
  | "pull_request_base"
  | "pull_request_number"
  | "candidate_not_merge"
  | "delivery_lookup_truncated"
  | "delivery_absent"
  | "acceptance_lookup_truncated"
  | "acceptance_evidence_unknown"
  | "duplicate_request"
  | "rerun";

export function reviewAcceptanceComment(input: {
  request: AcceptanceCommentRequest;
  pullRequest: PullRequestSnapshot | null;
  delivery: WorkflowRunList | null;
  acceptance: AcceptanceRunList | null;
}): AcceptanceRequestDecision {
  const request = input.request;
  if (
    request.eventName !== "issue_comment" ||
    request.eventAction !== "created"
  ) {
    return reject("event");
  }
  if (request.repository !== ACCEPTANCE_REPOSITORY) return reject("repository");
  if (
    request.actorId !== ACCEPTANCE_ACTOR_ID ||
    request.actorLogin !== ACCEPTANCE_ACTOR_LOGIN
  ) {
    return reject("actor");
  }
  if (!DIGITS.test(request.commentId)) return reject("comment_id");
  if (!DIGITS.test(request.runId)) return reject("run_id");
  if (request.runAttempt !== "1") return reject("rerun");
  if (!DIGITS.test(request.issueNumber)) return reject("issue_number");
  const command = parseAcceptanceCommand(request.commentBody);
  if (!command) return reject("command");
  if (!SHA.test(request.githubSha) || command !== request.githubSha) {
    return reject("candidate_not_head");
  }
  if (!request.pullRequestPresent) return reject("not_pull_request");
  const pullRequest = input.pullRequest;
  if (!pullRequest) return reject("not_pull_request");
  if (!pullRequest.merged) return reject("pull_request_unmerged");
  if (
    pullRequest.baseRef !== "main" ||
    pullRequest.baseRepository !== ACCEPTANCE_REPOSITORY
  ) {
    return reject("pull_request_base");
  }
  if (pullRequest.number !== request.issueNumber) {
    return reject("pull_request_number");
  }
  if (pullRequest.mergeCommitSha !== command) {
    return reject("candidate_not_merge");
  }
  if (!input.delivery?.complete) return reject("delivery_lookup_truncated");
  const delivered = input.delivery.runs.some(
    (run) =>
      run.headSha === command &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  if (!delivered) return reject("delivery_absent");
  if (!input.acceptance?.complete) return reject("acceptance_lookup_truncated");
  let unknown = false;
  for (const run of input.acceptance.runs) {
    const evidence = earlierAcceptance(run, request.runId, command);
    if (evidence === "block") return reject("duplicate_request");
    if (evidence === "unknown") unknown = true;
  }
  if (unknown) return reject("acceptance_evidence_unknown");
  return { ok: true, candidate: command };
}

export function candidateMatchesHead(
  candidate: string,
  githubSha: string,
): boolean {
  return SHA.test(candidate) && candidate === githubSha;
}

function parseAcceptanceCommand(body: string): string | null {
  if (Buffer.byteLength(body, "utf8") > COMMENT_MAX_BYTES) return null;
  if (body.includes("\r") || body.includes("\0")) return null;
  const normalized =
    body.endsWith("\n") && !body.slice(0, -1).endsWith("\n")
      ? body.slice(0, -1)
      : body;
  const match = /^\/tutor-mbos accept-development ([0-9a-f]{40})$/.exec(
    normalized,
  );
  return match?.[1] ?? null;
}

function earlierAcceptance(
  run: AcceptanceRunSnapshot,
  currentRunId: string,
  candidate: string,
): "ignore" | "block" | "unknown" {
  if (run.headSha !== candidate) return "ignore";
  if (!DIGITS.test(run.id) || !DIGITS.test(currentRunId)) return "unknown";
  if (BigInt(run.id) >= BigInt(currentRunId)) return "ignore";
  if (run.event === "issue_comment") return commentAuthorized(run);
  if (run.event === "workflow_dispatch") return dispatchAccepted(run);
  return "unknown";
}

function commentAuthorized(
  run: AcceptanceRunSnapshot,
): "ignore" | "block" | "unknown" {
  if (run.actorId === null || run.actorLogin === null) return "unknown";
  if (
    run.actorId !== ACCEPTANCE_ACTOR_ID ||
    run.actorLogin !== ACCEPTANCE_ACTOR_LOGIN
  ) {
    return "ignore";
  }
  if (!run.jobsComplete) return "unknown";
  const jobs = run.jobs.filter((job) => job.name === AUTHORIZE_JOB_NAME);
  if (jobs.length === 0) return "ignore";
  if (jobs.length > 1) return "unknown";
  const job = jobs[0];
  if (!job || !knownJob(job)) return "unknown";
  if (job.status !== "completed" || job.conclusion === "success")
    return "block";
  return "ignore";
}

function dispatchAccepted(
  run: AcceptanceRunSnapshot,
): "ignore" | "block" | "unknown" {
  if (!run.jobsComplete) return "unknown";
  const preflight = oneJob(run.jobs, PREFLIGHT_JOB_NAME);
  const accept = oneJob(run.jobs, ACCEPT_JOB_NAME);
  if (preflight === "duplicate" || accept === "duplicate") return "unknown";
  if ((preflight && !knownJob(preflight)) || (accept && !knownJob(accept))) {
    return "unknown";
  }
  if (
    preflight &&
    (preflight.status !== "completed" || preflight.conclusion === "success")
  ) {
    return "block";
  }
  if (!accept) return "ignore";
  if (accept.status !== "completed") return "block";
  if (accept.conclusion === "success") return "block";
  if (accept.conclusion && ACCEPT_RAN.has(accept.conclusion)) return "block";
  return "ignore";
}

function oneJob(
  jobs: readonly AcceptanceJobSnapshot[],
  name: string,
): AcceptanceJobSnapshot | "duplicate" | null {
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length > 1) return "duplicate";
  return matches[0] ?? null;
}

function knownJob(job: AcceptanceJobSnapshot): boolean {
  if (!JOB_STATUS.has(job.status)) return false;
  if (job.conclusion === null) return job.status !== "completed";
  return JOB_CONCLUSION.has(job.conclusion);
}

function reject(reason: AcceptanceRequestReason): AcceptanceRequestDecision {
  return { ok: false, reason };
}
