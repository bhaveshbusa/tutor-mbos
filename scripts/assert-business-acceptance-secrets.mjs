/**
 * Presence check for the names the business job needs. Prints each name as
 * present or absent. Does not print a value, length, or hash, and does not
 * write a job output. An absent name stops preflight before the admin
 * capability check mints a nonce.
 */
const names = [
  [
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    "Copy the project's existing Protection Bypass for Automation value to GitHub → Settings → Environments → development → Secrets. The business job sends it as x-vercel-protection-bypass and does not receive VERCEL_TOKEN. Do not generate a new bypass and do not disable Deployment Protection.",
  ],
  [
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "Expected secret scope: GitHub environment development (Settings → Environments → development → Secrets). Purpose: business-job Auth and Data API calls. This is the public key, not the admin key.",
  ],
  [
    "APP_RUNTIME_PASSWORD",
    "Expected secret scope: GitHub environment development (Settings → Environments → development → Secrets). Purpose: the only app_runtime password. The business job encodes it into the connection URL. Not the migration URL.",
  ],
  [
    "TUTOR_MBOS_APP_DATABASE_HOST",
    "Expected variable scope: GitHub environment development (Settings → Environments → development → Variables). Host only. Not a secret and not a password.",
  ],
  [
    "TUTOR_MBOS_APP_DATABASE_PORT",
    "Expected variable scope: GitHub environment development (Settings → Environments → development → Variables). Port only. Not a secret and not a password.",
  ],
];

let missing = false;
for (const [name, guidance] of names) {
  if (process.env[name]) {
    const scope = guidance.startsWith("Expected variable scope")
      ? "Expected variable scope: GitHub environment development."
      : "Expected secret scope: GitHub environment development.";
    console.log(`${name} is present. ${scope}`);
  } else {
    missing = true;
    console.error(`::error::${name} is absent. ${guidance}`);
  }
}
if (missing) {
  console.error(
    "::error::Development acceptance stops before the admin capability check until each absent business secret above is present.",
  );
  process.exit(1);
}
