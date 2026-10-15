import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSupabaseConsentGateway,
  resolveConsentEntry,
} from "@/adapters/http/consent";
import { withAccess } from "@/adapters/http/production";

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
  const cookie = (await cookies()).toString();
  const request = new Request("http://localhost/oauth/consent", {
    headers: cookie ? { cookie } : {},
  });
  const response = await withAccess(request, process.env, (deps) =>
    resolveConsentEntry(
      request,
      deps,
      createSupabaseConsentGateway(process.env),
      authorizationId,
    ),
  );
  if (response.status === 303) {
    const location = response.headers.get("location");
    if (location) redirect(location);
  }
  const repeat =
    response.status === 200 &&
    ((await response.json()) as { view?: string }).view === "repeat";
  return (
    <main>
      <h1>Authorize a client</h1>
      <p>
        Identity scopes such as openid and email do not grant business access.
        The boxes below are the only permissions stored for this client.
      </p>
      {repeat ? (
        <p>
          This authorization was already decided, and no single live grant
          matches it. Start the client connection again before approving.
        </p>
      ) : null}
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
