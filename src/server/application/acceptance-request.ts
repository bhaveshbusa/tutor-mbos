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

const COMMENT_MAX_BYTES = 256;
const SHA = /^[0-9a-f]{40}$/;
const DIGITS = /^[0-9]+$/;

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

export interface WorkflowRunList {
  complete: boolean;
  runs: readonly WorkflowRunSnapshot[];
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
  | "duplicate_request";

export function reviewAcceptanceComment(input: {
  request: AcceptanceCommentRequest;
  pullRequest: PullRequestSnapshot | null;
  delivery: WorkflowRunList | null;
  acceptance: WorkflowRunList | null;
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
  const duplicate = input.acceptance.runs.some((run) =>
    isDuplicateAcceptance(run, request.runId, command),
  );
  if (duplicate) return reject("duplicate_request");
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

function isDuplicateAcceptance(
  run: WorkflowRunSnapshot,
  currentRunId: string,
  candidate: string,
): boolean {
  if (run.id === currentRunId || run.headSha !== candidate) return false;
  if (run.conclusion === "success") return true;
  return run.status !== "completed";
}

function reject(reason: AcceptanceRequestReason): AcceptanceRequestDecision {
  return { ok: false, reason };
}
