/**
 * Pure review of one manual acceptance comment. The comment and event
 * payload are untrusted. This module does not open connections, read
 * credentials, or check out a ref.
 */

export const ACCEPTANCE_REPOSITORY = "bhaveshbusa/tutor-mbos";
export const ACCEPTANCE_ACTOR_ID = "3823973";
export const ACCEPTANCE_ACTOR_LOGIN = "bhaveshbusa";
export const ACCEPTANCE_COMMAND_PREFIX = "/tutor-mbos accept-development ";
export const RECOVER_COMMAND_PREFIX = "/tutor-mbos recover-development ";
export const DEPLOY_WORKFLOW_FILE = "deploy-development.yml";
export const ACCEPT_WORKFLOW_FILE = "accept-development.yml";
export const AUTHORIZE_JOB_NAME = "Authorize acceptance comment";
export const PREFLIGHT_JOB_NAME = "Preflight tutor-mbos-dev";
export const ACCEPT_JOB_NAME = "Accept tutor-mbos-dev";
export const CLEANUP_JOB_NAME = "Clean acceptance Auth resources";
export const EMPTY_RESOURCES_STEP_NAME = "Record empty acceptance resources";
export const CAPABILITY_STEP_NAME =
  "Check admin capability and mint run identity";
export const RUNNER_SETUP_STEP_NAME = "Set up job";
export const RUNNER_COMPLETE_STEP_NAME = "Complete job";
export const POST_BOUNDARY_STEP_NAMES = [
  "Pull Vercel project settings and environment",
  "Verify deployment target binding",
] as const;
export const ACCEPTANCE_RUN_PAGE_SIZE = 100;
/** Documented workflow-run search cap when actor, event, or head_sha is set. */
export const ACCEPTANCE_RUN_RESULT_BOUND = 1_000;
/** Self-imposed jobs bound. The jobs API documents page size, not this cap. */
export const ACCEPTANCE_JOB_RESULT_BOUND = 1_000;

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

export interface AcceptanceStepSnapshot {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface AcceptanceJobSnapshot {
  name: string;
  status: string;
  conclusion: string | null;
  steps: readonly AcceptanceStepSnapshot[];
  stepsComplete: boolean;
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
  | "recovery_not_proven"
  | "recovery_denied"
  | "rerun";

export function reviewAcceptanceRequestShape(
  request: AcceptanceCommentRequest,
): AcceptanceRequestDecision {
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
  const parsed = parseAcceptanceCommand(request.commentBody);
  if (!parsed) return reject("command");
  if (!SHA.test(request.githubSha) || parsed.candidate !== request.githubSha) {
    return reject("candidate_not_head");
  }
  if (!request.pullRequestPresent) return reject("not_pull_request");
  return { ok: true, candidate: parsed.candidate };
}

export function reviewAcceptanceComment(input: {
  request: AcceptanceCommentRequest;
  pullRequest: PullRequestSnapshot | null;
  delivery: WorkflowRunList | null;
  acceptance: AcceptanceRunList | null;
}): AcceptanceRequestDecision {
  const shape = reviewAcceptanceRequestShape(input.request);
  if (!shape.ok) return shape;
  const parsed = parseAcceptanceCommand(input.request.commentBody);
  if (!parsed) return reject("command");
  const command = parsed.candidate;
  const pullRequest = input.pullRequest;
  if (!pullRequest) return reject("not_pull_request");
  if (!pullRequest.merged) return reject("pull_request_unmerged");
  if (
    pullRequest.baseRef !== "main" ||
    pullRequest.baseRepository !== ACCEPTANCE_REPOSITORY
  ) {
    return reject("pull_request_base");
  }
  if (pullRequest.number !== input.request.issueNumber) {
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
  if (parsed.kind === "accept") {
    let unknown = false;
    for (const run of input.acceptance.runs) {
      const evidence = earlierAcceptance(run, input.request.runId, command);
      if (evidence === "block") return reject("duplicate_request");
      if (evidence === "unknown") unknown = true;
    }
    if (unknown) return reject("acceptance_evidence_unknown");
    return { ok: true, candidate: command };
  }
  let proven = false;
  let denied = false;
  let unknown = false;
  for (const run of input.acceptance.runs) {
    const evidence = recoveryEvidence(run, input.request.runId, command);
    if (evidence === "proven") proven = true;
    else if (evidence === "deny") denied = true;
    else if (evidence === "unknown") unknown = true;
  }
  if (denied) return reject("recovery_denied");
  if (unknown) return reject("acceptance_evidence_unknown");
  if (!proven) return reject("recovery_not_proven");
  return { ok: true, candidate: command };
}

export function candidateMatchesHead(
  candidate: string,
  githubSha: string,
): boolean {
  return SHA.test(candidate) && candidate === githubSha;
}

function parseAcceptanceCommand(
  body: string,
): { kind: "accept" | "recover"; candidate: string } | null {
  if (Buffer.byteLength(body, "utf8") > COMMENT_MAX_BYTES) return null;
  if (body.includes("\r") || body.includes("\0")) return null;
  const normalized =
    body.endsWith("\n") && !body.slice(0, -1).endsWith("\n")
      ? body.slice(0, -1)
      : body;
  const accept = /^\/tutor-mbos accept-development ([0-9a-f]{40})$/.exec(
    normalized,
  );
  if (accept?.[1]) return { kind: "accept", candidate: accept[1] };
  const recover = /^\/tutor-mbos recover-development ([0-9a-f]{40})$/.exec(
    normalized,
  );
  if (recover?.[1]) return { kind: "recover", candidate: recover[1] };
  return null;
}

function earlierAcceptance(
  run: AcceptanceRunSnapshot,
  currentRunId: string,
  candidate: string,
): "ignore" | "block" | "unknown" {
  if (run.headSha !== candidate) return "ignore";
  if (!DIGITS.test(run.id) || !DIGITS.test(currentRunId)) return "unknown";
  if (BigInt(run.id) >= BigInt(currentRunId)) return "ignore";
  if (run.event === "issue_comment") {
    const authorized = commentAuthorized(run);
    if (authorized === "block" && finishedWithoutHostedResources(run)) {
      return "ignore";
    }
    return authorized;
  }
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
  return attemptsOf(run.jobs, AUTHORIZE_JOB_NAME, (job) => {
    return job.status !== "completed" || job.conclusion === "success";
  });
}

function dispatchAccepted(
  run: AcceptanceRunSnapshot,
): "ignore" | "block" | "unknown" {
  if (!run.jobsComplete) return "unknown";
  const preflight = attemptsOf(run.jobs, PREFLIGHT_JOB_NAME, (job) => {
    return job.status !== "completed" || job.conclusion === "success";
  });
  const accept = attemptsOf(run.jobs, ACCEPT_JOB_NAME, (job) => {
    if (job.status !== "completed" || job.conclusion === "success") return true;
    return job.conclusion !== null && ACCEPT_RAN.has(job.conclusion);
  });
  if (preflight === "block" || accept === "block") return "block";
  if (preflight === "unknown" || accept === "unknown") return "unknown";
  return "ignore";
}

/**
 * A finished comment run may be followed by a new accept command when the
 * business job failed and cleanup proved the manifest listed no Auth users
 * and no OAuth clients. A recorded user or client stays ineligible after
 * deletion. Recover is unchanged and stays denied once accept has started.
 */
function finishedWithoutHostedResources(run: AcceptanceRunSnapshot): boolean {
  if (!run.jobsComplete) return false;
  const authorizeJobs = run.jobs.filter(
    (job) => job.name === AUTHORIZE_JOB_NAME,
  );
  if (
    authorizeJobs.length === 0 ||
    authorizeJobs.some((job) => !knownJob(job) || job.status !== "completed")
  ) {
    return false;
  }
  if (
    !authorizeJobs.some((job) => job.conclusion === "success") ||
    authorizeJobs.some(
      (job) => job.conclusion !== "success" && job.conclusion !== "skipped",
    )
  ) {
    return false;
  }
  const accepts = run.jobs.filter((job) => job.name === ACCEPT_JOB_NAME);
  if (
    accepts.length === 0 ||
    accepts.some(
      (job) =>
        !knownJob(job) ||
        job.status !== "completed" ||
        job.conclusion !== "failure",
    )
  ) {
    return false;
  }
  const cleanups = run.jobs.filter((job) => job.name === CLEANUP_JOB_NAME);
  if (cleanups.length === 0) return false;
  return cleanups.every(emptyResourcesStepProven);
}

function emptyResourcesStepProven(job: AcceptanceJobSnapshot): boolean {
  if (
    !knownJob(job) ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !job.stepsComplete
  ) {
    return false;
  }
  const marks = job.steps.filter(
    (step) => step.name === EMPTY_RESOURCES_STEP_NAME,
  );
  return (
    marks.length > 0 &&
    marks.every(
      (step) =>
        knownStep(step) &&
        step.status === "completed" &&
        step.conclusion === "success",
    )
  );
}

function attemptsOf(
  jobs: readonly AcceptanceJobSnapshot[],
  name: string,
  blocks: (job: AcceptanceJobSnapshot) => boolean,
): "ignore" | "block" | "unknown" {
  let unknown = false;
  for (const job of jobs) {
    if (job.name !== name) continue;
    if (!knownJob(job)) {
      unknown = true;
      continue;
    }
    if (blocks(job)) return "block";
  }
  return unknown ? "unknown" : "ignore";
}

function knownJob(job: AcceptanceJobSnapshot): boolean {
  if (!JOB_STATUS.has(job.status)) return false;
  if (job.conclusion === null) return job.status !== "completed";
  return JOB_CONCLUSION.has(job.conclusion);
}

function recoveryEvidence(
  run: AcceptanceRunSnapshot,
  currentRunId: string,
  candidate: string,
): "ignore" | "proven" | "deny" | "unknown" {
  if (run.headSha !== candidate) return "ignore";
  if (!DIGITS.test(run.id) || !DIGITS.test(currentRunId)) return "unknown";
  if (BigInt(run.id) >= BigInt(currentRunId)) return "ignore";
  if (run.event === "workflow_dispatch") {
    if (!run.jobsComplete) return "unknown";
    const accepted = dispatchAccepted(run);
    if (accepted === "block") return "deny";
    if (accepted === "unknown") return "unknown";
    return "ignore";
  }
  if (run.event !== "issue_comment") return "unknown";
  if (run.actorId === null || run.actorLogin === null) return "unknown";
  if (
    run.actorId !== ACCEPTANCE_ACTOR_ID ||
    run.actorLogin !== ACCEPTANCE_ACTOR_LOGIN
  ) {
    return "ignore";
  }
  if (!run.jobsComplete) return "unknown";
  if (
    run.jobs.some((job) => job.name === AUTHORIZE_JOB_NAME && !knownJob(job))
  ) {
    return "unknown";
  }
  const authorized = attemptsOf(run.jobs, AUTHORIZE_JOB_NAME, (job) => {
    return job.status !== "completed" || job.conclusion === "success";
  });
  if (authorized === "unknown") return "unknown";
  if (authorized === "ignore") return "ignore";
  const authorizeJobs = run.jobs.filter(
    (job) => job.name === AUTHORIZE_JOB_NAME,
  );
  if (authorizeJobs.some((job) => job.status !== "completed")) return "deny";
  return preResourceFailure(run);
}

function preResourceFailure(
  run: AcceptanceRunSnapshot,
): "proven" | "deny" | "unknown" {
  const accepts = run.jobs.filter((job) => job.name === ACCEPT_JOB_NAME);
  if (accepts.length === 0) return "unknown";
  for (const job of accepts) {
    if (!knownJob(job)) return "unknown";
    if (job.status !== "completed" || job.conclusion !== "skipped") {
      return "deny";
    }
  }
  const preflights = run.jobs.filter((job) => job.name === PREFLIGHT_JOB_NAME);
  if (preflights.length === 0) return "unknown";
  let proven = false;
  for (const job of preflights) {
    if (!knownJob(job)) return "unknown";
    if (job.status !== "completed") return "deny";
    if (job.conclusion === "skipped") continue;
    if (job.conclusion !== "failure") return "deny";
    const steps = failedBeforeCapability(job);
    if (steps !== "proven") return steps;
    proven = true;
  }
  return proven ? "proven" : "unknown";
}

function failedBeforeCapability(
  job: AcceptanceJobSnapshot,
): "proven" | "deny" | "unknown" {
  if (!job.stepsComplete || job.steps.length === 0) return "unknown";
  const capability = job.steps.filter(
    (step) => step.name === CAPABILITY_STEP_NAME,
  );
  if (capability.length !== 1) return "unknown";
  const boundary = capability[0];
  if (!boundary || !knownStep(boundary)) return "unknown";
  if (boundary.status !== "completed" || boundary.conclusion !== "skipped") {
    return "deny";
  }
  let earlierFailure = false;
  const earlier = job.steps.filter((step) => step.number < boundary.number);
  for (const step of job.steps) {
    if (!knownStep(step)) return "unknown";
    if (step.number < boundary.number) {
      if (step.status !== "completed") return "unknown";
      if (step.conclusion === "failure") earlierFailure = true;
      continue;
    }
    if (step.name === CAPABILITY_STEP_NAME && step.number === boundary.number) {
      continue;
    }
    const after = stepAfterBoundary(step, earlier);
    if (after === "deny") return "deny";
    if (after === "unknown") return "unknown";
  }
  return earlierFailure ? "proven" : "unknown";
}

function stepAfterBoundary(
  step: AcceptanceStepSnapshot,
  earlier: readonly AcceptanceStepSnapshot[],
): "allow" | "deny" | "unknown" {
  if ((POST_BOUNDARY_STEP_NAMES as readonly string[]).includes(step.name)) {
    return step.status === "completed" && step.conclusion === "skipped"
      ? "allow"
      : "deny";
  }
  if (isRunnerTeardown(step.name, earlier)) {
    return step.status === "completed" &&
      (step.conclusion === "success" || step.conclusion === "skipped")
      ? "allow"
      : "unknown";
  }
  return "unknown";
}

function isRunnerTeardown(
  name: string,
  earlier: readonly AcceptanceStepSnapshot[],
): boolean {
  if (name === RUNNER_COMPLETE_STEP_NAME) return true;
  if (!name.startsWith("Post ")) return false;
  const rest = name.slice("Post ".length);
  return earlier.some(
    (step) => step.name === rest || step.name === `Run ${rest}`,
  );
}

function knownStep(step: AcceptanceStepSnapshot): boolean {
  if (!Number.isSafeInteger(step.number)) return false;
  if (!JOB_STATUS.has(step.status)) return false;
  if (step.conclusion === null) return step.status !== "completed";
  return JOB_CONCLUSION.has(step.conclusion);
}

function reject(reason: AcceptanceRequestReason): AcceptanceRequestDecision {
  return { ok: false, reason };
}
