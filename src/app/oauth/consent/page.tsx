export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const params = await searchParams;
  const authorizationId = params.authorization_id;
  if (!authorizationId) {
    return (
      <main>
        <h1>Authorize a client</h1>
        <p>This page opens from a Supabase authorization request.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Authorize a client</h1>
      <p>
        Identity scopes such as openid and email do not grant business access.
        The boxes below are the only permissions stored for this client.
      </p>
      <form action="/api/oauth/decision" method="post">
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <fieldset>
          <legend>Business permissions</legend>
          <label>
            <input
              type="checkbox"
              name="permissions"
              value="business.read"
              defaultChecked
            />{" "}
            Read the business
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              name="permissions"
              value="reports.read"
              defaultChecked
            />{" "}
            Read reports
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              name="permissions"
              value="business.onboard"
            />{" "}
            Create the first business
          </label>
        </fieldset>
        <p>
          <button type="submit" name="decision" value="approve">
            Approve
          </button>{" "}
          <button type="submit" name="decision" value="deny">
            Deny
          </button>
        </p>
      </form>
      <p>
        Not signed in? <a href="/login">Sign in</a> and return to this request.
      </p>
    </main>
  );
}
