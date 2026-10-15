import { handleRecoveryCallback } from "@/adapters/http/browser-auth";
import { withBrowserAuth } from "@/adapters/http/supabase-browser";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withBrowserAuth(request, process.env, (auth, siteOrigin) =>
    handleRecoveryCallback(request, auth, siteOrigin),
  );
}
