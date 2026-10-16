/**
 * Isolated receiving read for one development acceptance run.
 * This process receives only the Resend key. It does not receive the
 * admin key, the Management API token, the app database URL, the
 * publishable key, or the Vercel token, and it does not open the
 * acceptance session file.
 */
import { pathToFileURL } from "node:url";
import {
  CLEANUP_USER_LABELS,
  expectedCleanupEmail,
} from "../src/server/application/acceptance-cleanup.ts";
import {
  acceptanceStateDir,
  readRecoveryWindow,
  writeMailResult,
} from "../src/server/application/acceptance-checkpoint.ts";
import {
  RECEIVING_KEY_CAPABILITY,
  collectReceivedActions,
  type MailPurpose,
} from "../src/server/application/acceptance-mail.ts";
import { siteOriginFor } from "../src/server/config/access.ts";
import {
  ENVIRONMENT_BINDINGS,
  supabaseUrlFor,
} from "../src/server/config/environments.ts";

function mask(value: string | null | undefined): void {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

function purposeOf(value: string | undefined): MailPurpose | null {
  if (value === "confirmation" || value === "recovery") return value;
  return null;
}

async function main(): Promise<number> {
  if (
    process.env.TUTOR_MBOS_ACCEPTANCE !== "development" ||
    process.env.GITHUB_ACTIONS !== "true"
  ) {
    console.error(
      "::error::Receiving mail runs only from the protected development workflow.",
    );
    return 2;
  }
  const purpose = purposeOf(process.env.ACCEPTANCE_MAIL_PURPOSE);
  if (!purpose) {
    console.error("::error::ACCEPTANCE_MAIL_PURPOSE is absent.");
    return 2;
  }
  const nonce = process.env.ACCEPTANCE_RUN_NONCE ?? "";
  mask(nonce);
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    console.error("::error::ACCEPTANCE_RUN_NONCE must be 32 hex characters.");
    return 2;
  }
  const root = process.env.RUNNER_TEMP ?? "";
  if (!root) {
    console.error("::error::RUNNER_TEMP is absent.");
    return 2;
  }
  const startedAt =
    purpose === "recovery"
      ? (readRecoveryWindow(acceptanceStateDir(root)) ?? "")
      : (process.env.ACCEPTANCE_STARTED_AT ?? "");
  const apiKey = process.env.RESEND_DEVELOPMENT_RECEIVING_API_KEY ?? "";
  mask(apiKey);
  const ref = ENVIRONMENT_BINDINGS.development.supabaseProjectRef;
  console.log(
    `receiving_permission=full_access account_wide=true domain_restriction=sending_access_only capability=${RECEIVING_KEY_CAPABILITY}`,
  );
  const result = await collectReceivedActions({
    fetchImpl: fetch,
    apiKey,
    purpose,
    startedAt,
    nowMs: Date.now(),
    supabaseOrigin: supabaseUrlFor(ref),
    siteOrigin: siteOriginFor("development"),
    recipients: (purpose === "confirmation"
      ? CLEANUP_USER_LABELS
      : (["tenant-a"] as const)
    ).map((label) => ({
      label,
      email: expectedCleanupEmail(label, nonce),
    })),
  });
  writeMailResult(acceptanceStateDir(root), result);
  console.log(`${purpose}_mail=${result.status}`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
