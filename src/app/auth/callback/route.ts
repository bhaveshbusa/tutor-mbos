import { handleCallback } from "@/adapters/http/browser-auth";
import { withBrowserAuth } from "@/adapters/http/supabase-browser";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withBrowserAuth(request, process.env, (auth, siteOrigin) =>
    handleCallback(request, auth, siteOrigin),
  );
}
