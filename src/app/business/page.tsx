import { createAccessHandlers } from "@/adapters/http/access";
import { withAccess } from "@/adapters/http/production";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function BusinessPage() {
  const cookie = (await cookies()).toString();
  const request = new Request("http://localhost/api/v1/business", {
    headers: cookie ? { cookie } : {},
  });
  const response = await withAccess(request, process.env, (deps) =>
    createAccessHandlers(deps).getBusiness(
      new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          origin: deps.siteOrigin,
        },
      }),
    ),
  );
  if (response.status === 401) {
    return (
      <main>
        <h1>Your business</h1>
        <p>
          <a href="/login">Sign in</a> to see the business owned by your
          account.
        </p>
      </main>
    );
  }
  if (response.status !== 200) {
    return (
      <main>
        <h1>Your business</h1>
        <p>The business could not be loaded.</p>
      </main>
    );
  }
  const body = (await response.json()) as {
    business: { id: string; displayName: string } | null;
  };
  if (!body.business) {
    return (
      <main>
        <h1>Your business</h1>
        <p>No business exists for this account yet.</p>
        <p>
          <a href="/onboarding">Create your business</a>
        </p>
      </main>
    );
  }
  return (
    <main>
      <h1>{body.business.displayName}</h1>
      <p>Business id {body.business.id}</p>
    </main>
  );
}
