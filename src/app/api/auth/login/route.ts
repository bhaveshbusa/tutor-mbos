import { handleLogin } from "@/adapters/http/browser-auth";
import { withBrowserAuth } from "@/adapters/http/supabase-browser";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return withBrowserAuth(request, process.env, (auth, siteOrigin) =>
    handleLogin(request, auth, siteOrigin),
  );
}
