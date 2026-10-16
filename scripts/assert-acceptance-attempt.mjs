const eventName = process.env.ACCEPTANCE_EVENT_NAME ?? "";
const attempt = process.env.ACCEPTANCE_RUN_ATTEMPT ?? "";
if (eventName === "workflow_dispatch") {
  process.exit(0);
}
if (eventName !== "issue_comment" || attempt !== "1") {
  console.error("::error::rerun");
  process.exit(1);
}
