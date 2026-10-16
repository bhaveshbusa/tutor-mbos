const candidate = process.env.ACCEPTANCE_CANDIDATE ?? "";
const sha = process.env.GITHUB_SHA ?? "";
if (!/^[0-9a-f]{40}$/.test(candidate) || candidate !== sha) {
  console.error("::error::candidate_not_head");
  process.exit(1);
}
