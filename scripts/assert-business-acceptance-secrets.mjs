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
    "TUTOR_MBOS_APP_DATABASE_URL",
    "Expected secret scope: GitHub environment development (Settings → Environments → development → Secrets). Purpose: development app_runtime connection for direct tenant reads and scoped business-row cleanup. Not the migration URL.",
  ],
];

let missing = false;
for (const [name, guidance] of names) {
  if (process.env[name]) {
    console.log(
      `${name} is present. Expected secret scope: GitHub environment development.`,
    );
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
